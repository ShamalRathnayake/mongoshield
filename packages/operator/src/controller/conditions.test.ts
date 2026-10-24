/** Tests for status conditions (Kubernetes API conventions). */

import { describe, expect, it } from "vitest";
import { findCondition, isConditionTrue, setCondition, setConditions } from "./conditions.ts";

const t1 = new Date("2026-10-24T10:00:00Z");
const t2 = new Date("2026-10-24T11:00:00Z");

describe("setCondition", () => {
  it("adds a new condition with the transition time and generation", () => {
    const conditions = setCondition(
      undefined,
      { type: "Ready", status: "True", reason: "Ok", message: "fine" },
      3,
      t1,
    );
    expect(conditions).toEqual([
      {
        type: "Ready",
        status: "True",
        reason: "Ok",
        message: "fine",
        observedGeneration: 3,
        lastTransitionTime: t1.toISOString(),
      },
    ]);
  });

  it("keeps the transition time while the status stays the same", () => {
    const first = setCondition(
      [],
      { type: "Ready", status: "False", reason: "A", message: "a" },
      1,
      t1,
    );
    const second = setCondition(
      first,
      { type: "Ready", status: "False", reason: "B", message: "b" },
      2,
      t2,
    );
    expect(second[0]).toMatchObject({
      reason: "B",
      message: "b",
      observedGeneration: 2,
      lastTransitionTime: t1.toISOString(),
    });
  });

  it("moves the transition time when the status flips, and leaves other types alone", () => {
    const start = setConditions(
      [],
      [
        { type: "Ready", status: "False", reason: "A", message: "" },
        { type: "Other", status: "True", reason: "X", message: "" },
      ],
      undefined,
      t1,
    );
    const flipped = setCondition(
      start,
      { type: "Ready", status: "True", reason: "Ok", message: "" },
      undefined,
      t2,
    );
    expect(findCondition(flipped, "Ready")?.lastTransitionTime).toBe(t2.toISOString());
    expect(findCondition(flipped, "Other")?.lastTransitionTime).toBe(t1.toISOString());
    expect(findCondition(flipped, "Ready")).not.toHaveProperty("observedGeneration");
    expect(isConditionTrue(flipped, "Ready")).toBe(true);
    expect(isConditionTrue(flipped, "Missing")).toBe(false);
  });

  it("caps very long messages", () => {
    const conditions = setCondition(
      [],
      { type: "T", status: "True", reason: "R", message: "x".repeat(40_000) },
      1,
      t1,
    );
    expect(conditions[0]?.message).toHaveLength(32_000);
  });
});
