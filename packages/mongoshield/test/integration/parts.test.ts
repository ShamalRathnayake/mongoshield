// Integration tests for split collections (docs/specs/PARTS-AND-RESUME.md, section 1):
// a collection larger than partSizeBytes is dumped as several `_id` ranges, and
// restore, verify and export put the parts back together exactly. The source holds
// `_id`s of many BSON types on purpose: ranges built with $gte/$lt would lose the
// documents whose type differs from a boundary's (type bracketing).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Double, Int32, Long, MaxKey, MinKey, type MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { verifyBackup } from "../../src/engine/verify.ts";
import { createBsonSplitter } from "../../src/format/bson-stream.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { exportBackup } from "../../src/interop/export.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext, decodeDataFile, entryFor, sourceDocuments } from "./backup-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("parts");
const restored = uniqueDb("parts_r");
const own = { include: [`${database}.*`] };

/** Small parts so a few thousand documents make many of them. */
const PART_SIZE = 32 * 1024;

/** `_id`s of many BSON types, in no particular order. */
function mixedIds(count: number): unknown[] {
  const ids: unknown[] = [new MinKey(), new MaxKey()];
  for (let index = 0; index < count; index++) {
    switch (index % 6) {
      case 0:
        ids.push(new ObjectId());
        break;
      case 1:
        ids.push(`key-${index}`);
        break;
      case 2:
        ids.push(new Int32(index));
        break;
      case 3:
        ids.push(Long.fromString(`${9_007_199_254_740_993n + BigInt(index)}`));
        break;
      case 4:
        ids.push(new Double(index + 0.5));
        break;
      default:
        ids.push({ compound: index, at: new Date(1_700_000_000_000 + index) });
    }
  }
  return ids;
}

beforeAll(async () => {
  const db = client().db(database);
  const ids = mixedIds(3000);
  await db
    .collection<{ _id: unknown }>("orders")
    .insertMany(ids.map((_id, index) => ({ _id, index, payload: "x".repeat(40 + (index % 50)) })));
  await db.collection("small").insertMany([{ name: "a" }, { name: "b" }]);
  await db.createCollection("metrics", { timeseries: { timeField: "at", metaField: "sensor" } });
  await db.collection("metrics").insertMany(
    Array.from({ length: 500 }, (_, index) => ({
      at: new Date(1_700_000_000_000 + index * 1000),
      sensor: index % 3,
      value: index,
    })),
  );
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await client().db(restored).dropDatabase();
});

/** The documents of a collection as sorted hex strings (a multiset of raw BSON). */
async function rawSet(mongo: MongoClient, ns: string): Promise<string[]> {
  return (await sourceDocuments(mongo, ns)).map((buffer) => buffer.toString("hex")).sort();
}

