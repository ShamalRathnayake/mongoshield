// Upgrade rehearsals end to end: a backup taken from the shared test replica set
// (MongoDB 7.0 locally, see MONGOMS_SYSTEM_BINARY) is rehearsed on MongoDB 8.0.13,
// once on an ephemeral server the rehearsal starts itself and once on a scratch
// deployment given as the target. Also: the target's version is checked, and the
// backup's own source deployment is refused.
//
// The 8.0.13 binary is downloaded by mongodb-memory-server on first use (cached in
// ~/.cache/mongodb-binaries). MONGOMS_SYSTEM_BINARY is unset in this file so the
// 7.0 binary the shared replica set uses is not picked for the 8.0 servers.

import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDrills } from "../../src/catalog/annotations.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { MongoShield } from "../../src/shield.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

/** The release rehearsed: the newest one whose notes MongoShield encodes. */
const TARGET_VERSION = "8.0.13";

const client = useMongoClient();
const good = uniqueDb("upg");
const broken = uniqueDb("upgbad");
let storage: StorageAdapter;
let shield: MongoShield;
let sourceVersion: string;
let goodBackupId: string;
let brokenBackupId: string;
let scratch: MongoMemoryReplSet | undefined;
const savedSystemBinary = process.env.MONGOMS_SYSTEM_BINARY;

beforeAll(async () => {
  // The shared replica set is already running; from here on, 8.0 servers download 8.0.
  delete process.env.MONGOMS_SYSTEM_BINARY;
  const admin = client().db("admin");
  sourceVersion = String((await admin.command({ buildInfo: 1 })).version);

  // A healthy database with what the rules look at: a validator comparing with null,
  // a view with $rank, a legacy v1 index, a time series.
  const db = client().db(good);
  await db.createCollection("items", {
    validator: { $or: [{ deletedAt: null }, { deletedAt: { $type: "date" } }] },
  });
  await db.collection("items").insertMany(
    Array.from({ length: 200 }, (_, index) => ({
      index,
      label: `item ${index}`,
      deletedAt: null,
    })),
  );
  await db.command({
    createIndexes: "items",
    indexes: [{ v: 1, key: { label: 1 }, name: "by_label_v1" }],
  });
  await db.createCollection("ranked", {
    viewOn: "items",
    pipeline: [{ $setWindowFields: { sortBy: { index: -1 }, output: { rank: { $rank: {} } } } }],
  });
  await db.createCollection("metrics", { timeseries: { timeField: "at", metaField: "host" } });
  await db.collection("metrics").insertMany(
    Array.from({ length: 50 }, (_, index) => ({
      at: new Date(1_700_000_000_000 + index * 1000),
      host: "a",
      value: index,
    })),
  );

  // A database whose view calls a JavaScript function MongoDB 6.0 removed.
  await client()
    .db(broken)
    .collection("orders")
    .insertMany([{ tags: ["a"] }, { tags: ["b"] }]);
  await client()
    .db(broken)
    .createCollection("tagged", {
      viewOn: "orders",
      pipeline: [
        {
          $addFields: {
            n: {
              $function: {
                body: "function(tags) { return Array.concat(tags, ['x']).length; }",
                args: ["$tags"],
                lang: "js",
              },
            },
          },
        },
      ],
    });

  storage = memoryStorage();
  shield = new MongoShield({ source: { uri: mongoUri() }, storage });
  goodBackupId = (await shield.backup({ include: [`${good}.*`] })).id;
  brokenBackupId = (await shield.backup({ include: [`${broken}.*`] })).id;
});

afterAll(async () => {
  await shield?.close();
  await scratch?.stop();
  if (savedSystemBinary !== undefined) process.env.MONGOMS_SYSTEM_BINARY = savedSystemBinary;
});

/** True when the shared replica set is older than 8.0 (the usual local setup). */
function crossesEight(): boolean {
  return Number(sourceVersion.split(".")[0]) < 8;
}

describe("rehearseUpgrade on an ephemeral 8.0 server", () => {
  it("restores a 7.0 backup on 8.0, runs every check and records the rehearsal", async () => {
    // `keep` cannot keep anything on a server that is deleted afterwards: a warning says so.
    const report = await shield.rehearseUpgrade({
      backup: goodBackupId,
      targetVersion: TARGET_VERSION,
      keep: true,
    });
    expect(report.warnings.at(-1)).toContain("--keep has no lasting effect on an ephemeral server");

    expect(report).toMatchObject({
      backupId: goodBackupId,
      ok: true,
      ephemeral: true,
      sourceVersion,
      targetVersion: TARGET_VERSION,
      serverVersion: TARGET_VERSION,
      problems: [],
    });
    // The drill part: everything restored, every document and index there, samples identical.
    expect(report.drill).toMatchObject({ ok: true, restored: true, documentsRestored: 250 });
    const items = report.drill.namespaces.find((namespace) => namespace.ns === `${good}.items`);
    expect(items).toMatchObject({
      restoredDocuments: 200,
      indexesFound: 2,
      sampled: 100,
      ok: true,
    });

    // The live checks: validate per collection, the view queried, the validator evaluated.
    const outcome = (check: string, ns: string) =>
      report.checks.find((candidate) => candidate.check === check && candidate.ns === ns)?.outcome;
    expect(outcome("validate", `${good}.items`)).toBe("passed");
    expect(outcome("validate", `${good}.metrics`)).toBe("passed");
    expect(outcome("view", `${good}.ranked`)).toBe("passed");
    expect(outcome("validator", `${good}.items`)).toBe("passed");

    // The analysis: warnings only (v1 index; when crossing 8.0, $rank and null equality).
    const rules = report.compatibility.findings.map((finding) => finding.rule);
    expect(report.compatibility.ok).toBe(true);
    expect(rules).toContain("index-version-legacy");
    if (crossesEight()) {
      expect(report.compatibility.upgradePath.at(-1)).toBe("8.0");
      expect(rules).toEqual(
        expect.arrayContaining(["rank-null-missing", "null-matches-undefined"]),
      );
      expect(outcome("undefined", `${good}.items`)).toBe("passed");
    }

    // Recorded next to the backup as a drill with the version it proved.
    const [record] = await readDrills(storage, goodBackupId);
    expect(record).toMatchObject({
      ok: true,
      targetVersion: TARGET_VERSION,
      sourceVersion,
      compatibility: { problems: 0 },
    });
    expect(record?.compatibility?.warnings).toBeGreaterThan(0);
  });
});

