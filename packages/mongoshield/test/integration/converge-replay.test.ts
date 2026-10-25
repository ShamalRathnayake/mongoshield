// The converge replay (src/engine/converge-replay.ts) driven directly with hand-built
// change events against the real server: every step of the translation table, the
// edge cases of renames and drops, the tolerated "path no longer fits" update errors,
// small batch limits, and the errors that must fail the restore.

import { BSON, type Document, Timestamp } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { parseChangeEvent, type StoredChangeEvent } from "../../src/engine/converge-events.ts";
import { type ReplayResult, replayChangeEvents } from "../../src/engine/converge-replay.ts";
import type { ReplayTargets } from "../../src/engine/converge-targets.ts";
import { ProgressTracker } from "../../src/engine/progress.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import type { ClusterTime } from "../../src/format/manifest.ts";
import type { Logger } from "../../src/logger.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { type AnyDocument, collectionNames } from "./converge-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

function newDatabase(): string {
  const name = uniqueDb("cvrp");
  databases.push(name);
  return name;
}

/** Events with increasing cluster times, from field lists. */
function events(list: readonly Document[]): StoredChangeEvent[] {
  return list.map((fields, index) => {
    const raw = Buffer.from(
      BSON.serialize({ clusterTime: new Timestamp({ t: 1000, i: index + 1 }), ...fields }),
    );
    return { raw, event: parseChangeEvent(raw) };
  });
}

async function* source(list: readonly StoredChangeEvent[]): AsyncGenerator<StoredChangeEvent> {
  yield* list;
}

/** Every namespace of `database` maps to itself, except those in `skip`. */
function sameTargets(database: string, skip: readonly string[] = []): ReplayTargets {
  return {
    targetOf: (ns) => (ns.startsWith(`${database}.`) && !skip.includes(ns) ? ns : undefined),
    sourcesInDatabase: (db) => (db === database ? [`${database}.a`, `${database}.b`] : []),
    windowTargets: new Map(),
  };
}

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const ignore = (): void => {};
  return {
    logger: {
      debug: ignore,
      info: ignore,
      warn: (message) => warnings.push(message),
      error: ignore,
    },
    warnings,
  };
}

function replay(
  list: readonly StoredChangeEvent[],
  targets: ReplayTargets,
  options: { until?: ClusterTime; maxDocuments?: number; logger?: Logger } = {},
): Promise<ReplayResult> {
  return replayChangeEvents({
    client: client(),
    logger: options.logger ?? recordingLogger().logger,
    events: source(list),
    until: options.until,
    targets,
    writeConcern: { w: 1 },
    bypassDocumentValidation: false,
    tracker: new ProgressTracker(),
    expectedEvents: list.length,
    signal: undefined,
    batchLimits: { maxDocuments: options.maxDocuments ?? 1000, maxBytes: 8 * 1024 * 1024 },
  });
}

const ns = (database: string, coll: string) => ({ db: database, coll });

