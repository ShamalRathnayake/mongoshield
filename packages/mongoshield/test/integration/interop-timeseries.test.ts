// Time-series collections through the real mongodump and mongorestore, both directions:
//
//   mongodump (buckets) → importMongodump (unpacks them) → backup holds measurements
//                                                         → mongoshield restore
//   mongoshield backup (measurements) → exportBackup (computes buckets) → mongorestore
//
// The source collections cover what bucket encodings depend on: every BSON type,
// sparse fields, embedded documents and arrays (interleaved columns), long runs (RLE),
// out-of-order inserts (version 3 buckets on MongoDB 8.0; open, uncompressed version 1
// buckets on 7.0), no metaField, fixed bucketing, a collation, and an empty collection.
// Imported measurements must equal what `find` returns on the source byte for byte;
// restored collections must hold the same measurements, answer filtered queries the
// same way (which proves the computed control.min/max bounds), and pass `validate`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Binary,
  BSON,
  Decimal128,
  type Document,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  type MongoClient,
  ObjectId,
  Timestamp,
} from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { exportBackup } from "../../src/interop/export.ts";
import { importMongodump, type MongodumpSource } from "../../src/interop/import.ts";
import { storedDocuments } from "../../src/interop/test-fixtures.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { tool, toolsMissing } from "../helpers/mongo-tools.ts";

const client = useMongoClient();
const source = uniqueDb("ts");
const BASE_TIME = Date.UTC(2026, 0, 1);

/** The time-series collections of the source database and their creation options. */
const COLLECTIONS: Record<string, Document> = {
  metrics: { timeseries: { timeField: "t", metaField: "meta", granularity: "seconds" } },
  events: {
    timeseries: { timeField: "at", bucketMaxSpanSeconds: 7200, bucketRoundingSeconds: 7200 },
    expireAfterSeconds: 10 * 365 * 86_400,
    collation: { locale: "en", strength: 2 },
  },
  runs: { timeseries: { timeField: "t", metaField: "m", granularity: "hours" } },
  empty_ts: { timeseries: { timeField: "t" } },
};

/** Filters that must match the same measurements on the source and a restored copy. */
const QUERIES: Record<string, Document[]> = {
  metrics: [
    { int: { $gt: 0 } },
    { int: { $lte: -50 } },
    { dbl: { $gte: 40.5 } },
    { str: { $gte: "sensor-2" } },
    { flag: true },
    { "obj.a": { $gt: 100 } },
    { "obj.b.c": { $lt: 10 } },
    { "meta.site": "b" },
    { t: { $gte: new Date(BASE_TIME + 3_600_000) } },
    { when: { $lt: new Date(BASE_TIME - 1_000_000) } },
    { long: { $gt: Long.fromNumber(1e12 + 100_000) } },
    { oid: { $exists: true } },
    { sparse: { $exists: true } },
    { list: 3 },
  ],
  events: [
    { kind: "ALARM" },
    { kind: { $gt: "b" } },
    { level: { $gte: 3 } },
    { at: { $lt: new Date(BASE_TIME + 86_400_000) } },
  ],
  runs: [{ inc: { $gte: 500 } }, { d1: { $lt: 12.5 } }, { late: { $exists: true } }],
  empty_ts: [{}],
};

