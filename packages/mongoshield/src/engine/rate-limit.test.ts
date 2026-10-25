import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  createRateLimiter,
  createThrottleStream,
  DEFAULT_BURST_MS,
  RateLimiter,
  TokenBucket,
} from "./rate-limit.ts";

/** A clock tests move by hand. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

describe("TokenBucket", () => {
  it("lets a burst through, then asks callers to wait at the average rate", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(100, { burstMs: 0, now: clock.now });
    // 100 tokens/s: each token costs 10 ms.
    expect(bucket.take(1)).toBe(10 - 0);
    expect(bucket.take(1)).toBe(20);
    clock.advance(20);
    expect(bucket.take(1)).toBe(10);
  });

  it("allows `burstMs` of tokens before any wait", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(1000, { burstMs: DEFAULT_BURST_MS, now: clock.now });
    for (let index = 0; index < 250; index++) expect(bucket.take(1)).toBe(0);
    expect(bucket.take(1)).toBeCloseTo(1);
  });

  it("does not save up tokens while idle", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(10, { burstMs: 0, now: clock.now });
    clock.advance(60_000);
    expect(bucket.take(1)).toBe(100);
  });

  it("holds the long-run rate whatever the cost per take", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(1000, { burstMs: 100, now: clock.now });
    let taken = 0;
    while (clock.now() < 10_000) {
      taken += 7;
      clock.advance(bucket.take(7));
      clock.advance(0.5);
    }
    // 10 s at 1000/s, plus at most one burst.
    expect(taken).toBeGreaterThan(9_900);
    expect(taken).toBeLessThan(10_200);
  });
});

describe("RateLimiter", () => {
  it("waits for whichever limit is tighter", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(
      { maxDocumentsPerSecond: 1_000_000, maxBytesPerSecond: 1000 },
      { now: clock.now },
    );
    // 1000 bytes at 1000 B/s = 1 s, minus the 250 ms burst.
    expect(limiter.take(1, 1000)).toBe(750);
  });

  it("is not created when no limit is set", () => {
    expect(createRateLimiter({})).toBeUndefined();
    expect(createRateLimiter({ maxBytesPerSecond: 10 })).toBeInstanceOf(RateLimiter);
  });
});

describe("createThrottleStream", () => {
  it("passes documents through unchanged, slowed to the limit", async () => {
    const limiter = new RateLimiter({ maxDocumentsPerSecond: 400 });
    const documents = Array.from({ length: 200 }, (_, index) => Buffer.from([index]));
    const received: Buffer[] = [];
    const started = performance.now();
    await pipeline(
      Readable.from(documents),
      createThrottleStream(limiter),
      new Writable({
        objectMode: true,
        write(chunk: Buffer, _encoding, callback) {
          received.push(chunk);
          callback();
        },
      }),
    );
    expect(received).toEqual(documents);
    // 200 documents at 400/s = 500 ms, minus the 250 ms burst.
    expect(performance.now() - started).toBeGreaterThan(200);
  });

  it("clears its timer when destroyed while waiting", async () => {
    const limiter = new RateLimiter({ maxDocumentsPerSecond: 1 });
    const throttle = createThrottleStream(limiter);
    throttle.write(Buffer.from("a"));
    throttle.write(Buffer.from("b"));
    throttle.destroy();
    await new Promise((resolve) => throttle.once("close", resolve));
    expect(throttle.destroyed).toBe(true);
  });
});