describe("replayChangeEvents", () => {
  it("applies writes in order across small batches and stops at the end of the window", async () => {
    const database = newDatabase();
    const inserts = Array.from({ length: 5 }, (_, n) => ({
      operationType: "insert",
      ns: ns(database, "a"),
      documentKey: { _id: n },
      fullDocument: { _id: n, n },
    }));
    const list = events([
      ...inserts,
      { operationType: "delete", ns: ns(database, "a"), documentKey: { _id: 0 } },
      {
        operationType: "insert",
        ns: ns(database, "a"),
        documentKey: { _id: 99 },
        fullDocument: { _id: 99 },
      },
    ]);
    const result = await replay(list, sameTargets(database), {
      maxDocuments: 2,
      until: { t: 1000, i: 6 },
    });
    expect(result).toMatchObject({ events: 7, applied: 6, skipped: 1, toleratedErrors: 0 });
    const ids = (await client().db(database).collection<AnyDocument>("a").find().toArray()).map(
      (d) => d._id,
    );
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it("skips what it cannot or need not replay", async () => {
    const database = newDatabase();
    const { logger, warnings } = recordingLogger();
    const list = events([
      // Another database: no target.
      {
        operationType: "insert",
        ns: ns("elsewhere", "x"),
        documentKey: { _id: 1 },
        fullDocument: { _id: 1 },
      },
      { operationType: "create", ns: ns("elsewhere", "x"), operationDescription: {} },
      { operationType: "drop", ns: ns("elsewhere", "x") },
      {
        operationType: "createIndexes",
        ns: ns("elsewhere", "x"),
        operationDescription: { indexes: [{ key: { a: 1 }, name: "a_1" }] },
      },
      { operationType: "rename", ns: ns("elsewhere", "x"), to: ns("elsewhere", "y") },
      // A collection option change: ignored.
      { operationType: "modify", ns: ns(database, "a") },
      // An update the backup could not record replayably.
      {
        operationType: "update",
        ns: ns(database, "a"),
        documentKey: { _id: 1 },
        updateDescription: {
          updatedFields: { "a.b": 1 },
          removedFields: [],
          disambiguatedPaths: { "a.b": ["a.b"] },
        },
      },
    ]);
    const result = await replay(list, sameTargets(database), { logger });
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(7);
    expect(warnings).toHaveLength(1);
    expect(result.warnings).toEqual(warnings);
  });

  it("tolerates updates whose path no longer fits the document", async () => {
    const database = newDatabase();
    await client()
      .db(database)
      .collection<AnyDocument>("a")
      .insertOne({ _id: 1, a: "now a string" });
    const list = events([
      {
        operationType: "update",
        ns: ns(database, "a"),
        documentKey: { _id: 1 },
        updateDescription: { updatedFields: { "a.5.x": 1 }, removedFields: [] },
      },
      {
        operationType: "update",
        ns: ns(database, "a"),
        documentKey: { _id: 1 },
        updateDescription: { updatedFields: { b: 2 }, removedFields: [] },
      },
    ]);
    const result = await replay(list, sameTargets(database));
    expect(result.toleratedErrors).toBe(1);
    expect(await client().db(database).collection<AnyDocument>("a").findOne({ _id: 1 })).toEqual({
      _id: 1,
      a: "now a string",
      b: 2,
    });
  });

  it("fails with MS_RESTORE_FAILED on any other write error", async () => {
    const database = newDatabase();
    await client()
      .db(database)
      .collection<AnyDocument>("a")
      .createIndex({ email: 1 }, { unique: true });
    await client().db(database).collection<AnyDocument>("a").insertOne({ _id: 1, email: "x" });
    const list = events([
      {
        operationType: "insert",
        ns: ns(database, "a"),
        documentKey: { _id: 2 },
        fullDocument: { _id: 2, email: "x" },
      },
    ]);
    const error = await replay(list, sameTargets(database)).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_RESTORE_FAILED")).toBe(true);
    expect(String(error)).toContain(`${database}.a`);
  });

  it("creates collections, keeps existing ones, and drops what stays dropped", async () => {
    const database = newDatabase();
    await client().db(database).createCollection("a");
    await client().db(database).collection<AnyDocument>("b").insertOne({ _id: 1 });
    const list = events([
      { operationType: "create", ns: ns(database, "a"), operationDescription: {} },
      {
        operationType: "create",
        ns: ns(database, "c"),
        operationDescription: { capped: true, size: 4096 },
      },
      { operationType: "drop", ns: ns(database, "b") },
      { operationType: "drop", ns: ns(database, "c") },
      { operationType: "create", ns: ns(database, "c"), operationDescription: {} },
    ]);
    const result = await replay(list, sameTargets(database));
    expect([...result.removedTargets]).toEqual([`${database}.b`]);
    expect(await collectionNames(client(), database)).toEqual(["a", "c"]);
  });

  it("replays dropDatabase as a drop of every target in the database", async () => {
    const database = newDatabase();
    await client().db(database).collection<AnyDocument>("a").insertOne({ _id: 1 });
    await client().db(database).collection<AnyDocument>("b").insertOne({ _id: 1 });
    const list = events([{ operationType: "dropDatabase", ns: { db: database } }]);
    const result = await replay(list, sameTargets(database));
    expect([...result.removedTargets].sort()).toEqual([`${database}.a`, `${database}.b`]);
    expect(await collectionNames(client(), database)).toEqual([]);
  });

  it("replays renames, including out of and into namespaces it does not restore", async () => {
    const database = newDatabase();
    const { logger, warnings } = recordingLogger();
    await client().db(database).collection<AnyDocument>("a").insertOne({ _id: "a" });
    await client().db(database).collection<AnyDocument>("b").insertOne({ _id: "b" });
    await client().db(database).collection<AnyDocument>("out").insertOne({ _id: "out" });
    const skipped = `${database}.excluded`;
    const list = events([
      // a → b, replacing b.
      { operationType: "rename", ns: ns(database, "a"), to: ns(database, "b") },
      // b → b: nothing to do.
      { operationType: "rename", ns: ns(database, "b"), to: ns(database, "b") },
      // A source that does not exist in the target (the backup recorded the destination).
      { operationType: "rename", ns: ns(database, "ghost"), to: ns(database, "ghost2") },
      // Out of the restored namespaces: a drop.
      { operationType: "rename", ns: ns(database, "out"), to: ns(database, "excluded") },
      // Into them from one this restore does not write: reported.
      { operationType: "rename", ns: ns(database, "excluded"), to: ns(database, "b") },
    ]);
    const result = await replay(list, sameTargets(database, [skipped]), { logger });
    expect(await client().db(database).collection<AnyDocument>("b").find().toArray()).toEqual([
      { _id: "a" },
    ]);
    expect(await collectionNames(client(), database)).toEqual(["b"]);
    expect(result.removedTargets.has(`${database}.out`)).toBe(true);
    expect(warnings).toEqual([
      `${database}.b keeps its restored documents: it was replaced during the backup by ${skipped}, which this restore does not include.`,
    ]);
  });

  it("returns the index changes of targets that still exist", async () => {
    const database = newDatabase();
    const index = { key: { n: 1 }, name: "n_1" };
    const list = events([
      {
        operationType: "createIndexes",
        ns: ns(database, "a"),
        operationDescription: { indexes: [index] },
      },
      {
        operationType: "createIndexes",
        ns: ns(database, "b"),
        operationDescription: { indexes: [index] },
      },
      { operationType: "drop", ns: ns(database, "b") },
      {
        operationType: "createIndexes",
        ns: ns(database, "tmp"),
        operationDescription: { indexes: [index] },
      },
      { operationType: "rename", ns: ns(database, "tmp"), to: ns(database, "c") },
    ]);
    await client().db(database).createCollection("tmp");
    const result = await replay(list, sameTargets(database));
    expect([...result.indexChanges.keys()].sort()).toEqual([`${database}.a`, `${database}.c`]);
  });
});