/** One measurement of `metrics`, with every kind of value bucket encodings treat differently. */
function metric(index: number): Document {
  const measurement: Document = {
    t: new Date(BASE_TIME + index * 5000 + (index % 7) * 13),
    meta: [{ site: "a", rack: 1 }, { site: "b" }, "standalone"][index % 3],
    int: new Int32(((index * 37) % 200) - 100),
    long: Long.fromNumber(1e12 + index * 977),
    dbl: new Double(Math.round(((index * 7919) % 10_000) / 1.3) / 100),
    raw: new Double(Math.sin(index)),
    flag: index % 3 === 0,
    when: new Date(BASE_TIME - index * 60_000),
    oid: new ObjectId(),
    ts: new Timestamp({ t: 1_700_000_000 + index, i: index % 4 }),
    bin: new Binary(
      Buffer.from(Array.from({ length: index % 19 }, (_, k) => (k * 31 + index) & 255)),
    ),
    obj: {
      a: new Int32(index),
      b: { c: new Double(index / 4), s: `v${index % 3}` },
      list: [index, "x"],
    },
    list: [new Int32(index % 5), new Int32((index + 1) % 5)],
  };
  if (index % 4 !== 0)
    measurement.str = ["", "a", "héllo ✓", `sensor-${index % 4}`, "y".repeat(30)][index % 5];
  if (index % 9 === 0) measurement.dec = Decimal128.fromString(`${index}.25`);
  if (index % 97 === 0) measurement.sparse = new Int32(index);
  if (index % 250 === 0) {
    Object.assign(measurement, {
      odd: [null, new MinKey(), new MaxKey(), new Double(Number.NaN), new Double(-0)][
        (index / 250) % 5
      ],
    });
  }
  return measurement;
}

/** Raw measurements of a collection, keyed by `_id` (hex). */
async function measurementsOf(mongo: MongoClient, database: string, name: string) {
  const byId = new Map<string, Buffer>();
  for await (const raw of mongo.db(database).collection(name).find({}, { raw: true })) {
    const bytes = Buffer.from(raw as unknown as Uint8Array);
    byId.set(idOf(bytes), bytes);
  }
  return byId;
}

function idOf(measurement: Buffer): string {
  return String(BSON.deserialize(measurement)._id);
}

/**
 * A measurement as canonical Extended JSON with its top-level fields sorted. The
 * server orders a measurement's fields by its bucket's columns, which differ between
 * buckets built from the same measurements in another order; values (embedded
 * documents included) are compared exactly.
 */
function normalized(measurement: Buffer): string {
  const document = BSON.deserialize(measurement, { promoteValues: false, bsonRegExp: true });
  const sorted: Document = {};
  for (const key of Object.keys(document).sort()) sorted[key] = document[key];
  return BSON.EJSON.stringify(sorted, { relaxed: false });
}

/** Everything that must survive a round trip, per collection. */
interface TimeSeriesSnapshot {
  readonly options: string;
  readonly indexes: string;
  /** Normalized measurements, sorted. */
  readonly measurements: string[];
  /** The number of matches of each of QUERIES. */
  readonly counts: number[];
}

async function snapshot(database: string): Promise<Record<string, TimeSeriesSnapshot>> {
  const db = client().db(database);
  const result: Record<string, TimeSeriesSnapshot> = {};
  for (const name of Object.keys(COLLECTIONS)) {
    const [info] = await db.listCollections({ name }, { nameOnly: false }).toArray();
    const indexes = (await db.collection(name).listIndexes().toArray())
      .map(({ ns: _ns, ...spec }) => spec)
      .sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
    const measurements = [...(await measurementsOf(client(), database, name)).values()]
      .map(normalized)
      .sort();
    const counts: number[] = [];
    for (const filter of QUERIES[name] ?? []) {
      counts.push(await db.collection(name).countDocuments(filter));
    }
    result[name] = {
      options: BSON.EJSON.stringify(info?.options ?? {}, { relaxed: false }),
      indexes: BSON.EJSON.stringify(indexes, { relaxed: false }),
      measurements,
      counts,
    };
  }
  return result;
}

/** `validate` on the buckets of every time-series collection of `database` (it checks their bounds too). */
async function expectValid(database: string): Promise<void> {
  for (const name of Object.keys(COLLECTIONS)) {
    const result = await client()
      .db(database)
      .command({ validate: `system.buckets.${name}` });
    expect({ name, valid: result.valid, errors: result.errors }).toEqual({
      name,
      valid: true,
      errors: [],
    });
  }
}

const temporaryPaths: string[] = [];
async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mongoshield-interop-ts-"));
  temporaryPaths.push(path);
  return path;
}

