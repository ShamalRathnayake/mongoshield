import { Decimal128, Double, Int32, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  canonicalScalar,
  deriveErasureKey,
  MATCH_VERSION,
  matchesHashed,
  storeFilter,
  valuesAtPath,
} from "./erasure-match.ts";

const SECRET = "a-long-enough-erasure-secret";

describe("storeFilter", () => {
  it("hashes exact matches on strings, so the value is not in the record", () => {
    const stored = storeFilter({ email: "ada@example.com" }, deriveErasureKey(SECRET));
    expect(stored.kind).toBe("hashed");
    expect(JSON.stringify(stored)).not.toContain("ada@example.com");
    if (stored.kind === "hashed") {
      expect(stored.keyed).toBe(true);
      expect(stored.keyId).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("keeps id-only and operator filters as written", () => {
    const id = new ObjectId();
    expect(storeFilter({ _id: id }, deriveErasureKey(undefined))).toEqual({
      kind: "filter",
      filter: { _id: id },
    });
    expect(storeFilter({ age: { $gt: 3 }, name: "x" }, deriveErasureKey(undefined)).kind).toBe(
      "filter",
    );
  });

  it("refuses an empty filter and a short secret", () => {
    expect(() => storeFilter({}, deriveErasureKey(undefined))).toThrow(/non-empty filter/);
    expect(() => deriveErasureKey("short")).toThrow(/at least 16/);
  });
});

describe("matchesHashed", () => {
  const key = deriveErasureKey(SECRET);

  function fieldsOf(filter: Record<string, unknown>) {
    const stored = storeFilter(filter, key);
    if (stored.kind !== "hashed") throw new Error("expected a hashed filter");
    return stored.fields;
  }

  it("matches documents with every field equal, by MongoDB's numeric equality", () => {
    const fields = fieldsOf({ email: "ada@example.com", tenant: 7 });
    expect(matchesHashed({ email: "ada@example.com", tenant: new Int32(7) }, fields, key)).toBe(
      true,
    );
    expect(
      matchesHashed({ email: "ada@example.com", tenant: Long.fromNumber(7) }, fields, key),
    ).toBe(true);
    expect(matchesHashed({ email: "ada@example.com", tenant: new Double(7) }, fields, key)).toBe(
      true,
    );
    expect(matchesHashed({ email: "ada@example.com", tenant: 8 }, fields, key)).toBe(false);
    expect(matchesHashed({ email: "bob@example.com", tenant: 7 }, fields, key)).toBe(false);
  });

  it("matches array elements and dotted paths through arrays of sub-documents", () => {
    const fields = fieldsOf({ "contacts.email": "ada@example.com" });
    expect(
      matchesHashed(
        { contacts: [{ email: "bob@example.com" }, { email: ["x", "ada@example.com"] }] },
        fields,
        key,
      ),
    ).toBe(true);
    expect(matchesHashed({ contacts: { email: "bob@example.com" } }, fields, key)).toBe(false);
  });

  it("does not match with a different secret", () => {
    const fields = fieldsOf({ email: "ada@example.com" });
    const other = deriveErasureKey("another-long-erasure-secret");
    expect(matchesHashed({ email: "ada@example.com" }, fields, other)).toBe(false);
  });

  it("collects the values MongoDB equality compares against", () => {
    expect(valuesAtPath({ a: { b: [1, 2] } }, "a.b")).toEqual([[1, 2], 1, 2]);
    expect(valuesAtPath({ a: 1 }, "a.b")).toEqual([]);
  });
});

describe("canonicalScalar", () => {
  it("gives every scalar type its own text, and equal numbers the same one", () => {
    expect(canonicalScalar(true)).toBe("bool:true");
    expect(canonicalScalar(10n)).toBe("number:10");
    expect(canonicalScalar(new Date(5))).toBe("date:5");
    expect(canonicalScalar(-0)).toBe(canonicalScalar(0));
    expect(canonicalScalar(new Int32(7))).toBe(canonicalScalar(Long.fromNumber(7)));
    expect(canonicalScalar({ nested: true })).toBeUndefined();
  });

  it("keeps operator paths out of hashed filters", () => {
    const stored = storeFilter(
      { email: "ada@example.com", $comment: "gdpr" },
      deriveErasureKey(SECRET),
    );
    expect(stored.kind).toBe("filter");
  });
});

describe("exact numeric identity", () => {
  const key = deriveErasureKey(SECRET);

  function fieldsOf(filter: Record<string, unknown>) {
    const stored = storeFilter(filter, key);
    if (stored.kind !== "hashed") throw new Error("expected a hashed filter");
    return stored.fields;
  }

  it("records the match version on new hashed matches", () => {
    const stored = storeFilter({ email: "ada@example.com" }, key);
    expect(stored).toMatchObject({ kind: "hashed", matchVersion: MATCH_VERSION });
  });

  it("gives doubles and integers of equal value the same text", () => {
    expect(canonicalScalar(new Double(5))).toBe(canonicalScalar(new Int32(5)));
    expect(canonicalScalar(5)).toBe(canonicalScalar(Long.fromNumber(5)));
    expect(canonicalScalar(new Double(-0))).toBe(canonicalScalar(Long.fromNumber(0)));
    expect(canonicalScalar(new Double(5.5))).not.toBe(canonicalScalar(new Int32(5)));
  });

  it("matches a double above 2^53 with the Long of the same value, and not its neighbours", () => {
    const twoTo62 = 2 ** 62;
    // String(2 ** 62) is "4611686018427388000": the shortest text, not the value.
    const exact = Long.fromString("4611686018427387904");
    expect(canonicalScalar(new Double(twoTo62))).toBe(canonicalScalar(exact));
    expect(canonicalScalar(twoTo62)).toBe(canonicalScalar(BigInt(twoTo62)));
    expect(canonicalScalar(new Double(twoTo62))).not.toBe(
      canonicalScalar(Long.fromString("4611686018427388000")),
    );
    expect(canonicalScalar(exact.add(1))).not.toBe(canonicalScalar(new Double(twoTo62)));

    const fields = fieldsOf({ email: "ada@example.com", account: exact });
    expect(
      matchesHashed({ email: "ada@example.com", account: new Double(twoTo62) }, fields, key),
    ).toBe(true);
    expect(matchesHashed({ email: "ada@example.com", account: exact.add(1) }, fields, key)).toBe(
      false,
    );
  });

  it("keeps large Longs apart that one double would round together", () => {
    const big = Long.fromString("9007199254740993"); // 2^53 + 1: no double holds it
    const fields = fieldsOf({ email: "ada@example.com", account: big });
    expect(matchesHashed({ email: "ada@example.com", account: big }, fields, key)).toBe(true);
    expect(
      matchesHashed(
        { email: "ada@example.com", account: Long.fromString("9007199254740992") },
        fields,
        key,
      ),
    ).toBe(false);
    expect(
      matchesHashed({ email: "ada@example.com", account: new Double(2 ** 53) }, fields, key),
    ).toBe(false);
  });

  it("matches Decimal128 ids by value, whatever their trailing zeros or exponent", () => {
    const fields = fieldsOf({ email: "ada@example.com", tenant: Decimal128.fromString("5.0") });
    for (const tenant of [
      Decimal128.fromString("5"),
      Decimal128.fromString("500E-2"),
      new Int32(5),
      Long.fromNumber(5),
      new Double(5),
      5,
    ]) {
      expect(matchesHashed({ email: "ada@example.com", tenant }, fields, key)).toBe(true);
    }
    expect(
      matchesHashed(
        { email: "ada@example.com", tenant: Decimal128.fromString("5.01") },
        fields,
        key,
      ),
    ).toBe(false);
  });

  it("matches Decimal128 fractions with doubles only when the double is exactly equal", () => {
    // 0.5 is a binary fraction; 0.1 is not, so Double(0.1) is not one tenth.
    expect(canonicalScalar(Decimal128.fromString("0.5"))).toBe(canonicalScalar(new Double(0.5)));
    expect(canonicalScalar(Decimal128.fromString("0.1"))).not.toBe(canonicalScalar(0.1));
    expect(canonicalScalar(Decimal128.fromString("0.10"))).toBe(
      canonicalScalar(Decimal128.fromString("1E-1")),
    );
    expect(canonicalScalar(Decimal128.fromString("-0"))).toBe(canonicalScalar(0));
    expect(canonicalScalar(Decimal128.fromString("NaN"))).toBe(canonicalScalar(Number.NaN));
    expect(canonicalScalar(Decimal128.fromString("-Infinity"))).toBe(
      canonicalScalar(Number.NEGATIVE_INFINITY),
    );
  });
});
