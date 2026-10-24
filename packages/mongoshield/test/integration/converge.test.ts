// Integration tests for consistency mode "converge": the backup records the changes
// made while it runs, and restore replays them so every collection ends up as of the
// end of the backup (T1). Writes are injected deterministically while a data file is
// being written (see `hookedStorage`), so they always fall inside the window.

import type { Document } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { verifyBackup } from "../../src/engine/verify.ts";
import { MongoShieldError } from "../../src/errors.ts";
import { resolveBackupKey } from "../../src/format/layout.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { BackupOptions, EncryptionOptions, RestoreOptions } from "../../src/types.ts";
import { flipByte, replaceStoredFile } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import {
  collectionNames,
  firstDifference,
  hookedStorage,
  isDataFileOf,
  rawDocuments,
} from "./converge-test-utils.ts";

/** Test documents: any fields, with numeric or string `_id`s. */
interface TestDocument {
  _id?: number | string;
  n?: number;
  arr?: number[];
  tags?: string[];
  [field: string]: unknown;
}

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
    .collection<TestDocument>(collection)
    .insertMany(
      Array.from({ length: count }, (_, n) => ({
        _id: n,
        n,
        name: `doc ${n}`,
        nested: { x: n, y: [n, n + 1] },
        tags: ["a", "b", "c", "d"],
      })),
    );
}

/** A converge backup of `database.*`, one collection at a time. */
async function backup(
  storage: MemoryStorage,
  database: string,
  options: Partial<BackupOptions> = {},
  encryption?: EncryptionOptions,
): Promise<Manifest> {
  const result = await runBackup(
    backupContext(client(), storage, encryption === undefined ? {} : { encryption }),
    { include: [`${database}.*`], consistency: "converge", parallelism: 1, ...options },
  );
  if (result.status !== "complete") throw new Error("expected a complete backup");
  return result.manifest;
}

function restore(storage: MemoryStorage, options: RestoreOptions) {
  return runRestore({ client: client(), storage, logger: silentLogger }, options);
}

/** Expects `target` to hold exactly the documents `source` holds now, byte for byte. */
async function expectSameCollections(source: string, target: string): Promise<void> {
  const names = await collectionNames(client(), source);
  expect(await collectionNames(client(), target)).toEqual(names);
  for (const name of names) {
    const expected = await rawDocuments(client(), source, name);
    const actual = await rawDocuments(client(), target, name);
    expect(firstDifference(expected, actual), `${target}.${name}`).toBeUndefined();
  }
}

/** An update document, typed loosely (the driver's types reject some valid updates). */
function update(document: Document): Document {
  return document;
}

/** Every kind of document change, spread over three collections. */
async function changeEverything(database: string): Promise<void> {
  const db = client().db(database);
  await db.collection<TestDocument>("a").insertMany([{ _id: 1000, n: 1000, added: true }]);
  await db.collection<TestDocument>("a").deleteMany({ _id: { $in: [1, 2, 3] } });
  await db
    .collection<TestDocument>("a")
    .updateMany({ _id: { $lt: 50 } }, { $set: { "nested.x": -1, extra: "yes" } });
  await db
    .collection<TestDocument>("b")
    .updateMany({ _id: { $gte: 100 } }, { $unset: { name: "" } });
  await db.collection<TestDocument>("b").updateOne({ _id: 7 }, update({ $push: { tags: "e" } }));
  await db
    .collection<TestDocument>("b")
    .updateOne({ _id: 8 }, [{ $set: { tags: { $slice: ["$tags", 2] } } }]);
  await db.collection<TestDocument>("b").replaceOne({ _id: 9 }, { replaced: true });
  await db.collection<TestDocument>("c").updateOne({ _id: 299 }, update({ $inc: { n: 5 } }));
  await db.collection<TestDocument>("c").insertOne({ _id: "late", value: 1.5 });
}

