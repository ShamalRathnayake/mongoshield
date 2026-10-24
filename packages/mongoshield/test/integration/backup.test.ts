// Integration tests for runBackup against the shared replica set: what lands in
// storage, what the manifest says about it, and that the stored documents are
// byte-for-byte the documents in the source collections.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { runBackup } from "../../src/engine/backup.ts";
import { manifestKey, resolveBackupKey } from "../../src/format/layout.ts";
import { type Manifest, ManifestSchema } from "../../src/format/manifest.ts";
import { readManifest } from "../../src/format/manifest-io.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import type { ProgressEvent } from "../../src/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import {
  backupContext,
  decodeDataFile,
  decodeMetadata,
  entryFor,
  expectFilesMatchManifest,
  sourceDocuments,
} from "./backup-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("bk");
const LARGE_COUNT = 50_000;

/** Only this file's database, so parallel test files never interfere. */
const own = { include: [`${database}.*`] };

/** One document holding every BSON type the driver can write. */
function everyBsonType(index: number) {
  return {
    _id: new ObjectId(),
    double: new Double(1.0),
    negativeZero: new Double(-0),
    string: `héllo ✓ ${index}`,
    object: { nested: { deep: [1, { a: null }] } },
    array: [1, "two", new Int32(3), [4]],
    binary: new Binary(Buffer.from([0, 1, 2, 255])),
    uuid: new UUID(),
    customBinary: new Binary(Buffer.from("custom"), 0x80),
    bool: true,
    date: new Date(1_700_000_000_000 + index),
    null: null,
    regex: new BSONRegExp("^a.*b$", "imsux"),
    code: new Code("function () { return 1; }"),
    codeWithScope: new Code("function () { return x; }", { x: 1 }),
    symbol: new BSONSymbol("sym"),
    int32: new Int32(-42),
    timestamp: new Timestamp({ t: 1_700_000_000, i: 7 }),
    int64: Long.fromString("9223372036854775807"),
    decimal: Decimal128.fromString("1234.5678901234567890123456789"),
    minKey: new MinKey(),
    maxKey: new MaxKey(),
    "dotted.key": 1,
    $dollar: "allowed in stored documents",
  };
}

beforeAll(async () => {
  const db = client().db(database);
  await db.collection("types").insertMany(
    Array.from({ length: 25 }, (_, index) => everyBsonType(index)),
    { checkKeys: false },
  );
  await db.collection("types").createIndex({ int32: 1 }, { name: "by_int32" });

  // Inserted in batches to keep the driver's own memory use small.
  const large = db.collection("large");
  for (let start = 0; start < LARGE_COUNT; start += 10_000) {
    await large.insertMany(
      Array.from({ length: 10_000 }, (_, offset) => ({
        n: start + offset,
        payload: "x".repeat(100),
        createdAt: new Date(1_700_000_000_000 + start + offset),
      })),
    );
  }

  await db.createCollection("empty");
  await db.createCollection("capped", { capped: true, size: 64 * 1024, max: 50 });
  await db.collection("capped").insertMany(Array.from({ length: 80 }, (_, n) => ({ n })));
  await db.createCollection("metrics", {
    timeseries: { timeField: "t", metaField: "sensor", granularity: "seconds" },
  });
  await db.collection("metrics").insertMany(
    Array.from({ length: 30 }, (_, n) => ({
      t: new Date(1_700_000_000_000 + n * 1000),
      sensor: n % 2 === 0 ? "a" : "b",
      value: n,
    })),
  );
  await db.createCollection("big_view", {
    viewOn: "large",
    pipeline: [{ $match: { n: { $lt: 10 } } }],
  });
  // Same name except for case: their files must not collide on case-insensitive disks.
  await db.collection("Users").insertOne({ who: "upper" });
  await db.collection("users").insertMany([{ who: "lower" }, { who: "lower 2" }]);
});

afterAll(async () => {
  await client().db(database).dropDatabase();
});

