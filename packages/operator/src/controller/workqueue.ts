/**
 * A rate-limited work queue of object keys ("namespace/name"), modelled on
 * client-go's workqueue, which every Kubernetes controller uses.
 *
 * The properties that make reconcilers simple and safe:
 *
 *   - Deduplication: a key added ten times while waiting is processed once. Events
 *     only say "look at this object again"; the reconciler reads the current state.
 *   - No parallel work on one key: while a key is being processed, adding it again
 *     only marks it dirty, and it is queued once the current run is `done`. Two
 *     workers never reconcile the same object at the same time.
 *   - Per-key exponential backoff for failures (`addRateLimited`), reset by `forget`
 *     after a success, so one broken object retries slowly without slowing others.
 *   - Delayed adds (`addAfter`) for "check again in 30 s" requeues.
 */

/** Backoff for failed keys: doubling from `baseDelayMs` up to `maxDelayMs`. */
export interface RateLimit {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** Defaults like controller-runtime's: 5 ms, 10 ms, 20 ms, … capped at 5 minutes. */
export const DEFAULT_RATE_LIMIT: RateLimit = { baseDelayMs: 5, maxDelayMs: 5 * 60_000 };

export class WorkQueue {
  readonly #rateLimit: RateLimit;
  /** Keys waiting to be handed out, in order. */
  readonly #queue: string[] = [];
  /** Keys that need processing (queued, or re-added while processing). */
  readonly #dirty = new Set<string>();
  /** Keys a worker is processing right now. */
  readonly #processing = new Set<string>();
  /** Failure counts, for backoff. */
  readonly #failures = new Map<string, number>();
  /** Pending delayed adds: key → when it fires, and its timer. */
  readonly #delayed = new Map<string, { at: number; timer: NodeJS.Timeout }>();
  /** Workers waiting in `get` for a key to arrive. */
  readonly #waiters: ((key: string | undefined) => void)[] = [];
  #shuttingDown = false;

  constructor(rateLimit: RateLimit = DEFAULT_RATE_LIMIT) {
    this.#rateLimit = rateLimit;
  }

  /** Keys waiting to be processed (for the queue depth metric). */
  get length(): number {
    return this.#queue.length;
  }

  /** True once `shutDown` was called. */
  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /** Queues a key for processing (no-op if it is already waiting). */
  add(key: string): void {
    if (this.#shuttingDown || this.#dirty.has(key)) return;
    this.#dirty.add(key);
    // Re-added while being processed: `done` queues it again afterwards.
    if (this.#processing.has(key)) return;
    this.#push(key);
  }

  /**
   * Queues a key after a delay. If the key already has an earlier delayed add, that
   * one wins (the object gets looked at sooner, which is always safe).
   */
  addAfter(key: string, delayMs: number): void {
    if (this.#shuttingDown) return;
    if (delayMs <= 0) {
      this.add(key);
      return;
    }
    const at = Date.now() + delayMs;
    const existing = this.#delayed.get(key);
    if (existing && existing.at <= at) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.#delayed.delete(key);
      this.add(key);
    }, delayMs);
    // A pending requeue must not keep the process alive during shutdown.
    timer.unref();
    this.#delayed.set(key, { at, timer });
  }

  /** Queues a key after its backoff delay, and counts the failure. */
  addRateLimited(key: string): number {
    const failures = (this.#failures.get(key) ?? 0) + 1;
    this.#failures.set(key, failures);
    const delay = Math.min(
      this.#rateLimit.maxDelayMs,
      this.#rateLimit.baseDelayMs * 2 ** (failures - 1),
    );
    this.addAfter(key, delay);
    return delay;
  }

  /** Clears a key's failure count (call after it was processed successfully). */
  forget(key: string): void {
    this.#failures.delete(key);
  }

  /** How many times in a row the key has failed. */
  failures(key: string): number {
    return this.#failures.get(key) ?? 0;
  }

  /**
   * Waits for the next key and marks it as being processed. Resolves `undefined`
   * once the queue is shut down. Every key handed out must be passed to `done`.
   */
  get(): Promise<string | undefined> {
    if (this.#shuttingDown) return Promise.resolve(undefined);
    const key = this.#queue.shift();
    if (key !== undefined) return Promise.resolve(this.#startProcessing(key));
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Marks a key as processed; if it was re-added meanwhile, it is queued again. */
  done(key: string): void {
    this.#processing.delete(key);
    if (this.#dirty.has(key) && !this.#shuttingDown) this.#push(key);
  }

  /**
   * Stops handing out keys: waiting workers get `undefined`, delayed adds are
   * cancelled. Keys being processed may still call `done`.
   */
  shutDown(): void {
    this.#shuttingDown = true;
    for (const { timer } of this.#delayed.values()) clearTimeout(timer);
    this.#delayed.clear();
    for (const waiter of this.#waiters.splice(0)) waiter(undefined);
  }

  #push(key: string): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(this.#startProcessing(key));
    else this.#queue.push(key);
  }

  #startProcessing(key: string): string {
    this.#dirty.delete(key);
    this.#processing.add(key);
    return key;
  }
}
