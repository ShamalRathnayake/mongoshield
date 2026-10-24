import { Double, Int32, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { deriveErasureKey, matchesHashed, storeFilter, valuesAtPath } from "./erasure-match.ts";

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
