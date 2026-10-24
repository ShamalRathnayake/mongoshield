// Unit tests for parsing backed-up documents (find-parse.ts): lossless values, the
// stored field order of integer-like names, every BSON type the raw walk has to step
// over, and damaged bytes.

import {
  Binary,
  BSON,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  type Document,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { orderedEntries, storedFieldOrder } from "./filter-values.ts";
import { parseBackedUpDocument } from "./find-parse.ts";

function ordered(entries: [string, unknown][]): Map<string, unknown> {
  return new Map(entries);
}

describe("parseBackedUpDocument", () => {
  it("keeps BSON types and records nothing for documents without integer-like names", () => {
    const document = parseBackedUpDocument(BSON.serialize({ a: new Int32(1), b: { c: 2 } }));
    expect(document.a).toBeInstanceOf(Int32);
    expect(storedFieldOrder(document)).toBeUndefined();
  });

  it("records the stored order at every depth, also inside arrays", () => {
    const raw = BSON.serialize(
      ordered([
        ["z", 1],
        ["1", "one"],
        [
          "nested",
          ordered([
            ["b", 1],
            ["0", 2],
          ]),
        ],
        [
          "list",
          [
            ordered([
              ["x", 1],
              ["7", 2],
            ]),
            5,
          ],
        ],
      ]),
    );
    const document = parseBackedUpDocument(raw);
    expect(storedFieldOrder(document)).toEqual(["z", "1", "nested", "list"]);
    expect(orderedEntries(document.nested as Document).map(([name]) => name)).toEqual(["b", "0"]);
    const [first] = document.list as Document[];
    expect(orderedEntries(first ?? {}).map(([name]) => name)).toEqual(["x", "7"]);
  });

  it("steps over every BSON type while walking", () => {
    const everyType = ordered([
      ["double", new Double(1.5)],
      ["string", "text"],
      ["binary", new Binary(Buffer.from("ab"), 4)],
      ["undefined", undefined],
      ["objectId", new ObjectId()],
      ["bool", true],
      ["date", new Date(0)],
      ["null", null],
      ["regex", new BSONRegExp("^a", "i")],
      ["code", new Code("x = 1")],
      ["symbol", new BSONSymbol("s")],
      ["codeWithScope", new Code("x", { y: 1 })],
      ["int", new Int32(1)],
      ["timestamp", new Timestamp({ t: 1, i: 2 })],
      ["long", Long.fromNumber(3)],
      ["decimal", Decimal128.fromString("1.0")],
      ["min", new MinKey()],
      ["max", new MaxKey()],
      ["ref", new DBRef("users", new ObjectId())],
      ["0", "last"],
    ]);
    const document = parseBackedUpDocument(BSON.serialize(everyType, { ignoreUndefined: false }));
    expect(storedFieldOrder(document)).toEqual([...everyType.keys()]);
    expect(orderedEntries(document).at(-1)).toEqual(["0", "last"]);
  });

  it("lists fields added after parsing after the stored ones, and skips removed ones", () => {
    const document = parseBackedUpDocument(
      BSON.serialize(
        ordered([
          ["b", 1],
          ["0", 2],
        ]),
      ),
    );
    document.c = 3;
    delete document.b;
    expect(orderedEntries(document).map(([name]) => name)).toEqual(["0", "c"]);
  });

  it("fails with MS_INTEGRITY_FAILED for bytes that are not BSON", () => {
    let caught: unknown;
    try {
      parseBackedUpDocument(Buffer.from([5, 0, 0, 0, 1]));
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_INTEGRITY_FAILED")).toBe(true);
  });
});
