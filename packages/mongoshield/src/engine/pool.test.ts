import { describe, expect, it } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import { mapWithConcurrency } from "./pool.ts";

/** A promise plus the functions that settle it, for controlling job timing in tests. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
}

describe("mapWithConcurrency", () => {
  it("returns results in item order, whatever order jobs finish in", async () => {
    const results = await mapWithConcurrency(
      [30, 10, 20],
      async (delay) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return delay * 2;
      },
      { concurrency: 3 },
    );
    expect(results).toEqual([60, 20, 40]);
  });

  it("never runs more jobs at once than the concurrency limit", async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
  });

  it("handles an empty list without running anything", async () => {
    await expect(mapWithConcurrency([], async () => 1, { concurrency: 2 })).resolves.toEqual([]);
  });

  it("stops starting jobs after a failure and waits for running ones before rejecting", async () => {
    const started: number[] = [];
    const slow = deferred();
    let slowFinished = false;
    const boom = new MongoShieldError("MS_STORAGE_IO", "boom");

    const run = mapWithConcurrency(
      [0, 1, 2, 3],
      async (item, _index, signal) => {
        started.push(item);
        if (item === 0) throw boom;
        if (item === 1) {
          await slow.promise;
          slowFinished = true;
          expect(signal.aborted).toBe(true);
        }
      },
      { concurrency: 2 },
    );

    let settled = false;
    void run
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    await flush();
    expect(settled).toBe(false); // job 1 is still running
    slow.resolve();
    await expect(run).rejects.toBe(boom);
    expect(slowFinished).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it("passes jobs a signal that aborts when another job fails", async () => {
    let observedReason: unknown;
    const boom = new Error("first failure");
    const gate = deferred();
    const run = mapWithConcurrency(
      ["fails", "waits"],
      async (item, _index, signal) => {
        if (item === "fails") {
          await gate.promise;
          throw boom;
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        observedReason = signal.reason;
      },
      { concurrency: 2 },
    );
    gate.resolve();
    await expect(run).rejects.toBe(boom);
    expect(observedReason).toBe(boom);
  });

  it("rejects with MS_ABORTED and starts nothing when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const error = await mapWithConcurrency(
      [1, 2],
      async () => {
        calls += 1;
      },
      { concurrency: 1, signal: controller.signal },
    ).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    expect(calls).toBe(0);
  });

  it("reports a caller abort as MS_TIMEOUT for timeouts, even if jobs fail differently", async () => {
    const controller = new AbortController();
    const error = await mapWithConcurrency(
      [1, 2, 3],
      async (_item, _index, signal) => {
        controller.abort(new DOMException("too slow", "TimeoutError"));
        if (signal.aborted) throw new Error("torn down");
      },
      { concurrency: 1, signal: controller.signal },
    ).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_TIMEOUT")).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects a concurrency of %s", async (concurrency) => {
    const error = await mapWithConcurrency([1], async () => 1, { concurrency }).catch(
      (caught: unknown) => caught,
    );
    expect(isMongoShieldError(error, "MS_INTERNAL")).toBe(true);
  });
});
