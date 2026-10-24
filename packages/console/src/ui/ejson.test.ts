/**
 * Unit tests for the browser's Extended JSON helpers: the filter check (empty, invalid,
 * non-object, unknown operators anywhere in the tree, wrappers left alone), document
 * parsing, wrapper display and document id labels.
 */

import { describe, expect, it } from "vitest";
import {
  checkFilter,
  describeWrapper,
  documentIdLabel,
  isJsonObject,
  parseDocument,
} from "./ejson.ts";

describe("checkFilter", () => {
  it("treats an empty box or {} as no filter", () => {
    expect(checkFilter("  ")).toEqual({ ok: true, filter: undefined });
    expect(checkFilter("{}")).toEqual({ ok: true, filter: undefined });
  });

  it("refuses JSON that is not an object", () => {
    for (const text of ["[1]", "42", "null"]) {
      const result = checkFilter(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/must be an object/);
    }
  });

  it("finds unknown operators inside arrays and nested objects", () => {
    const result = checkFilter('{"$or": [{"a": 1}, {"b": {"$bogus": 2}}]}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Unknown operator "\$bogus"/);
  });

  it("accepts operators and does not look inside type wrappers", () => {
    expect(
      checkFilter(
        '{ "_id": {"$oid": "65f0"}, "n": {"$gte": {"$numberLong": "5"}}, "x": {"$in": [1, null]} }',
      ),
    ).toEqual({
      ok: true,
      filter: '{"_id":{"$oid":"65f0"},"n":{"$gte":{"$numberLong":"5"}},"x":{"$in":[1,null]}}',
    });
  });
});

describe("parseDocument and isJsonObject", () => {
  it("parses JSON and returns undefined otherwise", () => {
    expect(parseDocument('{"a":1}')).toEqual({ a: 1 });
    expect(parseDocument("{nope")).toBeUndefined();
  });

  it("recognises plain objects only", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });
});

describe("describeWrapper", () => {
  it("shows each common EJSON type compactly", () => {
    expect(describeWrapper({ $oid: "abc" })?.text).toBe('ObjectId("abc")');
    expect(describeWrapper({ $date: "2026-01-01T00:00:00.000Z" })?.text).toBe(
      'ISODate("2026-01-01T00:00:00.000Z")',
    );
    expect(describeWrapper({ $date: { $numberLong: "0" } })?.text).toBe(
      'ISODate("1970-01-01T00:00:00.000Z")',
    );
    expect(describeWrapper({ $date: 5 })?.text).toBe('ISODate("5")');
    expect(describeWrapper({ $numberLong: "9" })?.text).toBe("NumberLong(9)");
    expect(describeWrapper({ $numberDecimal: "1.5" })?.text).toBe('NumberDecimal("1.5")');
    expect(describeWrapper({ $numberInt: "3" })).toEqual({ type: "Number", text: "3" });
    expect(describeWrapper({ $numberDouble: "2.5" })?.text).toBe("2.5");
    expect(describeWrapper({ $uuid: "u-1" })?.text).toBe('UUID("u-1")');
    expect(describeWrapper({ $minKey: 1 })).toEqual({ type: "minKey", text: "minKey(1)" });
  });

  it("leaves ordinary values alone", () => {
    expect(describeWrapper("text")).toBeUndefined();
    expect(describeWrapper({ $oid: "a", extra: 1 })).toBeUndefined();
    expect(describeWrapper({ name: "x" })).toBeUndefined();
  });
});

describe("documentIdLabel", () => {
  it("labels documents by their _id", () => {
    expect(documentIdLabel({ _id: { $oid: "abc" } })).toBe('ObjectId("abc")');
    expect(documentIdLabel({ _id: 7 })).toBe("7");
    expect(documentIdLabel({ name: "x" })).toBe("(no _id)");
    expect(documentIdLabel(undefined)).toBe("(unparseable document)");
    expect(documentIdLabel([1])).toBe("(unparseable document)");
  });
});
