// Restore drills against the shared test replica set: a good backup passes every
// check, damaged or tampered backups fail with problems, the temporary databases
// are always dropped (also on failure and abort), and a drill refuses to run on
// the backup's own source deployment unless allowed.

import { randomBytes } from "node:crypto";
import { BSON, type Document } from "mongodb";
import { beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { type DrillContext, type DrillOptions, drillBackup } from "../../src/engine/drill.ts";
import { checkRestoredNamespace } from "../../src/engine/drill-checks.ts";
import { readDrills } from "../../src/engine/drill-record.ts";
import { sourceFromManifest } from "../../src/engine/read-pipeline.ts";
import { manifestKey } from "../../src/format/layout.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { serializeManifest } from "../../src/format/manifest-io.ts";
import { silentLogger } from "../../src/logger.ts";
import { describeDeployment } from "../../src/mongo/deployment.ts";
import { MongoShield } from "../../src/shield.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import {
  backupDatabaseForTest,
  flipByte,
  replaceStoredFile,
  writeTestBackup,
} from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("drl");
const ITEMS = 300;
let storage: StorageAdapter;
let good: Manifest;

beforeAll(async () => {
  const db = client().db(database);
  await db
    .collection("items")
    .insertMany(Array.from({ length: ITEMS }, (_, index) => ({ index, label: `item ${index}` })));
  await db.collection("items").createIndex({ label: 1 }, { name: "by_label" });
  await db.createCollection("recent", { viewOn: "items", pipeline: [{ $limit: 5 }] });

  storage = memoryStorage();
  good = await backupDatabaseForTest(client(), storage, { include: [`${database}.*`] });
});

/** A prefix unique to one test, so leftovers can be looked for precisely. */
function testPrefix(): string {
  return `dt${randomBytes(3).toString("hex")}_`;
}

/** Databases on the deployment whose names start with `prefix`. */
async function databasesStartingWith(prefix: string): Promise<string[]> {
  const { databases } = await client().db("admin").admin().listDatabases({ nameOnly: true });
  return databases.map((entry) => entry.name).filter((name) => name.startsWith(prefix));
}

function context(overrides: Partial<DrillContext> = {}): DrillContext {
  return { client: client(), storage, logger: silentLogger, ...overrides };
}

function drill(options: Partial<DrillOptions> & Pick<DrillOptions, "backup">, ctx = context()) {
  return drillBackup(ctx, { prefix: testPrefix(), ...options });
}

/** Rewrites a backup's manifest with a source cluster id (fixtures do not record one). */
async function withSourceClusterId(target: StorageAdapter, manifest: Manifest, clusterId: string) {
  const updated: Manifest = { ...manifest, source: { ...manifest.source, clusterId } };
  await target.put(manifestKey(manifest.id), Buffer.from(serializeManifest(updated), "utf8"));
  return updated;
}

describe("drillBackup on a good backup", () => {
  it("restores into temporary databases, passes every check and drops them", async () => {
    const prefix = testPrefix();
    const report = await drillBackup(context(), { backup: good.id, prefix, sample: 50 });

    expect(report).toMatchObject({ backupId: good.id, ok: true, restored: true, problems: [] });
    expect(report.restoreDurationMs).toBeGreaterThan(0);
    expect(report.documentsRestored).toBe(ITEMS);
    expect(report.databases).toEqual([
      {
        source: database,
        target: expect.stringMatching(new RegExp(`^${prefix}[0-9a-f]{8}_${database}$`)),
      },
    ]);
    const items = report.namespaces.find((entry) => entry.ns === `${database}.items`);
    expect(items).toMatchObject({
      expectedDocuments: ITEMS,
      restoredDocuments: ITEMS,
      indexesExpected: 2,
      indexesFound: 2,
      sampled: 50,
      ok: true,
    });
    expect(report.namespaces.find((entry) => entry.ns === `${database}.recent`)).toMatchObject({
      type: "view",
      ok: true,
    });

    expect(await databasesStartingWith(prefix)).toEqual([]);
    // The source was never touched.
    expect(await client().db(database).collection("items").countDocuments()).toBe(ITEMS);
  });

  it("runs assertions against the restored database and reports their failures", async () => {
    const seen: string[] = [];
    const report = await drill({
      backup: good.id,
      assertions: {
        [database]: async (db, info) => {
          seen.push(info.database);
          const count = await db.collection("items").countDocuments({ index: { $lt: 10 } });
          if (count !== 10) throw new Error(`expected 10 early items, found ${count}`);
          throw new Error("the business rule failed");
        },
        nosuchdb: async () => {},
      },
    });
    expect(seen).toEqual([database]);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      { subject: "assertions:nosuchdb", problem: expect.stringContaining('"nosuchdb"') },
      { subject: `assertions:${database}`, problem: "the business rule failed" },
    ]);
  });

  it("keeps the temporary databases when asked", async () => {
    const prefix = testPrefix();
    const report = await drillBackup(context(), { backup: good.id, prefix, keep: true });
    try {
      expect(report.kept).toBe(true);
      expect(await databasesStartingWith(prefix)).toHaveLength(1);
    } finally {
      for (const { target } of report.databases) await client().db(target).dropDatabase();
    }
  });

  it("is recorded next to the backup when run through MongoShield", async () => {
    const shield = new MongoShield({ storage });
    const report = await shield.drill({
      backup: good.id,
      target: { client: client() },
      prefix: testPrefix(),
    });
    expect(report.ok).toBe(true);
    const records = await readDrills(storage, good.id);
    expect(records.at(-1)).toMatchObject({
      backupId: good.id,
      ok: true,
      restored: true,
      documentsRestored: ITEMS,
      restoreDurationMs: report.restoreDurationMs,
      problemCount: 0,
    });
  });
});

