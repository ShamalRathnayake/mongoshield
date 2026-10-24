/**
 * Unit tests for ejson-text.ts: relaxed Extended JSON that keeps Int64 values beyond 2^53
 * exact, and an edit merge that leaves such a value untouched.
 */

import { Decimal128, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { relaxedText } from "./ejson-text.ts";
import { mergeEdit } from "./live/documents.ts";

describe("relaxedText", () => {
  it("keeps Int64 values beyond 2^53 as $numberLong, inside documents and arrays", () => {
    const text = relaxedText({
      big: Long.fromString("9007199254740993"),
      small: Long.fromNumber(42),
      nested: { values: [Long.fromString("-9007199254740995"), 1] },
    });
    expect(JSON.parse(text)).toEqual({
      big: { $numberLong: "9007199254740993" },
      small: 42,
      nested: { values: [{ $numberLong: "-9007199254740995" }, 1] },
    });
  });

  it("writes everything else exactly like relaxed Extended JSON", () => {
    const id = new ObjectId("65f1c2a0e4b0a1b2c3d4e5f6");
    const value = {
      _id: id,
      at: new Date("2026-10-24T00:00:00.000Z"),
      price: Decimal128.fromString("9.99"),
      name: "Ada",
      none: null,
    };
    expect(relaxedText(value)).toBe(
      '{"_id":{"$oid":"65f1c2a0e4b0a1b2c3d4e5f6"},"at":{"$date":"2026-10-24T00:00:00Z"},"price":{"$numberDecimal":"9.99"},"name":"Ada","none":null}',
    );
    expect(relaxedText([1, "a"])).toBe('[1,"a"]');
  });

  it("lets an edit leave an exact Int64 as it was", () => {
    const original = { _id: 1, big: Long.fromString("9007199254740993"), name: "a" };
    const edited = JSON.parse(relaxedText(original));
    edited.name = "b";
    const merged = mergeEdit(original, { ...edited, big: Long.fromString("9007199254740993") });
    expect(merged.changedFields).toEqual(["name"]);
    expect(String(merged.document.big)).toBe("9007199254740993");
  });
});
