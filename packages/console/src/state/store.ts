/**
 * The console's state store: one JSON document at `<data>/console.json`.
 *
 * - The whole document lives in memory; every change goes through `update()`,
 *   which applies it and rewrites the file atomically (atomic.ts). Updates are
 *   serialized, so two requests changing state at once never interleave.
 * - Only one process may own a data directory (lock.ts).
 * - Secrets inside the document are encrypted with a key derived from
 *   MONGOSHIELD_SECRET (crypto.ts). Opening a directory with the wrong secret
 *   fails immediately instead of corrupting or losing secrets later.
 *
 * The state is small (users, connections, plans, the last 500 jobs), so
 * rewriting it as a whole is simpler and safer than any incremental format.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import {
  type ConsoleKeys,
  decryptSecret,
  deriveKeys,
  encryptSecret,
  MIN_SECRET_LENGTH,
} from "./crypto.ts";
import { acquireDataDirLock, type DataDirLock, type WaitForPrevious } from "./lock.ts";
import { type ConsoleState, type MutableState, STATE_FORMAT_VERSION } from "./types.ts";

/** File name of the state document inside the data directory. */
export const STATE_FILE = "console.json";

/** The plaintext of `keyCheck`. Not a secret; it only proves the key is right. */
const KEY_CHECK_PLAINTEXT = "mongoshield-console key check";
const KEY_CHECK_CONTEXT = "state:key-check";

/** HKDF salt length (bytes). 32 random bytes, as RFC 5869 suggests (hash length). */
const SALT_BYTES = 32;

/** Options for {@link StateStore.open}. */
export interface OpenStateOptions {
  /** The data directory (MONGOSHIELD_DATA_DIR). Created if missing. */
  readonly dataDir: string;
  /** MONGOSHIELD_SECRET. */
  readonly secret: string;
  /** Lock heartbeat interval; tests shorten it. */
  readonly lockHeartbeatMs?: number;
  /**
   * Wait for the lock of a console that just went away (a replaced container)
   * instead of failing at once. The server sets it; tests leave it off.
   */
  readonly waitForPreviousLock?: WaitForPrevious;
}

/** Why the store could not be opened, in words an operator can act on. */
export class StateOpenError extends Error {
  override readonly name = "StateOpenError";
}

