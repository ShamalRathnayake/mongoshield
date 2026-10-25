/**
 * A small concurrency limiter for the engines: run one async job per item, with at
 * most N jobs in flight. Backup uses it to dump several collections at once, and
 * restore can use it the same way.
 *
 * Failure semantics, chosen so callers can clean up safely:
 *
 * - The first failure wins. No new jobs start after it, and the jobs still running
 *   are told to stop through the `signal` they receive.
 * - The returned promise settles only after EVERY started job has settled. A caller
 *   that deletes partial output on failure can therefore be sure no job is still
 *   writing when it starts cleaning up.
 * - If the caller's own signal aborts, jobs see it through the same `signal`, and
 *   the pool rejects with the typed abort error (`MS_ABORTED` / `MS_TIMEOUT`).
 */

import { abortError, MongoShieldError } from "../errors.ts";

/** Options for `mapWithConcurrency()`. */
export interface PoolOptions {
  /** Most jobs running at the same time. A whole number of at least 1. */
  readonly concurrency: number;
  /** Aborting it stops new jobs from starting and is forwarded to running jobs. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * One job. `signal` aborts when the caller aborts or when another job has failed,
 * so long-running jobs should pass it on to their streams and I/O.
 */
export type PoolJob<Item, Result> = (
  item: Item,
  index: number,
  signal: AbortSignal,
) => Promise<Result>;

/**
 * Runs `job` for every item with at most `options.concurrency` jobs in flight and
 * returns the results in item order.
 *
 * @throws the first job error (or the typed abort error), once all started jobs settled.
 * @throws MS_INTERNAL when `concurrency` is not a whole number of at least 1 (a caller
 *   bug: user-facing options are validated with friendlier errors before this).
 */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  job: PoolJob<Item, Result>,
  options: PoolOptions,
): Promise<Result[]> {
  assertValidConcurrency(options.concurrency);

  // One controller for the whole pool: it fires on the caller's abort and on the
  // first failure, so every running job learns that it should stop.
  const controller = new AbortController();
  const unlink = linkSignal(options.signal, controller);

  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  let failure: { readonly error: unknown } | undefined;

  /** Records the first failure and tells the other jobs to stop. */
  function fail(error: unknown): void {
    if (failure !== undefined) return;
    failure = { error };
    controller.abort(error);
  }

  /** A lane takes items one by one until none are left or something failed. */
  async function runLane(): Promise<void> {
    while (failure === undefined && nextIndex < items.length) {
      if (controller.signal.aborted) {
        fail(abortError(controller.signal));
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      try {
        // `index` is always in range here, so the cast only satisfies noUncheckedIndexedAccess.
        results[index] = await job(items[index] as Item, index, controller.signal);
      } catch (error) {
        fail(error);
      }
    }
  }

  try {
    const laneCount = Math.min(options.concurrency, items.length);
    const lanes: Promise<void>[] = [];
    for (let lane = 0; lane < laneCount; lane += 1) lanes.push(runLane());
    // Lanes never reject (errors go to `fail`), so this waits for every job to settle.
    await Promise.all(lanes);
  } finally {
    unlink();
  }

  // A caller abort is reported as such, even if a job failed with some other
  // error while being torn down by it.
  if (options.signal?.aborted) throw abortError(options.signal);
  if (failure !== undefined) throw failure.error;
  return results;
}

function assertValidConcurrency(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new MongoShieldError(
      "MS_INTERNAL",
      `Concurrency must be a whole number of at least 1, got ${String(concurrency)}.`,
    );
  }
}

/**
 * Makes `controller` abort (with the same reason) when `signal` aborts.
 * Returns a function that removes the listener, so long-lived signals do not
 * collect listeners from finished pools.
 */
function linkSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