describe("drillBackup on bad backups", () => {
  it("fails with a restore problem when a data file is damaged, and cleans up", async () => {
    const damagedStorage = memoryStorage();
    const manifest = await backupDatabaseForTest(client(), damagedStorage, {
      include: [`${database}.items`],
    });
    const key = manifest.namespaces[0]?.files[0]?.key ?? "";
    await replaceStoredFile(damagedStorage, manifest, key, (bytes) => flipByte(bytes, 20));

    const prefix = testPrefix();
    const report = await drillBackup(context({ storage: damagedStorage }), {
      backup: manifest.id,
      prefix,
    });
    expect(report).toMatchObject({ ok: false, restored: false, namespaces: [] });
    expect(report.problems).toEqual([
      { subject: "restore", problem: expect.stringMatching(/SHA-256|checksum|integrity/i) },
    ]);
    expect(await databasesStartingWith(prefix)).toEqual([]);
  });

  it("catches a tampered but valid backup with the sample comparison", async () => {
    // Every file is intact and the counts add up, but two documents cannot come back
    // as written: one has its _id after another field (the server moves _id first),
    // one has no _id at all (the server adds one).
    const tamperedStorage = memoryStorage();
    const ns = `${uniqueDb("tmp")}.people`;
    const rawDocuments: Uint8Array[] = [
      BSON.serialize({ _id: 1, name: "Ada" }),
      BSON.serialize({ name: "Grace", _id: 2 } satisfies Document),
      BSON.serialize({ name: "Linus" }),
    ];
    const manifest = await writeTestBackup(tamperedStorage, { namespaces: [{ ns, rawDocuments }] });

    const withoutSample = await drillBackup(context({ storage: tamperedStorage }), {
      backup: manifest.id,
      prefix: testPrefix(),
    });
    expect(withoutSample.ok).toBe(true);

    const prefix = testPrefix();
    const report = await drillBackup(context({ storage: tamperedStorage }), {
      backup: manifest.id,
      prefix,
      sample: 10,
    });
    expect(report.ok).toBe(false);
    expect(report.namespaces[0]).toMatchObject({ restoredDocuments: 3, sampled: 3 });
    expect(report.problems).toEqual(
      expect.arrayContaining([
        {
          subject: ns,
          problem: "sampled document _id 2 differs from the backup (values or field order)",
        },
        { subject: ns, problem: expect.stringContaining("has no _id") },
      ]),
    );
    expect(report.problems).toHaveLength(2);
    expect(await databasesStartingWith(prefix)).toEqual([]);
  });
});

describe("drillBackup safety", () => {
  it("drops the temporary databases when the drill is aborted mid-restore", async () => {
    const controller = new AbortController();
    const prefix = testPrefix();
    const drilled = drillBackup(context(), {
      backup: good.id,
      prefix,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === "namespace:progress" || event.type === "namespace:done") {
          controller.abort();
        }
      },
    });
    await expect(drilled).rejects.toMatchObject({ code: "MS_ABORTED" });
    expect(await databasesStartingWith(prefix)).toEqual([]);
  });

  it("refuses to drill into the backup's own source deployment unless allowed", async () => {
    const guardedStorage = memoryStorage();
    const fixture = await backupDatabaseForTest(client(), guardedStorage, {
      include: [`${database}.items`],
    });
    const { clusterId } = await describeDeployment(client());
    const manifest = await withSourceClusterId(guardedStorage, fixture, clusterId);

    const prefix = testPrefix();
    await expect(
      drillBackup(context({ storage: guardedStorage }), { backup: manifest.id, prefix }),
    ).rejects.toMatchObject({
      code: "MS_CONFIG_INVALID",
      hint: expect.stringContaining("--allow-same-deployment"),
    });
    expect(await databasesStartingWith(prefix)).toEqual([]);

    const allowed = await drillBackup(context({ storage: guardedStorage }), {
      backup: manifest.id,
      prefix: testPrefix(),
      allowSameDeployment: true,
    });
    expect(allowed.ok).toBe(true);

    // A scratch deployment has another identity (simulated through the injectable detection).
    const elsewhere = await drillBackup(
      context({ storage: guardedStorage, identifyDeployment: async () => "another-deployment" }),
      { backup: manifest.id, prefix: testPrefix() },
    );
    expect(elsewhere.ok).toBe(true);
  });
});

