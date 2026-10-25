// Unit tests for the restore action table (`decideAction`): every mode against
// every kind of existing target.

import { describe, expect, it } from "vitest";
import type { RestoreMode } from "../types.ts";
import { type ActionDecision, decideAction, type TargetState } from "./restore-plan.ts";

const missing: TargetState = { exists: false };
const emptyCollection: TargetState = { exists: true, type: "collection", documents: 0 };
const fullCollection: TargetState = { exists: true, type: "collection", documents: 5 };
const uncountedCollection: TargetState = {
  exists: true,
  type: "collection",
  documents: undefined,
};
const existingView: TargetState = { exists: true, type: "view", documents: 0 };
const emptyTimeSeries: TargetState = { exists: true, type: "timeseries", documents: 0 };
const fullTimeSeries: TargetState = { exists: true, type: "timeseries", documents: 3 };

function action(decision: ActionDecision): string {
  return "action" in decision ? decision.action : `conflict: ${decision.conflict}`;
}

describe("decideAction", () => {
  it.each<RestoreMode>(["fail-if-exists", "drop", "insert", "upsert"])(
    "creates a missing target in %s mode",
    (mode) => {
      expect(action(decideAction(mode, "collection", missing))).toBe("create");
      expect(action(decideAction(mode, "view", missing))).toBe("create");
      expect(action(decideAction(mode, "timeseries", missing))).toBe("create");
    },
  );

  describe("fail-if-exists", () => {
    it("restores into an existing empty collection", () => {
      expect(action(decideAction("fail-if-exists", "collection", emptyCollection))).toBe("insert");
    });

    it("refuses a non-empty collection", () => {
      expect(action(decideAction("fail-if-exists", "collection", fullCollection))).toMatch(
        /conflict: it already holds 5 documents/,
      );
    });

    it("refuses an existing view even though views hold no documents", () => {
      expect(action(decideAction("fail-if-exists", "view", existingView))).toMatch(/conflict/);
    });

    it("refuses a collection whose documents could not be counted", () => {
      expect(action(decideAction("fail-if-exists", "collection", uncountedCollection))).toMatch(
        /could not be counted/,
      );
    });

    it("refuses a target of another type, even when empty", () => {
      expect(action(decideAction("fail-if-exists", "timeseries", emptyCollection))).toMatch(
        /exists as a collection, but the backup holds a time series collection/,
      );
    });
  });

  describe("drop", () => {
    it("drops and recreates any existing target", () => {
      for (const target of [fullCollection, existingView, fullTimeSeries, uncountedCollection]) {
        expect(action(decideAction("drop", "collection", target))).toBe("drop-and-create");
      }
    });
  });

  describe("insert and upsert", () => {
    it("merge into an existing collection", () => {
      expect(action(decideAction("insert", "collection", fullCollection))).toBe("insert");
      expect(action(decideAction("upsert", "collection", fullCollection))).toBe("upsert");
      expect(action(decideAction("upsert", "collection", uncountedCollection))).toBe("upsert");
    });

    it("keep an existing view", () => {
      expect(action(decideAction("insert", "view", existingView))).toBe("skip");
      expect(action(decideAction("upsert", "view", existingView))).toBe("skip");
    });

    it("refuse a target of another type", () => {
      expect(action(decideAction("insert", "collection", existingView))).toMatch(/conflict/);
      expect(action(decideAction("upsert", "view", fullCollection))).toMatch(/conflict/);
    });

    it("insert into an empty time series but refuse to merge into a non-empty one", () => {
      expect(action(decideAction("insert", "timeseries", emptyTimeSeries))).toBe("insert");
      expect(action(decideAction("upsert", "timeseries", emptyTimeSeries))).toBe("insert");
      expect(action(decideAction("insert", "timeseries", fullTimeSeries))).toMatch(
        /cannot be merged/,
      );
    });
  });
});
