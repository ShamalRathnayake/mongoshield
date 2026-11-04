import { describe, expect, it } from "vitest";
import {
  LoginRateLimiter,
  MAX_FAILURES,
  MAX_THROTTLE_AUDITS_PER_INTERVAL,
  THROTTLE_AUDIT_INTERVAL_MS,
  WINDOW_MS,
} from "./rate-limit.ts";

describe("LoginRateLimiter", () => {
  it("blocks a key after too many failures until the window passes", () => {
    let now = 0;
    const limiter = new LoginRateLimiter(() => now);
    for (let attempt = 0; attempt < MAX_FAILURES; attempt++) {
      expect(limiter.retryAfterMs(["user:ada"])).toBe(0);
      limiter.recordFailure(["user:ada"]);
    }
    expect(limiter.retryAfterMs(["user:ada"])).toBe(WINDOW_MS);
    expect(limiter.retryAfterMs(["user:bob"])).toBe(0);
    now = WINDOW_MS;
    expect(limiter.retryAfterMs(["user:ada"])).toBe(0);
  });

  it("blocks when any of the keys is over the limit, and resets on success", () => {
    const limiter = new LoginRateLimiter(() => 0);
    for (let attempt = 0; attempt < MAX_FAILURES; attempt++) limiter.recordFailure(["address:1"]);
    expect(limiter.retryAfterMs(["user:ada", "address:1"])).toBeGreaterThan(0);
    limiter.reset("address:1");
    expect(limiter.retryAfterMs(["user:ada", "address:1"])).toBe(0);
  });

  it("forgets the least recently failed keys beyond 10,000 so a flood cannot exhaust memory", () => {
    const limiter = new LoginRateLimiter(() => 0);
    for (let attempt = 0; attempt < MAX_FAILURES; attempt++) limiter.recordFailure(["user:first"]);
    expect(limiter.retryAfterMs(["user:first"])).toBe(WINDOW_MS);
    for (let index = 0; index < 10_000; index++) limiter.recordFailure([`user:flood-${index}`]);
    expect(limiter.retryAfterMs(["user:first"])).toBe(0);
  });
});

describe("reserving attempts before the password check", () => {
  it("counts each attempt at once, so parallel guesses cannot pass the limit", () => {
    const limiter = new LoginRateLimiter(() => 0);
    const outcomes = Array.from({ length: 50 }, () =>
      limiter.tryReserve(["address:1", "user:ada"]),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(MAX_FAILURES);
    expect(outcomes.at(-1)).toEqual({ ok: false, retryAfterMs: WINDOW_MS });
  });

  it("gives back an attempt that succeeded", () => {
    const limiter = new LoginRateLimiter(() => 0);
    for (let attempt = 0; attempt < MAX_FAILURES - 1; attempt++) {
      limiter.tryReserve(["address:1"]);
    }
    const last = limiter.tryReserve(["address:1"]);
    if (!last.ok) throw new Error("the tenth attempt should be allowed");
    expect(limiter.retryAfterMs(["address:1"])).toBeGreaterThan(0);
    limiter.release(last.attempt);
    expect(limiter.retryAfterMs(["address:1"])).toBe(0);
  });
});

describe("auditing throttled attempts", () => {
  it("records one entry per key and minute, with the number left out", () => {
    let now = 0;
    const limiter = new LoginRateLimiter(() => now);
    expect(limiter.throttleAudit("address:1")).toBe(0);
    for (let index = 0; index < 99; index++)
      expect(limiter.throttleAudit("address:1")).toBeUndefined();
    now = THROTTLE_AUDIT_INTERVAL_MS;
    expect(limiter.throttleAudit("address:1")).toBe(99);
  });

  it("records at most a few entries per minute for all keys together", () => {
    const limiter = new LoginRateLimiter(() => 0);
    const recorded = Array.from({ length: 500 }, (_, index) =>
      limiter.throttleAudit(`address:${index}`),
    ).filter((outcome) => outcome !== undefined);
    expect(recorded).toHaveLength(MAX_THROTTLE_AUDITS_PER_INTERVAL);
  });
});
