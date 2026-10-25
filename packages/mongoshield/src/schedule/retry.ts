/**
 * Retrying scheduled steps after transient failures.
 *
 * Only failures that a second attempt can plausibly fix are retried: a dropped
 * connection, a storage hiccup. Everything else (bad config, missing
 * privileges, an integrity or guard failure) would fail the same way again,
 * and retrying it would only delay the alert.
 *
 * Delays grow exponentially with "equal jitter": half of each delay is fixed,
 * half random. The random half spreads out runners that failed together (say,
 * when the database restarted) so they don't all hammer it again in lockstep.
 */

import type { ErrorCode } from "../errors.ts";
import { abortError, isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { type Logger, silentLogger } from "../logger.ts";

/** Error codes worth retrying. Everything else fails immediately. */
export const TRANSIENT_ERROR_CODES: readonly ErrorCode[] = [
  "MS_CONNECTION_FAILED",
  "MS_STORAGE_IO",
];

/** True for errors that a retry may fix (see {@link TRANSIENT_ERROR_CODES}). */
export function isTransientError(error: unknown): boolean {
  return TRANSIENT_ERROR_CODES.some((code) => isMongoShieldError(error, code));
}

/** How to retry. */
export interface RetryPolicy {
  /** Retries after the first attempt (so `retries: 2` means up to 3 attempts). */
  readonly retries: number;
  /** Delay before the first retry. Doubles each time. */
  readonly baseDelayMs: number;
  /** Upper bound for a single delay. */
  readonly maxDelayMs: number;
}

/**
 * Defaults: 2 retries, 30 s then 60 s (each ±half). Long enough for a replica
 * set election (typically ~10 s) or a brief network blip to resolve.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retries: 2,
  baseDelayMs: 30_000,
  maxDelayMs: 5 * 60_000,
};

/**
 * The delay before retry number `retry` (1 for the first retry):
 * `min(maxDelay, baseDelay × 2^(retry-1))`, of which a random half is dropped.
 * `random` returns a number in [0, 1), like `Math.random`.
 */
export function backoffDelay(
  retry: number,
  policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  const half = exponential / 2;
  return Math.round(half + random() * half);
}

/** Options for {@link withRetries}. */
export interface WithRetriesOptions {
  readonly policy: RetryPolicy;
  /** What is being retried, for log messages ("backup", "verify"). */
  readonly step: string;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly random?: () => number;
}

/** A step's result plus how many attempts it took. */
export interface Attempted<T> {
  readonly value: T;
  readonly attempts: number;
}

/** A failure after one or more attempts; `attempts` is reported in the run report. */
export class RetriesExhaustedError extends Error {
  override readonly name = "RetriesExhaustedError";
  readonly attempts: number;
  constructor(cause: unknown, attempts: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.attempts = attempts;
  }
}

/**
 * Runs `task`, retrying transient failures with backoff.
 *
 * @throws RetriesExhaustedError wrapping the last error (its `cause`), so the
 *   caller can report both the error and the number of attempts.
 */
export async function withRetries<T>(
  task: (attempt: number) => Promise<T>,
  options: WithRetriesOptions,
): Promise<Attempted<T>> {
  const logger = options.logger ?? silentLogger;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      throwIfAborted(options.signal);
      return { value: await task(attempt), attempts: attempt };
    } catch (error) {
      const retriesLeft = options.policy.retries - (attempt - 1);
      const aborted = options.signal?.aborted === true;
      if (aborted || retriesLeft <= 0 || !isTransientError(error)) {
        throw new RetriesExhaustedError(
          aborted && options.signal ? abortError(options.signal) : error,
          attempt,
        );
      }
      const delayMs = backoffDelay(attempt, options.policy, options.random);
      logger.warn(`The ${options.step} step failed; retrying`, {
        attempt,
        retriesLeft,
        delayMs,
        code: error instanceof MongoShieldError ? error.code : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await sleep(delayMs, options.signal);
      } catch (sleepError) {
        throw new RetriesExhaustedError(sleepError, attempt);
      }
    }
  }
}

/** Waits `ms` milliseconds, or rejects with a typed abort error when `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      if (signal) reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
