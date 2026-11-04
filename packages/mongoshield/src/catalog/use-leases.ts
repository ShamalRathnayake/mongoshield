/**
 * Use leases: "this backup is being read (or written) right now, do not prune it".
 *
 * Retention could otherwise delete a backup in the middle of a restore: a drop-mode
 * restore of a week-old backup has dropped the live collections and is loading them
 * when the hourly job's prune decides the backup is no longer needed. The same goes for
 * a verify or drill reading it, and for a backup run still uploading (a single large
 * object can take hours without a visible write, so an incomplete run looks abandoned).
 *
 * Every restore, verify and drill (and every backup run, for its own incomplete
 * directory) holds a lease while it works:
 *
 *   annotations/<backup id>/leases/<purpose>-<random>.json
 *     { backupId, purpose, owner, host, pid, acquiredAt, expiresAt }
 *
 * They are shared, not exclusive: any number of readers may hold one at once, and
 * nothing waits for them; prune simply keeps a backup with a live lease (and, through
 * the chain rule, everything it depends on). A lease is the scheduler's lock lease
 * (schedule/lock.ts) in another place: it expires on its own after `leaseMs` if its
 * holder dies, and `keepLeaseAlive` renews it every third of that while the work runs.
 * It is deleted when the work ends.
 *
 * Losing a lease (storage unreachable for longer than the lease) does not stop the
 * work it protects; the work fails on its own if storage stays away, and otherwise the
 * next renewal writes the lease again.
 *
 * Leases live with the other annotations, outside `backups/<id>/`, so a backup
 * directory stays a plain mongodump layout. Old releases ignore them.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { isMongoShieldError } from "../errors.ts";
import { type Logger, silentLogger } from "../logger.ts";
import {
  createLockOwner,
  DEFAULT_LEASE_MS,
  keepLeaseAlive,
  type Lease,
  type LockOwner,
} from "../schedule/lock.ts";
import type { ObjectInfo, StorageAdapter } from "../storage/types.ts";
import { readStreamToBuffer } from "../util/streams.ts";
import { ANNOTATIONS_PREFIX } from "./annotations.ts";

/** What a lease protects the backup for. */
export type UseLeasePurpose = "restore" | "verify" | "drill" | "backup";

/** Leases are tiny; anything bigger is not one of ours. */
const MAX_LEASE_BYTES = 64 * 1024;

export const UseLeaseRecordSchema = z.object({
  backupId: z.string(),
  purpose: z.enum(["restore", "verify", "drill", "backup"]),
  owner: z.string(),
  host: z.string(),
  pid: z.number().int(),
  acquiredAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});

/** One stored lease (see {@link UseLeaseRecordSchema}). */
export type UseLeaseRecord = z.infer<typeof UseLeaseRecordSchema>;

/** Where one backup's leases live. */
export function useLeasesPrefix(backupId: string): string {
  return `${ANNOTATIONS_PREFIX}${backupId}/leases/`;
}

/** Options for {@link acquireUseLease} and {@link withUseLease}. */
export interface UseLeaseOptions {
  /** How long a lease lasts without renewal. Defaults to the lock lease, 5 minutes. */
  readonly leaseMs?: number;
  readonly owner?: LockOwner;
  readonly logger?: Logger;
  /** The current time; for tests. */
  readonly now?: () => Date;
}

/**
 * Writes a lease on `backupId` and returns it (renew it, then release it).
 *
 * @throws MongoShieldError from storage when the lease cannot be written.
 */