describe("rehearseUpgrade on a scratch deployment", () => {
  beforeAll(async () => {
    scratch = await MongoMemoryReplSet.create({
      // Not the default "testset": that is the shared source's name, and the drill's
      // same-deployment guard identifies replica sets by name.
      replSet: { name: "scratch80", count: 1, storageEngine: "wiredTiger" },
      binary: { version: TARGET_VERSION },
    });
  });

  it("finds removed JavaScript both in the analysis and when querying the view", async () => {
    const target = { uri: (scratch as MongoMemoryReplSet).getUri() };
    const report = await shield.rehearseUpgrade({
      backup: brokenBackupId,
      targetVersion: "8.0",
      target,
    });
    expect(report).toMatchObject({ ok: false, ephemeral: false, serverVersion: TARGET_VERSION });
    expect(report.compatibility.findings).toContainEqual(
      expect.objectContaining({
        rule: "javascript-removed-functions",
        subject: `${broken}.tagged`,
        severity: "problem",
      }),
    );
    const view = report.checks.find((check) => check.check === "view");
    expect(view).toMatchObject({ ns: `${broken}.tagged`, outcome: "problem" });
    expect(view?.message).toContain("Array.concat is not a function");
    expect(report.problems.map((problem) => problem.subject)).toEqual(
      expect.arrayContaining([
        `javascript-removed-functions:${broken}.tagged`,
        `view:${broken}.tagged`,
      ]),
    );
    // The temporary databases were dropped from the scratch deployment.
    const scratchClient = await MongoClient.connect(target.uri);
    try {
      const { databases } = await scratchClient
        .db("admin")
        .admin()
        .listDatabases({ nameOnly: true });
      expect(databases.some((database) => database.name.startsWith("msdrill_"))).toBe(false);
    } finally {
      await scratchClient.close();
    }

    const [record] = await readDrills(storage, brokenBackupId);
    expect(record).toMatchObject({
      ok: false,
      targetVersion: TARGET_VERSION,
      compatibility: { problems: 1 },
    });
  });

  it("refuses a target that runs another version", async () => {
    const error = await shield
      .rehearseUpgrade({ backup: goodBackupId, targetVersion: "8.0", target: { uri: mongoUri() } })
      .catch((caught: unknown) => caught);
    if (!crossesEight()) return; // The shared server already runs 8.0: nothing to refuse.
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String((error as Error).message)).toContain(`runs MongoDB ${sourceVersion}, not 8.0`);
  });

  it("refuses an exact patch the target does not run", async () => {
    const error = await shield
      .rehearseUpgrade({
        backup: goodBackupId,
        targetVersion: "8.0.1",
        target: { uri: (scratch as MongoMemoryReplSet).getUri() },
      })
      .catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String((error as Error).message)).toContain(`runs MongoDB ${TARGET_VERSION}, not 8.0.1`);
  });

  it("refuses the backup's own source deployment (production)", async () => {
    // Same version as the source, so only the drill's same-deployment guard can refuse it.
    const error = await shield
      .rehearseUpgrade({
        backup: goodBackupId,
        targetVersion: sourceVersion,
        target: { uri: mongoUri() },
      })
      .catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String((error as Error).message)).toMatch(/is the deployment backup .* was taken from/);
    // Nothing was recorded for a rehearsal that never ran.
    expect((await readDrills(storage, goodBackupId)).every((record) => record.ok)).toBe(true);
  });
});

describe("checkUpgradeCompatibility", () => {
  it("analyses a stored backup without any server", async () => {
    const offline = new MongoShield({ storage });
    try {
      const result = await offline.checkUpgradeCompatibility({
        backup: brokenBackupId,
        targetVersion: "8.0",
      });
      expect(result).toMatchObject({ backupId: brokenBackupId, ok: false, sourceVersion });
      expect(result.findings[0]).toMatchObject({ rule: "javascript-removed-functions" });
      // include/exclude narrow the analysis like a restore.
      const narrowed = await offline.checkUpgradeCompatibility({
        backup: brokenBackupId,
        targetVersion: "8.0",
        exclude: [`${broken}.tagged`],
      });
      expect(narrowed.findings.filter((finding) => finding.severity === "problem")).toEqual([]);
    } finally {
      await offline.close();
    }
  });
});
