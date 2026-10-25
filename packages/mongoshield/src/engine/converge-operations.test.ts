import fc from "fast-check";
import { type AnyBulkWriteOperation, BSON, Int32, Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  documentFor,
  embeddedDocument,
  knownReorderedDocument,
} from "../../test/helpers/ordered-documents.ts";
import { needsFullDocument, parseChangeEvent } from "./converge-events.ts";
import { BINARY_COLLATION, replayStepFor } from "./converge-operations.ts";

/** Serializes a change event like the server would send it. */
function event(fields: Record<string, unknown>) {
  return parseChangeEvent(
    BSON.serialize({ clusterTime: new Timestamp({ t: 100, i: 1 }), ...fields }),
  );
}

const ns = { db: "app", coll: "users" };

describe("replayStepFor", () => {
  it("replays inserts and replaces as upserting replacements by _id", () => {
    for (const operationType of ["insert", "replace"]) {
      const step = replayStepFor(
        event({ operationType, ns, documentKey: { _id: 1 }, fullDocument: { _id: 1, a: 2 } }),
      );
      expect(step).toEqual({
        kind: "write",
        ns: "app.users",
        operations: [
          {
            replaceOne: {
              filter: { _id: new Int32(1) },
              replacement: { _id: new Int32(1), a: new Int32(2) },
              upsert: true,
              collation: BINARY_COLLATION,
            },
          },
        ],
      });
    }
  });

  it("replays deletes by _id, ignoring the shard key in documentKey", () => {
    const step = replayStepFor(
      event({ operationType: "delete", ns, documentKey: { _id: "x", region: "eu" } }),
    );
    expect(step).toEqual({
      kind: "write",
      ns: "app.users",
      operations: [{ deleteOne: { filter: { _id: "x" }, collation: BINARY_COLLATION } }],
    });
  });

  it("replays updates as $set/$unset, after truncating arrays with $push/$slice", () => {
    const step = replayStepFor(
      event({
        operationType: "update",
        ns,
        documentKey: { _id: 1 },
        updateDescription: {
          updatedFields: { "arr.1": 9, name: "x" },
          removedFields: ["old"],
          truncatedArrays: [{ field: "arr", newSize: 2 }],
        },
      }),
    );
    expect(step.kind).toBe("write");
    if (step.kind !== "write") return;
    expect(step.operations).toEqual([
      {
        updateOne: {
          filter: { _id: new Int32(1) },
          update: { $push: { arr: { $each: [], $slice: 2 } } },
          collation: BINARY_COLLATION,
        },
      },
      {
        updateOne: {
          filter: { _id: new Int32(1) },
          update: { $set: { "arr.1": new Int32(9), name: "x" }, $unset: { old: "" } },
          collation: BINARY_COLLATION,
        },
      },
    ]);
  });

  it("replays an update that carries fullDocument as a replacement", () => {
    const step = replayStepFor(
      event({
        operationType: "update",
        ns,
        documentKey: { _id: 1 },
        updateDescription: { updatedFields: { "a.b": 1 }, removedFields: [], truncatedArrays: [] },
        fullDocument: { _id: 1, "a.b": 1 },
      }),
    );
    expect(step.kind === "write" && "replaceOne" in (step.operations[0] ?? {})).toBe(true);
  });

  it("creates collections with their recorded options, but not views", () => {
    expect(
      replayStepFor(
        event({
          operationType: "create",
          ns,
          operationDescription: { capped: true, size: 4096, temp: true, idIndex: { v: 2 } },
        }),
      ),
    ).toEqual({
      kind: "create",
      ns: "app.users",
      options: { capped: true, size: new Int32(4096) },
    });
    expect(
      replayStepFor(event({ operationType: "create", ns, operationDescription: { viewOn: "x" } }))
        .kind,
    ).toBe("ignore");
  });

  it("maps drop, dropDatabase and rename", () => {
    expect(replayStepFor(event({ operationType: "drop", ns }))).toEqual({
      kind: "drop",
      ns: "app.users",
      keepsIndexes: false,
    });
    expect(replayStepFor(event({ operationType: "dropDatabase", ns: { db: "app" } }))).toEqual({
      kind: "dropDatabase",
      db: "app",
    });
    expect(
      replayStepFor(event({ operationType: "rename", ns, to: { db: "app", coll: "people" } })),
    ).toEqual({ kind: "rename", from: "app.users", to: "app.people" });
  });

  it("keeps the indexes of a drop the capture synthesized before a rename's destination", () => {
    expect(replayStepFor(event({ operationType: "drop", ns, synthesized: true }))).toEqual({
      kind: "drop",
      ns: "app.users",
      keepsIndexes: true,
    });
  });

  it("maps createIndexes and dropIndexes to index changes, in order", () => {
    const spec = { v: 2, key: { email: 1 }, name: "email_1", unique: true };
    expect(
      replayStepFor(
        event({ operationType: "createIndexes", ns, operationDescription: { indexes: [spec] } }),
      ),
    ).toEqual({
      kind: "indexes",
      ns: "app.users",
      changes: [
        {
          kind: "create",
          spec: { v: new Int32(2), key: { email: new Int32(1) }, name: "email_1", unique: true },
        },
      ],
    });
    expect(
      replayStepFor(
        event({
          operationType: "dropIndexes",
          ns,
          operationDescription: { indexes: [spec, { key: { a: 1 }, name: "a_1" }] },
        }),
      ),
    ).toEqual({
      kind: "indexes",
      ns: "app.users",
      changes: [
        { kind: "drop", name: "email_1" },
        { kind: "drop", name: "a_1" },
      ],
    });
  });

  it("ignores index events that name no index, and other DDL", () => {
    const empty = event({ operationType: "createIndexes", ns, operationDescription: {} });
    expect(replayStepFor(empty).kind).toBe("ignore");
    const unnamed = event({
      operationType: "dropIndexes",
      ns,
      operationDescription: { indexes: [{ key: { a: 1 } }, "bogus"] },
    });
    expect(replayStepFor(unnamed).kind).toBe("ignore");
    expect(replayStepFor(event({ operationType: "createIndexes", ns: { db: "app" } })).kind).toBe(
      "ignore",
    );
    expect(replayStepFor(event({ operationType: "modify", ns })).kind).toBe("ignore");
    expect(replayStepFor(event({ operationType: "shardCollection", ns })).kind).toBe("ignore");
  });

  it("ignores document and DDL events without the namespace they need", () => {
    for (const operationType of ["insert", "create", "drop"]) {
      expect(replayStepFor(event({ operationType })).kind, operationType).toBe("ignore");
    }
    expect(replayStepFor(event({ operationType: "dropDatabase" })).kind).toBe("ignore");
    expect(replayStepFor(event({ operationType: "rename", ns })).kind).toBe("ignore");
  });

  it("ignores document events without an _id or anything to write", () => {
    expect(replayStepFor(event({ operationType: "insert", ns, documentKey: {} })).kind).toBe(
      "ignore",
    );
    expect(
      replayStepFor(event({ operationType: "insert", ns, documentKey: { _id: 1 } })).kind,
    ).toBe("ignore");
    expect(
      replayStepFor(
        event({
          operationType: "update",
          ns,
          documentKey: { _id: 1 },
          updateDescription: { updatedFields: {}, removedFields: [] },
        }),
      ).kind,
    ).toBe("ignore");
  });
});

