/**
 * Sleeping that can be interrupted.
 *
 * Every wait in the operator (retry backoff, leader election polling, requeue delays)
 * must end promptly on shutdown, so a SIGTERM never has to wait out a 30 s backoff.
 */

/** Waits `ms` milliseconds, or less if `signal` aborts first. Never rejects. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