describe("runBackup", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let manifest: Manifest;
  const events: ProgressEvent[] = [];

  beforeAll(async () => {
    storage = memoryStorage();
    const result = await runBackup(backupContext(client(), storage), {
      ...own,
      labels: { env: "test" },
      onProgress: (event) => events.push(event),
    });
    manifest = result.manifest;
    expect(result.id).toBe(manifest.id);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("commits a manifest that matches the schema and can be read back", async () => {
    expect(ManifestSchema.safeParse(manifest).success).toBe(true);
    expect(await readManifest(storage, manifest.id)).toEqual(manifest);
    expect(manifest).toMatchObject({
      status: "complete",
      compression: "zstd",
      encryption: null,
      labels: { env: "test" },
      // The default, "auto", is "converge" on a replica set whose user may open
      // change streams.
      consistency: { mode: "converge" },
      source: { topology: "replicaSet" },
    });
    expect(manifest.tool).toMatch(/^mongoshield@/);
    expect(manifest.source.clusterId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("includes every namespace of the database, sorted, with the right types", () => {
    expect(manifest.namespaces.map((entry) => entry.ns)).toEqual(
      ["Users", "big_view", "capped", "empty", "large", "metrics", "types", "users"].map(
        (name) => `${database}.${name}`,
      ),
    );
    expect(entryFor(manifest, `${database}.big_view`).type).toBe("view");
    expect(entryFor(manifest, `${database}.metrics`).type).toBe("timeseries");
  });

  it("records document counts and totals that add up", () => {
    expect(entryFor(manifest, `${database}.large`).documents).toBe(LARGE_COUNT);
    expect(entryFor(manifest, `${database}.types`).documents).toBe(25);
    expect(entryFor(manifest, `${database}.capped`).documents).toBe(50);
    expect(entryFor(manifest, `${database}.metrics`).documents).toBe(30);
    expect(entryFor(manifest, `${database}.empty`).documents).toBe(0);

    let documents = 0;
    let bytesRaw = 0;
    // The changes file of the converge window counts as stored data too.
    let bytesStored = manifest.changes?.size ?? 0;
    for (const entry of manifest.namespaces) {
      documents += entry.documents;
      bytesRaw += entry.bytesRaw;
      bytesStored += entry.metadata.size;
      for (const file of entry.files) bytesStored += file.size;
    }
    expect(manifest.totals).toEqual({
      namespaces: manifest.namespaces.length,
      documents,
      bytesRaw,
      bytesStored,
    });
  });

  it("stores files whose size and SHA-256 match the manifest", async () => {
    await expectFilesMatchManifest(storage, manifest);
    // Nothing but the listed files and the manifest was written.
    const listed = [
      ...manifest.namespaces.flatMap((entry) => [entry.metadata, ...entry.files]),
      ...(manifest.changes === undefined ? [] : [manifest.changes]),
    ].map((file) => resolveBackupKey(manifest.id, file.key));
    expect(storage.keys().sort()).toEqual([...listed, manifestKey(manifest.id)].sort());
  });

  it.each(["types", "large", "capped", "empty", "users", "Users"])(
    "stores the documents of %s byte for byte as the server returns them",
    async (name) => {
      const ns = `${database}.${name}`;
      const stored = await decodeDataFile(storage, manifest, ns);
      const source = await sourceDocuments(client(), ns);
      expect(stored.length).toBe(source.length);
      expect(Buffer.concat(stored).equals(Buffer.concat(source))).toBe(true);
      expect(entryFor(manifest, ns).bytesRaw).toBe(Buffer.concat(source).length);
    },
  );

  it("stores time series measurements, not buckets", async () => {
    const ns = `${database}.metrics`;
    const stored = await decodeDataFile(storage, manifest, ns);
    expect(stored).toHaveLength(30);
    const source = await sourceDocuments(client(), ns);
    expect(Buffer.concat(stored).equals(Buffer.concat(source))).toBe(true);
  });

  it("stores only metadata for views", async () => {
    const view = entryFor(manifest, `${database}.big_view`);
    expect(view.files).toEqual([]);
    expect(view.documents).toBe(0);
    const metadata = await decodeMetadata(storage, manifest, view.ns);
    expect(metadata.type).toBe("view");
    expect(metadata.options.viewOn).toBe("large");
  });

  it("stores mongodump-style metadata with options and indexes", async () => {
    const types = await decodeMetadata(storage, manifest, `${database}.types`);
    expect(types.collectionName).toBe("types");
    expect(types.indexes.map((index) => index.name).sort()).toEqual(["_id_", "by_int32"]);
    expect(types.uuid).toMatch(/^[0-9a-f]{32}$/);

    const capped = await decodeMetadata(storage, manifest, `${database}.capped`);
    expect(capped.options).toMatchObject({ capped: true });

    const metrics = await decodeMetadata(storage, manifest, `${database}.metrics`);
    expect(metrics.type).toBe("timeseries");
    expect(metrics.options.timeseries).toMatchObject({ timeField: "t", metaField: "sensor" });
  });

  it("gives case-clashing collection names distinct keys", () => {
    const upper = entryFor(manifest, `${database}.Users`);
    const lower = entryFor(manifest, `${database}.users`);
    const keys = [upper.metadata.key, lower.metadata.key, ...upper.files.map((file) => file.key)];
    keys.push(...lower.files.map((file) => file.key));
    const folded = new Set(keys.map((key) => key.toLowerCase()));
    expect(folded.size).toBe(keys.length);
  });

  it("reports progress: start before done for every namespace, and a final overall event", () => {
    for (const entry of manifest.namespaces) {
      const startIndex = events.findIndex(
        (event) => event.type === "namespace:start" && event.ns === entry.ns,
      );
      const doneIndex = events.findIndex(
        (event) => event.type === "namespace:done" && event.ns === entry.ns,
      );
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(doneIndex).toBeGreaterThan(startIndex);
      expect(events[doneIndex]).toMatchObject({ documents: entry.documents });
    }
    const start = events.find(
      (event) => event.type === "namespace:start" && event.ns === `${database}.large`,
    );
    expect(start).toMatchObject({ estimatedDocuments: LARGE_COUNT });
    expect(events.at(-1)).toMatchObject({
      type: "overall",
      documents: manifest.totals.documents,
      bytes: manifest.totals.bytesRaw,
      etaMs: 0,
    });
  });
});

describe("runBackup to file storage", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mongoshield-backup-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes an encrypted backup that decrypts with the identity", async () => {
    const storage: StorageAdapter = fileStorage({ path: directory });
    const { identity, recipient } = generateIdentity();
    const { manifest } = await runBackup(
      backupContext(client(), storage, {
        compression: "gzip",
        encryption: { recipients: [recipient] },
      }),
      { include: [`${database}.large`, `${database}.Users`, `${database}.users`] },
    );

    expect(manifest.encryption).toEqual({ scheme: "age-v1", recipients: [recipient] });
    expect(manifest.compression).toBe("gzip");
    for (const entry of manifest.namespaces) {
      expect(entry.metadata.key).toMatch(/\.metadata\.json\.age$/);
      for (const file of entry.files) expect(file.key).toMatch(/\.bson\.gz\.age$/);
    }
    await expectFilesMatchManifest(storage, manifest);

    for (const name of ["large", "Users", "users"]) {
      const ns = `${database}.${name}`;
      const stored = await decodeDataFile(storage, manifest, ns, { identities: [identity] });
      const source = await sourceDocuments(client(), ns);
      expect(Buffer.concat(stored).equals(Buffer.concat(source))).toBe(true);
      const metadata = await decodeMetadata(storage, manifest, ns, { identities: [identity] });
      expect(metadata.collectionName).toBe(name);
    }

    // Users and users really are separate files on disk (macOS disks ignore case).
    const files = await readdir(join(directory, "backups", manifest.id, database));
    expect(files.filter((file) => file.toLowerCase().startsWith("users"))).toHaveLength(4);
  });
});

describe("runBackup options", () => {
  it.each(["zstd", "gzip", "none"] as const)(
    "round-trips data with %s compression",
    async (compression) => {
      const storage = memoryStorage();
      const ns = `${database}.types`;
      const { manifest } = await runBackup(backupContext(client(), storage, { compression }), {
        include: [ns],
      });
      expect(manifest.compression).toBe(compression);
      const stored = await decodeDataFile(storage, manifest, ns);
      expect(Buffer.concat(stored).equals(Buffer.concat(await sourceDocuments(client(), ns)))).toBe(
        true,
      );
    },
  );

  it("honours include and exclude patterns", async () => {
    const { manifest } = await runBackup(backupContext(client(), memoryStorage()), {
      include: [`${database}.*`],
      exclude: [`${database}.large`, `${database}.*s`],
    });
    expect(manifest.namespaces.map((entry) => entry.collection)).toEqual([
      "big_view",
      "capped",
      "empty",
    ]);
  });

  it("dumps only the documents matching a per-namespace query", async () => {
    const storage = memoryStorage();
    const ns = `${database}.large`;
    const query = { n: { $gte: 100, $lt: 350 } };
    const { manifest } = await runBackup(backupContext(client(), storage), {
      include: [ns, `${database}.capped`],
      query: { [ns]: query },
    });
    expect(entryFor(manifest, ns).documents).toBe(250);
    expect(entryFor(manifest, `${database}.capped`).documents).toBe(50);
    const stored = await decodeDataFile(storage, manifest, ns);
    expect(
      Buffer.concat(stored).equals(Buffer.concat(await sourceDocuments(client(), ns, query))),
    ).toBe(true);
  });

  it("works with a parallelism of 1", async () => {
    const { manifest } = await runBackup(backupContext(client(), memoryStorage()), {
      ...own,
      exclude: [`${database}.large`],
      parallelism: 1,
    });
    expect(manifest.totals.namespaces).toBe(7);
  });
});

describe("runBackup with snapshot consistency", () => {
  const snapshotDb = uniqueDb("bksnap");

  beforeAll(async () => {
    const db = client().db(snapshotDb);
    await db.collection("a").insertMany(Array.from({ length: 2000 }, (_, n) => ({ n })));
    await db.collection("b").insertMany(Array.from({ length: 100 }, (_, n) => ({ n })));
    await db.createCollection("ts", { timeseries: { timeField: "t" } });
    await db.collection("ts").insertMany([{ t: new Date(), v: 1 }]);
  });

  afterAll(async () => {
    await client().db(snapshotDb).dropDatabase();
  });

  /**
   * A storage that, while the data file of `a` is being written, inserts more
   * documents into `b`, which is dumped afterwards (parallelism 1, sorted order).
   */
  function insertingStorage(): StorageAdapter {
    const inner = memoryStorage();
    return {
      ...inner,
      async put(key, body, options) {
        if (key.endsWith(`/${snapshotDb}/a.bson.zst`)) {
          await client()
            .db(snapshotDb)
            .collection("b")
            .insertMany(Array.from({ length: 50 }, (_, n) => ({ late: n })));
        }
        return inner.put(key, body, options);
      },
    };
  }

  it("reads every collection as of one cluster time and records it", async () => {
    const { manifest } = await runBackup(backupContext(client(), insertingStorage()), {
      include: [`${snapshotDb}.a`, `${snapshotDb}.b`],
      consistency: "snapshot",
      parallelism: 1,
    });
    expect(manifest.consistency.mode).toBe("snapshot");
    expect(manifest.consistency.from?.t).toBeGreaterThan(0);
    expect(manifest.consistency.to).toEqual(manifest.consistency.from);
    expect(entryFor(manifest, `${snapshotDb}.a`).documents).toBe(2000);
    // The 50 documents inserted mid-backup are not part of the snapshot.
    expect(entryFor(manifest, `${snapshotDb}.b`).documents).toBe(100);
  });

  it("sees concurrent writes without snapshot consistency (the contrast)", async () => {
    const before = await client().db(snapshotDb).collection("b").countDocuments();
    const { manifest } = await runBackup(backupContext(client(), insertingStorage()), {
      include: [`${snapshotDb}.a`, `${snapshotDb}.b`],
      consistency: "none",
      parallelism: 1,
    });
    expect(manifest.consistency).toEqual({ mode: "none" });
    expect(entryFor(manifest, `${snapshotDb}.b`).documents).toBe(before + 50);
  });

  it("backs up time series collections in snapshot mode", async () => {
    const { manifest } = await runBackup(backupContext(client(), memoryStorage()), {
      include: [`${snapshotDb}.ts`],
      consistency: "snapshot",
    });
    expect(entryFor(manifest, `${snapshotDb}.ts`).documents).toBe(1);
  });
});