describe("needsFullDocument", () => {
  const update = (description: Record<string, unknown>) =>
    event({
      operationType: "update",
      ns,
      documentKey: { _id: 1 },
      updateDescription: {
        removedFields: [],
        truncatedArrays: [],
        updatedFields: {},
        ...description,
      },
    });

  it("is false for paths update operators can address, including array indexes", () => {
    expect(needsFullDocument(update({ updatedFields: { "a.0.b": 1, c: 2 } }))).toBe(false);
    expect(
      needsFullDocument(
        update({ updatedFields: { "arr.0": 1 }, disambiguatedPaths: { "arr.0": ["arr", 0] } }),
      ),
    ).toBe(false);
  });

  it("is true for field names with dots or a leading $", () => {
    expect(
      needsFullDocument(
        update({ updatedFields: { "a.b": 1 }, disambiguatedPaths: { "a.b": ["a.b"] } }),
      ),
    ).toBe(true);
    expect(needsFullDocument(update({ removedFields: ["$weird"] }))).toBe(true);
  });

  it("is false for other events", () => {
    expect(needsFullDocument(event({ operationType: "insert", ns }))).toBe(false);
  });
});

describe("parseChangeEvent", () => {
  it("rejects bytes that are not a change event", () => {
    expect(() => parseChangeEvent(BSON.serialize({ hello: 1 }))).toThrow(/operationType/);
    expect(() => parseChangeEvent(Buffer.from([1, 2, 3]))).toThrow(/not valid BSON/);
  });
});

describe("replayStepFor and stored field order", () => {
  /** The BSON bytes of a value as the driver would send it, wrapped in `{ v }`. */
  function bytesOfValue(value: unknown): Buffer {
    return Buffer.from(BSON.serialize({ v: value }));
  }

  /** The single operation of a write step. */
  function onlyOperation(step: ReturnType<typeof replayStepFor>): AnyBulkWriteOperation {
    if (step.kind !== "write" || step.operations.length !== 1)
      throw new Error("expected one write");
    const [operation] = step.operations;
    if (operation === undefined) throw new Error("expected one write");
    return operation;
  }

  it("sends replacements and their _id filter in the order the event stored them", () => {
    fc.assert(
      fc.property(documentFor(1), fc.constantFrom("insert", "replace"), (document, type) => {
        const id = document.get("_id");
        const operation = onlyOperation(
          replayStepFor(
            event({
              operationType: type,
              ns,
              documentKey: new Map([["_id", id]]),
              fullDocument: document,
            }),
          ),
        );
        if (!("replaceOne" in operation)) throw new Error("expected a replaceOne");
        expect(bytesOfValue(operation.replaceOne.replacement)).toEqual(bytesOfValue(document));
        expect(bytesOfValue(operation.replaceOne.filter._id)).toEqual(bytesOfValue(id));
      }),
      { numRuns: 300 },
    );
  });

  it("sends $set values in the order the event stored them", () => {
    fc.assert(
      fc.property(embeddedDocument, embeddedDocument, (value, other) => {
        const updatedFields = new Map<string, unknown>([
          ["sub", value],
          ["list.1", [other]],
        ]);
        const operation = onlyOperation(
          replayStepFor(
            event({
              operationType: "update",
              ns,
              documentKey: { _id: 1 },
              updateDescription: { updatedFields, removedFields: [], truncatedArrays: [] },
            }),
          ),
        );
        if (!("updateOne" in operation)) throw new Error("expected an updateOne");
        const update: unknown = operation.updateOne.update;
        if (typeof update !== "object" || update === null) throw new Error("expected an update");
        expect(bytesOfValue(Reflect.get(update, "$set"))).toEqual(bytesOfValue(updatedFields));
      }),
      { numRuns: 300 },
    );
  });

  it("would reorder the known example without the stored order (the bug this guards)", () => {
    const document = knownReorderedDocument(1);
    const plain = BSON.deserialize(BSON.serialize(document));
    expect(bytesOfValue(plain)).not.toEqual(bytesOfValue(document));
  });
});
