// Unit tests for BSON value classification and MongoDB's comparison order
// (filter-values.ts): every type's comparison, exact numbers across types and in
// their corner cases, stored field order, and robustness against malformed BSON
// wrapper objects (values that claim a `_bsontype` without its fields).

import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "mongodb";
import { describe, expect, it } from "vitest";
import {
  bsonKind,
  bsonTag,
  canonicalRank,
  compareStrings,
  compareValues,
  documentFields,
  isBsonKindName,
  isIntegerLikeKey,
  isNaNValue,
  orderedEntries,
  recordStoredFieldOrder,
  regexParts,
  storedFieldOrder,
  toExactNumber,
  valuesEqual,
} from "./filter-values.ts";

/** The value of an exact fraction (fractions are not reduced, so compare the value). */
function ratio(exact: ReturnType<typeof toExactNumber>): number {
  if (exact.kind !== "finite") return Number.NaN;
  return Number(exact.numerator) / Number(exact.denominator);
}

/** A value that claims to be a js-bson class but has none of its fields. */
function fake(tag: string, fields: Record<string, unknown> = {}): object {
  return { _bsontype: tag, ...fields };
}

describe("bsonKind and bsonTag", () => {
  it("classifies JavaScript values and every js-bson class", () => {
    expect(bsonKind(null)).toBe("null");
    expect(bsonKind(undefined)).toBe("undefined");
    expect(bsonKind(1)).toBe("double");
    expect(bsonKind(1n)).toBe("long");
    expect(bsonKind("s")).toBe("string");
    expect(bsonKind(true)).toBe("bool");
    expect(bsonKind([])).toBe("array");
    expect(bsonKind(new Date(0))).toBe("date");
    expect(bsonKind(/a/)).toBe("regex");
    expect(bsonKind(new Code("x"))).toBe("javascript");
    expect(bsonKind(new Code("x", { a: 1 }))).toBe("javascriptWithScope");
    expect(bsonKind(new DBRef("c", new ObjectId()))).toBe("object");
    expect(bsonKind(fake("SomethingNew"))).toBe("object");
    expect(bsonKind(Symbol("s"))).toBe("object");
    expect(bsonTag("x")).toBeUndefined();
    expect(bsonTag(fake("Int32"))).toBe("Int32");
    expect(bsonTag({ _bsontype: 5 })).toBeUndefined();
    expect(isBsonKindName("int")).toBe(true);
    expect(isBsonKindName("number")).toBe(false);
  });
});

describe("compareValues", () => {
  it("orders values of different types by canonical type", () => {
    const ascending = [
      new MinKey(),
      null,
      1,
      "a",
      { a: 1 },
      [1],
      new Binary(Buffer.from("a")),
      new ObjectId("64b7f0000000000000000001"),
      false,
      new Date(0),
      new Timestamp({ t: 1, i: 1 }),
      /a/,
      new Code("x"),
      new Code("x", {}),
      new MaxKey(),
    ];
    for (let index = 1; index < ascending.length; index++) {
      expect(compareValues(ascending[index - 1], ascending[index]), String(index)).toBe(-1);
      expect(compareValues(ascending[index], ascending[index - 1]), String(index)).toBe(1);
    }
    expect(canonicalRank(new BSONSymbol("a"))).toBe(canonicalRank("a"));
  });

  it("compares within each type", () => {
    expect(compareValues(true, false)).toBe(1);
    expect(compareValues(new Date(1), new Date(2))).toBe(-1);
    expect(compareValues(new Timestamp({ t: 2, i: 0 }), new Timestamp({ t: 1, i: 9 }))).toBe(1);
    expect(compareValues(new Timestamp({ t: 1, i: 1 }), new Timestamp({ t: 1, i: 2 }))).toBe(-1);
    expect(compareValues(new BSONRegExp("a", "i"), /a/)).toBe(1);
    expect(compareValues(new BSONRegExp("a"), new BSONRegExp("b"))).toBe(-1);
    expect(compareValues(new Code("a"), new Code("b"))).toBe(-1);
    expect(compareValues(new Code("a", { x: 1 }), new Code("a", { x: 2 }))).toBe(-1);
    expect(compareValues(new BSONSymbol("b"), "a")).toBe(1);
    expect(compareValues(new MinKey(), new MinKey())).toBe(0);
    expect(compareValues(null, undefined)).toBe(1);
  });

  it("orders binaries by length, then subtype, then bytes", () => {
    expect(compareValues(new Binary(Buffer.from("zz")), new Binary(Buffer.from("aaa")))).toBe(-1);
    expect(compareValues(new Binary(Buffer.from("a"), 4), new Binary(Buffer.from("b"), 0))).toBe(1);
    expect(compareValues(new Binary(Buffer.from("a")), new Binary(Buffer.from("b")))).toBe(-1);
    expect(compareValues(new Binary(Buffer.from("a")), new Binary(Buffer.from("a")))).toBe(0);
  });

  it("compares documents by value type, then name, then value, then length", () => {
    expect(compareValues({ a: 1 }, { a: "x" })).toBe(-1);
    expect(compareValues({ a: 1 }, { b: 1 })).toBe(-1);
    expect(compareValues({ a: 2 }, { a: 1 })).toBe(1);
    expect(compareValues({ a: 1 }, { a: 1, b: 1 })).toBe(-1);
    expect(compareValues([1, 2], [1, 3])).toBe(-1);
    expect(compareValues([1, 2], [1])).toBe(1);
    const ref = new DBRef("users", new ObjectId("64b7f0000000000000000001"));
    expect(
      compareValues(ref, { $ref: "users", $id: new ObjectId("64b7f0000000000000000001") }),
    ).toBe(0);
  });

  it("orders strings by code point (UTF-8), handling surrogate pairs", () => {
    expect(compareStrings("a", "a")).toBe(0);
    expect(compareStrings("ab", "a")).toBe(1);
    expect(compareStrings("😀a", "😀b")).toBe(-1);
    expect(compareStrings("～", "😀")).toBe(-1);
  });
});

