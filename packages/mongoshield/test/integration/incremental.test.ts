// Integration tests for incremental backups (src/engine/backup-incremental.ts): a chain
// full → incremental → incremental is restored byte for byte as the source was at the
// chosen member's end, with DDL inside the windows (create, drop, rename, indexes),
// at points in time inside the chain, encrypted, and with the failures that must make
// an incremental impossible (lost history, a parent without an end time).

import { type Document, Long } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { MongoShieldError } from "../../src/errors.ts";
import { isIncrementalManifest, type Manifest } from "../../src/format/manifest.ts";
import { writeManifest } from "../../src/format/manifest-io.ts";
import { silentLogger } from "../../src/logger.ts";
import { MongoShield } from "../../src/shield.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { BackupOptions, EncryptionOptions, RestoreOptions } from "../../src/types.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import {
  type AnyDocument,
  collectionNames,
  firstDifference,
  indexDefinitions,
  rawDocuments,
} from "./converge-test-utils.ts";
import { clientWithOplogStartingAt } from "./journal-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

/** A fresh database name, dropped after the file. */
function newDatabase(prefix: string): string {
  const name = uniqueDb(prefix);
  databases.push(name);
  return name;
}

/** `count` documents with nested fields and arrays, `_id` 0…count-1. */
async function seed(database: string, collection: string, count: number): Promise<void> {
  await client()
    .db(database)
    .collection<AnyDocument>(collection)
    .insertMany(
      Array.from({ length: count }, (_, n) => ({
        _id: n,
        n,
        name: `doc ${n}`,
        nested: { x: n, y: [n, n + 1] },
        tags: ["a", "b", "c"],
      })),
    );
}

/** A backup of `database.*` (full by default; pass `incremental` for an incremental). */
async function backup(
  storage: MemoryStorage,
  database: string,
  options: Partial<BackupOptions> = {},
  encryption?: EncryptionOptions,
): Promise<Manifest> {
  const result = await runBackup(
    backupContext(client(), storage, encryption === undefined ? {} : { encryption }),
    { include: [`${database}.*`], parallelism: 1, ...options },
  );
  if (result.status !== "complete") throw new Error("expected a complete backup");
  return result.manifest;
}

function restore(storage: MemoryStorage, options: RestoreOptions) {
  return runRestore({ client: client(), storage, logger: silentLogger }, options);
}

/** Every collection of a database, as raw BSON documents and index definitions. */
interface DatabaseState {
  readonly collections: Map<string, { documents: Buffer[]; indexes: string[] }>;
}

async function stateOf(database: string): Promise<DatabaseState> {
  const collections = new Map<string, { documents: Buffer[]; indexes: string[] }>();
  for (const name of await collectionNames(client(), database)) {
    collections.set(name, {
      documents: await rawDocuments(client(), database, name),
      indexes: await indexDefinitions(client(), database, name),
    });
  }
  return { collections };
}

/** Expects `target` to hold exactly `expected` (documents byte for byte, and indexes). */
async function expectState(target: string, expected: DatabaseState): Promise<void> {
  const actual = await stateOf(target);
  expect([...actual.collections.keys()]).toEqual([...expected.collections.keys()]);
  for (const [name, { documents, indexes }] of expected.collections) {
    const restored = actual.collections.get(name);
    expect(
      firstDifference(documents, restored?.documents ?? []),
      `${target}.${name}`,
    ).toBeUndefined();
    expect(restored?.indexes, `${target}.${name} indexes`).toEqual(indexes);
  }
}

/** An update document, typed loosely (the driver's types reject some valid updates). */
function update(document: Document): Document {
  return document;
}

