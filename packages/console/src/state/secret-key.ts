/**
 * The console's generated secret: `<data>/secret.key`.
 *
 * Every console needs a secret (MONGOSHIELD_SECRET) to derive the key that encrypts
 * the connection strings, storage credentials and backup keys it stores (crypto.ts).
 * Operators who manage secrets pass one in (`MONGOSHIELD_SECRET`, or a file through
 * `MONGOSHIELD_SECRET_FILE` for Docker and Kubernetes secrets). Everyone else gets one
 * generated here on the first start, so `docker run` works without any setup.
 *
 * The rules, in order (see {@link loadOrCreateSecretKey}):
 *
 *   1. `secret.key` exists        → read it; refuse if it is malformed, not a regular
 *                                   file, or readable/writable by other users.
 *   2. `console.json` exists      → refuse: this data directory was created with a
 *      but no `secret.key`          secret passed in by the operator; generating a new
 *                                   one could never open its stored secrets.
 *   3. neither exists             → generate 32 random bytes, write them atomically
 *                                   (temp file + fsync + no-clobber link, mode 0600).
 *
 * The trade-off, documented in docs/console-security.md: the key now lives next to
 * the data it protects. Anyone who can read the volume can read both, so a copy of
 * the volume (a backup of /data) is a copy of every stored secret. Encryption at rest
 * then only protects against leaks of `console.json` alone (support bundles, a stray
 * `cat`), not against theft of the whole volume. Pass your own secret to separate them.
 */

import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { STATE_FILE } from "./store.ts";

/** File name of the generated secret inside the data directory. */
export const SECRET_KEY_FILE = "secret.key";

/** 32 random bytes (256 bits), written as 64 lowercase hex characters. */
const SECRET_BYTES = 32;

/** What a generated secret file contains: exactly 64 hex characters (a newline may follow). */
const SECRET_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Permission bits for "group or others may read, write or run this" (`----rwxrwx`). */
const GROUP_OR_OTHER_BITS = 0o077;

/** Why the secret file could not be used, in words an operator can act on. */
export class SecretKeyError extends Error {
  override readonly name = "SecretKeyError";
}

/** A secret read from, or just written to, `<data>/secret.key`. */
export interface LoadedSecretKey {
  /** The secret itself (64 hex characters). Treat like a password. */
  readonly secret: string;
  /** Absolute path of the file. */
  readonly path: string;
  /** True when this call generated it (first start), false when it already existed. */
  readonly created: boolean;
}

/**
 * Reads the data directory's secret, or generates it on a fresh data directory.
 * Only called when the operator passed no secret (MONGOSHIELD_SECRET or _FILE).
 *
 * @throws SecretKeyError when the file is malformed or too open, or when the data
 *   directory already holds state that was created with an operator's secret.
 */
export async function loadOrCreateSecretKey(dataDir: string): Promise<LoadedSecretKey> {
  // 0700, as StateStore.open would create it: only the console's user looks inside.
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, SECRET_KEY_FILE);

  const existing = await readSecretKey(path);
  if (existing !== undefined) return { secret: existing, path, created: false };

  // No key, but state: a console that ran with MONGOSHIELD_SECRET before. A new key
  // would fail the state's key check anyway; say what is actually wrong instead.
  if (await exists(join(dataDir, STATE_FILE))) {
    throw new SecretKeyError(
      [
        `MONGOSHIELD_SECRET is not set, and ${join(dataDir, STATE_FILE)} was created with one.`,
        "Start the console with the same MONGOSHIELD_SECRET (or MONGOSHIELD_SECRET_FILE) as before:",
        "the connection strings and keys stored in this data directory cannot be read without it.",
      ].join("\n"),
    );
  }

  const created = await createSecretKey(path);
  // Another console may have won the race to create the file (link() refused to
  // overwrite it); then its key is the data directory's key, and we read it.
  if (created !== undefined) return { secret: created, path, created: true };
  const winner = await readSecretKey(path);
  if (winner === undefined) {
    throw new SecretKeyError(`${path} disappeared while the console was creating it.`);
  }
  return { secret: winner, path, created: false };
}

/**
 * Reads and checks an existing secret file; `undefined` when there is none.
 * The checks protect the one thing that guards every stored secret:
 *   - a regular file, not a symlink (which could point anywhere, e.g. outside the volume),
 *   - not accessible to group or others (mode 0600 as created; skipped on Windows,
 *     which has no POSIX modes),
 *   - exactly 64 hex characters (a truncated or edited file fails loudly at startup
 *     instead of deriving a different key).
 */
async function readSecretKey(path: string): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile()) {
    throw new SecretKeyError(
      `${path} must be a regular file (it is a symlink or a directory). Remove it, or pass your own secret with MONGOSHIELD_SECRET_FILE.`,
    );
  }
  if (process.platform !== "win32" && (info.mode & GROUP_OR_OTHER_BITS) !== 0) {
    const mode = (info.mode & 0o777).toString(8).padStart(3, "0");
    throw new SecretKeyError(
      `${path} is readable or writable by other users (mode ${mode}). It protects every stored secret: run \`chmod 600 ${path}\` and start again.`,
    );
  }
  const text = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  if (!SECRET_KEY_PATTERN.test(text)) {
    throw new SecretKeyError(
      `${path} is not a MongoShield secret key (expected 64 hex characters). Restore it from a backup of the volume; without the original key the stored connection strings and backup keys cannot be read.`,
    );
  }
  return text;
}

/**
 * Generates a key and links it into place without ever overwriting an existing file.
 * Returns the new secret, or `undefined` when a file appeared meanwhile.
 *
 * Why temp file + link instead of `open(path, "wx")`: a crash half way through writing
 * would leave a truncated `secret.key`, which the next start would (rightly) refuse.
 * The temp file is complete and fsynced before `link()` makes it visible under its real
 * name, atomically, and `link()` fails with EEXIST instead of replacing a file.
 */
async function createSecretKey(path: string): Promise<string | undefined> {
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  // "wx": the temp name is fresh; 0600: only the console's user may ever read it.
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${secret}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, path);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return undefined;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
  await syncDirectory(path.slice(0, path.length - SECRET_KEY_FILE.length));
  return secret;
}

/** fsyncs a directory so the new link survives a crash (best effort, as in atomic.ts). */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Not supported everywhere (Windows); the link is still atomic.
  } finally {
    await handle?.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, "code") : undefined;
}
