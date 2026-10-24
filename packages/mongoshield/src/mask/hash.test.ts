import fc from "fast-check";
import { Binary, BSON, Double, Int32, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { hashedStringLength, hashValue, UNSUPPORTED } from "./hash.ts";
import { deriveMaskKeys } from "./keyed.ts";
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
