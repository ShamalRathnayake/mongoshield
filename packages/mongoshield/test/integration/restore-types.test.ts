// Integration tests: every kind of namespace, option and index survives a backup
// and restore into another database, and every BSON type round-trips byte for byte.
// The backup is written with the test fixtures from the real source collections.

import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  Decimal128,
  type Document,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from "mongodb";
import { beforeAll, describe, expect, it } from "vitest";
import { runRestore } from "../../src/engine/restore.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { RestoreResult } from "../../src/types.ts";
import { backupDatabaseForTest } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** Test documents use numbers, strings and dates as _id, not only ObjectIds. */
interface TestDocument {
  _id?: number | string | Date | ObjectId;
  [field: string]: unknown;
}
const source = uniqueDb("rtsrc");
const target = uniqueDb("rtdst");
let result: RestoreResult;

/** One document holding every BSON type, including the ones that are easy to lose. */
const everyType: Document = {
  _id: new ObjectId(),
  int32: new Int32(1),
  double: new Double(1),
  long: Long.fromNumber(1),
  longMax: Long.MAX_VALUE,
  decimal: Decimal128.fromString("1.10"),
  negativeZero: new Double(-0),
  nan: new Double(Number.NaN),
  infinity: new Double(Number.POSITIVE_INFINITY),
  binaryGeneric: new Binary(Buffer.from([0, 1, 2, 255]), 0),
  binaryOldUuid: new Binary(Buffer.alloc(16, 7), 3),
  uuid: new UUID(),
  md5: new Binary(Buffer.alloc(16, 9), 5),
  userDefined: new Binary(Buffer.from("custom"), 0x80),
  date: new Date(0),
  dateBefore1970: new Date(-86_400_000),
  regex: new BSONRegExp("^a.*b$", "imsx"),
  timestamp: new Timestamp({ t: 1_700_000_000, i: 42 }),
  minKey: new MinKey(),
  maxKey: new MaxKey(),
  code: new Code("function () { return 1; }"),
  symbol: new BSONSymbol("sym"),
  nothing: null,
  flag: true,
  text: "héllo 🌍",
  nested: { array: [new Int32(1), new Double(2), Long.fromNumber(3), [{ deep: new Double(0.5) }]] },
  "dotted.field": 1,
  $dollar: 2,
};

/** Options as listCollections reports them, keyed by collection name. */
async function optionsByName(database: string): Promise<Map<string, Document>> {
  const infos = await client().db(database).listCollections({}, { nameOnly: false }).toArray();
  return new Map(
    infos
      .filter((info) => !info.name.startsWith("system."))
      .map((info) => [info.name, "options" in info ? (info.options ?? {}) : {}]),
  );
}

