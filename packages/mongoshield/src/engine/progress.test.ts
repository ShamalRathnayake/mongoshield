import { describe, expect, it } from "vitest";
import type { Logger } from "../logger.ts";
import type { ProgressEvent } from "../types.ts";
import { estimateRemainingMs, MIN_ETA_ELAPSED_MS, ProgressTracker } from "./progress.ts";

/** A tracker on a fake clock that records every event. */
function setup(intervalMs = 250) {
  let time = 0;
  const events: ProgressEvent[] = [];
  const tracker = new ProgressTracker({
    onProgress: (event) => events.push(event),
    intervalMs,
    now: () => time,
  });
  return {
    tracker,
    events,
    advance(ms: number) {
      time += ms;
    },
    types: () => events.map((event) => event.type),
  };
}

describe("estimateRemainingMs", () => {
  it("extrapolates the average speed so far to the remaining documents", () => {
    // 100 documents in 2 s → 20 ms each → 300 remaining take 6 s.
    expect(estimateRemainingMs(100, 400, 2000)).toBe(6000);
  });

  it("has no estimate before any document or before the minimum elapsed time", () => {
    expect(estimateRemainingMs(0, 400, 5000)).toBeUndefined();
    expect(estimateRemainingMs(10, 400, MIN_ETA_ELAPSED_MS - 1)).toBeUndefined();
  });

  it("has no estimate once more documents were done than estimated", () => {
    expect(estimateRemainingMs(500, 400, 5000)).toBeUndefined();
  });

  it("is zero when exactly the estimated number is done", () => {
    expect(estimateRemainingMs(400, 400, 5000)).toBe(0);
  });
});

describe("ProgressTracker", () => {
  it("emits start, throttled progress, done and a final overall event", () => {
    const { tracker, events, advance, types } = setup();
    tracker.startNamespace("app.users", 1000);
    for (let documents = 1; documents <= 1000; documents += 1) {
      advance(1); // one document per millisecond: 1 s in total
      tracker.updateNamespace("app.users", documents, documents * 10);
    }
    tracker.finishNamespace("app.users", 1000, 10_000);
    tracker.finish();

    expect(types()[0]).toBe("namespace:start");
    const progress = events.filter((event) => event.type === "namespace:progress");
    // 1 s at one event per 250 ms.
    expect(progress).toHaveLength(4);
    expect(types()).toContain("namespace:done");
    expect(events.at(-1)).toEqual({
      type: "overall",
      documents: 1000,
      estimatedDocuments: 1000,
      bytes: 10_000,
      elapsedMs: 1000,
      etaMs: 0,
    });
  });

  it("sums all namespaces in overall events and estimates the ETA", () => {
    const { tracker, events, advance } = setup();
    tracker.startNamespace("app.a", 300);
    tracker.startNamespace("app.b", 100);
    advance(2000);
    tracker.updateNamespace("app.a", 60, 600);
    tracker.updateNamespace("app.b", 40, 400);
    advance(250);
    tracker.updateNamespace("app.b", 40, 400);

    const overall = events.filter((event) => event.type === "overall").at(-1);
    expect(overall).toMatchObject({ documents: 100, estimatedDocuments: 400, bytes: 1000 });
    // 100 documents in 2.25 s → 300 more take 6.75 s.
    expect(overall?.type === "overall" ? overall.etaMs : -1).toBe(6750);
  });

  it("never throttles start and done events", () => {
    const { tracker, types } = setup(10_000);
    for (const ns of ["a.x", "a.y", "a.z"]) {
      tracker.startNamespace(ns, 0);
      tracker.finishNamespace(ns, 0, 0);
    }
    expect(types().filter((type) => type.startsWith("namespace:"))).toEqual([
      "namespace:start",
      "namespace:done",
      "namespace:start",
      "namespace:done",
      "namespace:start",
      "namespace:done",
    ]);
  });

  it("throttles progress per namespace, so a busy namespace cannot starve another", () => {
    const { tracker, events, advance } = setup();
    tracker.startNamespace("a.busy", 10);
    tracker.startNamespace("a.quiet", 10);
    advance(300);
    tracker.updateNamespace("a.busy", 1, 1);
    tracker.updateNamespace("a.quiet", 1, 1);
    const progressNamespaces = events
      .filter((event) => event.type === "namespace:progress")
      .map((event) => (event.type === "namespace:progress" ? event.ns : ""));
    expect(progressNamespaces).toEqual(["a.busy", "a.quiet"]);
  });

  it("does nothing without a callback", () => {
    const tracker = new ProgressTracker();
    expect(tracker.enabled).toBe(false);
    tracker.startNamespace("a.b", 1);
    tracker.updateNamespace("a.b", 1, 1);
    tracker.finishNamespace("a.b", 1, 1);
    tracker.finish();
  });

  it("survives a throwing callback and logs a single warning", () => {
    const warnings: string[] = [];
    const noop = (): void => {};
    const logger: Logger = {
      debug: noop,
      info: noop,
      error: noop,
      warn: (message) => warnings.push(message),
    };
    const tracker = new ProgressTracker({
      onProgress: () => {
        throw new Error("UI crashed");
      },
      logger,
    });
    tracker.startNamespace("a.b", 1);
    tracker.finishNamespace("a.b", 1, 1);
    tracker.finish();
    expect(warnings).toHaveLength(1);
  });
});
