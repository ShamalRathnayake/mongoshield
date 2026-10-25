/**
 * Read throttling for backups (`maxDocumentsPerSecond`, `maxBytesPerSecond`), so a
 * backup can run against production without eating its I/O budget.
 *
 *   cursor → count → THROTTLE → coalesce → compress → … → storage
 *
 * The throttle is a pass-through stream that holds back each document until the
 * limiter allows it. Holding a document back stops the stream from reading the
 * next one, and backpressure carries that all the way to the cursor, which then
 * asks the server for its next batch later. The server therefore only does the work
 * we actually consume; nothing piles up in memory.
 *
 * One limiter is shared by every part dumped at the same time, so the limits apply
 * to the backup as a whole, not per collection.
 */

import { Transform, type TransformCallback } from "node:stream";

/**
 * Sleeping is only worth it once the debt reaches this many milliseconds: timers
 * have about 1 ms resolution, so sleeping for every single document of a fast
 * collection would cap throughput far below the limit. Smaller debts are carried
 * over (the bucket still charges for them) and paid with the next sleep.
 */
export const MIN_SLEEP_MS = 5;

/** How far ahead of the average rate a reader may run (a short burst), in ms. */
export const DEFAULT_BURST_MS = 250;

/**
 * A token bucket in its "virtual scheduling" form (GCRA): instead of counting
 * tokens, it remembers the theoretical time at which everything taken so far would
 * have been paid for at `ratePerSecond`. Taking `cost` tokens pushes that time
 * forward by `cost / rate`; the caller must wait for however far it lies beyond
 * `now + burst`. This is exact for any mix of costs and callers and needs no timer.
 */
export class TokenBucket {
  readonly #msPerToken: number;
  readonly #burstMs: number;
  readonly #now: () => number;
  /** When everything taken so far is paid for (the "theoretical arrival time"). */
  #paidUntil = Number.NEGATIVE_INFINITY;

  /**
   * @param ratePerSecond tokens per second, a positive finite number.
   * @param options.burstMs how far ahead of the rate callers may run; defaults to 250 ms.
   * @param options.now clock in milliseconds; for tests.
   */
  constructor(
    ratePerSecond: number,
    options: { readonly burstMs?: number; readonly now?: () => number } = {},
  ) {
    this.#msPerToken = 1000 / ratePerSecond;
    this.#burstMs = options.burstMs ?? DEFAULT_BURST_MS;
    this.#now = options.now ?? (() => performance.now());
  }

  /**
   * Takes `cost` tokens and returns how many milliseconds the caller should wait
   * before going on (0 when it may go on right away). The tokens are charged either
   * way, so callers that ignore a small wait simply pay for it later.
   */
  take(cost: number): number {
    const now = this.#now();
    // An idle bucket does not save up more than the burst allows.
    const start = Math.max(this.#paidUntil, now);
    this.#paidUntil = start + cost * this.#msPerToken;
    return Math.max(0, this.#paidUntil - now - this.#burstMs);
  }
}

/** Limits as given in `BackupOptions`. */
export interface RateLimits {
  readonly maxDocumentsPerSecond?: number | undefined;
  readonly maxBytesPerSecond?: number | undefined;
}

/** A documents bucket and a bytes bucket; each is optional. */
export class RateLimiter {
  readonly #documents: TokenBucket | undefined;
  readonly #bytes: TokenBucket | undefined;

  constructor(limits: RateLimits, options: { readonly now?: () => number } = {}) {
    const { maxDocumentsPerSecond, maxBytesPerSecond } = limits;
    this.#documents =
      maxDocumentsPerSecond === undefined
        ? undefined
        : new TokenBucket(maxDocumentsPerSecond, options);
    this.#bytes =
      maxBytesPerSecond === undefined ? undefined : new TokenBucket(maxBytesPerSecond, options);
  }

  /** Charges for `documents` documents of `bytes` bytes; returns the wait in ms. */
  take(documents: number, bytes: number): number {
    const documentWait = this.#documents?.take(documents) ?? 0;
    const byteWait = this.#bytes?.take(bytes) ?? 0;
    return Math.max(documentWait, byteWait);
  }
}

/**
 * Creates a limiter for `limits`, or `undefined` when no limit is set (so the
 * pipeline does not even get a throttle stage).
 */
export function createRateLimiter(limits: RateLimits): RateLimiter | undefined {
  if (limits.maxDocumentsPerSecond === undefined && limits.maxBytesPerSecond === undefined) {
    return undefined;
  }
  return new RateLimiter(limits);
}

/**
 * A pass-through stream for raw documents (one Buffer per document) that delays
 * each one as the limiter says. Backpressure does the rest (see the file header).
 */
export function createThrottleStream(limiter: RateLimiter): Transform {
  let pendingTimer: NodeJS.Timeout | undefined;
  return new Transform({
    objectMode: true,
    transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback) {
      const bytes = chunk instanceof Uint8Array ? chunk.byteLength : 0;
      const waitMs = limiter.take(1, bytes);
      if (waitMs < MIN_SLEEP_MS) {
        callback(null, chunk);
        return;
      }
      pendingTimer = setTimeout(() => {
        pendingTimer = undefined;
        callback(null, chunk);
      }, waitMs);
    },
    destroy(error: Error | null, callback: (error: Error | null) => void) {
      // A failure or abort elsewhere must not leave a timer that pushes into a
      // destroyed stream (or keeps the process alive).
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      callback(error);
    },
  });
}
