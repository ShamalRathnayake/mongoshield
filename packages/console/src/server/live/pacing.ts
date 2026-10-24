/**
 * Pacing the heavy reads of the data browser (schema samples and exports), per
 * connection, so the console never floods a cluster with them.
 *
 * Why: Atlas Free clusters allow about 100 operations per second (Flex about 500), for
 * every client of the cluster together, the application included. A `$sample` of 200
 * documents or an export of 10,000 is a burst of getMore batches; several of them at
 * once (two browser tabs, a colleague exporting) would eat the application's share and
 * trigger the tier's throttling. So on a shared tier only ONE sample or export runs at a
 * time; on other deployments at most {@link DEFAULT_SLOTS}.
 *
 * Requests over the limit wait their turn, first come first served, for at most
 * {@link MAX_WAIT_MS}; then they fail with `429 CONSOLE_LIVE_BUSY` and a message saying
 * to try again. A waiting request whose browser goes away (its abort signal fires)
 * leaves the queue at once.
 *
 * The pacer is in-memory and per console process, which is the whole deployment: the
 * console runs as a single process.
 */

import { ConsoleError } from "../errors.ts";

/** Samples/exports running at once on an Atlas shared-tier connection. */
export const SHARED_TIER_SLOTS = 1;
/** Samples/exports running at once on any other connection. */
export const DEFAULT_SLOTS = 4;
/** Longest a request waits for its turn before `429`: 30 seconds. */
export const MAX_WAIT_MS = 30_000;

/** Options of a {@link ConnectionPacer} (tests shorten the wait). */
export interface PacerOptions {
  readonly maxWaitMs?: number;
  readonly sharedTierSlots?: number;
  readonly defaultSlots?: number;
}

/** A request waiting for its turn. */
interface Waiter {
  /** How many may run at once for this request's kind of connection. */
  readonly slots: number;
  /** Starts the request (stops its timers and listeners first). */
  readonly grant: () => void;
}

/** The running count and queue of one connection. */
interface Lane {
  active: number;
  readonly waiting: Waiter[];
}

/** The per-connection limiter; see the file header. */
export class ConnectionPacer {
  readonly #lanes = new Map<string, Lane>();
  readonly #maxWaitMs: number;
  readonly #sharedTierSlots: number;
  readonly #defaultSlots: number;

  constructor(options: PacerOptions = {}) {
    this.#maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
    this.#sharedTierSlots = options.sharedTierSlots ?? SHARED_TIER_SLOTS;
    this.#defaultSlots = options.defaultSlots ?? DEFAULT_SLOTS;
  }

  /**
   * Runs `task` when the connection has a free slot, and frees it afterwards (also
   * when the task fails).
   *
   * @param key the connection id.
   * @param sharedTier true for an Atlas shared tier (one slot instead of a few).
   * @param signal the request's abort signal: aborting while waiting leaves the queue
   *   and rejects with the signal's reason.
   */
  async run<T>(
    key: string,
    sharedTier: boolean,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.#acquire(key, sharedTier, signal);
    try {
      return await task();
    } finally {
      this.#release(key);
    }
  }

  /** How many tasks run and wait for a connection (tests and debugging). */
  stateOf(key: string): { readonly active: number; readonly waiting: number } {
    const lane = this.#lanes.get(key);
    return { active: lane?.active ?? 0, waiting: lane?.waiting.length ?? 0 };
  }

  /** Takes a slot now, or queues until one is free (bounded; see the file header). */
  #acquire(key: string, sharedTier: boolean, signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    const slots = sharedTier ? this.#sharedTierSlots : this.#defaultSlots;
    let lane = this.#lanes.get(key);
    if (lane === undefined) {
      lane = { active: 0, waiting: [] };
      this.#lanes.set(key, lane);
    }
    // Nobody queued and a slot free: run at once. (Never jump an existing queue.)
    if (lane.waiting.length === 0 && lane.active < slots) {
      lane.active += 1;
      return Promise.resolve();
    }
    const queue = lane;
    return new Promise<void>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = queue.waiting.indexOf(waiter);
        if (index !== -1) queue.waiting.splice(index, 1);
      };
      const onAbort = () => {
        leave();
        reject(signal?.reason);
      };
      const waiter: Waiter = {
        slots,
        grant: () => {
          leave();
          queue.active += 1;
          resolve();
        },
      };
      const timer = setTimeout(() => {
        leave();
        reject(busyError(sharedTier));
      }, this.#maxWaitMs);
      // A waiting request must never keep the process alive at shutdown.
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.waiting.push(waiter);
    });
  }

  /** Frees a slot and starts the next waiters that now fit. */
  #release(key: string): void {
    const lane = this.#lanes.get(key);
    if (lane === undefined) return;
    lane.active -= 1;
    let next = lane.waiting[0];
    while (next !== undefined && lane.active < next.slots) {
      next.grant(); // removes itself from the queue
      next = lane.waiting[0];
    }
    // An idle connection keeps no state.
    if (lane.active === 0 && lane.waiting.length === 0) this.#lanes.delete(key);
  }
}

/** The `429` of a request that waited too long. */
function busyError(sharedTier: boolean): ConsoleError {
  return new ConsoleError(
    429,
    "CONSOLE_LIVE_BUSY",
    sharedTier
      ? "This Atlas Free/Flex cluster is busy with another sample; try again in a moment."
      : "This connection is busy with other samples and exports; try again in a moment.",
    sharedTier
      ? "Atlas Free and Flex clusters are throttled, so the console reads them one sample or export at a time."
      : undefined,
  );
}
