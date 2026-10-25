/**
 * Login rate limiting: slows down password guessing.
 *
 * Failed logins are counted per key in a sliding window; the login route uses
 * two keys per attempt, the client address and the username, so neither one
 * attacker trying many usernames nor many addresses trying one username get
 * more than {@link MAX_FAILURES} guesses per window. A successful login clears
 * the username's counter.
 *
 * Counters live in memory: a restart resets them, which is acceptable for a
 * single-process console (an attacker cannot trigger restarts).
 */

/** Failed attempts allowed per key and window. */
export const MAX_FAILURES = 10;
/** The window: 15 minutes. */
export const WINDOW_MS = 15 * 60 * 1000;
/** Keys tracked at most, so a flood of random usernames cannot exhaust memory. */
const MAX_KEYS = 10_000;

/** Counts failed logins; see the file header. */
export class LoginRateLimiter {
  readonly #failures = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * How long (ms) the caller must wait before trying again, or 0 when an
   * attempt is allowed for every key.
   */
  retryAfterMs(keys: readonly string[]): number {
    const now = this.#now();
    let wait = 0;
    for (const key of keys) {
      const recent = this.#recent(key, now);
      if (recent.length >= MAX_FAILURES) {
        const oldest = recent[0] ?? now;
        wait = Math.max(wait, oldest + WINDOW_MS - now);
      }
    }
    return wait;
  }

  /** Records a failed attempt for every key. */
  recordFailure(keys: readonly string[]): void {
    const now = this.#now();
    for (const key of keys) {
      const recent = this.#recent(key, now);
      recent.push(now);
      this.#failures.delete(key);
      this.#failures.set(key, recent);
    }
    // Maps iterate in insertion order: drop the least recently failed keys first.
    while (this.#failures.size > MAX_KEYS) {
      const oldest = this.#failures.keys().next().value;
      if (oldest === undefined) break;
      this.#failures.delete(oldest);
    }
  }

  /** Forgets the failures of a key (after a successful login). */
  reset(key: string): void {
    this.#failures.delete(key);
  }

  /** Failures of `key` inside the window, oldest first. */
  #recent(key: string, now: number): number[] {
    return (this.#failures.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  }
}
