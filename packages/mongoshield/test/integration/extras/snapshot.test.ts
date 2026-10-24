/**
 * Snapshots before a migration and rollbacks (src/extras/snapshot.ts), against the
 * real test replica set: a "migration" rewrites and drops data, the rollback puts it
 * back and leaves a safety snapshot of what it replaced.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ROLLBACK_OF_LABEL,
  rollback,
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
    // Collections created by the migration are left alone.
    expect(await db.collection("audit").countDocuments()).toBe(1);

    // The safety snapshot holds the broken state, and points back at the snapshot.
    const safety = (await shield.list()).find((entry) => entry.id === result.safetySnapshotId);
    expect(safety?.manifest?.labels[SNAPSHOT_LABEL]).toBe("pre-rollback-v42");
    expect(safety?.manifest?.labels[ROLLBACK_OF_LABEL]).toBe(taken.id);
    expect(safety?.manifest?.namespaces.map((entry) => entry.ns)).toEqual([`${database}.accounts`]);
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
});
