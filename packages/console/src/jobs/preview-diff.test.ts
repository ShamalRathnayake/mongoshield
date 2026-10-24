import { BSON, Double, Int32, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  diffDocumentFields,
  looksSecret,
  MAX_FIELD_CHANGES,
  MAX_VALUE_CHARACTERS,
  redactedJson,
} from "./preview-diff.ts";

describe("diffDocumentFields", () => {
  it("lists added, removed and changed fields by dotted path", () => {
    const { fields, truncated } = diffDocumentFields(
      { _id: 1, name: "Ada", address: { city: "London", zip: "N1" }, tags: ["a", "b"] },
      { _id: 1, name: "Ada", address: { city: "Paris" }, tags: ["a", "c", "d"], extra: true },
    );
    expect(truncated).toBe(false);
    expect(fields).toEqual([
      { path: "address.city", change: "changed", backup: '"London"', live: '"Paris"' },
      { path: "address.zip", change: "added", backup: '"N1"' },
      { path: "tags.1", change: "changed", backup: '"b"', live: '"c"' },
      { path: "tags.2", change: "removed", live: '"d"' },
      { path: "extra", change: "removed", live: "true" },
    ]);
  });

  it("treats a different BSON type of the same number as a change", () => {
    const { fields } = diffDocumentFields(
      { _id: 1, qty: new Int32(1) },
      { _id: 1, qty: new Double(1) },
    );
    expect(fields).toEqual([{ path: "qty", change: "changed", backup: "1", live: "1" }]);
  });

  it("compares Extended JSON types as single values", () => {
    const id = new ObjectId("65f000000000000000000001");
    const same = diffDocumentFields(
      { _id: id, at: new Date("2026-10-01T00:00:00Z") },
      { _id: id, at: new Date("2026-10-01T00:00:00Z") },
    );
    expect(same.fields).toEqual([]);
    const moved = diffDocumentFields(
      { _id: id, at: new Date("2026-10-01T00:00:00Z") },
      { _id: id, at: new Date("2026-10-02T00:00:00Z") },
    );
    expect(moved.fields).toEqual([
      {
        path: "at",
        change: "changed",
        backup: '{"$date":"2026-10-01T00:00:00Z"}',
        live: '{"$date":"2026-10-02T00:00:00Z"}',
      },
    ]);
  });

  it("compares an object with an array as one changed value", () => {
    const { fields } = diffDocumentFields({ _id: 1, value: { a: 1 } }, { _id: 1, value: [1] });
    expect(fields).toEqual([{ path: "value", change: "changed", backup: '{"a":1}', live: "[1]" }]);
  });

  it("lists every field of a document that exists on one side only", () => {
    expect(diffDocumentFields(undefined, { _id: 7, name: "x" }).fields).toEqual([
      { path: "_id", change: "removed", live: "7" },
      { path: "name", change: "removed", live: '"x"' },
    ]);
    expect(diffDocumentFields({ _id: 7 }, undefined).fields).toEqual([
      { path: "_id", change: "added", backup: "7" },
    ]);
    expect(diffDocumentFields(undefined, undefined).fields).toEqual([]);
  });

  it("hides the values of secret-looking fields at any depth, but reports the change", () => {
    const { fields } = diffDocumentFields(
      { _id: 1, auth: { passwordHash: "old" }, credentials: { user: "a" } },
      { _id: 1, auth: { passwordHash: "new" }, credentials: { user: "b" } },
    );
    expect(fields).toEqual([
      {
        path: "auth.passwordHash",
        change: "changed",
        backup: '"***"',
        live: '"***"',
        redacted: true,
      },
      {
        path: "credentials.user",
        change: "changed",
        backup: '"***"',
        live: '"***"',
        redacted: true,
      },
    ]);
    expect(diffDocumentFields(undefined, { _id: 1, apiKey: "k" }).fields).toContainEqual({
      path: "apiKey",
      change: "removed",
      live: '"***"',
      redacted: true,
    });
  });

  it("stops listing after the limit and cuts long values", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_FIELD_CHANGES + 5 }, (_, index) => [`f${index}`, index]),
    );
    const result = diffDocumentFields({ _id: 1, ...many }, { _id: 1 });
    expect(result.fields).toHaveLength(MAX_FIELD_CHANGES);
    expect(result.truncated).toBe(true);

    const long = "x".repeat(MAX_VALUE_CHARACTERS * 2);
    const [field] = diffDocumentFields({ _id: 1, text: long }, { _id: 1, text: "y" }).fields;
    expect(field?.backup?.endsWith("…")).toBe(true);
    expect(field?.backup?.length).toBe(MAX_VALUE_CHARACTERS + 1);
  });
});

describe("redactedJson", () => {
  it("replaces secret values in relaxed Extended JSON and keeps everything else", () => {
    const json = redactedJson({
      _id: new ObjectId("65f000000000000000000001"),
      name: "Ada",
      profile: { token: { value: "abc" }, history: [{ secret: 1 }, { ok: 2 }] },
    });
    expect(JSON.parse(json)).toEqual({
      _id: { $oid: "65f000000000000000000001" },
      name: "Ada",
      profile: { token: "***", history: [{ secret: "***" }, { ok: 2 }] },
    });
    // Still valid Extended JSON.
    expect(BSON.EJSON.parse(json)).toMatchObject({ name: "Ada" });
  });
});

describe("looksSecret", () => {
  it("matches the usual names of secrets, whatever their case", () => {
    for (const name of ["password", "PASSWD", "refreshToken", "api_key", "apiKey", "privateKey"]) {
      expect(looksSecret(name), name).toBe(true);
    }
    for (const name of ["name", "email", "passenger", "keys"]) {
      expect(looksSecret(name), name).toBe(false);
    }
  });
});
