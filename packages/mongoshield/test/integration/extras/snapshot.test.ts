/**
 * Snapshots before a migration and rollbacks (src/extras/snapshot.ts), against the
 * real test replica set: a "migration" rewrites and drops data, the rollback puts it
 * back and leaves a safety snapshot of what it replaced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROLLBACK_OF_LABEL,
  rollback,
  SNAPSHOT_INCLUDE_LABEL,
  SNAPSHOT_LABEL,
  snapshot,
} from "../../../src/extras/snapshot.ts";
import { isMongoShieldError, MongoShield } from "../../../src/index.ts";
import { memoryStorage } from "../../../src/storage/memory.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../../helpers/mongo.ts";

const client = useMongoClient();
let database: string;
let shield: MongoShield;

interface Account {
  _id: number;
  plan: string;
}

beforeEach(async () => {
  database = uniqueDb("snap");
  shield = new MongoShield({ source: { uri: mongoUri() }, storage: memoryStorage() });
  const db = client().db(database);
  await db
    .collection<Account>("accounts")
    .insertMany(Array.from({ length: 20 }, (_, index) => ({ _id: index, plan: "basic" })));
  await db.collection("settings").insertOne({ theme: "dark" });
});

afterEach(async () => {
  await client().db(database).dropDatabase();
});

/** A migration that goes wrong: rewrites one collection, drops another, adds a third. */
async function badMigration(): Promise<void> {
  const db = client().db(database);
  await db.collection<Account>("accounts").updateMany({}, { $set: { plan: "BROKEN" } });
  await db.collection("settings").drop();
  await db.collection("audit").insertOne({ migrated: true });
}

