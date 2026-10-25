// BSONColumn decoding, on hand-made columns that each exercise one rule of the format
// (see bson-column.ts), plus properties: Simple-8b round trips, and damaged real
// columns failing cleanly. Real columns of MongoDB 7.0 and 8.0 are checked end to end
// in timeseries-buckets.test.ts.

import { readFileSync } from "node:fs";
import fc from "fast-check";
import { BSON, Decimal128, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { type ColumnValue, decodeBsonColumn, decodeSimple8b } from "./bson-column.ts";
import { BsonType, readElements } from "./raw-bson.ts";
import { fixturePath, splitBson } from "./test-fixtures.ts";

// ---------------------------------------------------------------------------
// Building columns by hand
// ---------------------------------------------------------------------------

/** A literal: type, empty field name, value. */
function literal(type: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type, 0x00]), value]);
}

function int32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value, 0);
  return bytes;
}

function int64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value, 0);
  return bytes;
}

function double(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value, 0);
  return bytes;
}

function string(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([int32(bytes.length + 1), bytes, Buffer.from([0])]);
}

function document(fields: Record<string, unknown>): Buffer {
  return Buffer.from(BSON.serialize(fields));
}

/** zigzag encoding of a signed delta. */
function zigzag(delta: bigint): bigint {
  return delta >= 0n ? delta * 2n : -delta * 2n - 1n;
}

/** One Simple-8b word with selector 14: a single 60-bit value, or a skip. */
function single(value: bigint | undefined): bigint {
  const slot = value === undefined ? (1n << 60n) - 1n : value;
  return (slot << 4n) | 14n;
}

/** An RLE word: the previous value 120 × `count` more times. */
function rle(count: number): bigint {
  return (BigInt(count - 1) << 4n) | 15n;
}

/** A delta control: `nibble` picks the scale (0x8 = none), then the words. */
function deltas(words: readonly bigint[], nibble = 0x8): Buffer {
  const bytes = Buffer.alloc(1 + 8 * words.length);
  bytes[0] = (nibble << 4) | (words.length - 1);
  words.forEach((word, index) => {
    bytes.writeBigUInt64LE(word, 1 + 8 * index);
  });
  return bytes;
}

/** Interleaved start: control byte + reference document. */
function interleaved(control: number, reference: Buffer): Buffer {
  return Buffer.concat([Buffer.from([control]), reference]);
}

const END = Buffer.from([0x00]);

