/**
 * A lease lock stored next to the backups, built only on `put` with
 * `ifNoneMatch: "*"` (create-if-absent), which every object store offers.
 *
 * ## Why numbered lock objects instead of one `locks/backup.json`
 *
 * Taking over an EXPIRED lease is the hard part. With a single object it means
 * "delete the stale lock, then create mine", and two runners can interleave:
 *
 *   A sees the lease expired        B sees the lease expired
 *   A deletes it, creates its own
 *                                   B deletes A's FRESH lock, creates its own
 *   → both think they hold the lock
 *
 * Fixing that needs a conditional delete or replace (If-Match), which the
 * storage interface does not have. So each lease gets its own object, numbered
 * by a generation counter, and nobody ever deletes or overwrites someone else's
 * current lease:
 *
 *   locks/backup/00000000000000000041.json   ← expired or released
 *   locks/backup/00000000000000000042.json   ← the current lease (highest number)
 *
 * Acquiring: list, read the highest generation N. If it is live, the lock is
 * busy. Otherwise create N+1 with `ifNoneMatch: "*"`: of several runners
 * racing for N+1, the store lets exactly one create it. Then list once more: a
 * runner that acted on a stale listing may have created a LOWER number than the
 * real current lease; seeing a higher number, it deletes its own and backs off.
 * Finally, generations below N+1 are deleted (best effort; they are dead).
 *
 * Renewing rewrites the holder's own object (nobody else writes it), then
 * checks that no higher generation exists; if one does, the lease was lost.
 * Releasing marks the object as released rather than deleting it, so the
 * counter never goes backwards.
 *
 * Expiry compares the holder's clock (written into the lease) with the
 * reader's. Keep the lease (5 minutes by default) far longer than any clock
 * difference between machines; NTP-synced hosts differ by milliseconds.
 */

import { z } from "zod";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import { type Logger, silentLogger } from "../logger.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { readStreamToBuffer } from "../util/streams.ts";
import type { AcquireResult, JobLock, Lease, LeaseInfo, LockOwner } from "./lock.ts";

/** Options for {@link storageLock}. */
export interface StorageLockOptions {
  readonly storage: StorageAdapter;
  readonly owner: LockOwner;
  readonly leaseMs: number;
  /** Lock name: one lock per name. Defaults to `"backup"`. */
  readonly name?: string;
  readonly logger?: Logger;
  /** The current time; for tests. */
  readonly now?: () => Date;
}

/** Lock objects live under `locks/<name>/`, away from `backups/`. */
const LOCKS_PREFIX = "locks/";

/** 20 digits holds any safe integer, and zero-padding makes key order numeric order. */
const GENERATION_DIGITS = 20;
const GENERATION_FILE = /^(\d{20})\.json$/;

/** Lock objects are tiny; anything bigger is not one of ours. */
const MAX_LOCK_BYTES = 64 * 1024;

/** The JSON stored in each lock object. */
const LockRecordSchema = z.object({
  formatVersion: z.literal(1),
  owner: z.string(),
  host: z.string(),
  pid: z.number().int(),
  generation: z.number().int().positive(),
  acquiredAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  /** True once the holder gave the lock up; the next runner need not wait for expiry. */
  released: z.boolean(),
});
type LockRecord = z.infer<typeof LockRecordSchema>;

/**
 * A lock stored in `storage`.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when the adapter cannot do
 *   conditional writes: without them two runners could both "create" the lock.
 */
