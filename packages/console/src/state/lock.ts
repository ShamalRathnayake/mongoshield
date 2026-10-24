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

/** Thrown when another live process holds the data directory. */
export class DataDirLockedError extends Error {
  override readonly name = "DataDirLockedError";
}

/**
 * Takes the data directory lock, or throws {@link DataDirLockedError} if another
 * live console holds it.
 *
 * @param now the clock; tests move it to simulate a stale lock.
 */
export async function acquireDataDirLock(
  dataDir: string,
  options: { readonly now?: () => Date; readonly heartbeatMs?: number } = {},
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

  const existing = await readLock(path);
  if (existing !== undefined) {
    const age = now().getTime() - Date.parse(existing.heartbeatAt);
    if (Number.isFinite(age) && age < STALE_AFTER_MS) {
      throw new DataDirLockedError(
        `Another MongoShield console (pid ${existing.pid} on ${existing.host}) is using ${dataDir}.`,
      );
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

  const timer = setInterval(() => {
    writeFileAtomic(path, `${JSON.stringify(content())}\n`).catch(() => undefined);
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  // The heartbeat alone must never keep the process alive.
  timer.unref();

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
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
