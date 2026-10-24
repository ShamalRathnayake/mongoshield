// The byte-level BSON reader and builder used by the time-series and oplog conversions,
// checked against the js-bson parser on arbitrary documents.

import fc from "fast-check";
import {
  BSON,
  BSONRegExp,
  Code,
  DBRef,
  Decimal128,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { buildDocument, readElements } from "./raw-bson.ts";

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("readElements", () => {
  it("splits every BSON type into elements that rebuild the same document", () => {
    const document = Buffer.from(
      BSON.serialize(
        {
          double: 1.5,
          string: "héllo",
          document: { a: 1 },
          array: [1, "x"],
          binary: new BSON.Binary(Buffer.from([1, 2, 3]), 0x80),
          undefined: undefined,
          objectId: new ObjectId(),
          boolean: true,
          date: new Date(5),
          null: null,
          regex: new BSONRegExp("^a", "i"),
          dbRef: new DBRef("c", new ObjectId()),
          code: new Code("f()"),
          codeWithScope: new Code("f()", { x: 1 }),
          int32: new Int32(1),
          timestamp: new Timestamp({ t: 1, i: 2 }),
          int64: Long.fromNumber(3),
          decimal: Decimal128.fromString("1.5"),
          minKey: new MinKey(),
          maxKey: new MaxKey(),
        },
        { ignoreUndefined: false },
      ),
    );
    const elements = readElements(document, "test");
    expect(elements.map((element) => element.name)).toEqual(
      Object.keys(BSON.deserialize(document, { promoteValues: false })),
    );
    expect(
      buildDocument(elements.map((element) => [element.type, element.name, element.value])),
    ).toEqual(document);
  });

  it("agrees with js-bson on arbitrary documents (property)", () => {
    fc.assert(
      fc.property(fc.object({ maxDepth: 3 }), (value) => {
        const document = Buffer.from(BSON.serialize(value));
        const elements = readElements(document, "test");
        expect(elements.map((element) => element.name)).toEqual(
          Object.keys(BSON.deserialize(document)),
        );
        expect(
          buildDocument(elements.map((element) => [element.type, element.name, element.value])),
        ).toEqual(document);
      }),
    );
  });

  it("refuses documents whose framing is wrong", () => {
    const valid = Buffer.from(BSON.serialize({ a: "x", b: { c: 1 } }));
    const wrongLength = Buffer.from(valid);
    wrongLength.writeInt32LE(valid.length + 1, 0);
    const negative = Buffer.from(BSON.serialize({ s: "x" }));
    negative.writeInt32LE(-5, 7);
    const unterminatedName = Buffer.from([8, 0, 0, 0, 0x10, 0x61, 0x62, 0]);
    const unknownType = Buffer.from([8, 0, 0, 0, 0x20, 0x61, 0, 0]);
    const runsPast = Buffer.from([9, 0, 0, 0, 0x01, 0x61, 0, 1, 0]);
    const emptyString = Buffer.from([12, 0, 0, 0, 0x02, 0x61, 0, 0, 0, 0, 0, 0]);
    for (const bytes of [
      wrongLength,
      negative,
      unterminatedName,
      unknownType,
      runsPast,
      emptyString,
    ]) {
      expect(
        isMongoShieldError(
          failure(() => readElements(bytes, "test")),
          "MS_INTEGRITY_FAILED",
        ),
      ).toBe(true);
    }
    const unterminatedRegex = Buffer.from([9, 0, 0, 0, 0x0b, 0x61, 0, 0x62, 0]);
    expect(
      isMongoShieldError(
        failure(() => readElements(unterminatedRegex, "test")),
        "MS_INTEGRITY_FAILED",
      ),
    ).toBe(true);
  });
});