const restoredDatabases: string[] = [];
function newTarget(): string {
  const name = uniqueDb("ts_r");
  restoredDatabases.push(name);
  return name;
}

describe.skipIf(toolsMissing)("time-series collections with mongodump and mongorestore", () => {
  let expected: Record<string, TimeSeriesSnapshot>;

  beforeAll(async () => {
    const db = client().db(source);
    const { version } = await db.admin().command({ buildInfo: 1 });
    const [major = 0, minor = 0] = String(version).split(".").map(Number);
    if (major < 6 || (major === 6 && minor < 3)) {
      // Fixed bucketing (bucketMaxSpanSeconds / bucketRoundingSeconds) came in 6.3.
      COLLECTIONS.events = {
        ...COLLECTIONS.events,
        timeseries: { timeField: "at", granularity: "hours" },
      };
    }
    for (const [name, options] of Object.entries(COLLECTIONS))
      await db.createCollection(name, options);

    // Several batches with some measurements going back in time: buckets get closed,
    // reopened and (on 8.0) written as version 3.
    const metrics = Array.from({ length: 3000 }, (_, index) => metric(index));
    for (let batch = 0; batch < 6; batch += 1) {
      await db.collection("metrics").insertMany(metrics.filter((_, index) => index % 6 === batch));
    }
    await db.collection("metrics").createIndex({ "meta.site": 1, t: -1 }, { name: "by_site" });

    await db.collection("events").insertMany(
      Array.from({ length: 400 }, (_, index) => ({
        at: new Date(BASE_TIME + index * 300_000),
        kind: ["alarm", "ALARM", "Info", "debug"][index % 4],
        level: new Int32(index % 5),
      })),
    );
    await db.collection("runs").insertMany(
      Array.from({ length: 1500 }, (_, index) => ({
        t: new Date(BASE_TIME + index * 1000),
        m: "line-1",
        same: new Int32(5),
        inc: new Int32(index),
        d1: new Double(index / 10),
        d4: new Double(index / 10_000),
        ...(index > 900 ? { late: "x" } : {}),
      })),
    );

    expected = await snapshot(source);
    expect(expected.metrics?.measurements).toHaveLength(3000);
    expect(expected.events?.measurements).toHaveLength(400);
    expect(expected.runs?.measurements).toHaveLength(1500);
    expect(expected.metrics?.counts.every((count) => count > 0)).toBe(true);
  });

  afterAll(async () => {
    for (const database of [source, ...restoredDatabases]) {
      await client().db(database).dropDatabase();
    }
    for (const path of temporaryPaths) await rm(path, { recursive: true, force: true });
  });

  describe("mongodump → importMongodump", () => {
    async function importAndCheck(dump: MongodumpSource): Promise<void> {
      const storage = memoryStorage();
      const result = await importMongodump(dump, storage);
      expect(result.skipped).toEqual([]);
      const types = Object.fromEntries(
        result.manifest.namespaces.map((entry) => [entry.collection, entry.type]),
      );
      expect(types).toEqual({
        empty_ts: "timeseries",
        events: "timeseries",
        metrics: "timeseries",
        runs: "timeseries",
      });

      // The backup holds exactly what `find` returns on the source, byte for byte.
      for (const name of Object.keys(COLLECTIONS)) {
        const stored = await storedDocuments(storage, result.manifest, `${source}.${name}`);
        const original = await measurementsOf(client(), source, name);
        expect(stored).toHaveLength(original.size);
        for (const measurement of stored)
          expect(measurement.equals(original.get(idOf(measurement)) ?? Buffer.alloc(0))).toBe(true);
      }

      const target = newTarget();
      await runRestore(
        { client: client(), storage, logger: silentLogger },
        { backup: result.id, rename: { [`${source}.*`]: `${target}.*` } },
      );
      expect(await snapshot(target)).toEqual(expected);
      await expectValid(target);
    }

    it("unpacks the buckets of a dump directory into measurements", async () => {
      const out = await tempDirectory();
      await tool("mongodump", ["--db", source, "--out", out]);
      await importAndCheck({ directory: out });
    });

    it("unpacks the buckets of a gzipped dump directory", async () => {
      const out = await tempDirectory();
      await tool("mongodump", ["--db", source, "--out", out, "--gzip"]);
      await importAndCheck({ directory: out });
    });

    it("unpacks the buckets of an archive", async () => {
      const archive = join(await tempDirectory(), "dump.archive");
      await tool("mongodump", ["--db", source, `--archive=${archive}`]);
      await importAndCheck({ archive });
    });

    it("unpacks the buckets of a gzipped archive", async () => {
      const archive = join(await tempDirectory(), "dump.archive.gz");
      await tool("mongodump", ["--db", source, `--archive=${archive}`, "--gzip"]);
      await importAndCheck({ archive });
    });
  });

  describe("mongoshield backup → exportBackup → mongorestore", () => {
    let storage: StorageAdapter;
    let backupId: string;

    beforeAll(async () => {
      storage = memoryStorage();
      const result = await runBackup(
        {
          client: client(),
          storage,
          logger: silentLogger,
          compression: "zstd",
          encryption: undefined,
        },
        { include: [`${source}.*`] },
      );
      backupId = result.id;
    });

    const nsMapping = (target: string) => ["--nsFrom", `${source}.*`, "--nsTo", `${target}.*`];

    async function expectRestored(target: string): Promise<void> {
      expect(await snapshot(target)).toEqual(expected);
      await expectValid(target);
    }

    it("restores exported buckets from a directory", async () => {
      const output = join(await tempDirectory(), "dump");
      const summary = await exportBackup(storage, backupId, { format: "directory", output });
      expect(summary.skipped).toEqual([]);
      expect(summary.documents).toBe(4900);
      const target = newTarget();
      await tool("mongorestore", ["--dir", output, ...nsMapping(target)]);
      await expectRestored(target);
      // Measurements keep their field order: the computed buckets list fields as they came.
      const restored = await measurementsOf(client(), target, "runs");
      for (const [id, original] of await measurementsOf(client(), source, "runs")) {
        expect(restored.get(id)?.equals(original)).toBe(true);
      }
    });

    it("restores exported buckets from a gzipped directory", async () => {
      const output = join(await tempDirectory(), "dump");
      await exportBackup(storage, backupId, { format: "directory", output, gzip: true });
      const target = newTarget();
      await tool("mongorestore", ["--gzip", "--dir", output, ...nsMapping(target)]);
      await expectRestored(target);
    });

    it("restores exported buckets from an archive", async () => {
      const output = join(await tempDirectory(), "backup.archive");
      await exportBackup(storage, backupId, { format: "archive", output });
      const target = newTarget();
      await tool("mongorestore", [`--archive=${output}`, ...nsMapping(target)]);
      await expectRestored(target);
    });

    it("restores exported buckets from a gzipped archive", async () => {
      const output = join(await tempDirectory(), "backup.archive.gz");
      await exportBackup(storage, backupId, { format: "archive", output, gzip: true });
      const target = newTarget();
      await tool("mongorestore", ["--gzip", `--archive=${output}`, ...nsMapping(target)]);
      await expectRestored(target);
    });

    it("round-trips export → mongodump-style import → export unchanged in content", async () => {
      // An exported directory is a dump: importing it gives back the same measurements.
      const output = join(await tempDirectory(), "dump");
      await exportBackup(storage, backupId, { format: "directory", output });
      const again = memoryStorage();
      const imported = await importMongodump({ directory: output }, again);
      for (const name of Object.keys(COLLECTIONS)) {
        const stored = await storedDocuments(again, imported.manifest, `${source}.${name}`);
        const original = await measurementsOf(client(), source, name);
        expect(stored.map(normalized).sort()).toEqual(
          [...original.values()].map(normalized).sort(),
        );
      }
    });
  });
});