describe("numbers", () => {
  it("compares exactly across Int32, Long, Double, Decimal128 and bigint", () => {
    expect(compareValues(Long.fromString("9007199254740993"), 9007199254740992)).toBe(1);
    expect(compareValues(9007199254740993n, Long.fromString("9007199254740993"))).toBe(0);
    expect(compareValues(Decimal128.fromString("0.1"), 0.1)).toBe(-1);
    expect(compareValues(Decimal128.fromString("1.5E+3"), new Int32(1500))).toBe(0);
    expect(compareValues(Decimal128.fromString("-2.5"), -2)).toBe(-1);
    expect(compareValues(new Double(2 ** 60), Long.fromString("1152921504606846976"))).toBe(0);
    expect(compareValues(5e-324, 0)).toBe(1); // the smallest subnormal double
    expect(compareValues(-1.5, Long.fromNumber(-1))).toBe(-1);
  });

  it("orders NaN first and infinities around the finite numbers", () => {
    expect(compareValues(Number.NaN, Number.NEGATIVE_INFINITY)).toBe(-1);
    expect(compareValues(Number.NaN, new Double(Number.NaN))).toBe(0);
    expect(compareValues(1, Number.NaN)).toBe(1);
    expect(compareValues(Decimal128.fromString("NaN"), Long.fromNumber(0))).toBe(-1);
    expect(compareValues(Decimal128.fromString("Infinity"), Long.MAX_VALUE)).toBe(1);
    expect(compareValues(Decimal128.fromString("-Infinity"), Long.MIN_VALUE)).toBe(-1);
    expect(compareValues(Decimal128.fromString("Infinity"), Number.POSITIVE_INFINITY)).toBe(0);
    expect(isNaNValue(Decimal128.fromString("NaN"))).toBe(true);
    expect(isNaNValue("NaN")).toBe(false);
    expect(valuesEqual(new Double(-0), 0)).toBe(true);
  });

  it("converts numbers to exact fractions", () => {
    expect(ratio(toExactNumber(0.5))).toBe(0.5);
    expect(ratio(toExactNumber(-0.75))).toBe(-0.75);
    expect(toExactNumber(2 ** 70)).toEqual({
      kind: "finite",
      numerator: 2n ** 70n,
      denominator: 1n,
    });
    expect(toExactNumber(Decimal128.fromString("12"))).toEqual({
      kind: "finite",
      numerator: 12n,
      denominator: 1n,
    });
    expect(toExactNumber("not a number")).toEqual({ kind: "nan" });
  });
});

describe("malformed BSON wrapper objects", () => {
  it("compares them as empty values instead of throwing", () => {
    expect(compareValues(fake("Int32"), fake("Double"))).toBe(0); // both NaN
    expect(compareValues(fake("Long"), Long.fromNumber(0))).toBe(0);
    expect(compareValues(fake("Long", { toBigInt: () => "x" }), 0)).toBe(0);
    expect(compareValues(fake("Binary"), new Binary(Buffer.alloc(0)))).toBe(0);
    expect(
      compareValues(fake("Binary", { buffer: Buffer.from("ab") }), new Binary(Buffer.from("ab"))),
    ).toBe(0);
    expect(compareValues(fake("ObjectId"), fake("ObjectId"))).toBe(0);
    expect(compareValues(fake("BSONRegExp"), fake("BSONRegExp", { pattern: 1, options: 2 }))).toBe(
      0,
    );
    expect(compareValues(fake("BSONSymbol"), fake("BSONSymbol", { value: 3 }))).toBe(0);
    expect(compareValues(fake("Code", { code: 5 }), fake("Code", { code: "5" }))).toBe(0);
    expect(compareValues(fake("Decimal128", { toString: () => "garbage" }), Number.NaN)).toBe(0);
  });

  it("reads regex parts of anything", () => {
    expect(regexParts(/a/gi)).toEqual({ pattern: "a", flags: "gi" });
    expect(regexParts("a")).toEqual({ pattern: "", flags: "" });
    expect(regexParts(new BSONRegExp("x", "m"))).toEqual({ pattern: "x", flags: "m" });
  });
});

describe("stored field order", () => {
  it("recognises the names JavaScript lists first", () => {
    expect(isIntegerLikeKey("0")).toBe(true);
    expect(isIntegerLikeKey("4294967294")).toBe(true);
    expect(isIntegerLikeKey("4294967295")).toBe(false);
    expect(isIntegerLikeKey("01")).toBe(false);
    expect(isIntegerLikeKey("a")).toBe(false);
  });

  it("uses a recorded order, skipping missing and repeated names", () => {
    const document = { "0": "x", b: "y", c: "z" };
    recordStoredFieldOrder(document, ["b", "gone", "0", "b"]);
    expect(storedFieldOrder(document)).toEqual(["b", "gone", "0", "b"]);
    expect(orderedEntries(document)).toEqual([
      ["b", "y"],
      ["0", "x"],
      ["c", "z"],
    ]);
    expect(orderedEntries({ a: 1 })).toEqual([["a", 1]]);
  });

  it("unpacks DBRefs into the document they are stored as", () => {
    const id = new ObjectId();
    expect(documentFields(new DBRef("users", id, "app"))).toEqual({
      $ref: "users",
      $id: id,
      $db: "app",
    });
    expect(documentFields(fake("DBRef", { toJSON: () => "not a document" }))).toMatchObject({
      _bsontype: "DBRef",
    });
  });
});