export function storageLock(options: StorageLockOptions): JobLock {
  const { storage, owner, leaseMs } = options;
  const name = options.name ?? "backup";
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());

  if (!storage.capabilities.conditionalWrites) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The ${storage.kind} storage adapter cannot do conditional writes, so it cannot hold a backup lock.`,
      {
        hint: 'Set schedule.lock to "mongo" (a lock document in the source database) or "none" if only one runner can ever start.',
      },
    );
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Invalid lock name "${name}".`, {
      hint: "Use lowercase letters, digits and dashes.",
    });
  }

  const prefix = `${LOCKS_PREFIX}${name}/`;
  const keyOf = (generation: number): string =>
    `${prefix}${String(generation).padStart(GENERATION_DIGITS, "0")}.json`;

  /** Every generation number present, ascending. */
  async function listGenerations(signal: AbortSignal | undefined): Promise<number[]> {
    const generations: number[] = [];
    for await (const object of storage.list(prefix, signal ? { signal } : {})) {
      const match = GENERATION_FILE.exec(object.key.slice(prefix.length));
      if (match?.[1]) generations.push(Number(match[1]));
    }
    return generations.sort((a, b) => a - b);
  }

  /** Reads a lock object; `undefined` if it vanished. Unreadable content is reported as such. */
  async function readRecord(
    generation: number,
    signal: AbortSignal | undefined,
  ): Promise<LockRecord | "unreadable" | undefined> {
    let bytes: Buffer;
    try {
      const body = await storage.get(keyOf(generation), signal ? { signal } : {});
      bytes = await readStreamToBuffer(body, { maxBytes: MAX_LOCK_BYTES });
    } catch (error) {
      if (isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")) return undefined;
      if (isMongoShieldError(error, "MS_INTEGRITY_FAILED")) return "unreadable";
      throw error;
    }
    try {
      const parsed = LockRecordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      return parsed.success ? parsed.data : "unreadable";
    } catch {
      return "unreadable";
    }
  }

  async function writeRecord(record: LockRecord, conditional: boolean): Promise<void> {
    await storage.put(keyOf(record.generation), Buffer.from(`${JSON.stringify(record)}\n`), {
      contentType: "application/json",
      ...(conditional ? { ifNoneMatch: "*" as const } : {}),
    });
  }

  function recordFor(generation: number, acquiredAt: Date): LockRecord {
    return {
      formatVersion: 1,
      owner: owner.id,
      host: owner.host,
      pid: owner.pid,
      generation,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(now().getTime() + leaseMs).toISOString(),
      released: false,
    };
  }

  /** Deletes generations below `generation`. They are dead; failing to delete them is harmless. */
  async function deleteOlder(generation: number, existing: readonly number[]): Promise<void> {
    const older = existing.filter((value) => value < generation).map(keyOf);
    if (older.length === 0) return;
    try {
      await storage.delete(older);
    } catch (error) {
      logger.debug("Could not delete old lock objects", { error: String(error) });
    }
  }

  function leaseFor(initial: LockRecord): Lease {
    let current = initial;
    return {
      get info() {
        return toLeaseInfo(current);
      },

      async renew(renewOptions = {}) {
        // Once our own lease has expired, another runner may legitimately have
        // taken over; rewriting our object would not undo that, so give up.
        if (now() >= new Date(current.expiresAt)) return "lost";
        const renewed = {
          ...current,
          expiresAt: new Date(now().getTime() + leaseMs).toISOString(),
        };
        await writeRecord(renewed, false);
        current = renewed;
        const generations = await listGenerations(renewOptions.signal);
        return generations.some((value) => value > current.generation) ? "lost" : "renewed";
      },

      async release() {
        await writeRecord({ ...current, released: true, expiresAt: now().toISOString() }, false);
      },
    };
  }

  return {
    kind: "storage",
    location: `${storage.location}${prefix}`,

    async tryAcquire(acquireOptions = {}): Promise<AcquireResult> {
      const { signal } = acquireOptions;
      const generations = await listGenerations(signal);
      const latest = generations.at(-1);

      if (latest !== undefined) {
        const record = await readRecord(latest, signal);
        // An unreadable lock may have been written by a newer release; never
        // take it over automatically.
        if (record === "unreadable") {
          throw new MongoShieldError(
            "MS_CONFIG_INVALID",
            `The lock object ${keyOf(latest)} cannot be read.`,
            {
              hint: "If no backup is running, delete that object and try again.",
            },
          );
        }
        if (record !== undefined && !record.released && new Date(record.expiresAt) > now()) {
          return { acquired: false, holder: toLeaseInfo(record) };
        }
      }

      const generation = (latest ?? 0) + 1;
      const record = recordFor(generation, now());
      try {
        await writeRecord(record, true);
      } catch (error) {
        if (!isMongoShieldError(error, "MS_STORAGE_PRECONDITION_FAILED")) throw error;
        // Another runner created this generation first.
        const winner = await readRecord(generation, signal);
        return {
          acquired: false,
          holder: typeof winner === "object" ? toLeaseInfo(winner) : undefined,
        };
      }

      // Our listing may have been stale (see the file header): back off if a
      // higher generation exists.
      const after = await listGenerations(signal);
      const higher = after.find((value) => value > generation);
      if (higher !== undefined) {
        await storage.delete([keyOf(generation)]).catch(() => undefined);
        const holder = await readRecord(higher, signal);
        return {
          acquired: false,
          holder: typeof holder === "object" ? toLeaseInfo(holder) : undefined,
        };
      }

      await deleteOlder(generation, after);
      logger.debug("Acquired the storage lock", { key: keyOf(generation) });
      return { acquired: true, lease: leaseFor(record) };
    },
  };
}

function toLeaseInfo(record: LockRecord): LeaseInfo {
  return {
    owner: record.owner,
    host: record.host,
    acquiredAt: new Date(record.acquiredAt),
    expiresAt: new Date(record.expiresAt),
  };
}
