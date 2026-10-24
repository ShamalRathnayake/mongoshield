import { BSON, Int32, Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
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

  it("maps drop, dropDatabase and rename, and ignores index events", () => {
    expect(replayStepFor(event({ operationType: "drop", ns }))).toEqual({
      kind: "drop",
      ns: "app.users",
    });
    expect(replayStepFor(event({ operationType: "dropDatabase", ns: { db: "app" } }))).toEqual({
      kind: "dropDatabase",
      db: "app",
    });
    expect(
      replayStepFor(event({ operationType: "rename", ns, to: { db: "app", coll: "people" } })),
    ).toEqual({ kind: "rename", from: "app.users", to: "app.people" });
    expect(replayStepFor(event({ operationType: "createIndexes", ns })).kind).toBe("ignore");
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
