// Unit tests for keeping stored field order through JavaScript objects
// (field-order.ts): parse → (optional changes) → inStoredOrder → serialize gives back
// the original bytes for any document, documents without integer-like names take the
// fast path untouched, and the helpers for `_id`s and assembled documents.

import fc from "fast-check";
import { BSON, type Document, Int32 } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  bytesOf,
  documentFor,
  embeddedDocument,
  knownReorderedDocument,
} from "../../test/helpers/ordered-documents.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "./bson-stream.ts";
import {
  deserializeInStoredOrder,
  documentId,
  inStoredOrder,
  inStoredOrderAnywhere,
  isIntegerLikeKey,
  storedFieldOrder,
  valueInStoredOrder,
} from "./field-order.ts";

/** What the write paths do with a document: parse, then hand `inStoredOrder` to BSON. */
function roundTrip(bytes: Buffer): Buffer {
  return Buffer.from(BSON.serialize(inStoredOrder(deserializeInStoredOrder(bytes))));
}

describe("deserializeInStoredOrder + inStoredOrder", () => {
  it("gives back the original bytes for any document, whatever its field names", () => {
    fc.assert(
      fc.property(documentFor(1), (document) => {
        const bytes = bytesOf(document);
        expect(roundTrip(bytes).equals(bytes)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("keeps integer-like names after others at every depth, in arrays and in the _id", () => {
    const bytes = bytesOf(knownReorderedDocument(1));
    // The bug this file exists for: a plain parse moves "1", "7", "0" and "2" first.
    const plain = Buffer.from(
      BSON.serialize(BSON.deserialize(bytes, LOSSLESS_DESERIALIZE_OPTIONS)),
    );
    expect(plain.equals(bytes)).toBe(false);
    expect(roundTrip(bytes).equals(bytes)).toBe(true);
  });

  it("returns ordinary documents as parsed, without recording anything", () => {
    const bytes = Buffer.from(BSON.serialize({ _id: 1, a: { b: [{ c: 1 }] }, "01": 2, "-1": 3 }));
    const parsed = deserializeInStoredOrder(bytes);
    expect(storedFieldOrder(parsed)).toBeUndefined();
    expect(inStoredOrder(parsed)).toBe(parsed);
    expect(inStoredOrderAnywhere(parsed)).toBe(parsed);
  });

  it("keeps parsed documents plain objects, so filters and masks can read them", () => {
    const parsed = deserializeInStoredOrder(bytesOf(knownReorderedDocument(1)));
    expect(parsed).not.toBeInstanceOf(Map);
    expect(parsed.b).toEqual(new Int32(1));
    expect(storedFieldOrder(parsed)).toEqual(["_id", "b", "7", "nested", "list"]);
  });

  it("writes fields a transform added after the stored ones, and drops removed ones", () => {
    const parsed = deserializeInStoredOrder(bytesOf(knownReorderedDocument(1)));
    parsed.added = "x";
    delete parsed.b;
    const expected = knownReorderedDocument(1);
    expected.delete("b");
    expected.set("added", "x");
    expect(Buffer.from(BSON.serialize(inStoredOrder(parsed)))).toEqual(bytesOf(expected));
  });

  it("does not modify the parsed document", () => {
    const parsed = deserializeInStoredOrder(bytesOf(knownReorderedDocument(1)));
    const before = BSON.serialize(parsed);
    inStoredOrder(parsed);
    expect(Buffer.from(BSON.serialize(parsed)).equals(Buffer.from(before))).toBe(true);
  });
});

describe("DBRef-shaped sub-documents", () => {
  /** `{ ref: { $ref, $id, …extra } }` in exactly the given order. */
  function withReference(reference: Map<string, unknown>): Buffer {
    return bytesOf(
      new Map<string, unknown>([
        ["_id", new Int32(1)],
        ["ref", reference],
      ]),
    );
  }

  it("keeps the order of extra fields and of an embedded-document $id", () => {
    const bytes = withReference(
      new Map<string, unknown>([
        ["$ref", "users"],
        [
          "$id",
          new Map<string, unknown>([
            ["b", new Int32(1)],
            ["1", new Int32(2)],
          ]),
        ],
        ["$db", "app"],
        ["b", new Int32(2)],
        ["1", "x"],
      ]),
    );
    // js-bson parses it into a DBRef whose `fields` and `oid` list "1" first.
    const plain = Buffer.from(
      BSON.serialize(BSON.deserialize(bytes, LOSSLESS_DESERIALIZE_OPTIONS)),
    );
    expect(plain.equals(bytes)).toBe(false);
    expect(roundTrip(bytes).equals(bytes)).toBe(true);
    // Also when it is reached from a root built in memory.
    const parsed = deserializeInStoredOrder(bytes);
    const assembled = { _id: parsed._id, ref: parsed.ref };
    expect(Buffer.from(BSON.serialize(inStoredOrderAnywhere(assembled))).equals(bytes)).toBe(true);
  });

  it("keeps a DBRef without $db, and leaves DBRefs of ordinary documents to js-bson", () => {
    const bytes = withReference(
      new Map<string, unknown>([
        ["$ref", "users"],
        ["$id", new Int32(7)],
        ["z", true],
        ["0", null],
      ]),
    );
    expect(roundTrip(bytes).equals(bytes)).toBe(true);
    const ordinary = withReference(
      new Map<string, unknown>([
        ["$ref", "users"],
        ["$id", new Int32(7)],
      ]),
    );
    const parsed = deserializeInStoredOrder(ordinary);
    expect(inStoredOrder(parsed)).toBe(parsed);
    expect(roundTrip(ordinary).equals(ordinary)).toBe(true);
  });
});

describe("helpers for the write paths", () => {
  it("reads the _id of plain and rebuilt documents", () => {
    const parsed = deserializeInStoredOrder(bytesOf(knownReorderedDocument(4)));
    const rebuilt = inStoredOrder(parsed);
    expect(rebuilt).toBeInstanceOf(Map);
    const id = documentId(rebuilt);
    expect(id).toBeInstanceOf(Map);
    expect(Buffer.from(BSON.serialize({ _id: id }))).toEqual(
      Buffer.from(BSON.serialize({ _id: knownReorderedDocument(4).get("_id") })),
    );
    expect(documentId({ _id: 5 })).toBe(5);
    expect(documentId(new Map([["a", 1]]))).toBeUndefined();
  });

  it("finds recorded orders below a root built in memory", () => {
    fc.assert(
      fc.property(embeddedDocument, (value) => {
        const bytes = Buffer.from(BSON.serialize({ value }));
        const parsed = deserializeInStoredOrder(bytes).value;
        // A fresh root, like `{ ...event, fullDocument }` or a replayed `$set`.
        const assembled: Document = { value: parsed };
        expect(Buffer.from(BSON.serialize(inStoredOrderAnywhere(assembled)))).toEqual(bytes);
        expect(Buffer.from(BSON.serialize({ value: valueInStoredOrder(parsed) }))).toEqual(bytes);
      }),
      { numRuns: 300 },
    );
  });

  it("leaves values without recorded order alone", () => {
    const value = { a: 1, list: [{ b: 2 }] };
    expect(valueInStoredOrder(value)).toBe(value);
    expect(valueInStoredOrder(7)).toBe(7);
  });
});

describe("isIntegerLikeKey", () => {
  it("matches exactly the names JavaScript lists first", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (name) => {
        const object: Document = { "\u0000first": 1 };
        object[name] = 2;
        const listedFirst = Object.keys(object)[0] === name && name !== "\u0000first";
        expect(isIntegerLikeKey(name)).toBe(listedFirst);
      }),
      { numRuns: 1000 },
    );
    for (const name of ["0", "7", "42", "4294967294"]) expect(isIntegerLikeKey(name)).toBe(true);
    for (const name of ["01", "-1", "1.5", "4294967295", "", "a1"]) {
      expect(isIntegerLikeKey(name)).toBe(false);
    }
  });
});
