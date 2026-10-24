/**
 * Unit tests for the per-connection pacer: one run at a time on a shared tier, a few
 * otherwise, first come first served, the bounded wait (429), leaving the queue on
 * abort, and freeing the slot when a task fails.
 */

import { describe, expect, it } from "vitest";
import { ConsoleError } from "../errors.ts";
import { ConnectionPacer, DEFAULT_SLOTS, MAX_WAIT_MS, SHARED_TIER_SLOTS } from "./pacing.ts";

/** A task the test finishes by hand, recording when it started. */
function manualTask(log: string[], name: string) {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const task = async () => {
    log.push(`start ${name}`);
    await done;
    log.push(`end ${name}`);
    return name;
  };
  return { task, finish };
}

/** Lets pending promise callbacks run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("the pacer", () => {
  it("documents its limits: one on a shared tier, four otherwise, 30 s of waiting", () => {
    expect(SHARED_TIER_SLOTS).toBe(1);
    expect(DEFAULT_SLOTS).toBe(4);
    expect(MAX_WAIT_MS).toBe(30_000);
  });

  it("runs one task at a time on a shared tier, in arrival order", async () => {
    const pacer = new ConnectionPacer();
    const log: string[] = [];
    const first = manualTask(log, "a");
    const second = manualTask(log, "b");
    const third = manualTask(log, "c");
    const runs = [
      pacer.run("atlas", true, first.task),
      pacer.run("atlas", true, second.task),
      pacer.run("atlas", true, third.task),
    ];
    await tick();
    expect(log).toEqual(["start a"]);
    expect(pacer.stateOf("atlas")).toEqual({ active: 1, waiting: 2 });
    first.finish();
    await tick();
    expect(log).toEqual(["start a", "end a", "start b"]);
    second.finish();
    await tick();
    third.finish();
    expect(await Promise.all(runs)).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    // An idle connection keeps no state.
    expect(pacer.stateOf("atlas")).toEqual({ active: 0, waiting: 0 });
  });

  it("runs a few at once elsewhere, and keeps connections apart", async () => {
    const pacer = new ConnectionPacer({ defaultSlots: 2 });
    const log: string[] = [];
    const tasks = ["a", "b", "c"].map((name) => manualTask(log, name));
    const other = manualTask(log, "other");
    const runs = tasks.map(({ task }) => pacer.run("local", false, task));
    const otherRun = pacer.run("atlas", true, other.task);
    await tick();
    expect(log).toEqual(["start a", "start b", "start other"]);
    for (const { finish } of tasks) finish();
    other.finish();
    expect(await Promise.all([...runs, otherRun])).toEqual(["a", "b", "c", "other"]);
  });

  it("gives up after the bounded wait with a clear 429", async () => {
    const pacer = new ConnectionPacer({ maxWaitMs: 20 });
    const log: string[] = [];
    const busy = manualTask(log, "busy");
    const running = pacer.run("atlas", true, busy.task);
    const waiting = pacer.run("atlas", true, async () => "never");
    const error = await waiting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConsoleError);
    expect(error).toMatchObject({
      status: 429,
      code: "CONSOLE_LIVE_BUSY",
      message: "This Atlas Free/Flex cluster is busy with another sample; try again in a moment.",
    });
    expect(pacer.stateOf("atlas")).toEqual({ active: 1, waiting: 0 });
    busy.finish();
    expect(await running).toBe("busy");
  });

  it("says the connection is busy on other deployments", async () => {
    const pacer = new ConnectionPacer({ maxWaitMs: 10, defaultSlots: 1 });
    const busy = manualTask([], "busy");
    const running = pacer.run("local", false, busy.task);
    await expect(pacer.run("local", false, async () => "never")).rejects.toThrow(
      /This connection is busy/,
    );
    busy.finish();
    await running;
  });

  it("drops a waiting request whose browser went away", async () => {
    const pacer = new ConnectionPacer();
    const busy = manualTask([], "busy");
    const running = pacer.run("atlas", true, busy.task);
    const controller = new AbortController();
    const waiting = pacer.run("atlas", true, async () => "never", controller.signal);
    await tick();
    expect(pacer.stateOf("atlas").waiting).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(pacer.stateOf("atlas").waiting).toBe(0);
    // A request that is aborted already never queues.
    await expect(pacer.run("atlas", true, async () => "x", controller.signal)).rejects.toThrow();
    busy.finish();
    await running;
  });

  it("frees the slot when a task fails", async () => {
    const pacer = new ConnectionPacer();
    await expect(
      pacer.run("atlas", true, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await pacer.run("atlas", true, async () => "next")).toBe("next");
  });
});