describe("snapshot and rollback", () => {
  it("rolls a failed migration back and keeps a safety snapshot of what it replaced", async () => {
    const taken = await snapshot(shield, { label: "v42", include: [`${database}.*`] });
    expect(taken.manifest.labels[SNAPSHOT_LABEL]).toBe("v42");
    await badMigration();

    const result = await rollback(shield, { label: "v42" });
    expect(result.snapshotId).toBe(taken.id);
    const db = client().db(database);
    expect(await db.collection<Account>("accounts").countDocuments({ plan: "basic" })).toBe(20);
    expect(await db.collection("settings").countDocuments()).toBe(1);
    // Collections created by the migration are dropped.
    expect(result.newCollections).toEqual([`${database}.audit`]);
    expect(result.dropsNew).toBe(true);
    const names = (await db.listCollections().toArray()).map((info) => info.name).sort();
    expect(names).toEqual(["accounts", "settings"]);

    // The safety snapshot holds the broken state, the dropped collection included, and
    // points back at the snapshot.
    const safety = (await shield.list()).find((entry) => entry.id === result.safetySnapshotId);
    expect(safety?.manifest?.labels[SNAPSHOT_LABEL]).toBe("pre-rollback-v42");
    expect(safety?.manifest?.labels[ROLLBACK_OF_LABEL]).toBe(taken.id);
    expect(safety?.manifest?.namespaces.map((entry) => entry.ns).sort()).toEqual([
      `${database}.accounts`,
      `${database}.audit`,
    ]);
  });

  it("keeps the collections created since the snapshot with keepNew", async () => {
    await snapshot(shield, { label: "keep", include: [`${database}.*`] });
    await badMigration();
    const result = await rollback(shield, { label: "keep", keepNew: true });
    expect(result).toMatchObject({ newCollections: [`${database}.audit`], dropsNew: false });
    expect(await client().db(database).collection("audit").countDocuments()).toBe(1);
  });

  it("drops only new collections the snapshot would have captured, and the rollback selects", async () => {
    const db = client().db(database);
    await db.collection("cache").insertOne({ hot: true });
    // The snapshot leaves `cache` out on purpose: it was not "created after it".
    await snapshot(shield, {
      label: "narrow",
      include: [`${database}.*`],
      exclude: [`${database}.cache`],
    });
    await badMigration();
    await db.createCollection("audit_view", { viewOn: "audit", pipeline: [] });
    await db.collection("scratch").insertOne({ temp: true });

    const dry = await rollback(shield, {
      label: "narrow",
      exclude: [`${database}.scratch`],
      dryRun: true,
    });
    expect(dry.newCollections).toEqual([`${database}.audit`, `${database}.audit_view`]);
    expect(await db.collection("audit").countDocuments()).toBe(1);

    await rollback(shield, { label: "narrow", exclude: [`${database}.scratch`] });
    const names = (await db.listCollections().toArray())
      .map((info) => info.name)
      .filter((name) => !name.startsWith("system."))
      .sort();
    expect(names).toEqual(["accounts", "cache", "scratch", "settings"]);
  });

  it("plans without writing in a dry run, and picks the newest snapshot with the label", async () => {
    await snapshot(shield, { label: "v1", include: [`${database}.*`] });
    await client().db(database).collection("settings").insertOne({ theme: "light" });
    const newer = await snapshot(shield, { label: "v1", include: [`${database}.*`] });
    await badMigration();
    const before = (await shield.list()).length;

    const dry = await rollback(shield, { label: "v1", dryRun: true });
    expect(dry.snapshotId).toBe(newer.id);
    expect(dry.plan.mode).toBe("drop");
    expect((await shield.list()).length).toBe(before);
    expect(
      await client().db(database).collection("accounts").countDocuments({ plan: "basic" }),
    ).toBe(0);
  });

  it("rolls back by backup id without a safety snapshot when asked", async () => {
    const taken = await snapshot(shield, { label: "by-id", include: [`${database}.accounts`] });
    await badMigration();
    const result = await rollback(shield, { backupId: taken.id, safetySnapshot: false });
    expect(result.safetySnapshotId).toBeUndefined();
    expect((await shield.list()).length).toBe(1);
    expect(
      await client().db(database).collection("accounts").countDocuments({ plan: "basic" }),
    ).toBe(20);
  });

  it("explains a missing label and rejects malformed ones", async () => {
    await snapshot(shield, { label: "exists", include: [`${database}.*`] });
    await expect(rollback(shield, { label: "nope" })).rejects.toSatisfy(
      (error) =>
        isMongoShieldError(error, "MS_BACKUP_NOT_FOUND") && /exists/.test(error.hint ?? ""),
    );
    await expect(snapshot(shield, { label: "has space" })).rejects.toThrow(
      /not a valid snapshot label/,
    );
    await expect(rollback(shield, {})).rejects.toThrow(/exactly one/);
  });

  it("treats a plain backup (no recorded patterns) as having captured its databases whole", async () => {
    const backup = await shield.backup({
      include: [`${database}.accounts`],
      consistency: "none",
      // Not written by snapshot(): unreadable pattern labels are ignored.
      labels: { [SNAPSHOT_INCLUDE_LABEL]: "not json" },
    });
    await badMigration();
    const dry = await rollback(shield, { backupId: backup.id, dryRun: true });
    // `settings` is gone, `audit` is new; with whole databases captured, the live
    // `audit` counts as created after the backup.
    expect(dry.newCollections).toEqual([`${database}.audit`]);
    expect(dry.label).toBeUndefined();
  });

  it("refuses filters that select nothing of the snapshot, and explains when there are no snapshots", async () => {
    await expect(rollback(shield, { label: "none-yet" })).rejects.toSatisfy(
      (error) =>
        isMongoShieldError(error, "MS_BACKUP_NOT_FOUND") && /Take one/.test(error.hint ?? ""),
    );
    await snapshot(shield, { label: "only", include: [`${database}.*`] });
    await expect(
      rollback(shield, { label: "only", include: [`${database}.nothing_here`] }),
    ).rejects.toThrow(/No namespace in backup/);
  });

  it("takes no safety snapshot when there is nothing to lose", async () => {
    const db = client().db(database);
    await db.collection("accounts").deleteMany({});
    await db.collection("settings").deleteMany({});
    await snapshot(shield, { label: "empty", include: [`${database}.*`], exclude: [] });
    const result = await rollback(shield, { label: "empty" });
    expect(result.safetySnapshotId).toBeUndefined();
    expect(result.newCollections).toEqual([]);
    expect(result.dropsNew).toBe(false);
  });

  it("writes snapshots that are retained, with extra labels", async () => {
    const locked = new MongoShield({
      source: { uri: mongoUri() },
      storage: memoryStorage({ objectLock: true }),
    });
    // Scoped to this test's database: the test server is shared by every test file
    // running in parallel, and a snapshot of all of it would read (and race with) their
    // databases while they are being created and dropped.
    const taken = await snapshot(locked, {
      label: "kept",
      include: [`${database}.*`],
      retainDays: 1,
      labels: { ticket: "OPS-1" },
    });
    expect(taken.manifest.labels).toMatchObject({
      ticket: "OPS-1",
      [SNAPSHOT_LABEL]: "kept",
      [SNAPSHOT_INCLUDE_LABEL]: JSON.stringify([`${database}.*`]),
    });
    expect(taken.manifest.immutableUntil).toBeDefined();
  });

  it("records no pattern labels for a snapshot of everything", async () => {
    // Only what snapshot() asks the backup for matters here, so the backup itself is
    // stubbed rather than run over the whole shared test server.
    const backup = vi.spyOn(shield, "backup").mockRejectedValue(new Error("not run"));
    await expect(snapshot(shield, { label: "all", labels: { ticket: "OPS-2" } })).rejects.toThrow(
      "not run",
    );
    expect(backup).toHaveBeenCalledTimes(1);
    const options = backup.mock.calls[0]?.[0];
    expect(options?.include).toBeUndefined();
    expect(options?.labels).toEqual({ ticket: "OPS-2", [SNAPSHOT_LABEL]: "all" });
  });
});