describe("drillBackup on time series", () => {
  it("compares sampled measurements ignoring the bucket layout and field order", async () => {
    const tsDatabase = uniqueDb("drlts");
    const db = client().db(tsDatabase);
    await db.createCollection("metrics", {
      timeseries: { timeField: "at", metaField: "sensor", granularity: "seconds" },
    });
    await db.collection("metrics").insertMany(
      Array.from({ length: 120 }, (_, index) => ({
        value: index,
        // The meta field after the time field: the server rebuilds it elsewhere.
        at: new Date(1_700_000_000_000 + (index % 40) * 1000),
        sensor: { site: `s${index % 3}`, rack: index % 2 },
      })),
    );
    const tsStorage = memoryStorage();
    const manifest = await backupDatabaseForTest(client(), tsStorage, {
      include: [`${tsDatabase}.*`],
    });
    const report = await drillBackup(context({ storage: tsStorage }), {
      backup: manifest.id,
      prefix: testPrefix(),
      sample: 30,
    });
    expect(report.problems).toEqual([]);
    expect(report.namespaces[0]).toMatchObject({ type: "timeseries", sampled: 30, ok: true });
    expect(report.namespaces[0]?.notes).toEqual([]);
  });

  it("reports measurements that are missing or differ in the restored time series", async () => {
    const tsStorage = memoryStorage();
    const ns = `${uniqueDb("drlts")}.metrics`;
    const options = { timeseries: { timeField: "at", metaField: "meta", granularity: "seconds" } };
    const manifest = await writeTestBackup(tsStorage, {
      namespaces: [
        {
          ns,
          type: "timeseries",
          options,
          rawDocuments: [
            BSON.serialize({ _id: 1, at: new Date(0), meta: { b: 1, a: 2 }, value: 1 }),
            BSON.serialize({ _id: 2, at: new Date(1000), value: 2 }),
            BSON.serialize({ _id: 3, at: new Date(2000), value: 3 }),
            BSON.serialize({ value: 4 }),
          ],
        },
      ],
    });
    // A "restored" collection standing in for a faulty restore: measurement 1 is
    // intact (its meta field normalized by the server), 2 has another value, 3 is gone.
    const target = `${uniqueDb("drlts")}.metrics`;
    const [targetDb = "", targetCollection = ""] = target.split(".");
    const db = client().db(targetDb);
    await db.createCollection(targetCollection, options);
    await db.collection<{ _id: number; [field: string]: unknown }>(targetCollection).insertMany([
      { _id: 1, at: new Date(0), meta: { a: 2, b: 1 }, value: 1 },
      { _id: 2, at: new Date(1000), value: 20 },
    ]);
    const entry = manifest.namespaces[0];
    if (entry === undefined) throw new Error("no entry");
    const report = await checkRestoredNamespace({
      client: client(),
      source: sourceFromManifest(tsStorage, manifest, undefined),
      planned: {
        from: ns,
        to: target,
        type: "timeseries",
        documents: 4,
        action: "create",
        existingDocuments: 0,
      },
      entry,
      sampleSize: 10,
      replayedChanges: false,
      signal: undefined,
    });
    expect(report.sampled).toBe(4);
    expect([...report.problems].sort()).toEqual([
      "2 documents restored, the manifest lists 4",
      'a sampled measurement has neither an _id nor a time field "at"',
      "sampled measurement _id 2 differs from the backup (field values)",
      "sampled measurement _id 3 is missing",
    ]);
  });
});

