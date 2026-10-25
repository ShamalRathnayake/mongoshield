// Integration tests for the write side of restore against a real server: how document
// batches are written in each mode (restore-documents.ts) and how indexes are built
// next to existing ones (restore-indexes.ts), including the failures each one reports.

import { BSON, type Collection, type Document, type WriteConcernSettings } from "mongodb";
import { describe, expect, it } from "vitest";
import { dropNamespace } from "../../src/engine/restore-collections.ts";
import { type WriteMode, writeDocuments } from "../../src/engine/restore-documents.ts";
import { restoreIndexes } from "../../src/engine/restore-indexes.ts";
import { isMongoShieldError, type MongoShieldError } from "../../src/errors.ts";
import { type Logger, silentLogger } from "../../src/logger.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** Test documents with numeric or string ids. */
interface TestDocument {
  _id?: number | string;
  [field: string]: unknown;
}

async function* rawDocuments(documents: readonly Document[]): AsyncGenerator<Buffer> {
  for (const document of documents) yield Buffer.from(BSON.serialize(document));
}

function newCollection() {
  return client().db(uniqueDb("rw")).collection<TestDocument>("c");
}

/** Writes into `collection` (typed for the tests' setup; written to as plain documents). */
async function write(
  collection: Collection<TestDocument>,
  mode: WriteMode,
  documents: AsyncIterable<Buffer>,
  extra: Partial<Parameters<typeof writeDocuments>[0]> = {},
) {
  return writeDocuments({
    documents,
    collection: client().db(collection.dbName).collection(collection.collectionName),
    mode,
    workers: 2,
    bypassDocumentValidation: false,
    batchLimits: { maxDocuments: 2, maxBytes: 1024 },
    ...extra,
  });
}

async function failure(promise: Promise<unknown>): Promise<MongoShieldError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (caught: unknown) => caught,
  );
  if (!isMongoShieldError(error)) throw error;
  return error;
}

describe("writing document batches", () => {
  it("upserts by _id, replacing existing documents and inserting documents without an _id", async () => {
    const collection = newCollection();
    await collection.insertOne({ _id: 1, v: "old" });
    const result = await write(
      collection,
      "upsert",
      rawDocuments([{ _id: 1, v: "new" }, { _id: 2, v: "two" }, { v: "no id" }]),
    );
    expect(result).toMatchObject({ documents: 3, documentsRead: 3 });
    expect(await collection.findOne({ _id: 1 })).toEqual({ _id: 1, v: "new" });
    expect(await collection.countDocuments({ v: "no id" })).toBe(1);
  });

  it("writes nothing for a batch a transform empties", async () => {
    const collection = newCollection();
    const progress: number[] = [];
    const result = await write(collection, "insert-new", rawDocuments([{ _id: 1 }, { _id: 2 }]), {
      transformBatch: async () => [],
      onProgress: (documents) => progress.push(documents),
    });
    expect(result).toMatchObject({ documents: 0, documentsRead: 2 });
    expect(progress).toEqual([0]);
  });

  it("fails with MS_INTEGRITY_FAILED for bytes that are not a BSON document", async () => {
    async function* broken(): AsyncGenerator<Buffer> {
      yield Buffer.from([7, 0, 0, 0, 0x7e, 0x00, 0x00]);
    }
    const error = await failure(write(newCollection(), "insert-new", broken()));
    expect(error.code).toBe("MS_INTEGRITY_FAILED");
  });

  it("skips duplicates only when asked, and names the first real write error", async () => {
    const collection = newCollection();
    await collection.insertOne({ _id: 1 });
    const duplicate = await failure(write(collection, "insert-new", rawDocuments([{ _id: 1 }])));
    expect(duplicate.code).toBe("MS_RESTORE_FAILED");
    expect(duplicate.message).toContain(collection.namespace);

    const skipped = await write(
      collection,
      "insert-skip-duplicates",
      rawDocuments([{ _id: 1 }, { _id: 3 }]),
    );
    expect(skipped.documents).toBe(1);

    // A validator failure is not a duplicate: it fails even in skip-duplicates mode.
    const validated = client().db(uniqueDb("rw"));
    await validated.createCollection("v", { validator: { n: { $type: "int" } } });
    await validated.collection<TestDocument>("v").insertOne({ _id: 1, n: 1 });
    const invalid = await failure(
      write(
        validated.collection<TestDocument>("v"),
        "insert-skip-duplicates",
        rawDocuments([
          { _id: 1, n: 1 },
          { _id: 2, n: "x" },
        ]),
        {
          batchLimits: { maxDocuments: 10, maxBytes: 1024 },
        },
      ),
    );
    expect(invalid.message).toMatch(/\(code 121\)/);
  });

  it("stops with MS_ABORTED when the signal fires between batches", async () => {
    const controller = new AbortController();
    async function* slow(): AsyncGenerator<Buffer> {
      for (let n = 0; n < 10; n++) {
        if (n === 4) controller.abort();
        yield Buffer.from(BSON.serialize({ _id: n }));
      }
    }
    const error = await failure(
      write(newCollection(), "insert-new", slow(), { signal: controller.signal, workers: 1 }),
    );
    expect(error.code).toBe("MS_ABORTED");
  });
});

