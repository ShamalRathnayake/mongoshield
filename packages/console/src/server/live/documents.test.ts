/**
 * Unit tests for the live document helpers: versions, type-preserving merges and the
 * parsers for what users type into the data browser.
 */

import { BSON, Double, Int32, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { relaxedText } from "../ejson-text.ts";
import { parseNamespace } from "./apply.ts";
import {
  assertNoServerJavaScript,
  fromExtendedJson,
  idLabelOf,
  liveDocumentView,
  mergeEdit,
  parseDocumentText,
  parseIdKey,
  parseQueryObject,
  parseSort,
  parseUpdate,
  parseVersion,
  versionOf,
} from "./documents.ts";

/** The relaxed text the browser shows, edited by `change`, parsed like the server does. */
function editedFrom(original: BSON.Document, change: (value: Record<string, unknown>) => void) {
  // Exactly the text the browser is shown (relaxed, unsafe Int64 values kept exact).
  const shown = JSON.parse(relaxedText(original));
  change(shown);
  return parseDocumentText(JSON.stringify(shown));
}

/** Canonical Extended JSON, to compare types exactly. */
const canonical = (value: unknown) => BSON.EJSON.stringify(value, { relaxed: false });

describe("versions", () => {
  it("change with any value or type, and not with nothing", () => {
    const document = { _id: 1, price: new Double(1) };
    expect(versionOf(document)).toBe(versionOf({ _id: 1, price: new Double(1) }));
    expect(versionOf(document)).not.toBe(versionOf({ _id: 1, price: new Int32(1) }));
    expect(versionOf(document)).not.toBe(versionOf({ _id: 1, price: new Double(2) }));
  });

  it("are left out of partial documents, which cannot be edited", () => {
    const view = liveDocumentView({ _id: new ObjectId("65f000000000000000000001"), a: 1 }, false);
    expect(view.id).toBe('{"$oid":"65f000000000000000000001"}');
    expect(view.version).toBeUndefined();
    expect(liveDocumentView({ a: 1 }, true)).toEqual({ json: '{"a":1}' });
  });
});

describe("mergeEdit", () => {
  const original = {
    _id: 1,
    price: new Double(1),
    big: Long.fromString("9007199254740993"),
    nested: { ratio: new Double(2), label: "x" },
    tags: [new Double(1), "b"],
    when: new Date("2026-01-01T00:00:00Z"),
  };

  it("keeps the exact type of every untouched value", () => {
    const merged = mergeEdit(
      original,
      editedFrom(original, (shown) => {
        (shown.nested as Record<string, unknown>).label = "y";
      }),
    );
    expect(merged.changedFields).toEqual(["nested.label"]);
    expect(canonical(merged.document)).toBe(
      canonical({ ...original, nested: { ratio: new Double(2), label: "y" } }),
    );
  });

  it("uses the typed value of changed fields", () => {
    const merged = mergeEdit(
      original,
      editedFrom(original, (shown) => {
        shown.price = 2.5;
        shown.big = { $numberLong: "7" };
      }),
    );
    expect(merged.changedFields).toEqual(["price", "big"]);
    expect(canonical(merged.document.price)).toBe('{"$numberDouble":"2.5"}');
    expect(canonical(merged.document.big)).toBe('{"$numberLong":"7"}');
  });

  it("reports added and removed fields", () => {
    const merged = mergeEdit(
      original,
      editedFrom(original, (shown) => {
        delete shown.when;
        shown.added = true;
      }),
    );
    expect(merged.changedFields).toEqual(["added", "when"]);
    expect("when" in merged.document).toBe(false);
  });

  it("compares arrays element by element, and reports a changed length as the array", () => {
    const sameLength = mergeEdit(
      original,
      editedFrom(original, (shown) => {
        (shown.tags as unknown[])[1] = "c";
      }),
    );
    expect(sameLength.changedFields).toEqual(["tags.1"]);
    expect(canonical(sameLength.document.tags)).toBe('[{"$numberDouble":"1.0"},"c"]');
    const longer = mergeEdit(
      original,
      editedFrom(original, (shown) => {
        (shown.tags as unknown[]).push("d");
      }),
    );
    expect(longer.changedFields).toEqual(["tags"]);
    // The element that still lines up keeps its double type.
    expect(canonical(longer.document.tags)).toBe('[{"$numberDouble":"1.0"},"b","d"]');
  });

  it("reports nothing for an untouched document, and replaced scalars by path", () => {
    expect(
      mergeEdit(
        original,
        editedFrom(original, () => {}),
      ).changedFields,
    ).toEqual([]);
    const typeChange = mergeEdit({ _id: 1, a: { b: 1 } }, parseDocumentText('{"_id": 1, "a": 5}'));
    expect(typeChange.changedFields).toEqual(["a"]);
  });
});

describe("parsing what users type", () => {
  it("accepts documents as Extended JSON and refuses everything else", () => {
    expect(parseDocumentText('{"a": {"$numberLong": "5"}}').a).toBeInstanceOf(Long);
    expect(() => parseDocumentText("")).toThrow("required");
    expect(() => parseDocumentText(5)).toThrow("required");
    expect(() => parseDocumentText("[1]")).toThrow("JSON object");
    expect(() => parseDocumentText("{")).toThrow("not valid Extended JSON");
    expect(() => parseDocumentText('{"$set": {"a": 1}}')).toThrow('cannot start with "$"');
    expect(() => parseDocumentText(`{"a": "${"x".repeat(1024 * 1024)}"}`)).toThrow("KiB");
  });

  it("checks ids and versions sent back by the browser", () => {
    expect(parseIdKey('{"$oid":"65f000000000000000000001"}')).toBeInstanceOf(ObjectId);
    expect(() => parseIdKey("")).toThrow("_id");
    expect(() => parseIdKey("{")).toThrow("not valid");
    expect(parseVersion("a".repeat(64))).toBe("a".repeat(64));
    expect(() => parseVersion("A".repeat(64))).toThrow("version");
  });

  it("refuses server-side JavaScript anywhere in a query", () => {
    expect(() => parseQueryObject('{"$where": "1"}', "The filter")).toThrow("$where");
    expect(() =>
      parseQueryObject('{"a": {"$elemMatch": {"$expr": {"$function": {}}}}}', "The filter"),
    ).toThrow("$function");
    expect(() => assertNoServerJavaScript([{ $accumulator: {} }], "The update")).toThrow(
      "$accumulator",
    );
    expect(parseQueryObject("", "The filter")).toBeUndefined();
    expect(parseQueryObject('{"a": 1}', "The filter")).toEqual({ a: new Int32(1) });
  });

  it("accepts sorts of 1 and -1 only", () => {
    expect(parseSort('{"a": 1, "b": -1}')).toEqual({ a: 1, b: -1 });
    expect(parseSort(undefined)).toBeUndefined();
    expect(parseSort('{"a": {"$numberLong": "-1"}}')).toEqual({ a: -1 });
    expect(() => parseSort('{"a": 0}')).toThrow("1 or -1");
    expect(() => parseSort('{"a": "asc"}')).toThrow("1 or -1");
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`f${index}`, 1]));
    expect(() => parseSort(JSON.stringify(tooMany))).toThrow("32");
  });

  it("accepts plain update operators only", () => {
    expect(Object.keys(parseUpdate('{"$set": {"a": 1}, "$inc": {"n": 1}}'))).toEqual([
      "$set",
      "$inc",
    ]);
    expect(() => parseUpdate(undefined)).toThrow("required");
    expect(() => parseUpdate("{}")).toThrow("at least one operator");
    expect(() => parseUpdate('{"a": 1}')).toThrow("not an allowed update operator");
    expect(() => parseUpdate('{"$set": 1}')).toThrow("object of fields");
    expect(() => parseUpdate('{"$set": {}}')).toThrow("object of fields");
    expect(() => parseUpdate('{"$set": {"_id": 1}}')).toThrow("_id");
    expect(() => parseUpdate('{"$unset": {"_id.x": ""}}')).toThrow("_id");
  });

  it("shortens long _id labels for the index and the audit log", () => {
    expect(idLabelOf(5)).toBe("5");
    const label = idLabelOf("x".repeat(500));
    expect(label).toHaveLength(200);
    expect(label.endsWith("…")).toBe(true);
    expect(fromExtendedJson('{"$numberInt": "3"}')).toEqual(new Int32(3));
  });
});

describe("namespaces", () => {
  it("splits database and collection at the first dot", () => {
    expect(parseNamespace("app.users.archive")).toEqual({
      db: "app",
      collection: "users.archive",
      ns: "app.users.archive",
    });
  });

  it("refuses malformed names and MongoDB's own databases and collections", () => {
    for (const bad of [undefined, "", "app", ".users", "app.", "a b.users", "a$.users"]) {
      expect(() => parseNamespace(bad), String(bad)).toThrow();
    }
    expect(() => parseNamespace("x".repeat(256))).toThrow("required");
    for (const internal of [
      "admin.users",
      "config.settings",
      "local.oplog.rs",
      "app.system.views",
    ]) {
      expect(() => parseNamespace(internal), internal).toThrow("belongs to MongoDB itself");
    }
  });
});
