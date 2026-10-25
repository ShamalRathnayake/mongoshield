/**
 * Unit tests for bson.ts: recognising every BSON type in relaxed and canonical Extended
 * JSON, the values inside them (ObjectId timestamps, dates, numbers, binary sizes,
 * UUIDs), their one-line text, and flattening documents into dot-path columns.
 */

import { describe, expect, it } from "vitest";
import {
  BSON_TYPE_LABELS,
  base64Bytes,
  binaryInfo,
  bsonTypeOf,
  columnsOf,
  dateOf,
  flattenDocument,
  isNumericType,
  isPlainObject,
  numberOf,
  objectIdHex,
  objectIdTime,
  shortText,
  uuidText,
  valueAtPath,
  wrapperKey,
} from "./bson.ts";
import type { JsonValue } from "./ejson.ts";

/** One value of every type, as relaxed (or canonical) Extended JSON writes it. */
const SAMPLES: readonly [JsonValue, ReturnType<typeof bsonTypeOf>][] = [
  [{ $oid: "65f1c2a0e4b0a1b2c3d4e5f6" }, "objectId"],
  [{ $date: "2026-10-24T14:18:56.911Z" }, "date"],
  [{ $date: { $numberLong: "1792850336911" } }, "date"],
  ["text", "string"],
  [42, "number"],
  [{ $numberInt: "42" }, "int"],
  [{ $numberLong: "9007199254740993" }, "long"],
  [{ $numberDouble: "Infinity" }, "double"],
  [{ $numberDecimal: "9.99" }, "decimal"],
  [true, "boolean"],
  [null, "null"],
  [{ $binary: { base64: "AAEC", subType: "00" } }, "binary"],
  [{ $binary: { base64: "AAECAwQFBgcICQoLDA0ODw==", subType: "04" } }, "uuid"],
  [{ $uuid: "00010203-0405-0607-0809-0a0b0c0d0e0f" }, "uuid"],
  [{ $regularExpression: { pattern: "^a", options: "i" } }, "regex"],
  [{ $timestamp: { t: 1_700_000_000, i: 3 } }, "timestamp"],
  [{ $minKey: 1 }, "minKey"],
  [{ $maxKey: 1 }, "maxKey"],
  [{ $code: "function () {}" }, "code"],
  [{ $code: "x", $scope: { a: 1 } }, "code"],
  [{ $symbol: "sym" }, "symbol"],
  [{ $dbPointer: { $ref: "c", $id: { $oid: "65f1c2a0e4b0a1b2c3d4e5f6" } } }, "dbPointer"],
  [{ $undefined: true }, "undefined"],
  [[1, 2], "array"],
  [{ a: 1 }, "object"],
  [{}, "object"],
];

