import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import {
  collectionFileStem,
  MAX_STEM_BYTES,
  parseCollectionFileStem,
  queryEscape,
  queryUnescape,
} from "./dump-names.ts";

describe("queryEscape", () => {
  it("escapes like Go's url.QueryEscape: unreserved kept, space as +, the rest as %XX", () => {
    expect(queryEscape("users")).toBe("users");
    expect(queryEscape("a-b_c.d~e")).toBe("a-b_c.d~e");
    expect(queryEscape("we/ird name+x~é")).toBe("we%2Fird+name%2Bx~%C3%A9");
    expect(queryEscape("$&,:;=?@%")).toBe("%24%26%2C%3A%3B%3D%3F%40%25");
  });

  it("is undone by queryUnescape for any name", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 }), (name) => {
        expect(queryUnescape(queryEscape(name))).toBe(name);
      }),
    );
  });
});

describe("queryUnescape", () => {
  it("turns + into a space and %XX into bytes", () => {
    expect(queryUnescape("we%2Fird+name%2Bx~%C3%A9")).toBe("we/ird name+x~é");
    expect(queryUnescape("%c3%a9")).toBe("é");
  });

  it("rejects what Go rejects, and bytes that are not UTF-8", () => {
    expect(queryUnescape("bad%2")).toBeUndefined();
    expect(queryUnescape("bad%zz")).toBeUndefined();
    expect(queryUnescape("%C3")).toBeUndefined();
  });
});

describe("collectionFileStem", () => {
  it("keeps short names escaped but whole", () => {
    expect(collectionFileStem("orders.2024")).toBe("orders.2024");
  });

  it("shortens long names exactly like mongodump 100.16 (prefix, %24, base64url SHA-1)", () => {
    // Taken from a real `mongodump` run on a collection named "é" × 100.
    const expected = `${"%C3%A9".repeat(34)}%C3%%2402mW-EhxMxXsZ8vh0-6fogZ0Bd4`;
    expect(collectionFileStem("é".repeat(100))).toBe(expected);
    expect(expected).toHaveLength(MAX_STEM_BYTES);
  });

  it("never produces a stem longer than 238 bytes", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", minLength: 1, maxLength: 200 }), (name) => {
        expect(Buffer.byteLength(collectionFileStem(name))).toBeLessThanOrEqual(MAX_STEM_BYTES);
      }),
    );
  });
});

describe("parseCollectionFileStem", () => {
  it("unescapes ordinary stems", () => {
    expect(parseCollectionFileStem("we%2Fird+name%2Bx~%C3%A9")).toEqual({
      kind: "name",
      collection: "we/ird name+x~é",
    });
  });

  it("recognises shortened stems, whose name must come from the metadata file", () => {
    expect(parseCollectionFileStem(collectionFileStem("x".repeat(300)))).toEqual({
      kind: "shortened",
    });
  });

  it("rejects stems mongodump never writes", () => {
    let error: unknown;
    try {
      parseCollectionFileStem("broken%G1");
    } catch (caught) {
      error = caught;
    }
    expect(isMongoShieldError(error, "MS_FORMAT_UNSUPPORTED")).toBe(true);
  });
});
