// detectPii end to end on in-memory documents: one finding per kind, the look-alikes
// that must produce nothing (ids, counters, enums, hashes), paths through arrays and
// sub-documents, the profiler's bounds, and the privacy rule: no sampled value ever
// appears in a finding.

import fc from "fast-check";
import { Binary, Decimal128, Double, Int32, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { classifyProfile, detectPii, type PiiFinding } from "./classify.ts";
import { maskedShape } from "./example.ts";
import { CollectionProfiler, isDataKey, numericValue } from "./profile.ts";

/** `count` documents built by `make(index)`. */
function documents<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => make(index));
}

/** The finding at a path, or undefined. */
function at(findings: readonly PiiFinding[], path: string): PiiFinding | undefined {
  return findings.find((finding) => finding.path === path);
}

const FIRST_NAMES = ["Ada", "Grace", "Linus", "Seán", "Mei", "Tariq", "Zoë", "Kai"];

describe("detectPii: one finding per kind", () => {
  const users = documents(40, (index) => ({
    _id: new ObjectId(),
    email: `user${index}@corp.example`,
    phone: `+44 20 7946 ${String(1000 + index)}`,
    firstName: FIRST_NAMES[index % FIRST_NAMES.length],
    addresses: [{ street: `${index + 1} Baker Street`, zip: "SW1A 1AA", city: "London" }],
    dob: new Date(1980, 0, index + 1),
    password: `$2b$10$${"a".repeat(53)}`,
    resetToken: `tok${index}X9fK2mQ7vB4nL8pR3sT6`,
    lastLoginIp: `10.0.0.${index}`,
    location: { type: "Point", coordinates: [-0.12, 51.5] },
    lat: 51.5 + index / 1000,
    lng: -0.12,
    homeLocation: [-0.12, 51.5],
    iban: "GB82 WEST 1234 5698 7654 32",
    card: "4111 1111 1111 1111",
    ssn: "123-45-6789",
    nino: "AB 12 34 56 C",
    notes:
      index % 4 === 0 ? `Prefers a call on +44 7700 900${100 + index}` : "Ordered twice, happy",
  }));
  const findings = detectPii(users, { collection: "users" });

  it.each([
    ["email", "email", undefined],
    ["phone", "phone", "e164"],
    ["firstName", "person-name", undefined],
    ["addresses.*.street", "address", undefined],
    ["addresses.*.zip", "postal-code", "distinctive"],
    ["dob", "date-of-birth", undefined],
    ["password", "secret", "password-hash"],
    ["resetToken", "secret", "token"],
    ["lastLoginIp", "ip-address", "4"],
    ["location", "geolocation", "geojson"],
    ["lat", "geolocation", "latitude"],
    ["lng", "geolocation", "longitude"],
    ["homeLocation", "geolocation", "pair"],
    ["iban", "iban", undefined],
    ["card", "credit-card", undefined],
    ["ssn", "national-id", "us-ssn"],
    ["nino", "national-id", "uk-nino"],
    ["notes", "free-text", undefined],
  ] as const)("finds %s: %s", (path, kind, detail) => {
    const finding = at(findings, path);
    expect(finding?.kind).toBe(kind);
    expect(finding?.detail).toBe(detail);
    expect(finding?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("finds nothing in the city, the _id or a GeoJSON point's coordinates", () => {
    expect(at(findings, "addresses.*.city")).toBeUndefined();
    expect(at(findings, "_id")).toBeUndefined();
    expect(findings.some((finding) => finding.path.startsWith("location."))).toBe(false);
  });

  it("sorts by confidence, highest first", () => {
    const confidences = findings.map((finding) => finding.confidence);
    expect(confidences).toEqual([...confidences].sort((left, right) => right - left));
  });

  it("explains each finding and reports shares and counts", () => {
    const email = at(findings, "email");
    expect(email).toMatchObject({ share: 1, matched: 40, sampled: 40, valueType: "string" });
    expect(email?.reason).toBe("100% of 40 values are email addresses, and the field name agrees");
    expect(at(findings, "firstName")?.reason).toContain("the field name suggests a person name");
    expect(at(findings, "notes")?.reason).toBe(
      "25% of 40 texts contain an email address or phone number",
    );
  });

  it("never puts a sampled value into a finding: examples are shapes", () => {
    const output = JSON.stringify(findings);
    for (const user of users) {
      for (const value of [user.email, user.phone, user.resetToken, user.lastLoginIp, user.ssn]) {
        expect(output).not.toContain(value);
      }
    }
    expect(output).not.toContain("Baker");
    expect(output).not.toContain("WEST");
    expect(at(findings, "email")?.example).toBe("xxxx#@xxxx.xxxxxxx");
    expect(at(findings, "password")?.example).toBe("[secret, 60 characters]");
    expect(at(findings, "dob")?.example).toBe("####-##-##");
    expect(at(findings, "notes")?.example).toBe("…+## #### ######…");
  });
});

describe("detectPii: privacy", () => {
  it("never returns any sampled email, name or phone, whatever they are", () => {
    const person = fc.record({
      email: fc.emailAddress(),
      fullName: fc.stringMatching(/^[A-Z][a-z]{2,10} [A-Z][a-z]{2,12}$/),
      phone: fc.stringMatching(/^\+[1-9][0-9]{9,12}$/),
    });
    fc.assert(
      fc.property(fc.array(person, { minLength: 1, maxLength: 20 }), (people) => {
        const output = JSON.stringify(detectPii(people, { collection: "people" }));
        for (const { email, fullName, phone } of people) {
          expect(output).not.toContain(email);
          expect(output).not.toContain(fullName);
          expect(output).not.toContain(phone);
        }
      }),
    );
  });
});

describe("detectPii: look-alikes that are not personal data", () => {
  it("ignores ids, counters, hashes, UUIDs, enums, booleans and prices", () => {
    const findings = detectPii(
      documents(50, (index) => ({
        _id: new ObjectId(),
        ref: new ObjectId().toHexString(),
        uuid: crypto.randomUUID(),
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        status: ["active", "pending", "closed"][index % 3],
        name: ["Basic", "Pro"][index % 2],
        views: index * 1_234_567,
        total: new Decimal128(`${index}.99`),
        count: new Long(index),
        active: index % 2 === 0,
        orderNumber: String(4_000_000_000_000_000 + index),
        createdAt: new Date(2026, 0, 1),
        version: "1.2.3",
        sku: `SKU-${10_000 + index}`,
        nanoid: `V1StGXR8_Z5jdHi6B-m${String(index).padStart(3, "0")}`,
        blob: new Binary(Buffer.from("hi")),
      })),
      { collection: "users" },
    );
    expect(findings).toEqual([]);
  });

  it("does not take a product's name, or names in an unrelated collection, for a person's", () => {
    const findings = detectPii(
      documents(30, (index) => ({ name: `${FIRST_NAMES[index % 8]} Widget` })),
      { collection: "products" },
    );
    expect(findings).toEqual([]);
  });

  it("needs most values to match when the name says nothing", () => {
    // 1 in 4 values an email: noise, not an email field.
    const findings = detectPii(
      documents(40, (index) => ({
        contact: index % 4 === 0 ? `a${index}@example.com` : `ref-${index}`,
      })),
    );
    expect(findings).toEqual([]);
  });

  it("accepts a lower share when the field name agrees", () => {
    const findings = detectPii(
      documents(40, (index) => ({ email: index % 2 === 0 ? `a${index}@example.com` : "" })),
    );
    expect(at(findings, "email")?.share).toBe(0.5);
  });

  it("drops findings under minConfidence", () => {
    const values = documents(20, (index) => ({
      notes: index === 0 ? "write to ada@example.com today" : "ok, thanks a lot",
    }));
    expect(at(detectPii(values), "notes")?.confidence).toBe(0.6);
    expect(detectPii(values, { minConfidence: 0.7 })).toEqual([]);
  });

  it("treats documents keyed by data as maps, so no key is ever shown", () => {
    const findings = detectPii([
      {
        contacts: {
          "ada@example.com": { phone: "+44 20 7946 0001" },
          "12345678": { phone: "+44 20 7946 0002" },
        },
      },
    ]);
    expect(findings.map((finding) => finding.path)).toEqual(["contacts.*.phone"]);
    expect(isDataKey("507f1f77bcf86cd799439011")).toBe(true);
    expect(isDataKey("10.0.0.1")).toBe(true);
    expect(isDataKey("+44 20 7946 0958")).toBe(true);
    expect(isDataKey("Ada Costa")).toBe(true);
    expect(isDataKey("@ada")).toBe(true);
    expect(isDataKey("billing")).toBe(false);
    expect(isDataKey("line1")).toBe(false);
  });
});

describe("detectPii: numbers and BSON types", () => {
  it("reads phone and postal codes stored as numbers when the name says so", () => {
    const findings = detectPii(
      documents(20, (index) => ({ phone: 7_700_900_000 + index, zip: new Int32(94_105) })),
    );
    expect(at(findings, "phone")).toMatchObject({
      kind: "phone",
      detail: "digits",
      valueType: "number",
    });
    expect(at(findings, "zip")).toMatchObject({ kind: "postal-code", valueType: "number" });
  });

  it("reads latitudes from js-bson Doubles and rejects out-of-range ones", () => {
    const valid = detectPii(documents(10, () => ({ latitude: new Double(51.5) })));
    expect(at(valid, "latitude")?.detail).toBe("latitude");
    expect(detectPii(documents(10, () => ({ latitude: 123.4 })))).toEqual([]);
  });

  it("converts every BSON number, and nothing else", () => {
    expect(numericValue(new Int32(5))).toBe(5);
    expect(numericValue(new Double(2.5))).toBe(2.5);
    expect(numericValue(Long.fromNumber(7))).toBe(7);
    expect(numericValue(new Decimal128("1.25"))).toBe(1.25);
    expect(numericValue(9n)).toBe(9);
    expect(numericValue("5")).toBeUndefined();
  });

  it("suggests nothing for dates of birth stored as other types it cannot read", () => {
    expect(detectPii(documents(10, () => ({ dob: true })))).toEqual([]);
  });

  it("reads string dates of birth and calls a mixed-type field mixed", () => {
    const findings = detectPii(
      documents(10, (index) => ({ dob: index < 5 ? "1990-05-01" : new Date(1990, 4, 1) })),
    );
    expect(at(findings, "dob")).toMatchObject({ kind: "date-of-birth", valueType: "mixed" });
  });
});

describe("the profiler's bounds", () => {
  it("stops adding paths at maxPaths and says so", () => {
    const profiler = new CollectionProfiler("things", { maxPaths: 2 });
    profiler.add({ a: 1, b: 2, c: 3 });
    expect(profiler.profiles().map((profile) => profile.path)).toEqual(["a", "b"]);
    expect(profiler.truncated).toBe(true);
    expect(profiler.documents).toBe(1);
  });

  it("stops at maxDepth and reads at most maxArrayElements elements", () => {
    const profiler = new CollectionProfiler("things", { maxDepth: 2, maxArrayElements: 3 });
    profiler.add({ one: { two: { three: "deep" } }, list: [1, 2, 3, 4, 5], pairs: [[1, 2]] });
    const paths = profiler.profiles().map((profile) => profile.path);
    expect(paths).not.toContain("one.two.three");
    expect(profiler.profiles().find((profile) => profile.path === "list.*")?.values).toBe(3);
    expect(paths).not.toContain("pairs.*.*");
  });

  it("skips keys a mask path cannot name, nulls and empty strings' signals", () => {
    const profiler = new CollectionProfiler("things");
    profiler.add({ "a.b": "x", $weird: "y", "": "z", gone: null, blank: "  " });
    expect(profiler.profiles().map((profile) => profile.path)).toEqual(["blank"]);
  });

  it("scans long text only for contacts, and only its beginning", () => {
    const long = `${"lorem ipsum ".repeat(100)} reach ada@example.com`;
    const findings = detectPii([{ body: long }, { body: `${"x ".repeat(6000)} ada@example.com` }]);
    expect(at(findings, "body")).toMatchObject({ kind: "free-text", matched: 1 });
  });

  it("classifies an empty profile as nothing", () => {
    const profiler = new CollectionProfiler("things");
    profiler.add({ location: [1, 2, 3] });
    const empty = { ...profiler.profiles()[0], values: 0 };
    expect(classifyProfile(empty as never)).toBeUndefined();
  });
});

describe("masked examples", () => {
  it("never contain a letter or digit of the input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 60 }), (text) => {
        const shape = maskedShape(text);
        // Only the placeholders, punctuation, symbols and spaces remain.
        expect(shape).toMatch(/^[xX#…\p{P}\p{S}\p{M}\p{Z}\p{C}]*$/u);
      }),
    );
  });

  it("are cut at 32 characters", () => {
    expect(maskedShape("a".repeat(40))).toBe(`${"x".repeat(32)}…`);
    expect(maskedShape("  Ada   Costa  ")).toBe("Xxx Xxxxx");
  });
});
