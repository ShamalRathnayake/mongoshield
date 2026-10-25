/**
 * Tests for parsing Extended JSON filters (document browser and selected-document restores).
 */

import { Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { MAX_FILTER_LENGTH, parseExtendedJsonFilter } from "./filter.ts";

describe("parseExtendedJsonFilter", () => {
  it("treats an absent or blank filter as none", () => {
    expect(parseExtendedJsonFilter(undefined, "The filter")).toBeUndefined();
    expect(parseExtendedJsonFilter("   ", "The filter")).toBeUndefined();
  });

  it("keeps canonical Extended JSON types so they match backed-up values exactly", () => {
    const filter = parseExtendedJsonFilter(
      '{"_id": {"$oid": "65f0c0ffee0000000000abcd"}, "n": {"$numberLong": "7"}}',
      "The filter",
    );
    expect(filter?._id).toBeInstanceOf(ObjectId);
    expect(filter?.n).toBeInstanceOf(Long);
  });

  it("refuses filters that are too long, not JSON, or not an object", () => {
    expect(() =>
      parseExtendedJsonFilter(`{"a":"${"x".repeat(MAX_FILTER_LENGTH)}"}`, "The filter"),
    ).toThrow(/at most/);
    expect(() => parseExtendedJsonFilter("{ nope", "The filter")).toThrow(
      /not valid Extended JSON/,
    );
    expect(() => parseExtendedJsonFilter("[1, 2]", '"filter"')).toThrow(
      /"filter" must be a JSON object/,
    );
  });
});
