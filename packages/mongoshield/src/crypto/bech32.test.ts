/**
 * Bech32 tests: the BIP 173 reference vectors plus age-specific behaviour
 * (no 90-character limit, uppercase identities, Bech32m rejected).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeBech32, encodeBech32 } from "./bech32.ts";

describe("decodeBech32", () => {
  // Valid Bech32 strings from BIP 173, "Test vectors".
  const validVectors = [
    "A12UEL5L",
    "a12uel5l",
    "an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs",
    "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw",
    "11qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8247j",
    "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
    "?1ezyfcl",
  ];

  it.each(validVectors)("accepts the BIP 173 valid vector %s", (vector) => {
    expect(decodeBech32(vector)).toBeDefined();
  });

  // Invalid strings from BIP 173 (the ones that do not rely on the 90-char limit).
  const invalidVectors = [
    ["\x201nwldj5", "HRP character out of range"],
    ["\x7f1axkwrx", "HRP character out of range"],
    ["pzry9x0s0muk", "no separator"],
    ["1pzry9x0s0muk", "empty HRP"],
    ["x1b4n0q5v", "invalid data character"],
    ["li1dgmt3", "too short checksum"],
    ["de1lg7wt\xff", "invalid character in checksum"],
    ["A1G7SGD8", "checksum calculated with uppercase HRP"],
    ["10a06t8", "empty HRP"],
    ["1qzzfhee", "empty HRP"],
    ["A12uEL5L", "mixed case"],
  ] as const;

  it.each(invalidVectors)("rejects %j (%s)", (vector) => {
    expect(decodeBech32(vector)).toBeUndefined();
  });

  it("rejects a Bech32m string, because age uses the original Bech32 checksum", () => {
    // "a1lqfn3a" is the BIP 350 (Bech32m) encoding of HRP "a" with no data.
    expect(decodeBech32("a1lqfn3a")).toBeUndefined();
    expect(decodeBech32("a12uel5l")).toBeDefined();
  });

  it("rejects a valid checksum over data whose padding bits are not zero", () => {
    // One byte is two 5-bit words with 2 padding bits; the word 1 sets one of them.
    expect(decodeBech32(withChecksum("a", [0, 1]))).toBeUndefined();
    expect(decodeBech32(withChecksum("a", [0, 0]))?.data).toEqual(Buffer.from([0]));
  });

  it("decodes the spec's example identity to 32 bytes of 0x42", () => {
    const decoded = decodeBech32(
      "AGE-SECRET-KEY-1GFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPQ4EGAEX",
    );
    expect(decoded?.hrp).toBe("age-secret-key-");
    expect(decoded?.data).toEqual(Buffer.alloc(32, 0x42));
  });
});

describe("encodeBech32", () => {
  it("round-trips arbitrary data with no length limit", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (data) => {
        const encoded = encodeBech32("age", data);
        expect(decodeBech32(encoded)).toEqual({ hrp: "age", data: Buffer.from(data) });
      }),
    );
  });

  it("writes uppercase output for an uppercase HRP, as age does for identities", () => {
    const encoded = encodeBech32("AGE-SECRET-KEY-", Buffer.alloc(32, 0x42));
    expect(encoded).toBe(
      "AGE-SECRET-KEY-1GFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPQ4EGAEX",
    );
  });

  it("detects any single-character substitution", () => {
    const encoded = encodeBech32("age", Buffer.alloc(32, 7));
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: encoded.length - 1 }),
        fc.constantFrom(..."qpzry9x8gf2tvdw0s3jn54khce6mua7l"),
        (position, replacement) => {
          fc.pre(encoded[position] !== replacement);
          const mutated = encoded.slice(0, position) + replacement + encoded.slice(position + 1);
          expect(decodeBech32(mutated)).toBeUndefined();
        },
      ),
    );
  });
});

/** The Bech32 charset, in word order (BIP 173). */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/**
 * A Bech32 string for arbitrary 5-bit words, with a correct checksum. Written out
 * here (BIP 173 reference algorithm) because `encodeBech32` only produces
 * well-padded data, and the decoder's padding check needs badly padded input.
 */
function withChecksum(hrp: string, words: readonly number[]): string {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values: readonly number[]) => {
    let checksum = 1;
    for (const value of values) {
      const top = checksum >>> 25;
      checksum = ((checksum & 0x1ffffff) << 5) ^ value;
      generator.forEach((term, bit) => {
        if ((top >>> bit) & 1) checksum ^= term;
      });
    }
    return checksum;
  };
  const codes = [...hrp].map((character) => character.charCodeAt(0));
  const expanded = [...codes.map((code) => code >>> 5), 0, ...codes.map((code) => code & 31)];
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, index) => (mod >>> (5 * (5 - index))) & 31);
  return `${hrp}1${[...words, ...checksum].map((word) => CHARSET[word]).join("")}`;
}
