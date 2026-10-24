// The helpers that look inside validators, pipelines, index keys and stored
// JavaScript for the upgrade compatibility rules.

import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  bsonTypeOf,
  codeText,
  forEachField,
  hasEqualityLookup,
  invalidRegexOptions,
  javaScriptSources,
  matchQueries,
  nullEqualityPaths,
  numberValue,
  operatorsUsed,
  regexOptionsIn,
  removedStaticFunctionCalls,
} from "./upgrade-compat-scan.ts";

describe("numberValue", () => {
  it("reads plain numbers and every BSON number type", () => {
    expect(numberValue(3)).toBe(3);
    expect(numberValue(new BSON.Int32(-1))).toBe(-1);
    expect(numberValue(new BSON.Double(0.5))).toBe(0.5);
    expect(numberValue(BSON.Long.fromNumber(7))).toBe(7);
    expect(numberValue(BSON.Decimal128.fromString("2.5"))).toBe(2.5);
  });

  it("keeps NaN, which the TTL and key rules look for", () => {
    expect(numberValue(new BSON.Double(Number.NaN))).toBeNaN();
    expect(numberValue(BSON.Decimal128.fromString("NaN"))).toBeNaN();
  });

  it("is undefined for anything else", () => {
    for (const value of ["1", true, null, undefined, {}, new BSON.ObjectId()]) {
      expect(numberValue(value)).toBeUndefined();
    }
  });
});

describe("bsonTypeOf and codeText", () => {
  it("names BSON value classes only", () => {
    expect(bsonTypeOf(new BSON.Int32(1))).toBe("Int32");
    expect(bsonTypeOf({ a: 1 })).toBeUndefined();
    expect(bsonTypeOf(null)).toBeUndefined();
  });

  it("reads code from Code values and strings", () => {
    expect(codeText(new BSON.Code("function () {}"))).toBe("function () {}");
    expect(codeText("return 1")).toBe("return 1");
    expect(codeText(42)).toBeUndefined();
  });
});

describe("forEachField and operatorsUsed", () => {
  it("walks embedded documents and arrays, not BSON values", () => {
    const seen: string[] = [];
    forEachField({ a: [{ b: 1 }, 2], c: new BSON.ObjectId(), d: { e: null } }, (name) =>
      seen.push(name),
    );
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("collects every $-prefixed name, at any depth", () => {
    const pipeline = [
      { $match: { $or: [{ a: { $gt: 1 } }] } },
      { $setWindowFields: { output: { r: { $rank: {} } } } },
    ];
    expect([...operatorsUsed(pipeline)].sort()).toEqual([
      "$gt",
      "$match",
      "$or",
      "$rank",
      "$setWindowFields",
    ]);
  });
});

describe("javaScriptSources", () => {
  it("finds $function bodies, $accumulator parts and $where code", () => {
    const pipeline = [
      {
        $addFields: {
          x: { $function: { body: new BSON.Code("function(a){return a}"), args: [], lang: "js" } },
        },
      },
      {
        $group: {
          _id: null,
          y: {
            $accumulator: {
              init: "function(){return 0}",
              accumulate: new BSON.Code("function(s){return s}"),
              merge: "function(a,b){return a+b}",
              lang: "js",
            },
          },
        },
      },
      { $match: { $where: "this.a > 1" } },
    ];
    expect(javaScriptSources(pipeline)).toEqual([
      "function(a){return a}",
      "function(){return 0}",
      "function(s){return s}",
      "function(a,b){return a+b}",
      "this.a > 1",
    ]);
  });

  it("ignores operators without code, and non-code values", () => {
    expect(javaScriptSources({ $function: "not a document", $where: 5, a: { body: "x" } })).toEqual(
      [],
    );
  });
});

describe("removedStaticFunctionCalls", () => {
  it("finds the static functions MongoDB 6.0 removed", () => {
    expect(
      removedStaticFunctionCalls("return Array.concat(a, b).length + String.trim(s).length"),
    ).toEqual(["Array.concat", "String.trim"]);
    expect(removedStaticFunctionCalls("Array . map ( x )")).toEqual(["Array.map"]);
  });

  it("does not flag prototype methods, other objects, or functions that still exist", () => {
    expect(
      removedStaticFunctionCalls("[1].concat([2]); s.trim(); Array.isArray(a); Array.from(b)"),
    ).toEqual([]);
    expect(
      removedStaticFunctionCalls("MyArray.concat(a); obj.Array.map(f); $Array.join()"),
    ).toEqual([]);
  });
});

describe("regexOptionsIn and invalidRegexOptions", () => {
  it("reads options of BSON regexes, JavaScript regexes and $regex/$options pairs", () => {
    const validator = {
      a: new BSON.BSONRegExp("^x", "il"),
      b: { $regex: "y", $options: "m" },
      c: { $options: "z" },
      d: [/z/s],
    };
    expect(regexOptionsIn(validator).sort()).toEqual(["il", "m", "s"]);
    expect(regexOptionsIn(new BSON.BSONRegExp("x", "l"))).toEqual(["l"]);
  });

  it("lists the options MongoDB does not accept, once each", () => {
    expect(invalidRegexOptions("imxsu")).toEqual([]);
    expect(invalidRegexOptions("iqlq")).toEqual(["q", "l"]);
  });
});

describe("nullEqualityPaths", () => {
  it("finds equality and inequality comparisons with null", () => {
    expect(
      nullEqualityPaths({
        a: null,
        b: { $eq: null },
        c: { $in: [1, null] },
        d: { $ne: null },
        e: { $nin: [null] },
        f: { $in: [1, 2] },
        g: { $exists: true },
        h: 5,
      }),
    ).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("follows $and/$or/$nor and $elemMatch, not $expr", () => {
    expect(
      nullEqualityPaths({
        $or: [{ x: null }, { $and: [{ y: { $eq: null } }] }],
        $nor: [{ z: null }],
        items: { $elemMatch: { sku: null } },
        $expr: { $eq: ["$w", null] },
      }),
    ).toEqual(["items.sku", "x", "y", "z"]);
  });

  it("is empty for non-documents", () => {
    expect(nullEqualityPaths(null)).toEqual([]);
    expect(nullEqualityPaths([{ a: null }])).toEqual([]);
  });
});

describe("matchQueries and hasEqualityLookup", () => {
  it("collects $match stages, also in sub-pipelines", () => {
    const pipeline = [
      { $match: { a: 1 } },
      { $lookup: { from: "o", pipeline: [{ $match: { b: null } }], as: "j" } },
    ];
    expect(matchQueries(pipeline)).toEqual([{ a: 1 }, { b: null }]);
    expect(hasEqualityLookup(pipeline)).toBe(false);
  });

  it("detects localField/foreignField joins", () => {
    expect(
      hasEqualityLookup([{ $lookup: { from: "o", localField: "a", foreignField: "b", as: "j" } }]),
    ).toBe(true);
  });
});