export async function acquireUseLease(
  storage: StorageAdapter,
  backupId: string,
  purpose: UseLeasePurpose,
  options: UseLeaseOptions = {},
): Promise<Lease> {
  const owner = options.owner ?? createLockOwner();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? (() => new Date());
  // A random name per lease: owner ids hold ":" and several leases may share a process.
  const key = `${useLeasesPrefix(backupId)}${purpose}-${randomBytes(8).toString("hex")}.json`;
  const acquiredAt = now();
  let record: UseLeaseRecord = {
    backupId,
    purpose,
    owner: owner.id,
    host: owner.host,
    pid: owner.pid,
    acquiredAt: acquiredAt.toISOString(),
    expiresAt: new Date(acquiredAt.getTime() + leaseMs).toISOString(),
  };
  const write = async (value: UseLeaseRecord): Promise<void> => {
    const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    await storage.put(key, body, { contentType: "application/json", sizeHint: body.length });
  };
  await write(record);

  // A renewal and the release can overlap: the background renewal may be halfway
  // through its write when the work ends. Deleting first and letting that write land
  // afterwards would leave a lease nobody renews or deletes, keeping the backup "in
  // use" until it expires. So the release waits for the write in flight, and once
  // released, a renewal writes nothing.
  let released = false;
  let renewing: Promise<void> | undefined;

  return {
    get info() {
      return {
        owner: record.owner,
        host: record.host,
        acquiredAt: new Date(record.acquiredAt),
        expiresAt: new Date(record.expiresAt),
      };
    },
    async renew() {
      // Released already: writing now would bring the deleted lease back.
      if (released) return "renewed";
      // Nobody else writes this object, so a renewal never "loses" it to another holder.
      const renewed = { ...record, expiresAt: new Date(now().getTime() + leaseMs).toISOString() };
      const writing = write(renewed);
      renewing = writing;
      try {
        await writing;
      } finally {
        if (renewing === writing) renewing = undefined;
      }
      record = renewed;
      return "renewed";
    },
    async release() {
      released = true;
      // Its outcome does not matter (the lease is going), only that it has landed.
      await renewing?.catch(() => {});
      await storage.delete([key]);
    },
  };
}

/**
 * Runs `task` while holding a lease on each of `backupIds` (renewed in the background),
 * and releases them afterwards, also when `task` fails. Releasing is best effort: a
 * lease that cannot be deleted simply expires.
 *
 * Storage that refuses the write (read-only credentials, a read-only mount) does not
 * stop the task: reading a backup must keep working where nobody may write. A warning
 * says the backup is not protected from a concurrent prune.
 *
 * @throws whatever `task` throws.
 */
export async function withUseLease<T>(
  storage: StorageAdapter,
  backupIds: readonly string[],
  purpose: UseLeasePurpose,
  options: UseLeaseOptions,
  task: () => Promise<T>,
): Promise<T> {
  const held: HeldUseLease[] = [];
  try {
    for (const backupId of new Set(backupIds)) {
      held.push(await holdUseLease(storage, backupId, purpose, options));
    }
    return await task();
  } finally {
    for (const lease of held) await lease.release();
  }
}

/** A lease being renewed in the background (see {@link holdUseLease}). */
export interface HeldUseLease {
  /** Stops renewing and deletes the lease (best effort: a leftover lease expires). */
  release(): Promise<void>;
}

/**
 * Writes a lease on `backupId` and renews it every third of its length until
 * `release()`. For work that cannot be wrapped in a callback (a backup run, which
 * releases in its own `finally`). Storage refusals only log a warning, as in
 * {@link withUseLease}.
 */
