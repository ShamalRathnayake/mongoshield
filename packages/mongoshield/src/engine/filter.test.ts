// Unit tests for the filter evaluator. The broad check against a real server lives
// in test/integration/find-filter.test.ts; these pin down documented behaviour and
// the error messages.

import {
  BSONRegExp,
  DBRef,
  Decimal128,
  type Document,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
} from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError, type MongoShieldError } from "../errors.ts";
import { compileFilter } from "./filter.ts";

function matches(filter: Document, document: Document): boolean {
  return compileFilter(filter)(document);
}

function compileError(filter: unknown): MongoShieldError {
  try {
    compileFilter(filter);
  } catch (error) {
    if (isMongoShieldError(error)) return error;
    throw error;
  }
  throw new Error("expected compileFilter to throw");
}

describe("compileFilter", () => {
  it("matches everything with an empty filter and ignores $comment", () => {
    expect(matches({}, { a: 1 })).toBe(true);
    expect(matches({ $comment: "why" }, { a: 1 })).toBe(true);
  });

  it("compares numbers exactly across Int32, Long, Double and Decimal128", () => {
    const big = { n: Long.fromString("9007199254740993") }; // 2^53 + 1
    expect(matches({ n: new Double(9007199254740992) }, big)).toBe(false);
    expect(matches({ n: { $gt: 9007199254740992 } }, big)).toBe(true);
    expect(matches({ n: Decimal128.fromString("9007199254740993.0") }, big)).toBe(true);
    expect(matches({ n: 1 }, { n: new Int32(1) })).toBe(true);
    expect(matches({ n: 0.1 }, { n: Decimal128.fromString("0.1") })).toBe(false);
    expect(matches({ n: 0 }, { n: new Double(-0) })).toBe(true);
  });

  it("brackets comparisons by type: $gt on a number never matches strings", () => {
    expect(matches({ a: { $gt: 1 } }, { a: "2" })).toBe(false);
    expect(matches({ a: { $lt: "b" } }, { a: "a" })).toBe(true);
    expect(matches({ a: { $gt: new MinKey() } }, {})).toBe(true);
    expect(matches({ a: { $lt: new MaxKey() } }, { a: "x" })).toBe(true);
  });

  it("orders strings by UTF-8 bytes, not UTF-16 code units", () => {
    // U+FF5E (BMP) sorts before U+1F600 (emoji) in UTF-8; JavaScript's < says otherwise.
    expect(matches({ a: { $lt: "😀" } }, { a: "～" })).toBe(true);
  });

  it("treats null as 'null or missing' and NaN as equal only to NaN", () => {
    expect(matches({ a: null }, {})).toBe(true);
    expect(matches({ a: null }, { a: [1] })).toBe(false);
    expect(matches({ a: { $ne: null } }, { a: 0 })).toBe(true);
    expect(matches({ a: Number.NaN }, { a: new Double(Number.NaN) })).toBe(true);
    expect(matches({ a: { $lt: 5 } }, { a: new Double(Number.NaN) })).toBe(false);
  });

  it("walks dotted paths through documents and arrays", () => {
    const document = {
      items: [
        { sku: "a", qty: 1 },
        { sku: "b", qty: 5 },
      ],
      tags: ["x", "y"],
    };
    expect(matches({ "items.sku": "b" }, document)).toBe(true);
    expect(matches({ "items.1.qty": 5 }, document)).toBe(true);
    expect(matches({ tags: "y" }, document)).toBe(true);
    expect(matches({ tags: ["x", "y"] }, document)).toBe(true);
    expect(matches({ tags: ["y", "x"] }, document)).toBe(false);
    expect(matches({ "items.qty": { $gt: 4 } }, document)).toBe(true);
  });

  it("supports $in/$nin with regexes, $exists, $type, $size and $not", () => {
    const document = { name: "Ada", tags: ["a", "b"], n: new Int32(3) };
    expect(matches({ name: { $in: [/^a/i, "x"] } }, document)).toBe(true);
    expect(matches({ name: { $nin: ["Ada"] } }, document)).toBe(false);
    expect(matches({ missing: { $exists: false } }, document)).toBe(true);
    expect(matches({ n: { $type: "int" } }, document)).toBe(true);
    expect(matches({ n: { $type: ["string", 16] } }, document)).toBe(true);
    expect(matches({ n: { $type: "number" } }, document)).toBe(true);
    expect(matches({ tags: { $size: 2 } }, document)).toBe(true);
    expect(matches({ n: { $not: { $gt: 5 } } }, document)).toBe(true);
    expect(matches({ name: { $not: /^A/ } }, document)).toBe(false);
  });

  it("supports both forms of $elemMatch", () => {
    const document = {
      scores: [3, 9],
      items: [
        { sku: "a", qty: 1 },
        { sku: "b", qty: 5 },
      ],
    };
    expect(matches({ scores: { $elemMatch: { $gt: 4, $lt: 10 } } }, document)).toBe(true);
    expect(matches({ items: { $elemMatch: { sku: "a", qty: { $gt: 2 } } } }, document)).toBe(false);
    expect(matches({ items: { $elemMatch: { sku: "b", qty: { $gt: 2 } } } }, document)).toBe(true);
  });

  it("supports $and, $or and $nor", () => {
    const document = { a: 1, b: 2 };
    expect(matches({ $and: [{ a: 1 }, { b: 2 }] }, document)).toBe(true);
    expect(matches({ $or: [{ a: 2 }, { b: 2 }] }, document)).toBe(true);
    expect(matches({ $nor: [{ a: 2 }, { b: 3 }] }, document)).toBe(true);
  });

  it("matches regexes with $regex/$options and treats $eq: /re/ as a literal", () => {
    expect(matches({ name: { $regex: "^ad", $options: "i" } }, { name: "Ada" })).toBe(true);
    expect(matches({ name: { $eq: /^A/ } }, { name: "Ada" })).toBe(false);
    expect(matches({ name: { $eq: /^A/ } }, { name: new BSONRegExp("^A", "") })).toBe(true);
  });

  it("matches ObjectIds, dates and DBRefs by value", () => {
    const id = new ObjectId();
    expect(matches({ _id: new ObjectId(id.toHexString()) }, { _id: id })).toBe(true);
    expect(matches({ at: { $gte: new Date(5) } }, { at: new Date(6) })).toBe(true);
    expect(
      matches(
        { "owner.$id": new ObjectId("64b7f0000000000000000007") },
        { owner: new DBRef("users", new ObjectId("64b7f0000000000000000007")) },
      ),
    ).toBe(true);
  });

  it("lists every unsupported operator in one MS_CONFIG_INVALID error", () => {
    const error = compileError({
      $where: "1",
      a: { $all: [1], $mod: [2, 0] },
      b: new BSONRegExp("x", "x"),
    });
    expect(error.code).toBe("MS_CONFIG_INVALID");
    expect(error.details?.unsupported).toEqual(["$all", "$mod", '$options "x"', "$where"]);
    expect(error.hint).toContain("$elemMatch");
  });

  it("explains malformed operator arguments", () => {
    expect(compileError({ a: { $in: 1 } }).message).toContain("$in needs an array");
    expect(compileError({ a: { $size: -1 } }).message).toContain("$size");
    expect(compileError({ a: { $type: "nope" } }).message).toContain("$type");
    expect(compileError({ $or: [] }).message).toContain("$or");
    expect(compileError({ a: { $regex: "(" } }).message).toContain("invalid regular expression");
    expect(compileError({ a: { $options: "i" } }).message).toContain("$options needs $regex");
    expect(compileError("name").message).toContain("must be a document");
  });
});