function column(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

function decode(...parts: Buffer[]) {
  return decodeBsonColumn(column(...parts), "test column");
}

/** Decoded values as plain JavaScript values (via a one-field document). */
function plain(values: readonly (ColumnValue | undefined)[]): unknown[] {
  return values.map((value) => {
    if (value === undefined) return undefined;
    const wrapped = Buffer.concat([
      int32(0),
      literal(value.type, value.value).subarray(0, 1),
      Buffer.from("v\0"),
      value.value,
      END,
    ]);
    wrapped.writeInt32LE(wrapped.length, 0);
    return BSON.deserialize(wrapped, { promoteValues: true }).v;
  });
}

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

function expectUnsupported(run: () => unknown): void {
  const error = failure(run);
  expect(
    isMongoShieldError(error, "MS_FORMAT_UNSUPPORTED") ||
      isMongoShieldError(error, "MS_INTEGRITY_FAILED"),
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// Regular mode
// ---------------------------------------------------------------------------

describe("decodeBsonColumn", () => {
  it("decodes literals, deltas, zero deltas and skips of int32 values", () => {
    const values = decode(
      literal(BsonType.int32, int32(5)),
      deltas([single(zigzag(1n)), single(zigzag(-3n)), single(undefined), single(0n)]),
      END,
    );
    expect(plain(values)).toEqual([5, 6, 3, undefined, 3]);
  });

  it("repeats the previous delta with run-length encoding", () => {
    const values = decode(
      literal(BsonType.int32, int32(0)),
      deltas([single(zigzag(2n)), rle(1)]),
      END,
    );
    expect(values).toHaveLength(122);
    expect(plain(values).at(-1)).toBe(242);
  });

  it("starts a control's run-length block from the previous control's last delta", () => {
    const values = decode(
      literal(BsonType.int64, int64(0n)),
      deltas([single(zigzag(1n))]),
      deltas([rle(1)]),
      END,
    );
    expect(plain(values).at(-1)).toBe(121);
  });

  it("treats values before the first literal as missing", () => {
    expect(decode(deltas([single(0n), single(undefined)]), END)).toEqual([undefined, undefined]);
  });

  it("scales doubles by the block's power of ten, and re-scales at every block", () => {
    const values = decode(
      literal(BsonType.double, double(1.5)),
      deltas([single(zigzag(5n))], 0xa), // ×10: 15 → 20
      deltas([single(zigzag(-75n))], 0xb), // ×100: 200 → 125
      deltas([single(zigzag(1n))], 0xc), // ×10^4: 12500 → 12501
      deltas([single(zigzag(-1n))], 0xd), // ×10^8: 125010000 → 125009999
      END,
    );
    expect(plain(values)).toEqual([1.5, 2, 1.25, 1.2501, 1.25009999]);
  });

  it("refuses a double block at a scale its previous value does not fit", () => {
    expectUnsupported(() =>
      decode(literal(BsonType.double, double(1.25)), deltas([single(0n)], 0x9), END),
    );
  });

  it("decodes doubles from their raw bits, and repeats -0 exactly", () => {
    const bits = (value: number) => double(value).readBigInt64LE(0);
    const values = decode(
      literal(BsonType.double, double(1)),
      deltas([single(zigzag(bits(2) - bits(1)))]),
      END,
    );
    expect(plain(values)).toEqual([1, 2]);
    const zeros = decode(literal(BsonType.double, double(-0)), deltas([single(0n)]), END);
    expect(Object.is(zeros[1]?.value.readDoubleLE(0), -0)).toBe(true);
  });

  it("decodes dates, timestamps and ObjectIds as deltas of deltas", () => {
    const dates = decode(
      literal(BsonType.date, int64(1_000_000n)),
      deltas([single(zigzag(1000n)), single(0n), single(zigzag(-500n))]),
      END,
    );
    expect(plain(dates).map((value) => (value as Date).getTime())).toEqual([
      1_000_000, 1_001_000, 1_002_000, 1_002_500,
    ]);

    const oid = new ObjectId("65a1b2c3d4e5f60718293a4b");
    const ids = decode(
      literal(BsonType.objectId, Buffer.from(oid.id)),
      deltas([single(zigzag(1n))]),
      END,
    );
    // +1 lands on the lowest encoded byte: the last counter byte. The process bytes stay.
    expect(String(plain(ids)[1])).toBe("65a1b2c3d4e5f60718293a4c");
  });

  it("decodes booleans, int64 and timestamps", () => {
    expect(
      plain(decode(literal(BsonType.boolean, Buffer.from([0])), deltas([single(zigzag(1n))]), END)),
    ).toEqual([false, true]);
    const timestamps = decode(
      literal(BsonType.timestamp, int64(5n)),
      deltas([single(zigzag(2n))]),
      END,
    );
    expect(timestamps[1]?.value.readBigUInt64LE(0)).toBe(7n);
  });

  it("decodes short strings, binary data and decimals with 128-bit deltas", () => {
    // Strings are stored reversed, so the last character is the lowest byte.
    expect(
      plain(decode(literal(BsonType.string, string("ab")), deltas([single(zigzag(1n))]), END)),
    ).toEqual(["ab", "ac"]);
    const code = decode(literal(BsonType.code, string("x")), deltas([single(0n)]), END);
    expect(code[1]).toBe(code[0]);
    // Shrinking a string to "" and back.
    expect(
      plain(decode(literal(BsonType.string, string("a")), deltas([single(zigzag(-0x61n))]), END)),
    ).toEqual(["a", ""]);

    const binary = decode(
      literal(BsonType.binary, Buffer.concat([int32(2), Buffer.from([0x80, 1, 2])])),
      deltas([single(zigzag(1n))]),
      END,
    );
    expect(binary[1]?.value).toEqual(Buffer.concat([int32(2), Buffer.from([0x80, 2, 2])]));

    const decimal = Buffer.from(Decimal128.fromString("1").bytes);
    const decimals = decode(
      literal(BsonType.decimal128, decimal),
      deltas([single(zigzag(1n))]),
      END,
    );
    expect(String(plain(decimals)[1])).toBe("2");
  });

  it("repeats types without deltas, and refuses a non-zero delta for them", () => {
    expect(
      decode(literal(BsonType.null, Buffer.alloc(0)), deltas([single(0n), single(0n)]), END),
    ).toHaveLength(3);
    expect(
      decode(
        literal(BsonType.minKey, Buffer.alloc(0)),
        literal(BsonType.maxKey, Buffer.alloc(0)),
        END,
      ),
    ).toHaveLength(2);
    expectUnsupported(() =>
      decode(literal(BsonType.null, Buffer.alloc(0)), deltas([single(zigzag(1n))]), END),
    );
    expectUnsupported(() =>
      decode(literal(BsonType.document, document({ a: 1 })), deltas([single(zigzag(1n))]), END),
    );
    const long = Buffer.concat([int32(20), Buffer.from([0]), Buffer.alloc(20, 7)]);
    expectUnsupported(() =>
      decode(literal(BsonType.binary, long), deltas([single(zigzag(1n))]), END),
    );
  });

  it("refuses scaled blocks after values that are not doubles", () => {
    expectUnsupported(() =>
      decode(literal(BsonType.int32, int32(1)), deltas([single(0n)], 0x9), END),
    );
    expectUnsupported(() =>
      decode(literal(BsonType.string, string("a")), deltas([single(0n)], 0xa), END),
    );
  });

  it.each([
    ["is empty", Buffer.alloc(0)],
    ["has no end", literal(BsonType.int32, int32(1))],
    ["has bytes after its end", column(literal(BsonType.int32, int32(1)), END, END)],
    ["has a Simple-8b selector 0", column(deltas([0n]), END)],
    ["has an invalid extended selector", column(deltas([(10n << 4n) | 7n]), END)],
    ["has a delta block that runs past its end", column(deltas([single(0n)]).subarray(0, 5))],
    ["has a delta block with nothing after it", deltas([single(0n)])],
    ["has an unknown control byte", Buffer.from([0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["has a literal with a field name", Buffer.from([BsonType.int32, 0x61, 0x00, 1, 0, 0, 0, 0])],
    ["has a literal that runs past its end", Buffer.from([BsonType.int32, 0x00, 1, 0])],
    ["has a literal of an unknown type", Buffer.from([0x1f, 0x00, 0x00])],
  ])("refuses a column that %s", (_name, bytes) => {
    expectUnsupported(() => decodeBsonColumn(bytes, "test column"));
  });
});

// ---------------------------------------------------------------------------
// Interleaved mode
// ---------------------------------------------------------------------------

describe("decodeBsonColumn in interleaved mode", () => {
  it("rebuilds documents field by field, leaving out missing fields and empty sub-documents", () => {
    const values = decode(
      interleaved(0xf1, document({ a: 1, b: { c: "x" }, e: {} })),
      deltas([single(zigzag(1n)), single(undefined)]), // a: 2, missing
      literal(BsonType.string, string("y")), // c of the first document
      deltas([single(undefined)]), // c of the second document: missing, so b is left out
      END, // a needs a control: the interleaved section ends
      END,
    );
    expect(plain(values)).toEqual([{ a: 2, b: { c: "y" }, e: {} }, { e: {} }]);
  });

  it("gives a missing value for a document without any field", () => {
    const values = decode(
      interleaved(0xf1, document({ a: 1 })),
      deltas([single(undefined)]),
      END,
      END,
    );
    expect(values).toEqual([undefined]);
  });

  it("decodes arrays field by field with 0xF2 (array root) and 0xF1", () => {
    const reference = Buffer.from(BSON.serialize({ 0: 1, 1: 2 }));
    const arrays = decode(
      interleaved(0xf2, reference),
      deltas([single(zigzag(1n))]),
      deltas([single(0n)]),
      END,
      END,
    );
    expect(arrays[0]?.type).toBe(BsonType.array);
    expect(plain(arrays)).toEqual([[2, 2]]);
    const nested = decode(
      interleaved(0xf1, document({ list: [1] })),
      deltas([single(zigzag(4n))]),
      END,
      END,
    );
    expect(plain(nested)).toEqual([{ list: [5] }]);
  });

  it("treats arrays as single values in the legacy 0xF0 mode", () => {
    const values = decode(
      interleaved(0xf0, document({ list: [1, 2] })),
      deltas([single(0n), single(0n)]),
      END,
      END,
    );
    expect(plain(values)).toEqual([{ list: [1, 2] }, { list: [1, 2] }]);
  });

  it("continues in regular mode after the section, from its last document", () => {
    const values = decode(
      interleaved(0xf1, document({ a: 1 })),
      deltas([single(0n)]),
      END,
      deltas([single(0n)]),
      END,
    );
    expect(plain(values)).toEqual([{ a: 1 }, { a: 1 }]);
  });

  it.each([
    ["a reference without fields", column(interleaved(0xf1, document({})), END, END)],
    ["no document", column(interleaved(0xf1, document({ a: 1 })), END)],
    [
      "an end in the middle of a document",
      column(interleaved(0xf1, document({ a: 1, b: 2 })), deltas([single(0n)]), END, END),
    ],
    [
      "values left at its end",
      column(
        interleaved(0xf1, document({ a: 1, b: 2 })),
        deltas([single(0n)]),
        deltas([single(0n), single(0n)]),
        END,
        END,
      ),
    ],
    ["a truncated reference", Buffer.from([0xf1, 0x20, 0, 0, 0, 0x10])],
  ])("refuses an interleaved section with %s", (_name, bytes) => {
    expectUnsupported(() => decodeBsonColumn(bytes, "test column"));
  });
});

// ---------------------------------------------------------------------------
// Simple-8b
// ---------------------------------------------------------------------------

/** Base selectors: [selector, bits per value, values per word]. */
const BASE_SELECTORS = [
  [1, 1, 60],
  [2, 2, 30],
  [3, 3, 20],
  [4, 4, 15],
  [5, 5, 12],
  [6, 6, 10],
  [7, 7, 8],
  [8, 8, 7],
  [9, 10, 6],
  [10, 12, 5],
  [11, 15, 4],
  [12, 20, 3],
  [13, 30, 2],
  [14, 60, 1],
] as const;

/**
 * A plain Simple-8b encoder for the round-trip property: greedy base selectors, and
 * RLE for runs of 120 repeats of the previous value.
 */
function encodeSimple8b(
  values: readonly (bigint | undefined)[],
  previous: bigint | undefined,
): Buffer {
  const words: bigint[] = [];
  let last = previous;
  let index = 0;
  while (index < values.length) {
    let run = 0;
    while (run < 16 * 120 && index + run < values.length && values[index + run] === last) run += 1;
    if (run >= 120) {
      const count = Math.floor(run / 120);
      words.push(rle(count));
      index += count * 120;
      continue;
    }
    for (const [selector, bits, count] of BASE_SELECTORS) {
      const chunk = values.slice(index, index + count);
      const skip = (1n << BigInt(bits)) - 1n;
      if (chunk.length < count || chunk.some((value) => value !== undefined && value >= skip))
        continue;
      const shift = selector === 7 || selector === 8 ? 8n : 4n;
      let word = BigInt(selector);
      chunk.forEach((value, position) => {
        word |= (value ?? skip) << (shift + BigInt(position * bits));
      });
      words.push(word);
      index += count;
      last = chunk.at(-1);
      break;
    }
  }
  const bytes = Buffer.alloc(8 * words.length);
  words.forEach((word, position) => {
    bytes.writeBigUInt64LE(word, 8 * position);
  });
  return bytes;
}

describe("decodeSimple8b", () => {
  it("decodes what a Simple-8b encoder writes (property)", () => {
    const value = fc.oneof(
      fc.constant(undefined),
      fc.bigInt({ min: 0n, max: 3n }),
      fc.bigInt({ min: 0n, max: (1n << 59n) - 1n }),
    );
    const runs = fc.array(fc.tuple(value, fc.integer({ min: 1, max: 300 })), { maxLength: 20 });
    fc.assert(
      fc.property(runs, (pieces) => {
        const values = pieces.flatMap(([item, count]) =>
          Array.from({ length: count % 7 === 0 ? count : 1 }, () => item),
        );
        expect(decodeSimple8b(encodeSimple8b(values, 0n), 0n, 64, "test")).toEqual(values);
      }),
    );
  });

  it("decodes trailing zeros of the extended selectors 7 and 8", () => {
    // Selector 7, extension 1: nine slots of 2 value bits + 4 bits counting trailing zeros.
    const seven = (3n << 12n) | (5n << 8n) | (1n << 4n) | 7n; // first slot: value 3, 5 zeros
    expect(decodeSimple8b(word(seven), 0n, 64, "test")[0]).toBe(3n << 5n);
    // Selector 8, extension 1: 4 value bits + 4 bits counting nibbles of zeros.
    const eightSmall = (9n << 12n) | (2n << 8n) | (1n << 4n) | 8n;
    expect(decodeSimple8b(word(eightSmall), 0n, 64, "test")[0]).toBe(9n << 8n);
    // Selector 8, extension 8: 4 value bits + 5 bits of nibble counts, up to 124 zeros.
    const eightLarge = (1n << 13n) | (31n << 8n) | (8n << 4n) | 8n;
    expect(decodeSimple8b(word(eightLarge), 0n, 128, "test")[0]).toBe(1n << 124n);
    // At 64 bits, the C++ shift of 124 is taken modulo 64 (60).
    expect(decodeSimple8b(word(eightLarge), 0n, 64, "test")[0]).toBe(
      (1n << 60n) & ((1n << 64n) - 1n),
    );
  });

  it("decodes the base forms of selectors 7 and 8", () => {
    expect(decodeSimple8b(word((5n << 8n) | 7n), 0n, 64, "test")).toEqual([
      5n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
    ]);
    expect(decodeSimple8b(word((5n << 8n) | 8n), 0n, 64, "test")).toHaveLength(7);
  });

  it("repeats an initial skip or value with RLE", () => {
    expect(decodeSimple8b(word(rle(1)), undefined, 64, "test")).toEqual(
      Array.from({ length: 120 }, () => undefined),
    );
    expect(new Set(decodeSimple8b(word(rle(16)), 7n, 64, "test"))).toEqual(new Set([7n]));
    expect(decodeSimple8b(word(rle(16)), 7n, 64, "test")).toHaveLength(1920);
  });
});

function word(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value, 0);
  return bytes;
}

// ---------------------------------------------------------------------------
// Damaged real columns
// ---------------------------------------------------------------------------

/** The BSONColumn payloads of the compressed fixture buckets (8.0, and 5.3 for the legacy format). */
function realColumns(): Buffer[] {
  const columns: Buffer[] = [];
  for (const [version, collection] of [
    ["mongodb-8.0", "mixed"],
    ["mongodb-8.0", "runs"],
    ["mongodb-5.3", "mixed"],
  ]) {
    const buckets = splitBson(
      readFileSync(fixturePath(`timeseries/${version}/${collection}.buckets.bson`)),
    );
    for (const bucket of buckets) {
      const data = readElements(bucket, "bucket").find((element) => element.name === "data");
      if (data === undefined) continue;
      for (const field of readElements(data.value, "data")) {
        // Uncompressed (version 1) buckets hold documents, not columns.
        if (field.type === BsonType.binary) columns.push(field.value.subarray(5));
      }
    }
  }
  return columns;
}

describe("decodeBsonColumn on damaged columns", () => {
  const columns = realColumns();

  it("decodes every real column", () => {
    expect(columns.length).toBeGreaterThan(20);
    for (const one of columns) expect(decodeBsonColumn(one, "fixture").length).toBeGreaterThan(0);
  });

  it("either decodes or fails with a MongoShieldError, never anything else (property)", () => {
    const damage = fc.record({
      column: fc.integer({ min: 0, max: columns.length - 1 }),
      flips: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
        minLength: 1,
        maxLength: 4,
      }),
      cut: fc.option(fc.nat()),
    });
    fc.assert(
      fc.property(damage, ({ column: index, flips, cut }) => {
        const original = columns[index] ?? Buffer.alloc(0);
        let damaged = Buffer.from(original);
        for (const [position, byte] of flips) damaged[position % damaged.length] = byte;
        if (cut !== null) damaged = damaged.subarray(0, cut % (damaged.length + 1));
        try {
          decodeBsonColumn(damaged, "damaged");
        } catch (error) {
          expect(
            isMongoShieldError(error, "MS_FORMAT_UNSUPPORTED") ||
              isMongoShieldError(error, "MS_INTEGRITY_FAILED"),
          ).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