describe("incremental backups", () => {
  it("restores each member of a chain exactly as the source was at its end", async () => {
    const source = newDatabase("inc_src");
    for (const name of ["a", "b", "c"]) await seed(source, name, 200);
    const db = client().db(source);
    const storage = memoryStorage();

    const full = await backup(storage, source, { consistency: "converge" });

    // Window 1: document changes and every kind of DDL.
    await db.collection<AnyDocument>("a").insertOne({ _id: 1000, added: new Long(7) });
    await db.collection<AnyDocument>("a").deleteMany({ _id: { $lt: 10 } });
    await db
      .collection<AnyDocument>("a")
      .updateMany({ _id: { $lt: 50 } }, { $set: { "nested.x": -1 } });
    await db.collection<AnyDocument>("b").updateOne({ _id: 20 }, update({ $push: { tags: "d" } }));
    await db.collection<AnyDocument>("b").replaceOne({ _id: 21 }, { replaced: true });
    await db.collection<AnyDocument>("b").createIndex({ name: 1 }, { name: "by_name" });
    await db.createCollection("created");
    await db.collection<AnyDocument>("created").insertMany([
      { _id: "x", v: 1 },
      { _id: "y", v: 2 },
    ]);
    await db.collection("c").rename("c_renamed");
    const first = await backup(storage, source, { incremental: true });
    const afterFirst = await stateOf(source);

    // Window 2: more DDL on top: a drop, an index drop, a rename over an existing name.
    await db.collection<AnyDocument>("created").updateOne({ _id: "x" }, { $unset: { v: "" } });
    await db.collection("b").dropIndex("by_name");
    await db.collection<AnyDocument>("a").createIndex({ n: -1 }, { name: "n_desc", unique: true });
    await db.collection("c_renamed").drop();
    await seed(source, "fresh", 5);
    await db.collection("fresh").rename("a", { dropTarget: true });
    const second = await backup(storage, source, { incremental: { from: "latest" } });
    const afterSecond = await stateOf(source);

    expect(isIncrementalManifest(first)).toBe(true);
    expect(first).toMatchObject({
      formatVersion: 2,
      kind: "incremental",
      chain: { base: full.id, parent: full.id, length: 1 },
      consistency: { mode: "converge", from: full.consistency.to },
    });
    // The metadata of every collection that existed at the start (no documents).
    expect(
      first.namespaces.map((entry) => [entry.collection, entry.content, entry.files.length]),
    ).toEqual([
      ["a", "metadata", 0],
      ["b", "metadata", 0],
      ["c_renamed", "metadata", 0],
      ["created", "metadata", 0],
    ]);
    expect(second).toMatchObject({
      chain: { base: full.id, parent: first.id, length: 2 },
      consistency: { from: first.consistency.to },
    });
    expect(first.changes?.events).toBeGreaterThan(0);

    // The newest member: the base plus both windows.
    const latest = newDatabase("inc_dst");
    const result = await restore(storage, {
      backup: second.id,
      rename: { [`${source}.*`]: `${latest}.*` },
    });
    expect(result.plan.chain).toEqual({
      baseBackupId: full.id,
      incrementals: [first.id, second.id],
    });
    expect(result.eventsReplayed).toBeGreaterThan(0);
    await expectState(latest, afterSecond);

    // A member in the middle stops after its own window.
    const middle = newDatabase("inc_mid");
    await restore(storage, { backup: first.id, rename: { [`${source}.*`]: `${middle}.*` } });
    await expectState(middle, afterFirst);
  });

  it("continues a snapshot backup and restores to a point in time inside the chain", async () => {
    const source = newDatabase("inc_pit");
    await seed(source, "a", 50);
    const db = client().db(source);
    const storage = memoryStorage();
    const full = await backup(storage, source, { consistency: "snapshot" });
    const atFull = await stateOf(source);

    await db.collection<AnyDocument>("a").updateOne({ _id: 1 }, { $set: { step: 1 } });
    const firstReply = await db.collection<AnyDocument>("a").insertOne({ _id: 500, step: 1 });
    expect(firstReply.acknowledged).toBe(true);
    const afterStepOne = await stateOf(source);
    const stepOneTime = (await db.command({ ping: 1 })).operationTime;
    await db.collection<AnyDocument>("a").deleteOne({ _id: 2 });
    const incremental = await backup(storage, source, { incremental: true });
    expect(incremental.chain?.parent).toBe(full.id);

    const shield = new MongoShield({ source: { uri: mongoUri() }, storage });
    const target = newDatabase("inc_pit_dst");
    const pointInTime = await shield.restore({
      backup: incremental.id,
      at: { t: stepOneTime.t, i: stepOneTime.i },
      rename: { [`${source}.*`]: `${target}.*` },
    });
    expect(pointInTime.pointInTime?.baseBackupId).toBe(full.id);
    await expectState(target, afterStepOne);

    // At the base's own time, nothing is replayed.
    const atBase = newDatabase("inc_pit_base");
    const fullTime = full.consistency.to;
    if (fullTime === undefined) throw new Error("a snapshot backup has a time");
    await shield.restore({
      backup: "latest",
      at: fullTime,
      rename: { [`${source}.*`]: `${atBase}.*` },
    });
    await expectState(atBase, atFull);

    // Outside the chain: a clear error naming the range.
    const tooLate = await shield
      .restore({ backup: incremental.id, at: { t: stepOneTime.t + 3600, i: 0 }, dryRun: true })
      .catch((error: unknown) => error);
    expect(tooLate).toMatchObject({ code: "MS_CHANGE_HISTORY_LOST" });
    await shield.close();
  });

  it("restores an encrypted chain (one key envelope per backup)", async () => {
    const source = newDatabase("inc_enc");
    await seed(source, "a", 30);
    const storage = memoryStorage();
    const encryption = { passphrase: "correct horse battery staple" };
    await backup(storage, source, { consistency: "converge" }, encryption);
    await client().db(source).collection<AnyDocument>("a").deleteOne({ _id: 3 });
    const incremental = await backup(storage, source, { incremental: true }, encryption);
    expect(incremental.encryption?.keyFile).toBeDefined();
    const expected = await stateOf(source);

    const target = newDatabase("inc_enc_dst");
    await restore(storage, {
      backup: incremental.id,
      rename: { [`${source}.*`]: `${target}.*` },
      decryption: { passphrase: encryption.passphrase },
      verifyFirst: true,
    });
    await expectState(target, expected);
  });

  it("fails with a hint to take a full backup when the oplog no longer covers the parent", async () => {
    const source = newDatabase("inc_lost");
    await seed(source, "a", 5);
    const storage = memoryStorage();
    const full = await backup(storage, source, { consistency: "converge" });
    const end = full.consistency.to;
    if (end === undefined) throw new Error("a converge backup has an end");

    // The oplog now starts after the full backup's end.
    const lostClient = clientWithOplogStartingAt(client(), { t: end.t + 1, i: 0 });
    const error = await runBackup(backupContext(lostClient, storage), {
      include: [`${source}.*`],
      incremental: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MongoShieldError);
    expect(error).toMatchObject({
      code: "MS_CHANGE_HISTORY_LOST",
      details: { parent: full.id },
    });
    expect((error as MongoShieldError).hint).toContain("full backup");
    // Nothing of the failed run is left behind.
    const ids = [];
    for await (const prefix of storage.listPrefixes("backups/")) ids.push(prefix);
    expect(ids).toEqual([`backups/${full.id}/`]);
  });

  it("refuses a parent without an exact end time, another selection, or none at all", async () => {
    const source = newDatabase("inc_refuse");
    await seed(source, "a", 5);
    const storage = memoryStorage();

    const nothing = await backup(storage, source, { incremental: true }).catch((e: unknown) => e);
    expect(nothing).toMatchObject({ code: "MS_BACKUP_NOT_FOUND" });

    const plain = await backup(storage, source, { consistency: "none" });
    const named = await backup(storage, source, { incremental: { from: plain.id } }).catch(
      (e: unknown) => e,
    );
    expect(named).toMatchObject({ code: "MS_CONFIG_INVALID" });
    expect((named as MongoShieldError).message).toContain('consistency "none"');

    await backup(storage, source, { consistency: "converge" });
    const other = await runBackup(backupContext(client(), storage), {
      include: [`${source}.a`],
      incremental: true,
    }).catch((e: unknown) => e);
    expect(other).toMatchObject({ code: "MS_BACKUP_NOT_FOUND" });

    const withQuery = await backup(storage, source, {
      incremental: true,
      query: { [`${source}.a`]: { n: 1 } },
    }).catch((e: unknown) => e);
    expect(withQuery).toMatchObject({ code: "MS_CONFIG_INVALID" });
  });
});

describe("incremental backup options", () => {
  const source = newDatabase("inc_options");
  beforeAll(() => seed(source, "a", 1));

  it.each([
    [
      "a non-string from",
      { incremental: { from: 5 as unknown as string } },
      "from must be a string",
    ],
    ["a bad fullAfterMs", { incremental: { fullAfterMs: -1 } }, "fullAfterMs"],
    ["a bad maxChainLength", { incremental: { maxChainLength: 0 } }, "maxChainLength"],
    ["a non-object", { incremental: "yes" as unknown as true }, "must be true or"],
    ["maxDurationMs", { incremental: true, maxDurationMs: 60_000 }, "checkpointed or resumed"],
    [
      "consistency snapshot",
      { incremental: true, consistency: "snapshot" as const },
      'consistency "snapshot"',
    ],
    ["retainDays without object lock", { incremental: true, retainDays: 1 }, "object lock"],
  ])("refuses %s", async (_label, options, message) => {
    const storage = memoryStorage();
    await backup(storage, source, { consistency: "converge" });
    const error = await backup(storage, source, options).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "MS_CONFIG_INVALID" });
    expect((error as Error).message).toContain(message);
  });

  it("refuses a parent that ends after the deployment's current time", async () => {
    const storage = memoryStorage();
    const full = await backup(storage, source, { consistency: "converge" });
    const to = full.consistency.to;
    if (to === undefined) throw new Error("a converge backup has an end");
    // The same backup, re-dated an hour into the future (a backup of another history).
    const future: Manifest = {
      ...full,
      id: full.id.replace(/_[0-9a-f]{6}$/, "_ffffff"),
      consistency: { ...full.consistency, to: { t: to.t + 3600, i: 1 } },
    };
    await writeManifest(storage, future);
    const error = await backup(storage, source, { incremental: { from: future.id } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "MS_CONFIG_INVALID" });
    expect((error as Error).message).toContain("after the deployment's current time");
  });

  it("takes a full backup instead when asked to, saying why", async () => {
    const storage = memoryStorage();
    await backup(storage, source, { consistency: "converge" });
    const result = await runBackup(backupContext(client(), storage), {
      include: [`${source}.*`],
      consistency: "snapshot",
      incremental: { fallbackToFull: true, maxChainLength: 1 },
    });
    expect(result.status === "complete" && result.fullBackupReason).toContain(
      'consistency "snapshot"',
    );

    // The chain policy: the chain is at maxChainLength, so a new chain starts.
    const first = await backup(storage, source, { incremental: true });
    const second = await runBackup(backupContext(client(), storage), {
      include: [`${source}.*`],
      incremental: { fallbackToFull: true, maxChainLength: 1 },
    });
    expect(first.chain?.length).toBe(1);
    expect(second.status === "complete" && second.fullBackupReason).toContain("maxChainLength");
  });
});
