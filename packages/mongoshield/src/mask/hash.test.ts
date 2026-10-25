import fc from "fast-check";
import { Binary, BSON, Decimal128, Double, Int32, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { hashedStringLength, hashValue, UNSUPPORTED } from "./hash.ts";
import { deriveMaskKeys } from "./keyed.ts";
import { exactDecimalOf, decimalText as formatDecimal, integerOf } from "./numbers.ts";
import { bsonTypeName } from "./values.ts";

const keys = deriveMaskKeys("a test secret that is long enough");
const otherKeys = deriveMaskKeys("another secret, also long enough");

/** Values `hash` supports, as the lossless parser produces them. */
const hashable = fc.oneof(
  fc.string(),
  fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }).map((value) => new Int32(value)),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((value) => new Double(value)),
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map((value) => Long.fromBigInt(value)),
  fc.uint8Array({ minLength: 12, maxLength: 12 }).map((bytes) => new ObjectId(Buffer.from(bytes))),
  fc.uint8Array({ minLength: 16, maxLength: 16 }).map((bytes) => new Binary(Buffer.from(bytes), 4)),
  fc.uint8Array({ maxLength: 40 }).map((bytes) => new Binary(Buffer.from(bytes), 0)),
);

/** Compares BSON values by their Extended JSON (exact types included). */
function same(left: unknown, right: unknown): boolean {
  return (
    BSON.EJSON.stringify({ v: left }, { relaxed: false }) ===
    BSON.EJSON.stringify({ v: right }, { relaxed: false })
  );
}

describe("hashValue", () => {
  it("is deterministic: the same input always gives the same output", () => {
    fc.assert(
      fc.property(hashable, (value) => same(hashValue(value, keys), hashValue(value, keys))),
    );
  });

  it("preserves the BSON type of every supported value", () => {
    fc.assert(
      fc.property(hashable, (value) => {
        expect(bsonTypeName(hashValue(value, keys))).toBe(bsonTypeName(value));
      }),
    );
  });

  it("gives different outputs under a different secret", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (value) => hashValue(value, keys) !== hashValue(value, otherKeys),
      ),
    );
  });

  it("keeps strings in their length class and uses only base32 characters", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (value) => {
        const hashed = hashValue(value, keys);
        expect(typeof hashed).toBe("string");
        expect(String(hashed)).toHaveLength(hashedStringLength(value.length));
        expect(String(hashed)).toMatch(/^[a-z2-7]+$/);
      }),
    );
    expect(hashValue("", keys)).toBe("");
    expect(hashedStringLength(3)).toBe(16);
    expect(hashedStringLength(20)).toBe(32);
    expect(hashedStringLength(100)).toBe(100);
  });

  it("keeps Int32 values in the Int32 range and never maps two ids to one", () => {
    const outputs = new Set<number>();
    for (let id = 1; id <= 5000; id += 1) {
      const hashed = hashValue(new Int32(id), keys);
      expect(hashed).toBeInstanceOf(Int32);
      outputs.add(Number(hashed));
    }
    expect(outputs.size).toBe(5000);
  });

  it("maps equal numbers of different BSON types to the same number", () => {
    const fromInt = Number(hashValue(new Int32(42), keys));
    expect(Number(hashValue(new Double(42), keys))).toBe(fromInt);
    expect(Number(hashValue(Long.fromNumber(42), keys))).toBe(fromInt);
    expect(hashValue(42, keys)).toBe(fromInt);
  });

  it("puts numbers inside a requested range", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (value) => {
        const hashed = Number(hashValue(new Int32(value), keys, { range: [18, 90] }));
        return hashed >= 18 && hashed <= 90;
      }),
    );
  });

  it("keeps the timestamp of an ObjectId", () => {
    const id = new ObjectId();
    const hashed = hashValue(id, keys);
    expect(hashed).toBeInstanceOf(ObjectId);
    expect(hashed instanceof ObjectId && hashed.getTimestamp()).toEqual(id.getTimestamp());
    expect(same(hashed, id)).toBe(false);
  });

  it("keeps UUIDs valid version-4 UUIDs", () => {
    const uuid = new BSON.UUID();
    const hashed = hashValue(new Binary(Buffer.from(uuid.buffer), 4), keys);
    expect(hashed instanceof Binary && hashed.sub_type).toBe(4);
    const text = hashed instanceof Binary ? Buffer.from(hashed.buffer).toString("hex") : "";
    expect(text[12]).toBe("4");
    expect(["8", "9", "a", "b"]).toContain(text[16]);
  });

  it.each([
    ["a boolean", true],
    ["a date", new Date()],
    ["an embedded document", { a: 1 }],
    ["a regex", new BSON.BSONRegExp("a")],
  ])("reports %s as unsupported", (_label, value) => {
    expect(hashValue(value, keys)).toBe(UNSUPPORTED);
  });
});

/** Decimal128 values as text: a sign, up to 34 digits and an exponent. */
const decimalText = fc
  .tuple(
    fc.boolean(),
    fc.bigInt({ min: 0n, max: 10n ** 34n - 1n }),
    fc.integer({ min: -6000, max: 6000 }),
  )
  .map(([negative, coefficient, exponent]) => `${negative ? "-" : ""}${coefficient}E${exponent}`);

