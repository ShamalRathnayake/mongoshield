/**
 * Unit tests for quick-filter.ts and autocomplete.ts: building filters from clicks
 * (equals, not equals, exists, missing, ranges, merged into what is typed), removing a
 * condition, describing conditions as chips, and field name suggestions while typing.
 */

import { describe, expect, it } from "vitest";
import {
  applyCompletion,
  completionContext,
  MAX_SUGGESTIONS,
  suggestionsFor,
} from "./autocomplete.ts";
import { addCondition, conditionOf, describeConditions, removeCondition } from "./quick-filter.ts";

describe("addCondition", () => {
  it("starts a filter from an empty box", () => {
    expect(addCondition("", { path: "status", op: "equals", value: "paid" })).toEqual({
      ok: true,
      text: '{"status":"paid"}',
    });
  });

  it("adds to what is already typed, keeping EJSON values as they are", () => {
    const edit = addCondition('{"plan": "pro"}', {
      path: "userId",
      op: "notEquals",
      value: { $oid: "65f1c2a0e4b0a1b2c3d4e5f6" },
    });
    expect(edit.ok && JSON.parse(edit.text)).toEqual({
      plan: "pro",
      userId: { $ne: { $oid: "65f1c2a0e4b0a1b2c3d4e5f6" } },
    });
  });

  it("replaces a value condition on the same field", () => {
    const edit = addCondition('{"status": "open"}', {
      path: "status",
      op: "equals",
      value: "paid",
    });
    expect(edit.ok && edit.text).toBe('{"status":"paid"}');
  });

  it("merges two operator conditions on the same field (two range clicks)", () => {
    const first = addCondition("", { path: "total", op: "range", from: 10 });
    const second = first.ok
      ? addCondition(first.text, { path: "total", op: "range", to: 20 })
      : first;
    expect(second.ok && JSON.parse(second.text)).toEqual({ total: { $gte: 10, $lt: 20 } });
  });

  it("refuses to touch a filter box with invalid text", () => {
    expect(addCondition("{oops", { path: "a", op: "exists" }).ok).toBe(false);
    expect(addCondition("[1]", { path: "a", op: "exists" }).ok).toBe(false);
  });

  it("builds each kind of condition", () => {
    expect(conditionOf({ path: "a", op: "equals" })).toBeNull();
    expect(conditionOf({ path: "a", op: "notEquals", value: 1 })).toEqual({ $ne: 1 });
    expect(conditionOf({ path: "a", op: "exists" })).toEqual({ $exists: true });
    expect(conditionOf({ path: "a", op: "missing" })).toEqual({ $exists: false });
    expect(
      conditionOf({
        path: "a",
        op: "range",
        from: { $date: "2026-01-01" },
        to: 5,
        inclusive: true,
      }),
    ).toEqual({ $gte: { $date: "2026-01-01" }, $lte: 5 });
  });
});

describe("removeCondition and chips", () => {
  it("removes one field's condition and clears the box when it was the last", () => {
    const edit = removeCondition('{"a": 1, "b": 2}', "a");
    expect(edit.ok && edit.text).toBe('{"b":2}');
    const last = removeCondition('{"b": 2}', "b");
    expect(last.ok && last.text).toBe("");
    expect(removeCondition("{nope", "a").ok).toBe(false);
  });

  it("describes conditions in words", () => {
    const chips = describeConditions(
      JSON.stringify({
        status: "paid",
        total: { $gte: 10, $lt: 20 },
        email: { $exists: true },
        phone: { $exists: false },
        userId: { $oid: "65f1c2a0e4b0a1b2c3d4e5f6" },
        tags: { $in: ["a", "b"] },
        $or: [{ a: 1 }, { b: 2 }],
        $and: { a: 1 },
        note: { $custom: "x" },
        long: "x".repeat(80),
      }),
    );
    expect(chips.map((chip) => chip.label)).toEqual([
      'status is "paid"',
      "total ≥ 10 and < 20",
      "email exists",
      "phone is missing",
      "userId is 65f1c2a0e4b0a1b2c3d4e5f6",
      "tags is one of [2 items]",
      "$or (2 conditions)",
      "$and (1 condition)",
      'note $custom "x"',
      `long is "${"x".repeat(38)}…`,
    ]);
    expect(describeConditions(undefined)).toEqual([]);
    expect(describeConditions("{nope")).toEqual([]);
  });
});

describe("field suggestions", () => {
  const fields = ["status", "address.city", "address.zip", "createdAt", "_id"];

  it("suggests fields where a key goes, after { or , and an optional quote", () => {
    const text = '{"addr';
    const context = completionContext(text, text.length);
    expect(context).toMatchObject({ prefix: "addr", kind: "field", start: 1 });
    expect(context === undefined ? [] : suggestionsFor(context, fields)).toEqual([
      "address.city",
      "address.zip",
    ]);
    expect(completionContext('{"a": 1, st', 11)).toMatchObject({ prefix: "st", start: 9 });
  });

  it("suggests nothing inside a value or before anything is typed", () => {
    expect(completionContext('{"status": "pa', 14)).toBeUndefined();
    expect(completionContext("{", 1)).toBeUndefined();
    // An opening quote alone is enough to ask for every field.
    const quoted = completionContext('{"', 2);
    expect(quoted === undefined ? [] : suggestionsFor(quoted, fields)).toHaveLength(fields.length);
  });

  it("suggests operators after $, and fields containing the text after those starting with it", () => {
    const operator = completionContext('{"total": {"$gt', 15);
    expect(operator?.kind).toBe("operator");
    expect(operator === undefined ? [] : suggestionsFor(operator, fields)).toEqual(["$gte"]);
    const contains = completionContext('{"zip', 5);
    expect(contains === undefined ? [] : suggestionsFor(contains, fields)).toEqual(["address.zip"]);
    const many = completionContext('{"', 2);
    expect(
      many === undefined
        ? []
        : suggestionsFor(
            many,
            Array.from({ length: 20 }, (_, i) => `f${i}`),
          ),
    ).toHaveLength(MAX_SUGGESTIONS);
  });

  it("writes the accepted field as a quoted key with a colon, replacing the whole word", () => {
    const text = '{"addr';
    const context = completionContext(text, text.length);
    if (context === undefined) throw new Error("no context");
    expect(applyCompletion(text, context, "address.city")).toEqual({
      text: '{"address.city": ',
      caret: 17,
    });
    // In the middle of a key that already has its colon: the colon is kept, not doubled.
    const existing = '{"sta": 1}';
    const middle = completionContext(existing, 4);
    if (middle === undefined) throw new Error("no context");
    expect(applyCompletion(existing, middle, "status").text).toBe('{"status": 1}');
  });
});