describe("write concern failures", () => {
  it("does not mistake duplicates for success when the write concern failed", async () => {
    const collection = newCollection();
    await collection.insertOne({ _id: 1 });
    // The single-node test replica set can never satisfy w: 2.
    const error = await failure(
      write(collection, "insert-skip-duplicates", rawDocuments([{ _id: 1 }, { _id: 2 }]), {
        writeConcern: { w: 2, wtimeoutMS: 100 },
      }),
    );
    expect(error.code).toBe("MS_RESTORE_FAILED");
  });

  it("passes drop failures other than a missing namespace on", async () => {
    const collection = newCollection();
    await collection.insertOne({ _id: 1 });
    const db = client().db(collection.dbName);
    // A replica set tag name; the driver's types only know numbers and "majority".
    const unknownTag: WriteConcernSettings = JSON.parse('{ "w": "noSuchTag" }');
    await expect(dropNamespace(db, "c", unknownTag)).rejects.toThrow();
    await expect(dropNamespace(db, "never_created", undefined)).resolves.toBeUndefined();
  });
});

describe("building indexes next to existing ones", () => {
  function recordingLogger(warnings: string[]): Logger {
    return { ...silentLogger, warn: (message) => warnings.push(message) };
  }

  it("keeps a conflicting target index in merge modes and builds the others", async () => {
    const collection = newCollection();
    await collection.createIndex({ a: 1 }, { name: "by_a" });
    const warnings: string[] = [];
    const created = await restoreIndexes(
      client().db(collection.dbName),
      "c",
      [
        { key: { a: -1 }, name: "by_a" },
        { key: { b: 1 }, name: "by_b" },
      ],
      { keepConflictingTargetIndexes: true, logger: recordingLogger(warnings) },
    );
    expect(created).toBe(1);
    expect(warnings).toEqual([
      "Kept the target's index instead of a conflicting one from the backup",
    ]);
    const names = (await collection.indexes()).map((index) => index.name).sort();
    expect(names).toEqual(["_id_", "by_a", "by_b"]);
  });

  it("fails on a conflict for new collections, and on non-conflict errors in merge modes", async () => {
    const collection = newCollection();
    await collection.createIndex({ a: 1 }, { name: "by_a" });
    const db = client().db(collection.dbName);
    const conflict = await failure(
      restoreIndexes(db, "c", [{ key: { a: -1 }, name: "by_a" }], {
        keepConflictingTargetIndexes: false,
        logger: silentLogger,
      }),
    );
    expect(conflict.message).toContain(`Building the indexes of ${collection.namespace} failed`);

    // A unique index over duplicate values cannot be built: not a conflict to skip.
    await collection.insertMany([
      { _id: 1, d: 1 },
      { _id: 2, d: 1 },
    ]);
    const duplicates = await failure(
      restoreIndexes(
        db,
        "c",
        [
          { key: { a: -1 }, name: "by_a" },
          { key: { d: 1 }, name: "unique_d", unique: true },
        ],
        { keepConflictingTargetIndexes: true, logger: silentLogger },
      ),
    );
    expect(duplicates.code).toBe("MS_RESTORE_FAILED");
  });

  it("does nothing when every index exists already", async () => {
    const collection = newCollection();
    await collection.createIndex({ a: 1 }, { name: "by_a" });
    const db = client().db(collection.dbName);
    expect(
      await restoreIndexes(db, "c", [{ key: { a: 1 }, name: "by_a" }], {
        keepConflictingTargetIndexes: false,
        logger: silentLogger,
      }),
    ).toBe(0);
  });
});
