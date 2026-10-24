/**
 * A lease lock kept as one document in the SOURCE deployment:
 *
 *   mongoshield.locks  { _id: "backup", owner, host, pid, acquiredAt, expiresAt }
 *
 * MongoDB updates a single document atomically, so the whole protocol is one
 * `findOneAndUpdate` per step, with no race windows:
 *
 *   acquire  upsert the document with a pipeline update that takes the lease
 *            over only IF it has expired (otherwise it rewrites the current
 *            values unchanged), then look at who owns it: us, or someone else.
 *            (A conditional filter would be simpler, but MongoDB does not allow
 *            `$expr`, which server-side time needs, in an upsert's filter.)
 *   renew    extend `expiresAt` IF we are still the owner.
 *   release  delete the document IF we are still the owner.
 *
 * All times come from the server (`$$NOW`), so clock differences between the
 * machines running backups do not matter. Writes use majority write concern so
 * a failover cannot forget a lock that was granted.
 *
 * Note: this WRITES to the deployment being backed up. The backup user needs
 * `readWrite` on the `mongoshield` database, and you may want to exclude
 * `mongoshield.*` from backups. Use the storage lock to keep backups read-only.
 */

import {
  type Collection,
  type MongoClient,
  MongoNetworkError,
  MongoServerError,
  MongoServerSelectionError,
} from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { type Logger, silentLogger } from "../logger.ts";
import type { AcquireResult, JobLock, Lease, LeaseInfo, LockOwner } from "./lock.ts";

/** Where lock documents live. */
export const MONGO_LOCK_DATABASE = "mongoshield";
export const MONGO_LOCK_COLLECTION = "locks";

/** Server error code for a unique index violation. */
const DUPLICATE_KEY = 11000;

/** Server error code for "not authorized". */
const UNAUTHORIZED = 13;

/** Options for {@link mongoLock}. */
export interface MongoLockOptions {
  /** A connected client for the source deployment. The lock never closes it. */
  readonly client: MongoClient;
  readonly owner: LockOwner;
  readonly leaseMs: number;
  /** Lock name, used as the document `_id`. Defaults to `"backup"`. */
  readonly name?: string;
  readonly logger?: Logger;
}

/** The lock document. */
interface LockDocument {
  _id: string;
  owner: string;
  host: string;
  pid: number;
  acquiredAt: Date;
  expiresAt: Date;
}

/** A lock stored in `mongoshield.locks` on the source deployment. */
export function mongoLock(options: MongoLockOptions): JobLock {
  const { owner, leaseMs } = options;
  const name = options.name ?? "backup";
  const logger = options.logger ?? silentLogger;
  const collection: Collection<LockDocument> = options.client
    .db(MONGO_LOCK_DATABASE)
    .collection<LockDocument>(MONGO_LOCK_COLLECTION);
  const writeConcern = { w: "majority" as const };

  /** `$$NOW + leaseMs`, evaluated on the server. */
  const expiryExpression = { $add: ["$$NOW", leaseMs] };

  function leaseFor(initial: LockDocument): Lease {
    let current = toLeaseInfo(initial);
    return {
      get info() {
        return current;
      },

      async renew() {
        const updated = await collection
          .findOneAndUpdate(
            { _id: name, owner: owner.id },
            [{ $set: { expiresAt: expiryExpression } }],
            { returnDocument: "after", writeConcern },
          )
          .catch(rethrowTyped);
        // No match: the lease expired and another runner took it over.
        if (updated === null) return "lost";
        current = toLeaseInfo(updated);
        return "renewed";
      },

      async release() {
        await collection
          .deleteOne({ _id: name, owner: owner.id }, { writeConcern })
          .catch(rethrowTyped);
      },
    };
  }

  return {
    kind: "mongo",
    location: `${MONGO_LOCK_DATABASE}.${MONGO_LOCK_COLLECTION} (_id "${name}")`,

    async tryAcquire(): Promise<AcquireResult> {
      let document: LockDocument | null;
      try {
        document = await collection.findOneAndUpdate(
          { _id: name },
          takeoverPipeline(owner, expiryExpression),
          { upsert: true, returnDocument: "after", writeConcern },
        );
      } catch (error) {
        // Two runners upserting a missing document at the same moment: one
        // insert wins, the other hits the unique _id index. The winner holds it.
        if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
          const holder = await collection.findOne({ _id: name }).catch(rethrowTyped);
          return { acquired: false, holder: holder === null ? undefined : toLeaseInfo(holder) };
        }
        rethrowTyped(error);
      }
      if (document === null)
        throw new MongoShieldError("MS_INTERNAL", "The lock upsert returned nothing.");
      if (document.owner !== owner.id) return { acquired: false, holder: toLeaseInfo(document) };
      logger.debug("Acquired the MongoDB lock", { lock: name });
      return { acquired: true, lease: leaseFor(document) };
    },
  };
}

/**
 * The update that takes the lease over when it has expired and leaves it
 * untouched otherwise. Stage 1 decides once (`$$NOW` is fixed for the whole
 * update); stage 2 picks our values or the current ones; stage 3 drops the flag.
 * A missing `expiresAt` (a brand-new document) compares lower than any date,
 * so it counts as expired.
 */
function takeoverPipeline(owner: LockOwner, expiryExpression: Record<string, unknown>) {
  const ours = (value: unknown, field: string) => ({
    $cond: ["$_mongoshieldTakeover", value, `$${field}`],
  });
  return [
    { $set: { _mongoshieldTakeover: { $lte: ["$expiresAt", "$$NOW"] } } },
    {
      $set: {
        // $literal: values starting with "$" would otherwise be read as field paths.
        owner: ours({ $literal: owner.id }, "owner"),
        host: ours({ $literal: owner.host }, "host"),
        pid: ours({ $literal: owner.pid }, "pid"),
        acquiredAt: ours("$$NOW", "acquiredAt"),
        expiresAt: ours(expiryExpression, "expiresAt"),
      },
    },
    { $unset: "_mongoshieldTakeover" },
  ];
}

function toLeaseInfo(document: LockDocument): LeaseInfo {
  return {
    owner: document.owner,
    host: document.host,
    acquiredAt: document.acquiredAt,
    expiresAt: document.expiresAt,
  };
}

/** Turns driver errors into typed errors; a missing privilege gets a specific hint. */
function rethrowTyped(error: unknown): never {
  if (error instanceof MongoShieldError) throw error;
  if (error instanceof MongoServerError && error.code === UNAUTHORIZED) {
    throw new MongoShieldError(
      "MS_PERMISSION_DENIED",
      `MongoDB refused to write the backup lock to ${MONGO_LOCK_DATABASE}.${MONGO_LOCK_COLLECTION}.`,
      {
        cause: error,
        hint: `Grant readWrite on the "${MONGO_LOCK_DATABASE}" database, or set schedule.lock to "storage".`,
      },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  // Network trouble is worth retrying; anything else is not.
  const lostConnection =
    error instanceof MongoNetworkError || error instanceof MongoServerSelectionError;
  throw new MongoShieldError(
    lostConnection ? "MS_CONNECTION_FAILED" : "MS_INTERNAL",
    `The backup lock could not be updated: ${message}`,
    { cause: error },
  );
}
