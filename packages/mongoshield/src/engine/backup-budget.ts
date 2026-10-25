/**
 * The time budget of a run with `maxDurationMs`: decides, part by part, whether
 * there is still time to start one more.
 *
 * Parts already running are never interrupted (they would only have to be redone),
 * so the budget stops STARTING parts early enough for the ones in flight to finish:
 * a new part starts only if, judging by the parts finished so far in this
 * invocation, it would end before the deadline minus a reserve for the checkpoint
 * write. Each invocation always starts at least one part, so a budget that is too
 * small still makes progress instead of checkpointing forever.
 */

/** Time kept free at the end for writing the checkpoint: 5% of the budget, at most 10 s. */
const RESERVE_FRACTION = 0.05;
const MAX_RESERVE_MS = 10_000;

/** See the file header. */
export class TimeBudget {
  readonly #deadline: number;
  readonly #reserveMs: number;
  readonly #now: () => number;
  #started = 0;
  #finished = 0;
  #finishedMs = 0;
  #exhausted = false;

  /**
   * @param maxDurationMs the budget, counted from `options.startedAt`.
   * @param options.startedAt when the invocation started, on the `now` clock.
   * @param options.now clock in milliseconds (defaults to `performance.now`); for tests.
   */
  constructor(
    maxDurationMs: number,
    options: { readonly startedAt?: number; readonly now?: () => number } = {},
  ) {
    this.#now = options.now ?? (() => performance.now());
    this.#deadline = (options.startedAt ?? this.#now()) + maxDurationMs;
    this.#reserveMs = Math.min(MAX_RESERVE_MS, maxDurationMs * RESERVE_FRACTION);
  }

  /**
   * Asks to start a part. Returns true (and counts the part as started) when there
   * is time, false once the budget is used up; after the first false it stays false.
   */
  tryStart(): boolean {
    if (this.#exhausted) return false;
    // Progress guarantee: the first part of every invocation always starts.
    if (this.#started > 0 && !this.#hasTimeForAnotherPart()) {
      this.#exhausted = true;
      return false;
    }
    this.#started += 1;
    return true;
  }

  /** Records how long a finished part took, to predict the next ones. */
  partFinished(durationMs: number): void {
    this.#finished += 1;
    this.#finishedMs += durationMs;
  }

  /** True once a part was refused for lack of time. */
  get exhausted(): boolean {
    return this.#exhausted;
  }

  #hasTimeForAnotherPart(): boolean {
    // Before any part finished there is nothing to go by, so only the reserve counts.
    const expectedPartMs = this.#finished === 0 ? 0 : this.#finishedMs / this.#finished;
    return this.#now() + expectedPartMs + this.#reserveMs <= this.#deadline;
  }
}