describe("split collections", () => {
  const storage = memoryStorage();
  let manifest: Manifest;

  beforeAll(async () => {
    const result = await runBackup(backupContext(client(), storage), {
      ...own,
      consistency: "none",
      partSizeBytes: PART_SIZE,
      parallelism: 3,
    });
    manifest = result.manifest;
  });

  it("splits a collection larger than partSizeBytes into numbered parts with ranges", () => {
    const orders = entryFor(manifest, `${database}.orders`);
    expect(orders.files.length).toBeGreaterThan(3);
    orders.files.forEach((file, index) => {
      expect(file.key).toBe(`${database}/orders.${String(index).padStart(3, "0")}.bson.zst`);
      expect(file.range).toBeDefined();
    });
    expect(orders.files[0]?.range?.from).toEqual({ $minKey: 1 });
    expect(orders.files.at(-1)?.range?.to).toEqual({ $maxKey: 1 });
    // Neighbouring parts share their boundary.
    for (let index = 1; index < orders.files.length; index++) {
      expect(orders.files[index]?.range?.from).toEqual(orders.files[index - 1]?.range?.to);
    }
    expect(orders.documents).toBe(3002);
  });

  it("keeps small collections and time series in one unsplit, mongodump-named file", () => {
    const small = entryFor(manifest, `${database}.small`);
    expect(small.files.map((file) => file.key)).toEqual([`${database}/small.bson.zst`]);
    expect(small.files[0]?.range).toBeUndefined();
    const metrics = entryFor(manifest, `${database}.metrics`);
    expect(metrics.files).toHaveLength(1);
    expect(metrics.files[0]?.key).toBe(`${database}/metrics.bson.zst`);
  });

  it("stores every document exactly once across the parts, byte for byte", async () => {
    const stored = await decodeDataFile(storage, manifest, `${database}.orders`);
    const storedSet = stored.map((buffer) => buffer.toString("hex")).sort();
    expect(storedSet).toEqual(await rawSet(client(), `${database}.orders`));
  });

  it("restores the parts into a collection equal to the source", async () => {
    await runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: manifest.id, rename: { [`${database}.*`]: `${restored}.*` } },
    );
    expect(await rawSet(client(), `${restored}.orders`)).toEqual(
      await rawSet(client(), `${database}.orders`),
    );
    expect(await client().db(restored).collection("metrics").countDocuments()).toBe(500);
  });

  it("passes deep verification", async () => {
    const report = await verifyBackup(
      { storage, logger: silentLogger },
      { backup: manifest.id, mode: "deep" },
    );
    expect(report.problems).toEqual([]);
    expect(report.documentsChecked).toBe(3002 + 2 + 500);
  });

  it("exports the parts as one mongodump .bson file per collection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ms-parts-"));
    try {
      const output = join(directory, "dump");
      await exportBackup(storage, manifest.id, {
        format: "directory",
        output,
        include: [`${database}.orders`],
      });
      const bytes = await readFile(join(output, database, "orders.bson"));
      const documents: string[] = [];
      await pipeline(
        Readable.from([bytes]),
        createBsonSplitter(),
        new Writable({
          objectMode: true,
          write(chunk: Buffer, _encoding, callback) {
            documents.push(Buffer.from(chunk).toString("hex"));
            callback();
          },
        }),
      );
      expect(documents.sort()).toEqual(await rawSet(client(), `${database}.orders`));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("read options", () => {
  it("reads with the configured read preference", async () => {
    // A single-node replica set only has a primary, which secondaryPreferred falls
    // back to. (Which member serves a read is covered by the unit tests of
    // resolveReadPreference; a one-node test server cannot show it.)
    const result = await runBackup(backupContext(client(), memoryStorage()), {
      include: [`${database}.small`],
      consistency: "none",
      readPreference: "secondaryPreferred",
      readPreferenceTags: [{ use: "backup" }, {}],
    });
    expect(entryFor(result.manifest, `${database}.small`).documents).toBe(2);
  });

  it("rejects tags combined with the primary read preference", async () => {
    await expect(
      runBackup(backupContext(client(), memoryStorage()), {
        ...own,
        readPreference: "primary",
        readPreferenceTags: [{ use: "backup" }],
      }),
    ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
  });

  it("throttles reads to roughly maxDocumentsPerSecond", async () => {
    const started = performance.now();
    const result = await runBackup(backupContext(client(), memoryStorage()), {
      include: [`${database}.orders`],
      consistency: "none",
      maxDocumentsPerSecond: 2000,
    });
    const elapsedMs = performance.now() - started;
    expect(entryFor(result.manifest, `${database}.orders`).documents).toBe(3002);
    // 3002 documents at 2000/s is ~1.5 s (minus a 250 ms burst). Generous bounds.
    expect(elapsedMs).toBeGreaterThan(1000);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it("throttles reads to roughly maxBytesPerSecond", async () => {
    const bytes = entryFor(
      (
        await runBackup(backupContext(client(), memoryStorage()), {
          include: [`${database}.orders`],
          consistency: "none",
        })
      ).manifest,
      `${database}.orders`,
    ).bytesRaw;
    const started = performance.now();
    await runBackup(backupContext(client(), memoryStorage()), {
      include: [`${database}.orders`],
      consistency: "none",
      maxBytesPerSecond: Math.round(bytes / 1.5),
    });
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeGreaterThan(1000);
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

describe("immutable backups", () => {
  it("locks every file and the manifest until start + retainDays", async () => {
    const storage = memoryStorage({ objectLock: true });
    const before = Date.now();
    const result = await runBackup(backupContext(client(), storage), {
      include: [`${database}.small`],
      consistency: "none",
      retainDays: 3,
    });
    const until = result.manifest.immutableUntil;
    expect(until).toBeDefined();
    const untilMs = Date.parse(until ?? "");
    expect(untilMs).toBeGreaterThanOrEqual(before + 3 * 86_400_000 - 1000);
    for (const key of storage.keys()) {
      expect(storage.retainUntilOf(key)?.getTime(), key).toBe(untilMs);
    }
  });

  it("refuses retainDays on storage without object lock before reading anything", async () => {
    const storage = memoryStorage();
    await expect(
      runBackup(backupContext(client(), storage), { ...own, retainDays: 3 }),
    ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
    expect(storage.keys()).toEqual([]);
  });
});
