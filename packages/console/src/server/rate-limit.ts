/**
 * Login rate limiting: slows down password guessing.
 *
 * Failed logins are counted per key in a sliding window; the login route uses
 * two keys per attempt, the client address and the username, so neither one
 * attacker trying many usernames nor many addresses trying one username get
 * more than {@link MAX_FAILURES} guesses per window. A successful login clears
 * the username's counter.
 *
 * Attempts are counted BEFORE the slow password check (`tryReserve`), and given back
 * when the password was right (`release`). Counting only after the ~100 ms scrypt run
 * would let any number of parallel guesses pass the check while none had failed yet.
 *
 * Throttled attempts are audited sparingly (`throttleAudit`): one entry per key and
 * minute, carrying how many were left out, and at most a few per minute overall. One
 * fsync'd audit line per refused request would let an anonymous flood rotate the real
 * history (restores, user changes) out of the audit log.
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
/** Throttled attempts of one key are audited at most once per minute. */
export const THROTTLE_AUDIT_INTERVAL_MS = 60 * 1000;
/** And at most this many throttle entries per minute for all keys together. */
export const MAX_THROTTLE_AUDITS_PER_INTERVAL = 20;

/** An attempt counted by {@link LoginRateLimiter.tryReserve}, to give back on success. */
export interface ReservedAttempt {
  readonly keys: readonly string[];
  readonly at: number;
}

/** Counts failed logins; see the file header. */
export class LoginRateLimiter {
  readonly #failures = new Map<string, number[]>();
  readonly #now: () => number;
  /** Per key: when its last throttle entry was audited, and how many were left out since. */
  readonly #throttleAudits = new Map<string, { at: number; suppressed: number }>();
  /** Throttle entries audited in the current interval, for all keys together. */
  #auditWindow = { startedAt: 0, count: 0 };

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

  /**
   * Checks the keys and, when an attempt is allowed, counts it at once, as if it had
   * failed, before the caller checks the password. There is no await between the check
   * and the count, so parallel requests cannot all pass. Give it back with
   * {@link release} when the attempt succeeds.
   */
  tryReserve(
    keys: readonly string[],
  ):
    | { readonly ok: true; readonly attempt: ReservedAttempt }
    | { readonly ok: false; readonly retryAfterMs: number } {
    const wait = this.retryAfterMs(keys);
    if (wait > 0) return { ok: false, retryAfterMs: wait };
    const at = this.#now();
    this.#record(keys, at);
    return { ok: true, attempt: { keys, at } };
  }

  /** Gives back a reserved attempt that succeeded: it no longer counts as a failure. */
  release(attempt: ReservedAttempt): void {
    for (const key of attempt.keys) {
      const recent = this.#failures.get(key);
      if (recent === undefined) continue;
      const index = recent.indexOf(attempt.at);
      if (index !== -1) recent.splice(index, 1);
      if (recent.length === 0) this.#failures.delete(key);
    }
  }

  /**
   * Whether a throttled attempt of `key` should be audited now. Returns how many
   * throttled attempts of the key were left out since its last entry (to record with
   * this one), or `undefined` to leave this one out too (see the file header).
   */
  throttleAudit(key: string): number | undefined {
    const now = this.#now();
    const previous = this.#throttleAudits.get(key);
    if (previous !== undefined && now - previous.at < THROTTLE_AUDIT_INTERVAL_MS) {
      previous.suppressed += 1;
      return undefined;
    }
    if (now - this.#auditWindow.startedAt >= THROTTLE_AUDIT_INTERVAL_MS) {
      this.#auditWindow = { startedAt: now, count: 0 };
    }
    if (this.#auditWindow.count >= MAX_THROTTLE_AUDITS_PER_INTERVAL) {
      if (previous !== undefined) previous.suppressed += 1;
      return undefined;
    }
    this.#auditWindow.count += 1;
    this.#throttleAudits.delete(key);
    this.#throttleAudits.set(key, { at: now, suppressed: 0 });
    while (this.#throttleAudits.size > MAX_KEYS) {
      const oldest = this.#throttleAudits.keys().next().value;
      if (oldest === undefined) break;
      this.#throttleAudits.delete(oldest);
    }
    return previous?.suppressed ?? 0;
  }

  /** Records a failed attempt for every key. */
  recordFailure(keys: readonly string[]): void {
    this.#record(keys, this.#now());
  }

  /** Adds one attempt at `now` to every key, dropping the least recently used keys beyond the cap. */
  #record(keys: readonly string[], now: number): void {
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