describe("the same-deployment guard by collection UUIDs", () => {
  it("refuses a target holding the backed-up collections even when the deployment id differs", async () => {
    // The real backup engine records collection UUIDs; another deployment id stands for
    // a standalone reached under a different host name.
    const guarded = memoryStorage();
    const result = await runBackup(backupContext(client(), guarded), {
      include: [`${database}.items`],
      consistency: "none",
    });
    if (result.status !== "complete") throw new Error("expected a complete backup");
    const otherHost = await withSourceClusterId(guarded, result.manifest, "another-host-name");

    const prefix = testPrefix();
    await expect(
      drillBackup(context({ storage: guarded }), { backup: otherHost.id, prefix }),
    ).rejects.toMatchObject({
      code: "MS_CONFIG_INVALID",
      message: expect.stringContaining(`${database}.items with the very collection UUID`),
    });
    expect(await databasesStartingWith(prefix)).toEqual([]);

    const allowed = await drillBackup(context({ storage: guarded }), {
      backup: otherHost.id,
      prefix: testPrefix(),
      allowSameDeployment: true,
    });
    expect(allowed.ok).toBe(true);
  });

  it("also checks backups that record no deployment id, and lets a real scratch target through", async () => {
    const guarded = memoryStorage();
    const result = await runBackup(backupContext(client(), guarded), {
      include: [`${database}.items`],
      consistency: "none",
    });
    if (result.status !== "complete") throw new Error("expected a complete backup");
    const { clusterId: _clusterId, ...source } = result.manifest.source;
    const anonymous: Manifest = { ...result.manifest, source };
    await guarded.put(manifestKey(anonymous.id), Buffer.from(serializeManifest(anonymous), "utf8"));
    await expect(
      drillBackup(context({ storage: guarded }), { backup: anonymous.id, prefix: testPrefix() }),
    ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });

    // The same collection names with other UUIDs (another deployment's copy): allowed.
    const copyDatabase = uniqueDb("drlcopy");
    await client().db(copyDatabase).collection("items").insertOne({ index: 0 });
    const copy = memoryStorage();
    const copied = await runBackup(backupContext(client(), copy), {
      include: [`${copyDatabase}.items`],
      consistency: "none",
    });
    if (copied.status !== "complete") throw new Error("expected a complete backup");
    await client().db(copyDatabase).dropDatabase();
    await client().db(copyDatabase).collection("items").insertOne({ index: 0 });
    const elsewhere = await withSourceClusterId(copy, copied.manifest, "another-deployment");
    const report = await drillBackup(context({ storage: copy }), {
      backup: elsewhere.id,
      prefix: testPrefix(),
    });
    expect(report.ok).toBe(true);
  });
});

describe("the guard and drill options on real backups", () => {
  it("recognises a time series by the UUID of its buckets collection", async () => {
    const tsDatabase = uniqueDb("drlguard");
    await client()
      .db(tsDatabase)
      .createCollection("m", { timeseries: { timeField: "at" } });
    await client()
      .db(tsDatabase)
      .collection("m")
      .insertOne({ at: new Date(0) });
    const guarded = memoryStorage();
    const result = await runBackup(backupContext(client(), guarded), {
      include: [`${tsDatabase}.*`],
      consistency: "none",
    });
    if (result.status !== "complete") throw new Error("expected a complete backup");
    const otherHost = await withSourceClusterId(guarded, result.manifest, "another-host-name");
    await expect(
      drillBackup(context({ storage: guarded }), { backup: otherHost.id, prefix: testPrefix() }),
    ).rejects.toMatchObject({ message: expect.stringContaining(`${tsDatabase}.m with the very`) });
  });

  it("skips damaged metadata in the guard; the restore then reports it as a finding", async () => {
    const copyDatabase = uniqueDb("drlmeta");
    await client().db(copyDatabase).collection("items").insertOne({ index: 0 });
    const damaged = memoryStorage();
    const result = await runBackup(backupContext(client(), damaged), {
      include: [`${copyDatabase}.items`],
      consistency: "none",
    });
    if (result.status !== "complete") throw new Error("expected a complete backup");
    const manifest = await withSourceClusterId(damaged, result.manifest, "another-deployment");
    const metadataKey = manifest.namespaces[0]?.metadata.key ?? "";
    await replaceStoredFile(damaged, manifest, metadataKey, (bytes) => flipByte(bytes, 2));
    const report = await drillBackup(context({ storage: damaged }), {
      backup: manifest.id,
      prefix: testPrefix(),
    });
    expect(report.restored).toBe(false);
    expect(report.problems).toEqual([
      { subject: "restore", problem: expect.stringMatching(/integrity|SHA-256/i) },
    ]);
  });

  it("passes include, exclude and concurrency options on to the restore", async () => {
    const seen: string[] = [];
    const report = await drill({
      backup: good.id,
      include: [`${database}.*`],
      exclude: [`${database}.recent`],
      parallelism: 1,
      insertWorkers: 1,
      onProgress: (event) => {
        if (event.type === "namespace:start") seen.push(event.ns);
      },
      // An assertion for another database only: the restored one has none.
      assertions: { elsewhere: async () => {} },
    });
    expect(report.namespaces.map((namespace) => namespace.ns)).toEqual([`${database}.items`]);
    expect(seen).toHaveLength(1);
    expect(report.problems).toEqual([
      { subject: "assertions:elsewhere", problem: expect.stringContaining('"elsewhere"') },
    ]);
  });
});