describe("consistency converge", () => {
  it("restores every collection as it was at the end of the backup", async () => {
    const source = newDatabase("cv_src");
    const target = newDatabase("cv_dst");
    for (const name of ["a", "b", "c"]) await seed(source, name, 300);

    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      // `b` is the second collection dumped: `a` is already stored, `c` not yet read.
      if (changed || !isDataFileOf(key, "b")) return;
      changed = true;
      await changeEverything(source);
    });
    const manifest = await backup(storage, source);

    expect(changed).toBe(true);
    expect(manifest.consistency.mode).toBe("converge");
    const { from, to } = manifest.consistency;
    expect(from).toBeDefined();
    expect(to).toBeDefined();
    expect(manifest.changes?.key).toBe("_changes/window.bson.zst");
    expect(manifest.changes?.events).toBeGreaterThanOrEqual(100);
    expect(manifest.totals.bytesStored).toBeGreaterThan(manifest.changes?.size ?? 0);

    await restore(storage, { backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } });
    await expectSameCollections(source, target);
  });

  it("replays drops, $out and collections created during the backup", async () => {
    const source = newDatabase("cv_ddl");
    const target = newDatabase("cv_ddl_dst");
    await seed(source, "a", 50);
    await seed(source, "doomed", 50);
    await seed(source, "summary", 5);
    await seed(source, "z", 50);

    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (changed || !isDataFileOf(key, "doomed")) return;
      changed = true;
      const db = client().db(source);
      await db.collection<TestDocument>("doomed").drop();
      // `$out` fills a scratch collection and renames it over `summary`.
      await db
        .collection<TestDocument>("a")
        .aggregate([{ $match: { n: { $lt: 10 } } }, { $out: "summary" }])
        .toArray();
      await db.collection<TestDocument>("fresh").insertMany([{ _id: 1 }, { _id: 2 }]);
      await db.collection<TestDocument>("z").deleteMany({ n: { $gte: 25 } });
    });
    const manifest = await backup(storage, source);
    expect(manifest.namespaces.map((entry) => entry.collection)).toContain("doomed");

    await restore(storage, { backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } });
    await expectSameCollections(source, target);
    expect(await collectionNames(client(), target)).not.toContain("doomed");
  });

  it("protects existing targets of collections created during the backup", async () => {
    const source = newDatabase("cv_new");
    const target = newDatabase("cv_new_dst");
    await seed(source, "a", 10);
    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (changed || !isDataFileOf(key, "a")) return;
      changed = true;
      await client().db(source).collection<TestDocument>("fresh").insertOne({ _id: 1 });
    });
    const manifest = await backup(storage, source);
    await client().db(target).collection<TestDocument>("fresh").insertOne({ _id: "existing" });
    const options = { backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } };

    const error = await restore(storage, options).catch((caught: unknown) => caught);
    expect((error as MongoShieldError).code).toBe("MS_RESTORE_CONFLICT");
    expect(await collectionNames(client(), target)).toEqual(["fresh"]);

    await restore(storage, { ...options, mode: "drop" });
    await expectSameCollections(source, target);
  });

  it("applies the restore's include filter and rename rules to the events", async () => {
    const source = newDatabase("cv_flt");
    const target = newDatabase("cv_flt_dst");
    await seed(source, "a", 40);
    await seed(source, "b", 40);

    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (changed || !isDataFileOf(key, "a")) return;
      changed = true;
      await client()
        .db(source)
        .collection<TestDocument>("a")
        .updateMany({}, { $set: { touched: true } });
      await client().db(source).collection<TestDocument>("b").deleteMany({});
    });
    const manifest = await backup(storage, source);

    await restore(storage, {
      backup: manifest.id,
      include: [`${source}.a`],
      rename: { [`${source}.a`]: `${target}.renamed` },
    });
    expect(await collectionNames(client(), target)).toEqual(["renamed"]);
    const expected = await rawDocuments(client(), source, "a");
    const actual = await rawDocuments(client(), target, "renamed");
    expect(firstDifference(expected, actual)).toBeUndefined();
  });

  it("encrypts the changes file and replays it with the identity", async () => {
    const source = newDatabase("cv_enc");
    const target = newDatabase("cv_enc_dst");
    await seed(source, "a", 100);
    const { identity, recipient } = generateIdentity();

    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (changed || !isDataFileOf(key, "a")) return;
      changed = true;
      await client()
        .db(source)
        .collection<TestDocument>("a")
        .updateMany({ n: { $lt: 30 } }, { $set: { secret: 1 } });
    });
    const manifest = await backup(storage, source, {}, { recipients: [recipient] });
    expect(manifest.changes?.key).toBe("_changes/window.bson.zst.age");

    await restore(storage, {
      backup: manifest.id,
      rename: { [`${source}.*`]: `${target}.*` },
      decryption: { identities: [identity] },
    });
    await expectSameCollections(source, target);
  });

  it("verifies the changes file in both modes and reports a damaged one", async () => {
    const source = newDatabase("cv_ver");
    await seed(source, "a", 20);
    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (changed || !isDataFileOf(key, "a")) return;
      changed = true;
      await client().db(source).collection<TestDocument>("a").insertOne({ _id: "new" });
    });
    const manifest = await backup(storage, source);
    const context = { storage, logger: silentLogger };

    const fast = await verifyBackup(context, { backup: manifest.id });
    const deep = await verifyBackup(context, { backup: manifest.id, mode: "deep" });
    expect(fast.ok).toBe(true);
    expect(deep.ok).toBe(true);
    // a: metadata + data; plus the changes file.
    expect(deep.filesChecked).toBe(3);

    const changes = manifest.changes;
    if (changes === undefined) throw new Error("no changes file");
    await replaceStoredFile(storage, manifest, changes.key, (bytes) => flipByte(bytes, -3));
    const damaged = await verifyBackup(context, { backup: manifest.id, mode: "deep" });
    expect(damaged.ok).toBe(false);
    expect(damaged.problems.map((problem) => problem.subject)).toEqual([changes.key]);
  });

  it("refuses to restore a damaged changes file before writing anything", async () => {
    const source = newDatabase("cv_bad");
    const target = newDatabase("cv_bad_dst");
    await seed(source, "a", 20);
    const storage = memoryStorage();
    const manifest = await backup(storage, source);
    const changes = manifest.changes;
    if (changes === undefined) throw new Error("no changes file");
    await replaceStoredFile(storage, manifest, changes.key, (bytes) => flipByte(bytes, 10));

    const error = await restore(storage, {
      backup: manifest.id,
      rename: { [`${source}.*`]: `${target}.*` },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MongoShieldError);
    expect((error as MongoShieldError).code).toBe("MS_INTEGRITY_FAILED");
    expect(await collectionNames(client(), target)).toEqual([]);
  });

  it("replays a rename of a collection the backup had not read yet", async () => {
    const source = newDatabase("cv_ren");
    const target = newDatabase("cv_ren_dst");
    await seed(source, "a", 20);
    await seed(source, "z_last", 20);
    let renamed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (renamed || !isDataFileOf(key, "a")) return;
      renamed = true;
      // z_last is dumped after this, as an empty (missing) collection: the backup must
      // record z_moved itself, since replaying the rename alone would empty it.
      await client().db(source).collection<TestDocument>("z_last").rename("z_moved");
      await client()
        .db(source)
        .collection<TestDocument>("z_moved")
        .updateOne({ _id: 3 }, { $set: { moved: true } });
    });

    const manifest = await backup(storage, source);
    await restore(storage, { backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } });
    await expectSameCollections(source, target);
    expect(await collectionNames(client(), target)).toEqual(["a", "z_moved"]);
  });

  it("writes an empty changes file when nothing changed during the backup", async () => {
    const source = newDatabase("cv_idle");
    await seed(source, "a", 10);
    const storage = memoryStorage();
    const manifest = await backup(storage, source);
    // The window includes T0 itself, which may be the seeding write (replaying it is harmless).
    expect(manifest.changes?.events).toBeLessThanOrEqual(1);
    const key = resolveBackupKey(manifest.id, manifest.changes?.key ?? "");
    expect(storage.keys()).toContain(key);
  });
});
