// Restore drills against the shared test replica set: a good backup passes every
// check, damaged or tampered backups fail with problems, the temporary databases
// are always dropped (also on failure and abort), and a drill refuses to run on
// the backup's own source deployment unless allowed.

import { randomBytes } from "node:crypto";
import { BSON, type Document } from "mongodb";
import { beforeAll, describe, expect, it } from "vitest";
import { type DrillContext, type DrillOptions, drillBackup } from "../../src/engine/drill.ts";
import { readDrills } from "../../src/engine/drill-record.ts";
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