describe("bsonTypeOf", () => {
  it.each(SAMPLES)("recognises %j as %s", (value, type) => {
    expect(bsonTypeOf(value)).toBe(type);
    // Every type has a name for people.
    expect(BSON_TYPE_LABELS[type]).toMatch(/^[A-Z]/);
  });

  it("treats objects with a $-key plus other keys as documents, not values", () => {
    expect(bsonTypeOf({ $oid: "65f1c2a0e4b0a1b2c3d4e5f6", other: 1 })).toBe("object");
    expect(wrapperKey({ $code: "x", other: 1 })).toBeUndefined();
    expect(isPlainObject({ $date: "2026-01-01T00:00:00Z" })).toBe(false);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("knows which types are numbers", () => {
    for (const type of ["number", "int", "long", "double", "decimal"] as const) {
      expect(isNumericType(type)).toBe(true);
    }
    expect(isNumericType("string")).toBe(false);
  });
});

describe("values inside wrappers", () => {
  it("reads the creation time of an ObjectId from its first four bytes", () => {
    // 0x65f1c2a0 seconds after the epoch.
    expect(objectIdTime("65f1c2a0e4b0a1b2c3d4e5f6")?.toISOString()).toBe(
      new Date(0x65f1c2a0 * 1000).toISOString(),
    );
    expect(objectIdTime("not-an-id")).toBeUndefined();
    expect(objectIdHex({ $oid: "abc" })).toBe("abc");
    expect(objectIdHex("abc")).toBeUndefined();
  });

  it("reads dates in relaxed (ISO), numeric and canonical ($numberLong) form", () => {
    expect(dateOf({ $date: "2026-10-24T00:00:00.000Z" })?.getTime()).toBe(
      Date.parse("2026-10-24T00:00:00.000Z"),
    );
    expect(dateOf({ $date: { $numberLong: "1000" } })?.getTime()).toBe(1000);
    expect(dateOf({ $date: 5 } as JsonValue)?.getTime()).toBe(5);
    expect(dateOf({ $date: "not a date" })).toBeUndefined();
    expect(dateOf("2026-10-24")).toBeUndefined();
  });

  it("reads numbers from plain numbers and every numeric wrapper", () => {
    expect(numberOf(3)).toBe(3);
    expect(numberOf({ $numberInt: "7" })).toBe(7);
    expect(numberOf({ $numberLong: "12" })).toBe(12);
    expect(numberOf({ $numberDouble: "1.5" })).toBe(1.5);
    expect(numberOf({ $numberDecimal: "9.99" })).toBe(9.99);
    expect(numberOf({ $numberDecimal: "NaN" })).toBeUndefined();
    expect(numberOf("3")).toBeUndefined();
  });

  it("measures binary data without decoding it, and reads UUIDs", () => {
    expect(base64Bytes("AAEC")).toBe(3);
    expect(base64Bytes("AAE=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
    expect(binaryInfo({ $binary: { base64: "AAEC", subType: "0" } })).toEqual({
      base64: "AAEC",
      bytes: 3,
      subType: "00",
    });
    expect(binaryInfo({ $binary: "broken" } as JsonValue)).toBeUndefined();
    expect(uuidText({ $binary: { base64: "AAECAwQFBgcICQoLDA0ODw==", subType: "04" } })).toBe(
      "00010203-0405-0607-0809-0a0b0c0d0e0f",
    );
    expect(uuidText({ $uuid: "abc" })).toBe("abc");
    // A subtype-4 binary of the wrong length is not a readable UUID.
    expect(uuidText({ $binary: { base64: "AAEC", subType: "04" } })).toBeUndefined();
    expect(
      uuidText({ $binary: { base64: "!!!!!!!!!!!!!!!!!!!!!!==", subType: "04" } }),
    ).toBeUndefined();
  });
});

describe("shortText", () => {
  it("writes each type the way people read it", () => {
    expect(shortText(null)).toBe("null");
    expect(shortText(true)).toBe("true");
    expect(shortText(1.5)).toBe("1.5");
    expect(shortText("plain")).toBe("plain");
    expect(shortText([1, 2, 3])).toBe("[3 items]");
    expect(shortText({ a: 1, b: 2 })).toBe("{2 fields}");
    expect(shortText({ $oid: "65f1c2a0e4b0a1b2c3d4e5f6" })).toBe("65f1c2a0e4b0a1b2c3d4e5f6");
    expect(shortText({ $date: "2026-10-24T00:00:00.000Z" })).toBe("2026-10-24T00:00:00.000Z");
    expect(shortText({ $date: "nope" })).toBe("Invalid date");
    expect(shortText({ $numberLong: "9007199254740993" })).toBe("9007199254740993");
    expect(shortText({ $numberDecimal: "9.99" })).toBe("9.99");
    expect(shortText({ $uuid: "u" })).toBe("u");
    expect(shortText({ $binary: { base64: "AAEC", subType: "00" } })).toBe("Binary · 3 bytes");
    expect(shortText({ $binary: { base64: "AAEC", subType: "04" } })).toBe("UUID");
    expect(shortText({ $regularExpression: { pattern: "^a", options: "i" } })).toBe("/^a/i");
    expect(shortText({ $timestamp: { t: 5, i: 1 } })).toBe("Timestamp(5, 1)");
    expect(shortText({ $code: "return 1" })).toBe("return 1");
    expect(shortText({ $symbol: "s" })).toBe("s");
    expect(shortText({ $minKey: 1 })).toBe("MinKey");
    expect(shortText({ $maxKey: 1 })).toBe("MaxKey");
    expect(shortText({ $undefined: true })).toBe("undefined");
    expect(shortText({ $dbPointer: {} })).toBe("DBPointer");
  });

  it("falls back to the type name for malformed wrappers", () => {
    expect(shortText({ $binary: "x" } as JsonValue)).toBe("Binary");
    expect(shortText({ $regularExpression: "x" } as JsonValue)).toBe("Regex");
    expect(shortText({ $timestamp: "x" } as JsonValue)).toBe("Timestamp");
    expect(shortText({ $oid: 5 } as JsonValue)).toBe("ObjectId");
  });

  it("cuts long strings with an ellipsis", () => {
    const text = shortText("x".repeat(500));
    expect(text).toHaveLength(120);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("dot paths", () => {
  const document = {
    _id: { $oid: "65f1c2a0e4b0a1b2c3d4e5f6" },
    name: "Ada",
    address: { city: "Colombo", geo: { lat: 6.9, lng: 79.8 } },
    tags: ["a", "b"],
    empty: {},
    created: { $date: "2026-01-01T00:00:00.000Z" },
  };

  it("flattens nested documents but keeps arrays, empty documents and EJSON values whole", () => {
    expect(flattenDocument(document).map(([path]) => path)).toEqual([
      "_id",
      "name",
      "address.city",
      "address.geo.lat",
      "address.geo.lng",
      "tags",
      "empty",
      "created",
    ]);
  });

  it("stops at the maximum depth", () => {
    expect(flattenDocument(document, 1).map(([path]) => path)).toContain("address");
    expect(flattenDocument({ a: { b: { c: 1 } } }, 2).map(([path]) => path)).toEqual(["a.b"]);
  });

  it("builds columns from several documents, with _id first and each path once", () => {
    expect(columnsOf([{ b: 1, _id: 1 }, { a: 2, b: 3 }, undefined, "not a document"])).toEqual([
      "_id",
      "b",
      "a",
    ]);
  });

  it("reads values at dot paths and says when they are missing", () => {
    expect(valueAtPath(document, "address.geo.lat")).toBe(6.9);
    expect(valueAtPath(document, "address.nowhere")).toBeUndefined();
    // Arrays and EJSON values are not walked into.
    expect(valueAtPath(document, "tags.0")).toBeUndefined();
    expect(valueAtPath(document, "created.$date")).toBeUndefined();
    expect(valueAtPath(undefined, "a")).toBeUndefined();
  });
});
