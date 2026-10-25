import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deriveMaskKeys,
  KeyedStream,
  MIN_SECRET_LENGTH,
  permuteBelow,
  permuteInteger,
  permuteLargeDouble,
} from "./keyed.ts";

const keys = deriveMaskKeys("a test secret that is long enough");
const otherKeys = deriveMaskKeys("another secret, also long enough");

const INT32_MIN = -(2n ** 31n);
const INT32_MAX = 2n ** 31n - 1n;
const SAFE = 2n ** 53n;

describe("deriveMaskKeys", () => {
  it(`rejects secrets shorter than ${MIN_SECRET_LENGTH} characters`, () => {
    expect(() => deriveMaskKeys("short")).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
  });
});

describe("KeyedStream", () => {
  it("produces the same bytes from the same seed", () => {
    const seed = Buffer.from("seed");
    expect(new KeyedStream(seed).bytes(100)).toEqual(new KeyedStream(seed).bytes(100));
  });

  it("draws integers within the bound", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (seed, bound) => {
          const draw = new KeyedStream(Buffer.from(seed)).int(bound);
          return draw >= 0 && draw < bound;
        },
      ),
    );
  });
});

describe("permuteInteger", () => {
  it("is deterministic and keeps each value in its tier (int32, safe integer, int64)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }), (value) => {
        const permuted = permuteInteger(value, keys);
        expect(permuteInteger(value, keys)).toBe(permuted);
        const inInt32 = (n: bigint) => n >= INT32_MIN && n <= INT32_MAX;
        const inSafe = (n: bigint) => n >= -SAFE && n < SAFE;
        expect(inInt32(permuted)).toBe(inInt32(value));
        expect(inSafe(permuted)).toBe(inSafe(value));
        expect(permuted >= -(2n ** 63n) && permuted < 2n ** 63n).toBe(true);
      }),
    );
  });

  it("never maps two different integers to the same value", () => {
    // A bijection: every input in a dense block has its own output.
    const outputs = new Set<bigint>();
    for (let value = -5000n; value < 5000n; value += 1n) outputs.add(permuteInteger(value, keys));
    expect(outputs.size).toBe(10_000);
    const wide = new Set<bigint>();
    for (let value = 2n ** 40n; value < 2n ** 40n + 2000n; value += 1n) {
      wide.add(permuteInteger(value, keys));
    }
    expect(wide.size).toBe(2000);
  });

  it("gives different results under a different secret", () => {
    const differing = [1n, 2n, 3n, 4n, 5n].filter(
      (value) => permuteInteger(value, keys) !== permuteInteger(value, otherKeys),
    );
    expect(differing.length).toBeGreaterThan(3);
  });
});

describe("permuteBelow", () => {
  it("is a bijection on [0, count) for awkward domain sizes", () => {
    for (const count of [1n, 2n, 3n, 10n, 90n, 1000n, 4097n]) {
      const outputs = new Set<bigint>();
      for (let value = 0n; value < count; value += 1n) {
        const permuted = permuteBelow(value, count, keys.feistel64);
        expect(permuted >= 0n && permuted < count).toBe(true);
        outputs.add(permuted);
      }
      expect(outputs.size).toBe(Number(count));
    }
  });
});

describe("permuteLargeDouble", () => {
  it("keeps the sign and the side of the int64 limit", () => {
    for (const value of [2 ** 53, 2 ** 62, -(2 ** 63), 2 ** 63, 1e300, -1e300]) {
      const permuted = permuteLargeDouble(value, keys);
      expect(Math.sign(permuted)).toBe(Math.sign(value));
      const inInt64 = (candidate: number) => candidate >= -(2 ** 63) && candidate < 2 ** 63;
      expect(inInt64(permuted)).toBe(inInt64(value));
    }
  });

  it("depends on the secret", () => {
    expect(permuteLargeDouble(2 ** 70, keys)).not.toBe(permuteLargeDouble(2 ** 70, otherKeys));
  });
});

describe("permuteInteger outside the int64 range", () => {
  it("refuses values no Long can hold", () => {
    expect(() => permuteInteger(2n ** 63n, keys)).toThrow(/outside the 64-bit integer range/);
  });
});