/** Index definitions without the format version, sorted by name. */
async function indexesOf(database: string, collection: string): Promise<Document[]> {
  const indexes = await client()
    .db(database)
    .collection<TestDocument>(collection)
    .listIndexes()
    .toArray();
  return indexes
    .map(({ v: _version, ...rest }) => rest)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

/** Every document as raw BSON, sorted by _id, so byte-level comparisons are possible. */
async function rawDocuments(database: string, collection: string): Promise<Buffer[]> {
  const documents: Buffer[] = [];
  const cursor = client()
    .db(database)
    .collection<TestDocument>(collection)
    .find({}, { raw: true, sort: { _id: 1 } });
  for await (const raw of cursor) documents.push(Buffer.from(raw as unknown as Uint8Array));
  return documents;
}

/**
 * Documents with BSON wrapper types kept, sorted by _id. Time series rebuild documents
 * from column-wise buckets, so their field order is not stable; toEqual ignores it.
 */
async function typedDocuments(database: string, collection: string): Promise<Document[]> {
  return client()
    .db(database)
    .collection<TestDocument>(collection)
    .find({}, { promoteValues: false, sort: { _id: 1 } })
    .toArray();
}

beforeAll(async () => {
  const db = client().db(source);

  await db
    .collection<TestDocument>("plain")
    .insertMany([everyType, { _id: 2, a: 1 }, { _id: 3, a: 2 }]);

  await db.createCollection("capped", { capped: true, size: 8192, max: 50 });
  await db.collection<TestDocument>("capped").insertMany([
    { _id: 1, n: 1 },
    { _id: 2, n: 2 },
  ]);

  await db.createCollection("clustered", {
    clusteredIndex: { key: { _id: 1 }, unique: true, name: "by_id" },
    expireAfterSeconds: 3600,
  });
  await db.collection<TestDocument>("clustered").insertMany([{ _id: new Date(), v: 1 }]);

  await db.createCollection("metrics", {
    timeseries: { timeField: "t", metaField: "sensor", granularity: "minutes" },
    expireAfterSeconds: 86_400 * 365 * 10,
  });
  await db.collection<TestDocument>("metrics").insertMany([
    { t: new Date("2026-01-01T00:00:00Z"), sensor: { id: "a" }, value: new Double(1.5) },
    { t: new Date("2026-01-01T00:01:00Z"), sensor: { id: "b" }, value: new Int32(2) },
  ]);
  await db
    .collection<TestDocument>("metrics")
    .createIndex({ "sensor.id": 1, value: -1 }, { name: "sensor_value" });

  // A document that violates the validator added afterwards: restore must bypass validation.
  await db.createCollection("validated", { collation: { locale: "fr", strength: 2 } });
  await db
    .collection<TestDocument>("validated")
    .insertMany([{ _id: 1, email: "a@example.com" }, { _id: 2 }]);
  await db.command({
    collMod: "validated",
    validator: { $jsonSchema: { bsonType: "object", required: ["email"] } },
    validationLevel: "moderate",
    validationAction: "error",
  });
  await db.collection<TestDocument>("validated").createIndex({ email: 1 }, { name: "email_fr" });
  await db
    .collection<TestDocument>("validated")
    .createIndex({ code: 1 }, { name: "code_simple", collation: { locale: "simple" } });
  await db
    .collection<TestDocument>("validated")
    .createIndex({ body: "text" }, { name: "body_text", collation: { locale: "simple" } });

  await db.createCollection("prepost", { changeStreamPreAndPostImages: { enabled: true } });

  const indexed = db.collection<TestDocument>("indexed");
  await indexed.insertOne({
    _id: 1,
    email: "x@example.com",
    loc: { type: "Point", coordinates: [1, 2] },
  });
  await indexed.createIndex({ createdAt: 1 }, { name: "ttl", expireAfterSeconds: 60 });
  await indexed.createIndex(
    { email: 1 },
    {
      name: "email_partial_unique",
      unique: true,
      partialFilterExpression: { email: { $exists: true } },
    },
  );
  await indexed.createIndex({ nickname: 1 }, { name: "sparse", sparse: true });
  await indexed.createIndex(
    { title: "text", body: "text" },
    { name: "text", weights: { title: 5 }, default_language: "french" },
  );
  await indexed.createIndex({ loc: "2dsphere" }, { name: "geo" });
  await indexed.createIndex({ "$**": 1 }, { name: "wildcard", wildcardProjection: { secret: 0 } });
  await indexed.createIndex({ a: 1, b: -1 }, { name: "compound", hidden: true });
  await indexed.createIndex({ name: 1 }, { name: "name_de", collation: { locale: "de" } });

  // Views in a chain must share a collation.
  await db.createCollection("base_view", {
    viewOn: "plain",
    pipeline: [{ $match: { a: { $gte: 1 } } }],
    collation: { locale: "en" },
  });
  await db.createCollection("top_view", {
    viewOn: "base_view",
    pipeline: [{ $project: { a: 1 } }],
    collation: { locale: "en" },
  });

  const storage = memoryStorage();
  await backupDatabaseForTest(client(), storage, { include: [`${source}.*`] });
  result = await runRestore(
    { client: client(), storage, logger: silentLogger },
    { backup: "latest", rename: { [`${source}.*`]: `${target}.*` }, insertWorkers: 3 },
  );
});

describe("restoring every kind of namespace", () => {
  it("restores every namespace and reports the documents written", () => {
    expect(result.dryRun).toBe(false);
    expect(result.plan.entries.map((entry) => entry.to).sort()).toEqual(
      [
        "base_view",
        "capped",
        "clustered",
        "indexed",
        "metrics",
        "plain",
        "prepost",
        "top_view",
        "validated",
      ].map((name) => `${target}.${name}`),
    );
    expect(result.plan.entries.every((entry) => entry.action === "create")).toBe(true);
    expect(result.documentsRestored).toBe(3 + 2 + 1 + 2 + 2 + 1);
  });

  it("recreates every collection, time series and view with identical options", async () => {
    const sourceOptions = await optionsByName(source);
    const targetOptions = await optionsByName(target);
    expect([...targetOptions.keys()].sort()).toEqual([...sourceOptions.keys()].sort());
    for (const [name, options] of sourceOptions) {
      expect(targetOptions.get(name), name).toEqual(options);
    }
  });

  it("recreates every index with identical definitions", async () => {
    for (const name of ["plain", "capped", "clustered", "metrics", "validated", "indexed"]) {
      expect(await indexesOf(target, name), name).toEqual(await indexesOf(source, name));
    }
  });

  it("restores documents byte for byte, every BSON type included", async () => {
    for (const name of ["plain", "capped", "clustered", "validated", "indexed"]) {
      const restored = await rawDocuments(target, name);
      const original = await rawDocuments(source, name);
      expect(restored.length, name).toBe(original.length);
      restored.forEach((bytes, index) => {
        expect(bytes.equals(original[index] ?? Buffer.alloc(0)), `${name} #${index}`).toBe(true);
      });
    }
  });

  it("keeps numeric types exactly (Int32 vs Double vs Long, -0.0, Decimal128)", async () => {
    const [restored] = await client()
      .db(target)
      .collection<TestDocument>("plain")
      .find({ _id: everyType._id }, { promoteValues: false, bsonRegExp: true })
      .toArray();
    if (restored === undefined) throw new Error("document not restored");
    expect(restored.int32).toBeInstanceOf(Int32);
    expect(restored.double).toBeInstanceOf(Double);
    expect(restored.long).toBeInstanceOf(Long);
    expect(Object.is((restored.negativeZero as Double).value, -0)).toBe(true);
    expect((restored.decimal as Decimal128).toString()).toBe("1.10");
    expect((restored.userDefined as Binary).sub_type).toBe(0x80);
    expect((restored.regex as BSONRegExp).options).toBe("imsx");
  });

  it("restores time series measurements", async () => {
    const restored = await typedDocuments(target, "metrics");
    expect(restored).toEqual(await typedDocuments(source, "metrics"));
    expect(restored[1]?.value).toBeInstanceOf(Int32);
  });

  it("restores documents that violate the validator by bypassing validation", async () => {
    expect(
      await client().db(target).collection<TestDocument>("validated").countDocuments({ _id: 2 }),
    ).toBe(1);
    // The validator is active on the restored collection.
    await expect(
      client().db(target).collection<TestDocument>("validated").insertOne({ _id: 3 }),
    ).rejects.toMatchObject({ code: 121 });
  });

  it("restores views that read through each other", async () => {
    const rows = await client()
      .db(target)
      .collection<TestDocument>("top_view")
      .find()
      .sort({ a: 1 })
      .toArray();
    expect(rows.map((row) => row.a)).toEqual([1, 2]);
  });
});