/** The console's persistent state. Create with {@link StateStore.open}. */
export class StateStore {
  /** Absolute path of console.json. */
  readonly path: string;
  /** The keys derived from MONGOSHIELD_SECRET for this data directory. */
  readonly #keys: ConsoleKeys;
  readonly #lock: DataDirLock;
  #state: ConsoleState;
  /** Tail of the update queue: each update waits for the previous one. */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, keys: ConsoleKeys, lock: DataDirLock, state: ConsoleState) {
    this.path = path;
    this.#keys = keys;
    this.#lock = lock;
    this.#state = state;
  }

  /**
   * Opens (or initialises) the state in `dataDir`.
   *
   * @throws StateOpenError when the secret is too short, the file is unreadable,
   *   or it was created with a different MONGOSHIELD_SECRET.
   * @throws DataDirLockedError when another console uses the directory.
   */
  static async open(options: OpenStateOptions): Promise<StateStore> {
    if (options.secret.length < MIN_SECRET_LENGTH) {
      throw new StateOpenError(
        `MONGOSHIELD_SECRET must be at least ${MIN_SECRET_LENGTH} characters long.`,
      );
    }
    // 0700: only the console's own user may look inside the data directory.
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    const lock = await acquireDataDirLock(options.dataDir, {
      ...(options.lockHeartbeatMs === undefined ? {} : { heartbeatMs: options.lockHeartbeatMs }),
      ...(options.waitForPreviousLock === undefined
        ? {}
        : { waitForPrevious: options.waitForPreviousLock }),
    });
    const path = join(options.dataDir, STATE_FILE);
    try {
      const existing = await readStateFile(path);
      if (existing === undefined) {
        const salt = randomBytes(SALT_BYTES);
        const keys = deriveKeys(options.secret, salt);
        const state = emptyState(salt, keys);
        await writeFileAtomic(path, serialize(state));
        return new StateStore(path, keys, lock, state);
      }
      const keys = deriveKeys(options.secret, Buffer.from(existing.keySalt, "base64"));
      assertKeyMatches(keys, existing);
      return new StateStore(path, keys, lock, existing);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /** The current state. Treat it as read-only; change it through {@link update}. */
  get current(): ConsoleState {
    return this.#state;
  }

  /** The CSRF key (derived from MONGOSHIELD_SECRET). */
  get csrfKey(): Buffer {
    return this.#keys.csrf;
  }

  /**
   * Applies `mutate` to a copy of the state and saves it. The in-memory state
   * changes only once the file was written, so a failed write changes nothing.
   * `mutate` must be synchronous: everything it decides is saved together.
   */
  update<T>(mutate: (draft: MutableState) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const draft: MutableState = { ...this.#state };
      const result = mutate(draft);
      const next: ConsoleState = { ...draft };
      await writeFileAtomic(this.path, serialize(next));
      this.#state = next;
      return result;
    };
    const result = this.#queue.then(run, run);
    // Keep the queue going even if this update fails.
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Encrypts a secret for storage; `context` names where it is stored (see crypto.ts). */
  encrypt(plaintext: string, context: string): string {
    return encryptSecret(this.#keys.secrets, plaintext, context);
  }

  /** Decrypts a stored secret. */
  decrypt(value: string, context: string): string {
    return decryptSecret(this.#keys.secrets, value, context);
  }

  /** Waits for pending writes and releases the data directory. */
  async close(): Promise<void> {
    await this.#queue;
    await this.#lock.release();
  }
}

/** A brand-new state for an empty data directory. */
function emptyState(salt: Buffer, keys: ConsoleKeys): ConsoleState {
  return {
    version: STATE_FORMAT_VERSION,
    keySalt: salt.toString("base64"),
    keyCheck: encryptSecret(keys.secrets, KEY_CHECK_PLAINTEXT, KEY_CHECK_CONTEXT),
    users: [],
    sessions: [],
    connections: [],
    storage: [],
    plans: [],
    jobs: [],
  };
}

function serialize(state: ConsoleState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** Refuses to run with a secret that cannot open this directory's secrets. */
function assertKeyMatches(keys: ConsoleKeys, state: ConsoleState): void {
  let plaintext: string | undefined;
  try {
    plaintext = decryptSecret(keys.secrets, state.keyCheck, KEY_CHECK_CONTEXT);
  } catch {
    plaintext = undefined;
  }
  if (plaintext !== KEY_CHECK_PLAINTEXT) {
    throw new StateOpenError(
      "MONGOSHIELD_SECRET does not match the secret this data directory was created with. " +
        "Start the console with the original secret (stored secrets cannot be read without it).",
    );
  }
}

/**
 * Reads and checks console.json; `undefined` when it does not exist yet.
 * Records inside are trusted (the file is ours, mode 0600), but the top-level
 * shape is checked so a truncated or foreign file fails loudly at startup.
 */
async function readStateFile(path: string): Promise<ConsoleState | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StateOpenError(`${path} is not valid JSON. Restore it from a backup of the volume.`);
  }
  if (!isConsoleState(parsed)) {
    throw new StateOpenError(
      `${path} is not a MongoShield console state file of version ${STATE_FORMAT_VERSION}.`,
    );
  }
  return parsed;
}

/** Top-level shape check of a parsed state file. */
function isConsoleState(value: unknown): value is ConsoleState {
  if (typeof value !== "object" || value === null) return false;
  const field = (name: string): unknown => Reflect.get(value, name);
  return (
    field("version") === STATE_FORMAT_VERSION &&
    typeof field("keySalt") === "string" &&
    typeof field("keyCheck") === "string" &&
    ["users", "sessions", "connections", "storage", "plans", "jobs"].every((name) =>
      Array.isArray(field(name)),
    )
  );
}