/** The numeric value of a Decimal128, normalized, so equal numbers compare equal. */
function decimalKey(value: unknown): string {
  return value instanceof Decimal128 ? decimalTextOf(value) : "";
}

function decimalTextOf(value: Decimal128): string {
  const exact = exactDecimalOf(value);
  return exact === undefined ? value.toString() : formatDecimal(exact);
}

describe("hashValue on Decimal128", () => {
  it("keeps the type, is deterministic, and maps equal numbers to equal numbers", () => {
    fc.assert(
      fc.property(decimalText, (text) => {
        const value = Decimal128.fromString(text);
        const hashed = hashValue(value, keys);
        expect(hashed).toBeInstanceOf(Decimal128);
        expect(same(hashed, hashValue(Decimal128.fromString(text), keys))).toBe(true);
        // 1.5 and 1.50 are the same number: they must hash to the same number.
        const padded = Decimal128.fromString(
          `${text.replace(/E.*$/, "")}0E${Number(text.split("E")[1]) - 1}`,
        );
        expect(decimalKey(hashValue(padded, keys))).toBe(decimalKey(hashed));
      }),
    );
  });

  it("never maps two different numbers to the same number", () => {
    const outputs = new Map<string, string>();
    fc.assert(
      fc.property(decimalText, (text) => {
        const input = decimalKey(Decimal128.fromString(text));
        const output = decimalKey(hashValue(Decimal128.fromString(text), keys));
        const previous = outputs.get(output);
        if (previous !== undefined) expect(previous).toBe(input);
        outputs.set(output, input);
      }),
      { numRuns: 2000 },
    );
    // A dense block of amounts, where collisions would be likely if there were any.
    const amounts = new Set<string>();
    for (let cents = 1; cents <= 3000; cents += 1) {
      amounts.add(decimalKey(hashValue(Decimal128.fromString(`${cents}E-2`), keys)));
    }
    expect(amounts.size).toBe(3000);
  });

  it("keeps the sign, the significant digits and the exponent of fractional values", () => {
    const hashed = hashValue(Decimal128.fromString("-19.99"), keys);
    expect(String(hashed)).toMatch(/^-\d\d\.\d\d$/);
    expect(String(hashed)).not.toBe("-19.99");
    expect(String(hashValue(Decimal128.fromString("0.000123"), keys))).toMatch(/^0\.000\d{3}$/);
  });

  it("hashes whole decimals like the integer types, so joins across types keep matching", () => {
    const fromInt = Number(hashValue(new Int32(5), keys));
    expect(Number(String(hashValue(Decimal128.fromString("5.00"), keys)))).toBe(fromInt);
    const big = Long.fromString("9000000000000000001");
    expect(String(hashValue(Decimal128.fromString(big.toString()), keys))).toBe(
      String(hashValue(big, keys)),
    );
  });

  it("keeps whole decimals beyond the int64 range beyond it", () => {
    for (const text of ["93E+17", "1E+19", "-99E+17", "123456789E+6000"]) {
      const exact = exactDecimalOf(Decimal128.fromString(text));
      const hashed = hashValue(Decimal128.fromString(text), keys);
      const result = hashed instanceof Decimal128 ? exactDecimalOf(hashed) : undefined;
      expect(result?.exponent).toBe(exact?.exponent);
      const integer = result === undefined ? 0n : (integerOf(result) ?? 0n);
      expect(integer > 2n ** 63n - 1n || integer < -(2n ** 63n)).toBe(true);
    }
  });

  it("keeps zero, NaN and infinities, and honours a range", () => {
    for (const text of ["0", "-0.00", "NaN", "Infinity", "-Infinity"]) {
      expect(String(hashValue(Decimal128.fromString(text), keys))).toBe(text);
    }
    const ranged = hashValue(Decimal128.fromString("42.5"), keys, { range: [18, 90] });
    expect(ranged).toBeInstanceOf(Decimal128);
    expect(Number(String(ranged))).toBeGreaterThanOrEqual(18);
    expect(Number(String(ranged))).toBeLessThanOrEqual(90);
  });
});

