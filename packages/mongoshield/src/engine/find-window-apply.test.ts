// Unit tests for applying change events to documents in memory, with replay's rules
// (find-window-apply.ts). The end-to-end check against a real converge backup is
// test/integration/find-window.test.ts.

import { BSON, type Document, Int32, ObjectId, Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import { inStoredOrderAnywhere } from "../format/field-order.ts";
import { type ChangeEvent, parseChangeEvent, type UpdateDescription } from "./converge-events.ts";
import { storedFieldOrder } from "./filter-values.ts";
import { parseBackedUpDocument } from "./find-parse.ts";
import {
  applyDocumentEvent,
  applyUpdateDescription,
  cloneValue,
  isDocumentEvent,
  replacesDocument,
} from "./find-window-apply.ts";

/** A change event as the changes file stores it. */
function event(fields: Document): ChangeEvent {
  return parseChangeEvent(
    BSON.serialize({
      clusterTime: new Timestamp({ t: 1, i: 1 }),
      ns: { db: "app", coll: "c" },
      ...fields,
    }),
  );
}

function update(description: Partial<UpdateDescription>): UpdateDescription {
  return {
    updatedFields: {},
    removedFields: [],
    truncatedArrays: [],
    disambiguatedPaths: new Map(),
    ...description,
  };
}

describe("applyDocumentEvent", () => {
  it("replaces with the event's document, deletes, and ignores updates without a description", () => {
    const before = { _id: 1, a: 1 };
    const inserted = applyDocumentEvent(
      undefined,
      event({ operationType: "insert", documentKey: { _id: 1 }, fullDocument: { _id: 1, b: 2 } }),
    );
    // Events are parsed losslessly: numbers keep their BSON type.
    expect(inserted).toEqual({ _id: new Int32(1), b: new Int32(2) });
    expect(
      applyDocumentEvent(before, event({ operationType: "delete", documentKey: { _id: 1 } })),
    ).toBeUndefined();
    expect(
      applyDocumentEvent(before, event({ operationType: "update", documentKey: { _id: 1 } })),
    ).toBe(before);
    expect(applyDocumentEvent(before, event({ operationType: "drop" }))).toBe(before);
  });

  it("applies updates, and an update of a missing document changes nothing", () => {
    const set = event({
      operationType: "update",
      documentKey: { _id: 1 },
      updateDescription: { updatedFields: { a: 2 }, removedFields: [], truncatedArrays: [] },
    });
    expect(applyDocumentEvent({ _id: 1, a: 1 }, set)).toEqual({ _id: 1, a: new Int32(2) });
    expect(applyDocumentEvent(undefined, set)).toBeUndefined();
  });

  it("classifies events", () => {
    expect(isDocumentEvent(event({ operationType: "replace" }))).toBe(true);
    expect(isDocumentEvent(event({ operationType: "rename" }))).toBe(false);
    expect(replacesDocument(event({ operationType: "delete" }))).toBe(true);
    expect(replacesDocument(event({ operationType: "update" }))).toBe(false);
  });
});

describe("applyUpdateDescription", () => {
  it("sets and removes dotted paths, creating missing documents, never mutating the input", () => {
    const before = { _id: 1, a: { b: 1, keep: true }, gone: 1 };
    const after = applyUpdateDescription(
      before,
      update({
        updatedFields: { "a.b": 2, "x.y.z": 3, top: "new" },
        removedFields: ["gone", "a.keep"],
      }),
    );
    expect(after).toEqual({ _id: 1, a: { b: 2 }, x: { y: { z: 3 } }, top: "new" });
    expect(before).toEqual({ _id: 1, a: { b: 1, keep: true }, gone: 1 });
  });

  it("indexes arrays by number, pads with nulls, and unsets elements to null", () => {
    const after = applyUpdateDescription(
      { _id: 1, arr: [1, { v: 1 }], docs: [{ n: 1 }] },
      update({
        updatedFields: { "arr.4": 5, "arr.1.v": 2, "docs.0.n": 9, "docs.2.n": 3 },
        removedFields: ["arr.0", "arr.9", "missing.path"],
      }),
    );
    expect(after).toEqual({
      _id: 1,
      arr: [null, { v: 2 }, null, null, 5],
      docs: [{ n: 9 }, null, { n: 3 }],
    });
  });

  it("treats numeric components of documents as field names", () => {
    expect(
      applyUpdateDescription(
        { _id: 1, d: { "0": "x" } },
        update({ updatedFields: { "d.0": "y", "d.1": "z" } }),
      ),
    ).toEqual({
      _id: 1,
      d: { "0": "y", "1": "z" },
    });
  });

  it("truncates arrays first, creating an empty array where there was none", () => {
    const after = applyUpdateDescription(
      { _id: 1, tags: ["a", "b", "c", "d"] },
      update({
        truncatedArrays: [
          { field: "tags", newSize: 2 },
          { field: "fresh", newSize: 0 },
        ],
        updatedFields: { "tags.1": "B" },
      }),
    );
    expect(after).toEqual({ _id: 1, tags: ["a", "B"], fresh: [] });
  });

  it("skips a write whose path no longer fits, completely, and keeps the other write", () => {
    const before = { _id: 1, n: 5, nil: null, arr: [1], tags: "not an array" };
    // $set through a number, through null, or by name into an array: the whole $set fails.
    for (const path of ["n.x", "nil.x", "arr.name", "arr.0.x"]) {
      const after = applyUpdateDescription(before, update({ updatedFields: { ok: 1, [path]: 1 } }));
      expect(after, path).toBe(before);
    }
    // A failed truncation is skipped; the $set after it still applies.
    const after = applyUpdateDescription(
      before,
      update({ truncatedArrays: [{ field: "tags", newSize: 1 }], updatedFields: { ok: 1 } }),
    );
    expect(after).toEqual({ ...before, ok: 1 });
  });

  it("leaves $unset through scalars and missing fields alone, and ignores empty updates", () => {
    const before = { _id: 1, n: 5, arr: [1] };
    expect(
      applyUpdateDescription(
        before,
        update({ removedFields: ["n.x", "arr.x", "arr.0.y", "no.such"] }),
      ),
    ).toEqual(before);
    expect(applyUpdateDescription(before, update({}))).toBe(before);
    expect(applyUpdateDescription(undefined, update({ updatedFields: { a: 1 } }))).toBeUndefined();
  });
});

describe("cloneValue", () => {
  it("copies documents and arrays deeply, shares BSON values, and keeps the stored field order", () => {
    const id = new ObjectId();
    const parsed = parseBackedUpDocument(
      BSON.serialize(
        new Map<string, unknown>([
          ["_id", id],
          ["b", new Int32(1)],
          ["0", [new Date(0)]],
        ]),
      ),
    );
    const copy = cloneValue(parsed) as Document;
    expect(copy).toEqual(parsed);
    expect(copy).not.toBe(parsed);
    expect(copy._id).toBe(parsed._id);
    expect(copy._id).toEqual(id);
    expect(storedFieldOrder(copy)).toEqual(["_id", "b", "0"]);
    expect(cloneValue(/re/)).toEqual(/re/);
  });
});

describe("stored field order of updated documents", () => {
  /** The document's bytes as a write path would send it. */
  function written(document: Document | undefined): Buffer {
    if (document === undefined) throw new Error("expected a document");
    return Buffer.from(BSON.serialize(inStoredOrderAnywhere(document)));
  }

  it("appends a new integer-like field after the existing ones, as the server does", () => {
    const before = parseBackedUpDocument(BSON.serialize({ _id: 6, "4294967295": "x", a: 1 }));
    const updatedFields = new Map<string, unknown>([
      [
        "9",
        new Map<string, unknown>([
          ["b", 1],
          ["0", 2],
        ]),
      ],
      ["sub", 1],
    ]);
    const after = applyDocumentEvent(
      before,
      event({
        operationType: "update",
        documentKey: { _id: 6 },
        updateDescription: { updatedFields, removedFields: [], truncatedArrays: [] },
      }),
    );
    const expected = new Map<string, unknown>([
      ["_id", 6],
      ["4294967295", "x"],
      ["a", 1],
      [
        "9",
        new Map<string, unknown>([
          ["b", 1],
          ["0", 2],
        ]),
      ],
      ["sub", 1],
    ]);
    expect(written(after)).toEqual(Buffer.from(BSON.serialize(expected)));
  });

  it("keeps a recorded order when a field is appended to an embedded document", () => {
    const before = parseBackedUpDocument(
      BSON.serialize(
        new Map<string, unknown>([
          ["_id", 1],
          [
            "sub",
            new Map([
              ["b", 1],
              ["0", 2],
            ]),
          ],
        ]),
      ),
    );
    const after = applyDocumentEvent(
      before,
      event({
        operationType: "update",
        documentKey: { _id: 1 },
        updateDescription: {
          updatedFields: { "sub.5": 3 },
          removedFields: [],
          truncatedArrays: [],
        },
      }),
    );
    const expected = new Map<string, unknown>([
      ["_id", 1],
      [
        "sub",
        new Map([
          ["b", 1],
          ["0", 2],
          ["5", 3],
        ]),
      ],
    ]);
    expect(written(after)).toEqual(Buffer.from(BSON.serialize(expected)));
  });
});
