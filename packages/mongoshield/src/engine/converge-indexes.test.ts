import { describe, expect, it } from "vitest";
import { IndexChangeTracker } from "./converge-indexes.ts";

const create = (name: string, key: Record<string, number> = { [name]: 1 }) => ({
  kind: "create" as const,
  spec: { key, name },
});
const drop = (name: string) => ({ kind: "drop" as const, name });

describe("IndexChangeTracker", () => {
  it("keeps the index changes of each target in order", () => {
    const tracker = new IndexChangeTracker();
    tracker.record("app.a", [create("x")]);
    tracker.record("app.b", [create("y")]);
    tracker.record("app.a", [drop("old"), create("z")]);
    expect(tracker.plans()).toEqual(
      new Map([
        ["app.a", { reset: false, changes: [create("x"), drop("old"), create("z")] }],
        ["app.b", { reset: false, changes: [create("y")] }],
      ]),
    );
  });

  it("never builds an index that is dropped again later in the window", () => {
    const tracker = new IndexChangeTracker();
    tracker.record("app.a", [create("x"), create("y")]);
    tracker.record("app.a", [drop("x")]);
    // The drop stays: the dumped indexes may hold `x` too.
    expect(tracker.plans().get("app.a")?.changes).toEqual([create("y"), drop("x")]);
  });

  it("forgets everything before a drop of the collection, and says to reset", () => {
    const tracker = new IndexChangeTracker();
    tracker.record("app.a", [create("x")]);
    tracker.reset("app.a");
    tracker.record("app.a", [create("y")]);
    expect(tracker.plans().get("app.a")).toEqual({ reset: true, changes: [create("y")] });
  });

  it("moves a collection's changes with a rename, replacing the destination's", () => {
    const tracker = new IndexChangeTracker();
    tracker.record("app.tmp", [create("x")]);
    tracker.record("app.target", [create("old")]);
    tracker.rename("app.tmp", "app.target");
    expect(tracker.plans()).toEqual(
      new Map([["app.target", { reset: false, changes: [create("x")] }]]),
    );

    // A source without changes leaves the destination with none either.
    tracker.rename("app.unknown", "app.target");
    expect(tracker.plans().size).toBe(0);
  });

  it("lists only targets with something to do", () => {
    const tracker = new IndexChangeTracker();
    tracker.record("app.a", []);
    expect(tracker.plans().size).toBe(0);
  });
});
