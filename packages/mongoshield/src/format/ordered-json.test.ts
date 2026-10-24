// Unit tests for order-keeping JSON and Extended JSON (ordered-json.ts): the stored
// field order of documents survives text → values → text, values parse to exactly what
// `JSON.parse` / `BSON.EJSON.parse` give, and text is byte-identical to
// `JSON.stringify` / `BSON.EJSON.stringify` whenever no integer-like key is involved.

import fc from "fast-check";
import { BSON, Double, Int32, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { bytesOf, embeddedDocument } from "../../test/helpers/ordered-documents.ts";
import { deserializeInStoredOrder, valueInStoredOrder } from "./field-order.ts";
import {
  fromExtendedJson,
  parseExtendedJson,
  parseJsonInStoredOrder,
  stringifyExtendedJson,
  stringifyJsonInStoredOrder,
  toExtendedJson,
} from "./ordered-json.ts";

const CANONICAL = { relaxed: false } as const;
const RELAXED = { relaxed: true } as const;

/** The BSON bytes of a parsed value as written for the driver (`{ value }`). */
function bytesOfValue(value: unknown): Buffer {
  return Buffer.from(BSON.serialize(new Map([["value", valueInStoredOrder(value)]])));
}

describe("parseJsonInStoredOrder", () => {
  it("parses any JSON exactly like JSON.parse", () => {
    fc.assert(
      fc.property(fc.json(), (text) => {
        expect(parseJsonInStoredOrder(text)).toStrictEqual(JSON.parse(text));
      }),
      { numRuns: 500 },
    );
  });

  it("keeps whitespace, escapes, repeated names and __proto__ like JSON.parse", () => {
    const text = ' { "a" : "x\\"y\\u00e9" , "__proto__" : [ 1 , -0.5e2 ] , "a" : null } ';
    const parsed = parseJsonInStoredOrder(text);
    expect(parsed).toStrictEqual(JSON.parse(text));
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it("rejects what JSON.parse rejects", () => {
    for (const text of ["", "{", '{"a"}', "[1,]", "01", "tru", '"a', '{"a":1}x', "+1", "{'a':1}"]) {
      expect(() => JSON.parse(text)).toThrow(SyntaxError);
      expect(() => parseJsonInStoredOrder(text)).toThrow(SyntaxError);
    }
  });

  it("writes text back in its own order, which JSON.parse + JSON.stringify do not", () => {
    const text = '{"b":1,"1":{"z":true,"0":[{"k":"v","2":null}]},"a":[]}';
    expect(JSON.stringify(JSON.parse(text))).not.toBe(text);
    expect(stringifyJsonInStoredOrder(parseJsonInStoredOrder(text))).toBe(text);
  });
});

describe("stringifyJsonInStoredOrder", () => {
  it("is JSON.stringify for values without a recorded order, indented or not", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.constantFrom(0, 2), (value, space) => {
        expect(stringifyJsonInStoredOrder(value, space)).toBe(JSON.stringify(value, null, space));
      }),
      { numRuns: 300 },
    );
  });

  it("indents ordered objects like JSON.stringify, with empty objects and arrays", () => {
    const text = '{"b":{},"1":[],"c":[1,{"d":2}],"0":{"x":"y"}}';
    const parsed = parseJsonInStoredOrder(text);
    // Same text as JSON.stringify produces for the same content in this order.
    const expected = [
      "{",
      '  "b": {},',
      '  "1": [],',
      '  "c": [',
      "    1,",
      "    {",
      '      "d": 2',
      "    }",
      "  ],",
      '  "0": {',
      '    "x": "y"',
      "  }",
      "}",
    ].join("\n");
    expect(stringifyJsonInStoredOrder(parsed, 2)).toBe(expected);
  });
});

describe("Extended JSON", () => {
  it("round-trips any document's bytes through canonical text", () => {
    fc.assert(
      fc.property(embeddedDocument, (document) => {
        const bytes = bytesOf(new Map([["value", document]]));
        const parsed = deserializeInStoredOrder(bytes).value;
        const text = stringifyExtendedJson(parsed, CANONICAL);
        expect(bytesOfValue(parseExtendedJson(text, CANONICAL)).equals(bytes)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("writes exactly what BSON.EJSON.stringify writes when no order is recorded", () => {
    fc.assert(
      fc.property(embeddedDocument, fc.boolean(), (document, relaxed) => {
        // A plain parse: integer-like keys already first, nothing recorded.
        const value = BSON.deserialize(bytesOf(document));
        const options = { relaxed };
        expect(stringifyExtendedJson(value, options)).toBe(BSON.EJSON.stringify(value, options));
      }),
      { numRuns: 300 },
    );
  });

  it("parses to exactly what BSON.EJSON.parse gives, wrappers and operators included", () => {
    const text = JSON.stringify({
      key: { b: 1, a: -1 },
      filter: {
        $and: [{ n: { $gt: { $numberInt: "5" } } }, { r: { $regex: "^a", $options: "i" } }],
        when: { $date: { $numberLong: "1700000000000" } },
        id: { $oid: "0123456789abcdef01234567" },
        bin: { $binary: { base64: "AAE=", subType: "00" } },
        dec: { $numberDecimal: "1.5" },
        long: { $numberLong: "9007199254740993" },
        dbl: { $numberDouble: "-0.0" },
        ts: { $timestamp: { t: 1, i: 2 } },
        min: { $minKey: 1 },
        gone: { $undefined: true },
        ref: { $ref: "c", $id: 1 },
      },
      bare: [1, 1.5, -0, 2147483648, 1e300, "s", true, null],
    });
    for (const options of [CANONICAL, RELAXED]) {
      expect(parseExtendedJson(text, options)).toStrictEqual(BSON.EJSON.parse(text, options));
    }
  });

  it("keeps a compound index key and a validator in stored order", () => {
    const text = '{"key":{"b":1,"1":1,"a":-1},"validator":{"z":{"$gt":1},"2":{"$exists":true}}}';
    const parsed = parseExtendedJson(text, CANONICAL) as Record<string, unknown>;
    expect(stringifyExtendedJson(parsed, CANONICAL)).toBe(
      '{"key":{"b":{"$numberInt":"1"},"1":{"$numberInt":"1"},"a":{"$numberInt":"-1"}},' +
        '"validator":{"z":{"$gt":{"$numberInt":"1"}},"2":{"$exists":true}}}',
    );
    // And as BSON, the way the driver will send it.
    const key = valueInStoredOrder(parsed.key);
    expect(key).toBeInstanceOf(Map);
    expect([...(key as Map<string, unknown>).keys()]).toEqual(["b", "1", "a"]);
  });

  it("converts plain JSON values and back like EJSON.deserialize / serialize", () => {
    const value = { a: new Int32(1), b: new Double(2.5), c: new ObjectId(), d: [new Date(0)] };
    const json = toExtendedJson(value, CANONICAL);
    expect(json).toStrictEqual(BSON.EJSON.serialize(value, CANONICAL));
    expect(fromExtendedJson(json, CANONICAL)).toStrictEqual(value);
  });

  it("refuses field names with NUL bytes, like js-bson", () => {
    expect(() => parseExtendedJson('{"a\\u0000":1}', CANONICAL)).toThrow(/null bytes/);
  });
});
