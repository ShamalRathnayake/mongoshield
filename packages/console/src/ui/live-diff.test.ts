/**
 * Unit tests for the live editor's field-level diff (live-diff.ts) and the query
 * checks of the live data browser (live-query.ts).
 */

import { describe, expect, it } from "vitest";
import { diffDocuments, MAX_LISTED_CHANGES, showValue } from "./live-diff.ts";
import { checkDocument, checkProjection, checkSort, checkUpdate } from "./live-query.ts";

describe("diffDocuments", () => {
  it("finds nothing in equal documents", () => {
    expect(diffDocuments({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toEqual([]);
  });

  it("reports added, removed and changed fields by dotted path", () => {
    const before = { _id: 1, name: "Ada", address: { city: "Colombo", zip: "100" }, old: true };
    const after = { _id: 1, name: "Ada L.", address: { city: "Colombo", country: "LK" }, extra: 5 };
    expect(diffDocuments(before, after)).toEqual([
      { path: "name", change: "changed", before: '"Ada"', after: '"Ada L."' },
      { path: "address.zip", change: "removed", before: '"100"' },
      { path: "address.country", change: "added", after: '"LK"' },
      { path: "old", change: "removed", before: "true" },
      { path: "extra", change: "added", after: "5" },
    ]);
  });

  it("compares arrays element by element", () => {
    expect(diffDocuments({ tags: ["a", "b"] }, { tags: ["a", "c", "d"] })).toEqual([
      { path: "tags.1", change: "changed", before: '"b"', after: '"c"' },
      { path: "tags.2", change: "added", after: '"d"' },
    ]);
    expect(diffDocuments({ tags: ["a", "b"] }, { tags: ["a"] })).toEqual([
      { path: "tags.1", change: "removed", before: '"b"' },
    ]);
  });

  it("treats Extended JSON wrappers as values and shows them the MongoDB way", () => {
    const changes = diffDocuments(
      { at: { $date: "2026-01-01T00:00:00Z" } },
      { at: { $date: "2026-02-01T00:00:00Z" } },
    );
    expect(changes).toEqual([
      {
        path: "at",
        change: "changed",
        before: 'ISODate("2026-01-01T00:00:00Z")',
        after: 'ISODate("2026-02-01T00:00:00Z")',
      },
    ]);
    expect(showValue({ $oid: "65aa" })).toBe('ObjectId("65aa")');
  });

  it("reports a type change of a whole value", () => {
    expect(diffDocuments({ a: { b: 1 } }, { a: [1] })).toEqual([
      { path: "a", change: "changed", before: '{"b":1}', after: "[1]" },
    ]);
    expect(diffDocuments(1, 2)[0]?.path).toBe("(document)");
  });

  it("lists at most a bounded number of changes", () => {
    const before = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`f${index}`, 1]));
    const after = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`f${index}`, 2]));
    expect(diffDocuments(before, after)).toHaveLength(MAX_LISTED_CHANGES);
  });
});

describe("live query checks", () => {
  it("accepts empty input as nothing", () => {
    expect(checkProjection("  ")).toEqual({ ok: true, value: undefined });
    expect(checkSort("{}")).toEqual({ ok: true, value: undefined });
  });

  it("compacts valid input", () => {
    expect(checkProjection('{ "name": 1 }')).toEqual({ ok: true, value: '{"name":1}' });
    expect(checkSort('{"a": 1, "b": -1}')).toEqual({ ok: true, value: '{"a":1,"b":-1}' });
    expect(checkUpdate('{"$set": {"a": 1}}')).toEqual({ ok: true, value: '{"$set":{"a":1}}' });
  });

  it("explains invalid input", () => {
    expect(checkProjection("{name: 1}")).toMatchObject({ ok: false });
    expect(checkProjection("[1]")).toMatchObject({
      ok: false,
      message: expect.stringContaining("object"),
    });
    expect(checkSort('{"a": "up"}')).toMatchObject({ ok: false });
    expect(checkUpdate("")).toMatchObject({ ok: false });
    expect(checkUpdate('{"$set": 1}')).toMatchObject({
      ok: false,
      message: '"$set" needs an object of fields.',
    });
    expect(checkUpdate('{"a": {"b": 1}}')).toMatchObject({ ok: false });
    expect(checkUpdate("not json")).toMatchObject({ ok: false });
  });

  it("refuses server-side JavaScript", () => {
    expect(checkProjection('{"$where": "1"}')).toMatchObject({
      ok: false,
      message: expect.stringContaining("$where"),
    });
  });

  it("checks documents and keeps _id unchanged in edits", () => {
    expect(checkDocument("{")).toMatchObject({ ok: false });
    expect(checkDocument("null")).toMatchObject({ ok: false });
    expect(checkDocument('{"$set": {}}')).toMatchObject({ ok: false });
    expect(checkDocument('{"_id": 2, "a": 1}', 1)).toMatchObject({
      ok: false,
      message: expect.stringContaining("_id"),
    });
    expect(checkDocument('{"_id": 1, "a": 1}', 1)).toEqual({
      ok: true,
      document: { _id: 1, a: 1 },
      text: '{"_id":1,"a":1}',
    });
  });
});
