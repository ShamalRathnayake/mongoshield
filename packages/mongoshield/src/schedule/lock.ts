/**
 * Job locks: making sure only one runner backs up at a time.
 *
 * Scheduled backups often run in several places at once without anyone
 * meaning to: three replicas of an app each start the in-process scheduler, or
 * a Kubernetes CronJob starts a new pod while the old one is still running.
 * Before each run the runner takes a LEASE lock: a lock with an owner and an
 * expiry time. The holder renews it while it works and releases it when done.
 * If the holder dies, the lease simply expires and the next runner takes over.
 *
 *   storage   a lock object next to the backups      (lock-storage.ts)
 *   mongo     a document in `mongoshield.locks`      (lock-mongo.ts)
 *   none      no lock (a single runner, or an external scheduler that never overlaps)
 *
 * This file holds the shared types, the no-op lock, and the renewal loop.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { MongoShieldError } from "../errors.ts";
import { type Logger, silentLogger } from "../logger.ts";

/** Which lock implementation to use; matches `schedule.lock` in the config file. */
export type LockKind = "storage" | "mongo" | "none";

/**
 * How long a lease lasts without renewal. Five minutes is a trade-off: a
 * crashed runner blocks the next one for at most this long, and renewals
 * (every third of it) have plenty of room for slow storage or a short outage.
 */
export const DEFAULT_LEASE_MS = 5 * 60_000;

/** Who is taking a lock. `id` is unique per run, so a restarted process never "owns" an old lease. */
export interface LockOwner {
  /** `<host>:<pid>:<random>`, unique per run. */
  readonly id: string;
  readonly host: string;
  readonly pid: number;
}

/** What a lease says about its holder. Shown when a run is skipped. */
export interface LeaseInfo {
  readonly owner: string;
  readonly host: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
}

/** A lock this runner holds. */
export interface Lease {
  /** The lease as of the last acquire or renewal. */
  readonly info: LeaseInfo;
  /**
   * Extends the lease. Returns `"lost"` when another runner has taken the lock
   * over (the run must stop); throws for transient errors (the caller retries).
   */
  renew(options?: { readonly signal?: AbortSignal }): Promise<"renewed" | "lost">;
  /** Gives the lock up so the next runner need not wait for the expiry. */
  release(): Promise<void>;
}

/** The result of one attempt to take a lock. */
export type AcquireResult =
  | { readonly acquired: true; readonly lease: Lease }
  /** Someone else holds the lock; `holder` describes them when known. */
  | { readonly acquired: false; readonly holder: LeaseInfo | undefined };

/** A lock that can be taken. Every implementation tries exactly once and never waits. */
export interface JobLock {
  readonly kind: LockKind;
  /** Where the lock lives, safe to print (no secrets). */
  readonly location: string;
  tryAcquire(options?: { readonly signal?: AbortSignal }): Promise<AcquireResult>;
}

/** A new owner identity for one run. */
export function createLockOwner(): LockOwner {
  const host = hostname();
  return { id: `${host}:${process.pid}:${randomBytes(4).toString("hex")}`, host, pid: process.pid };
}

/**
 * The lock for `schedule.lock: "none"`: always acquired, nothing to renew.
 * Use it only when nothing else can start the same job (one cron entry, one pod).
 */
export function noLock(owner: LockOwner): JobLock {
  return {
    kind: "none",
    location: "(no lock)",
    async tryAcquire() {
      const now = new Date();
      const info: LeaseInfo = {
        owner: owner.id,
        host: owner.host,
        acquiredAt: now,
        expiresAt: new Date(8.64e15), // the largest Date: never expires
      };
      return {
        acquired: true,
        lease: { info, renew: async () => "renewed", release: async () => {} },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------

/** Options for {@link keepLeaseAlive}. */
export interface KeepAliveOptions {
  /** How often to renew. Use a third of the lease so two renewals can fail before it expires. */
  readonly renewEveryMs: number;
  readonly logger?: Logger;
  /** The current time; for tests. */
  readonly now?: () => Date;
}

/** A running renewal loop. */
export interface LeaseKeeper {
  /** Aborted (with a `MongoShieldError`) when the lease is lost; pass it to the work it protects. */
  readonly lost: AbortSignal;
  /** Stops renewing. Call before releasing the lease. */
  stop(): void;
}

/**
 * Renews `lease` every `renewEveryMs` until stopped.
 *
 * If another runner took the lock over, or renewals keep failing until the
 * lease has expired, the `lost` signal fires so the run stops: carrying on
 * would mean two runners writing at once, which is exactly what the lock exists
 * to prevent. A failed renewal before expiry is only a warning; the next one
 * usually succeeds.
 */
export function keepLeaseAlive(lease: Lease, options: KeepAliveOptions): LeaseKeeper {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const lose = (message: string): void => {
    logger.error(message, { owner: lease.info.owner });
    controller.abort(
      new MongoShieldError("MS_ABORTED", message, {
        hint: "Another runner may be backing up now. Check that the lease is longer than any clock difference between machines, and that storage is reachable.",
      }),
    );
  };

  const renewOnce = async (): Promise<void> => {
    try {
      const outcome = await lease.renew();
      if (outcome === "lost") lose("Lost the backup lock: another runner has taken it over.");
      else logger.debug("Renewed the backup lock", { expiresAt: lease.info.expiresAt });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (now() >= lease.info.expiresAt) {
        lose(`Could not renew the backup lock before it expired: ${reason}`);
      } else {
        logger.warn("Renewing the backup lock failed; will retry", { error: reason });
      }
    }
  };

  // A chain of timeouts rather than setInterval: a slow renewal never overlaps the next one.
  const schedule = (): void => {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(() => {
      void renewOnce().then(schedule);
    }, options.renewEveryMs);
    // The run being protected keeps the process alive; the renewal timer must not.
    timer.unref();
  };
  schedule();

  return {
    lost: controller.signal,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
