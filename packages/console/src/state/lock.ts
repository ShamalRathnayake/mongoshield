/**
 * The single-writer lock on a data directory: `<data>/console.lock`.
 *
 * console.json is rewritten as a whole on every change, so two console processes
 * sharing a volume would silently overwrite each other's changes (lost users,
 * resurrected sessions). The second process must refuse to start instead.
 *
 * Why a heartbeat instead of a PID check: in containers the PID is usually 1 for
 * every incarnation and the host name changes per container, so "is that PID
 * alive?" cannot tell a crashed predecessor from a live neighbour. Instead the
 * holder rewrites the lock file every {@link HEARTBEAT_MS}; a lock whose
 * heartbeat is older than {@link STALE_AFTER_MS} belongs to a process that is
 * gone (crashed, killed, container replaced) and may be taken over.
 *
 * Replacing a container: `docker rm -f` (or a crash) leaves a lock whose heartbeat
 * is still fresh for up to {@link STALE_AFTER_MS}. With `waitForPrevious`, a new
 * console starting in that window waits instead of failing: if the heartbeat stops
 * changing, the previous holder is gone and the lock is taken over once it is stale;
 * if the heartbeat moves, another console is alive and the start is refused.
 *
 * Known limit: two processes that start within the same instant against a
 * stale lock can both take it over. Starting two consoles on one volume at the
 * same moment is an operator error this lock is not meant to arbitrate.
 */

import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** How often the holder proves it is alive. */
export const HEARTBEAT_MS = 10_000;
/** A lock not refreshed for this long is considered abandoned (three missed heartbeats). */
export const STALE_AFTER_MS = 30_000;

/** File name of the lock inside the data directory. */
export const LOCK_FILE = "console.lock";

/** What the lock file records about its holder (for the error message). */
interface LockContent {
  readonly owner: string;
  readonly host: string;
  readonly pid: number;
  readonly heartbeatAt: string;
}

/** A held lock. Call `release()` on shutdown. */
export interface DataDirLock {
  release(): Promise<void>;
}

/** How `acquireDataDirLock` waits for a predecessor's lock to go stale. */
export interface WaitForPrevious {
  /** Called once, when the wait starts, with a message for the log. */
  readonly onWait?: (message: string) => void;
  /** How often the lock file is read again while waiting (default 1 s). */
  readonly pollMs?: number;
}

/** Thrown when another live process holds the data directory. */
export class DataDirLockedError extends Error {
  override readonly name = "DataDirLockedError";
}

/**
 * Takes the data directory lock, or throws {@link DataDirLockedError} if another
 * live console holds it.
 *
 * @param now the clock; tests move it to simulate a stale lock.
 * @param waitForPrevious wait for a fresh lock whose heartbeat does not move (a
 *   console that just crashed or whose container was removed) instead of failing.
 */
export async function acquireDataDirLock(
  dataDir: string,
  options: {
    readonly now?: () => Date;
    readonly heartbeatMs?: number;
    readonly waitForPrevious?: WaitForPrevious;
  } = {},
): Promise<DataDirLock> {
  const now = options.now ?? (() => new Date());
  const path = join(dataDir, LOCK_FILE);
  const owner = randomBytes(8).toString("hex");
  const content = (): LockContent => ({
    owner,
    host: hostname(),
    pid: process.pid,
    heartbeatAt: now().toISOString(),
  });

  const isFresh = (lock: LockContent): boolean => {
    const age = now().getTime() - Date.parse(lock.heartbeatAt);
    return Number.isFinite(age) && age < STALE_AFTER_MS;
  };
  const lockedError = (lock: LockContent) =>
    new DataDirLockedError(
      `Another MongoShield console (pid ${lock.pid} on ${lock.host}) is using ${dataDir}.`,
    );

  let existing = await readLock(path);
  if (existing !== undefined && isFresh(existing)) {
    const wait = options.waitForPrevious;
    if (wait === undefined) throw lockedError(existing);
    // The heartbeat as first seen: a live holder rewrites it within HEARTBEAT_MS.
    const seen = existing;
    // A dead holder's lock goes stale within STALE_AFTER_MS; one poll of slack.
    const pollMs = wait.pollMs ?? 1_000;
    const deadline = now().getTime() + STALE_AFTER_MS + pollMs;
    wait.onWait?.(
      `The data directory ${dataDir} was in use moments ago (pid ${seen.pid} on ${seen.host}). ` +
        `Waiting up to ${Math.ceil(STALE_AFTER_MS / 1000)} s for that console to let go…`,
    );
    while (existing !== undefined && isFresh(existing)) {
      const refreshed = existing.owner !== seen.owner || existing.heartbeatAt !== seen.heartbeatAt;
      // Past the deadline: a heartbeat from the future (a skewed clock) never goes stale.
      if (refreshed || now().getTime() > deadline) throw lockedError(existing);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      existing = await readLock(path);
    }
  }

  if (existing === undefined) {
    // Create-if-absent: of two processes starting on an empty directory, one wins.
    try {
      await writeFile(path, `${JSON.stringify(content())}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new DataDirLockedError(`Another MongoShield console is starting in ${dataDir}.`);
      }
      throw error;
    }
  } else {
    // Taking over an abandoned lock: replace it atomically.
    await writeFileAtomic(path, `${JSON.stringify(content())}\n`);
  }

  // The heartbeat in flight, if any. release() waits for it: a write that
  // finished after the lock file was deleted would recreate it, and the next
  // start would then wait for a lock nobody holds.
  let heartbeat: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(() => writeFileAtomic(path, `${JSON.stringify(content())}\n`))
      .catch(() => undefined);
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  // The heartbeat alone must never keep the process alive.
  timer.unref();

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await heartbeat;
      // Only delete the lock if it is still ours (a takeover may have happened).
      const current = await readLock(path);
      if (current?.owner === owner) await rm(path, { force: true });
    },
  };
}

/** Reads the lock file; `undefined` if it is missing. Garbage counts as an abandoned lock. */
async function readLock(path: string): Promise<LockContent | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof Reflect.get(parsed, "owner") === "string" &&
      typeof Reflect.get(parsed, "heartbeatAt") === "string"
    ) {
      return {
        owner: String(Reflect.get(parsed, "owner")),
        host: String(Reflect.get(parsed, "host")),
        pid: Number(Reflect.get(parsed, "pid")),
        heartbeatAt: String(Reflect.get(parsed, "heartbeatAt")),
      };
    }
  } catch {
    // Fall through: unreadable.
  }
  return { owner: "", host: "unknown", pid: 0, heartbeatAt: new Date(0).toISOString() };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "EEXIST";
}
