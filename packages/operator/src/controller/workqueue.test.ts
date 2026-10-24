/** Tests for the work queue: dedup, one worker per key, backoff, delays, shutdown. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkQueue } from "./workqueue.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkQueue", () => {
  it("hands out each key once, however often it was added", async () => {
    const queue = new WorkQueue();
    queue.add("a");
    queue.add("b");
    queue.add("a");

    expect(queue.length).toBe(2);
    expect(await queue.get()).toBe("a");
    expect(await queue.get()).toBe("b");
    expect(queue.length).toBe(0);
  });

  it("never hands out a key that is being processed; re-adds wait for done", async () => {
    const queue = new WorkQueue();
    queue.add("a");
    const key = await queue.get();
    queue.add("a");
    expect(queue.length).toBe(0);

    queue.done(key ?? "");
    expect(queue.length).toBe(1);
    expect(await queue.get()).toBe("a");
  });

  it("does not requeue a processed key that was not re-added", async () => {
    const queue = new WorkQueue();
    queue.add("a");
    queue.done((await queue.get()) ?? "");
    expect(queue.length).toBe(0);
  });

  it("wakes a waiting worker when a key arrives", async () => {
    const queue = new WorkQueue();
    const waiting = queue.get();
    queue.add("late");
    expect(await waiting).toBe("late");
  });

  it("backs off exponentially per key and resets on forget", () => {
    const queue = new WorkQueue({ baseDelayMs: 100, maxDelayMs: 1000 });
    expect(queue.addRateLimited("a")).toBe(100);
    expect(queue.addRateLimited("a")).toBe(200);
    expect(queue.addRateLimited("a")).toBe(400);
    expect(queue.addRateLimited("a")).toBe(800);
    expect(queue.addRateLimited("a")).toBe(1000);
    expect(queue.failures("a")).toBe(5);
    expect(queue.addRateLimited("b")).toBe(100);

    queue.forget("a");
    expect(queue.failures("a")).toBe(0);
    expect(queue.addRateLimited("a")).toBe(100);
    queue.shutDown();
  });

  it("adds a key after a delay, keeping the earliest of several delays", async () => {
    vi.useFakeTimers();
    const queue = new WorkQueue();
    queue.addAfter("a", 1000);
    queue.addAfter("a", 5000);
    queue.addAfter("a", 500);
    expect(queue.length).toBe(0);

    vi.advanceTimersByTime(499);
    expect(queue.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(queue.length).toBe(1);
    // The cancelled timers never add it again.
    queue.done((await queue.get()) ?? "");
    vi.advanceTimersByTime(10_000);
    expect(queue.length).toBe(0);
  });

  it("treats a zero delay as an immediate add", () => {
    const queue = new WorkQueue();
    queue.addAfter("a", 0);
    expect(queue.length).toBe(1);
  });

  it("stops on shutdown: waiting workers get undefined, adds are ignored", async () => {
    vi.useFakeTimers();
    const queue = new WorkQueue();
    const waiting = queue.get();
    queue.addAfter("later", 1000);
    queue.shutDown();

    expect(await waiting).toBeUndefined();
    expect(await queue.get()).toBeUndefined();
    queue.add("x");
    queue.addAfter("y", 10);
    vi.advanceTimersByTime(5000);
    expect(queue.length).toBe(0);
    expect(queue.shuttingDown).toBe(true);
  });

  it("does not requeue a dirty key after shutdown", async () => {
    const queue = new WorkQueue();
    queue.add("a");
    const key = (await queue.get()) ?? "";
    queue.add("a");
    queue.shutDown();
    queue.done(key);
    expect(queue.length).toBe(0);
  });
});