export async function holdUseLease(
  storage: StorageAdapter,
  backupId: string,
  purpose: UseLeasePurpose,
  options: UseLeaseOptions = {},
): Promise<HeldUseLease> {
  const logger = options.logger ?? silentLogger;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  let lease: Lease;
  try {
    lease = await acquireUseLease(storage, backupId, purpose, options);
  } catch (error) {
    if (!isStorageRefusal(error)) throw error;
    logger.warn(
      "Could not mark the backup as in use; a prune running at the same time could delete it",
      { backupId, error: error instanceof Error ? error.message : String(error) },
    );
    return { release: async () => {} };
  }
  const keeper = keepLeaseAlive(lease, {
    renewEveryMs: leaseMs / 3,
    logger,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    async release() {
      // No new renewals; `lease.release()` waits for one already writing (see
      // acquireUseLease), so the delete is the last write to the lease.
      keeper.stop();
      await lease.release().catch((error: unknown) => {
        logger.debug("Could not release a use lease; it will expire", { error: String(error) });
      });
    },
  };
}

/**
 * The live (unexpired) leases on a backup. Unreadable lease files count as live until
 * they are older than a lease could be, so a damaged one protects rather than exposes.
 *
 * @throws MongoShieldError from storage listings.
 */
export async function liveUseLeases(
  storage: StorageAdapter,
  backupId: string,
  options: { readonly signal?: AbortSignal | undefined; readonly now?: Date } = {},
): Promise<UseLeaseRecord[]> {
  const now = (options.now ?? new Date()).getTime();
  const signalOption = options.signal ? { signal: options.signal } : {};
  const live: UseLeaseRecord[] = [];
  for await (const object of storage.list(useLeasesPrefix(backupId), signalOption)) {
    const record = await liveLeaseOf(storage, object, backupId, now, signalOption);
    if (record !== undefined) live.push(record);
  }
  return live;
}

/**
 * The live leases of every backup in the location, by backup id (backups without
 * one are absent). One listing of `annotations/` instead of one per backup, for
 * callers that look at many backups at once (prune plans over the whole catalog).
 * The same rules as {@link liveUseLeases} decide what is live.
 *
 * @throws MongoShieldError from storage listings.
 */
export async function liveUseLeasesByBackup(
  storage: StorageAdapter,
  options: { readonly signal?: AbortSignal | undefined; readonly now?: Date } = {},
): Promise<Map<string, UseLeaseRecord[]>> {
  const now = (options.now ?? new Date()).getTime();
  const signalOption = options.signal ? { signal: options.signal } : {};
  // Collect the lease files first: the listing also holds every other annotation
  // (verification records, holds), which are skipped by their key alone.
  const leaseFiles: { readonly backupId: string; readonly object: ObjectInfo }[] = [];
  for await (const object of storage.list(ANNOTATIONS_PREFIX, signalOption)) {
    const backupId = leaseOwnerOf(object.key);
    if (backupId !== undefined) leaseFiles.push({ backupId, object });
  }
  const byBackup = new Map<string, UseLeaseRecord[]>();
  for (const { backupId, object } of leaseFiles) {
    const record = await liveLeaseOf(storage, object, backupId, now, signalOption);
    if (record === undefined) continue;
    const leases = byBackup.get(backupId);
    if (leases === undefined) byBackup.set(backupId, [record]);
    else leases.push(record);
  }
  return byBackup;
}

/**
 * The backup id of a lease file's key (`annotations/<id>/leases/<name>`), or
 * `undefined` for any other annotation.
 */
function leaseOwnerOf(key: string): string | undefined {
  if (!key.startsWith(ANNOTATIONS_PREFIX)) return undefined;
  const rest = key.slice(ANNOTATIONS_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const backupId = rest.slice(0, slash);
  return key.startsWith(useLeasesPrefix(backupId)) ? backupId : undefined;
}

/**
 * One lease file's lease if it is live, else `undefined` (expired, or released
 * between the listing and the read). An unreadable file counts as live until it
 * is older than a lease could be, so a damaged one protects rather than exposes.
 */
async function liveLeaseOf(
  storage: StorageAdapter,
  object: ObjectInfo,
  backupId: string,
  now: number,
  signalOption: { readonly signal?: AbortSignal },
): Promise<UseLeaseRecord | undefined> {
  const record = await readLease(storage, object.key, signalOption);
  if (record === "missing") return undefined;
  if (record === "unreadable") {
    // A lease is rewritten at least every third of its length: one untouched for
    // longer than the default lease is dead whatever it says.
    if (now - object.lastModified.getTime() < DEFAULT_LEASE_MS) {
      return unreadableLease(backupId, object.lastModified);
    }
    return undefined;
  }
  return Date.parse(record.expiresAt) > now ? record : undefined;
}

/** Storage errors that mean "you may not write here", not "storage is broken". */
function isStorageRefusal(error: unknown): boolean {
  return (
    isMongoShieldError(error, "MS_STORAGE_FORBIDDEN") ||
    isMongoShieldError(error, "MS_STORAGE_IO") ||
    isMongoShieldError(error, "MS_STORAGE_INSUFFICIENT_SPACE") ||
    isMongoShieldError(error, "MS_CONFIG_INVALID")
  );
}

/** `"restore on host-a"`, for retention's keep reasons. */
export function describeUseLeases(leases: readonly UseLeaseRecord[]): string {
  const parts = leases.map((lease) => `${lease.purpose} on ${lease.host}`);
  return [...new Set(parts)].join(", ");
}

async function readLease(
  storage: StorageAdapter,
  key: string,
  signalOption: { readonly signal?: AbortSignal },
): Promise<UseLeaseRecord | "missing" | "unreadable"> {
  let bytes: Buffer;
  try {
    bytes = await readStreamToBuffer(await storage.get(key, signalOption), {
      maxBytes: MAX_LEASE_BYTES,
    });
  } catch (error) {
    // Released between the listing and the read.
    if (isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")) return "missing";
    if (isMongoShieldError(error, "MS_INTEGRITY_FAILED")) return "unreadable";
    throw error;
  }
  try {
    const parsed = UseLeaseRecordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data : "unreadable";
  } catch {
    return "unreadable";
  }
}

function unreadableLease(backupId: string, modified: Date): UseLeaseRecord {
  return {
    backupId,
    purpose: "restore",
    owner: "unknown",
    host: "an unreadable lease file",
    pid: 0,
    acquiredAt: modified.toISOString(),
    expiresAt: new Date(modified.getTime() + DEFAULT_LEASE_MS).toISOString(),
  };
}
