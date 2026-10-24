import { describe, expect, it } from "vitest";
import { LoginRateLimiter, MAX_FAILURES, WINDOW_MS } from "./rate-limit.ts";

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
});