describe("hashValue on numbers beyond 2^53", () => {
  it("maps exactly equal Long and Double values to the same number", () => {
    for (const power of [53n, 54n, 60n, 62n]) {
      const long = hashValue(Long.fromBigInt(2n ** power), keys);
      const double = hashValue(new Double(2 ** Number(power)), keys);
      expect(double).toBeInstanceOf(Double);
      expect(long instanceof Long && BigInt(Number(double)) === long.toBigInt()).toBe(true);
    }
    const negative = hashValue(Long.fromBigInt(-(2n ** 63n)), keys);
    expect(negative instanceof Long && negative.toBigInt()).toBe(
      BigInt(Number(hashValue(new Double(-(2 ** 63)), keys))),
    );
  });

  it("never maps two different large doubles to the same double, and keeps them large", () => {
    // Above the "safe" tier [-2^53, 2^53) of `permuteInteger`, on both sides.
    const large = fc
      .double({ min: 2 ** 53, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true })
      .chain((magnitude) =>
        fc.constantFrom(magnitude, magnitude === 2 ** 53 ? magnitude : -magnitude),
      );
    const outputs = new Map<number, number>();
    fc.assert(
      fc.property(large, (value) => {
        const hashed = Number(hashValue(new Double(value), keys));
        expect(Number.isFinite(hashed)).toBe(true);
        expect(hashed >= 2 ** 53 || hashed < -(2 ** 53)).toBe(true);
        expect(Math.sign(hashed)).toBe(Math.sign(value));
        const previous = outputs.get(hashed);
        if (previous !== undefined) expect(previous).toBe(value);
        outputs.set(hashed, value);
      }),
      { numRuns: 3000 },
    );
    // Doubles beyond 2^64 used to wrap around to the same integer and collide.
    const huge = [2 ** 116, 2 ** 117, 2 ** 200, 1e300].map((value) =>
      Number(hashValue(new Double(value), keys)),
    );
    expect(new Set(huge).size).toBe(4);
    expect(huge.every((value) => value >= 2 ** 63)).toBe(true);
  });

  it("keeps Longs that no double holds away from those a double holds", () => {
    // 2^62 + 1 is not a double; its hash must not be one either, or it could equal
    // the hash of a Double input.
    for (let offset = 1n; offset <= 50n; offset += 1n) {
      const hashed = hashValue(Long.fromBigInt(2n ** 62n + offset), keys);
      const value = hashed instanceof Long ? hashed.toBigInt() : 0n;
      expect(BigInt(Number(value)) === value).toBe(false);
      expect(value >= 2n ** 53n || value < -(2n ** 53n)).toBe(true);
    }
  });

  it("seeds ranges by the exact value, so equal values agree and different ones may not", () => {
    const range = { range: [0, 1_000_000] as const };
    expect(Number(hashValue(new Double(2 ** 62), keys, range))).toBe(
      Number(hashValue(Long.fromBigInt(2n ** 62n), keys, range)),
    );
    // String(2 ** 62) is "4611686018427388000": that Long is a different number.
    expect(Number(hashValue(new Double(2 ** 62), keys, range))).not.toBe(
      Number(hashValue(Long.fromString("4611686018427388000"), keys, range)),
    );
  });
});

describe("hashValue on other types", () => {
  it("turns an Int32 whose range result does not fit into a Long instead of wrapping", () => {
    const hashed = hashValue(new Int32(7), keys, { range: [2 ** 40, 2 ** 40 + 10] });
    expect(hashed).toBeInstanceOf(Long);
    expect(Number(hashed)).toBeGreaterThanOrEqual(2 ** 40);
  });

  it("hashes symbols like the strings they hold", () => {
    const hashed = hashValue(new BSON.BSONSymbol("ada@corp.com"), keys);
    expect(hashed).toBeInstanceOf(BSON.BSONSymbol);
    expect(String(hashed)).toBe(hashValue("ada@corp.com", keys));
  });

  it("hashes bigints from custom functions like Longs", () => {
    expect(hashValue(12n, keys)).toBe(BigInt(Number(hashValue(new Int32(12), keys))));
    expect(typeof hashValue(5n, keys, { range: [1, 3] })).toBe("bigint");
    expect(hashValue(2n ** 70n, keys)).toBe(UNSUPPORTED);
  });

  it("keeps vectors valid vectors of the same element type", () => {
    const floats = BSON.Binary.fromFloat32Array(new Float32Array([0.25, -0.5, 0.75]));
    const hashedFloats = hashValue(floats, keys);
    expect(hashedFloats instanceof Binary && hashedFloats.sub_type).toBe(9);
    const elements = hashedFloats instanceof Binary ? [...hashedFloats.toFloat32Array()] : [];
    expect(elements).toHaveLength(3);
    expect(elements.every((element) => element >= -1 && element < 1)).toBe(true);
    expect(elements).not.toEqual([0.25, -0.5, 0.75]);

    const bits = BSON.Binary.fromPackedBits(new Uint8Array([0xff, 0xff]), 3);
    const hashedBits = hashValue(bits, keys);
    const packed = hashedBits instanceof Binary ? hashedBits.toPackedBits() : new Uint8Array();
    expect(packed).toHaveLength(2);
    expect((packed[1] ?? 0) & 0b111).toBe(0);
    const int8 = BSON.Binary.fromInt8Array(new Int8Array([1, 2, 3]));
    const hashedInt8 = hashValue(int8, keys);
    expect(hashedInt8 instanceof Binary ? hashedInt8.toInt8Array() : []).toHaveLength(3);
  });

  it("leaves encrypted binaries to onUnsupported", () => {
    expect(hashValue(new Binary(Buffer.from([1, 2, 3]), 6), keys)).toBe(UNSUPPORTED);
  });

  it("keeps NaN and infinities", () => {
    expect(hashValue(Number.NaN, keys)).toBeNaN();
    expect(Number(hashValue(new Double(Number.POSITIVE_INFINITY), keys))).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
