// Index changes made while a converge backup runs (and after a journal's base backup)
// must come back: collections created during the window get their indexes, indexes
// created or dropped on backed-up collections during the window are applied after the
// dumped ones, a collection dropped and recreated gets only its new indexes, and
// `skipIndexes` leaves all of it out. Writes are injected while a data file is being
// written (see `hookedStorage`), so they always fall inside the window.

import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { applyIndexChanges } from "../../src/engine/converge-indexes.ts";
import { readClusterTime } from "../../src/engine/converge-time.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { planPointInTimeRestore, replayJournal } from "../../src/journal/index.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { RestoreOptions } from "../../src/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import {
  collectionNames,
  firstDifference,
  hookedStorage,
  indexDefinitions,
  isDataFileOf,
  rawDocuments,
} from "./converge-test-utils.ts";
import { startTestJournal, waitForJournalToCatchUp } from "./journal-test-utils.ts";

interface TestDocument {
  _id: number | string;
  n?: number;
  email?: string;
  text?: string;
  [field: string]: unknown;
}

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

function newDatabase(prefix: string): string {
  const name = uniqueDb(prefix);
  databases.push(name);
  return name;
}

async function seed(database: string, collection: string, count: number): Promise<void> {
  await client()
    .db(database)
    .collection<TestDocument>(collection)
    .insertMany(
      Array.from({ length: count }, (_, n) => ({ _id: n, n, email: `u${n}@example.com` })),
    );
}

/** A converge backup of `database.*`, one collection at a time (name order). */
async function backup(storage: MemoryStorage, database: string) {
  const result = await runBackup(backupContext(client(), storage), {
    include: [`${database}.*`],
    consistency: "converge",
    parallelism: 1,
  });
  if (result.status !== "complete") throw new Error("expected a complete backup");
  return result.manifest;
}

function restore(storage: MemoryStorage, options: RestoreOptions) {
  return runRestore({ client: client(), storage, logger: silentLogger }, options);
}

/** Expects every collection of `target` to have the documents and indexes of `source`. */
async function expectSameCollectionsAndIndexes(source: string, target: string): Promise<void> {
  const names = await collectionNames(client(), source);
  expect(await collectionNames(client(), target)).toEqual(names);
  for (const name of names) {
    const expected = await rawDocuments(client(), source, name);
    const actual = await rawDocuments(client(), target, name);
    expect(firstDifference(expected, actual), `${target}.${name}`).toBeUndefined();
    expect(await indexDefinitions(client(), target, name), `indexes of ${target}.${name}`).toEqual(
      await indexDefinitions(client(), source, name),
    );
  }
}

/** Index changes on every kind of collection, made once `b`'s data file is written. */
async function changeIndexes(database: string): Promise<void> {
  const db = client().db(database);
  // Created during the window, with options: restored only from its events.
  await db.createCollection("fresh", { collation: { locale: "fr", strength: 2 } });
  await db.collection<TestDocument>("fresh").insertMany([
    { _id: 1, email: "a@example.com", text: "bonjour" },
    { _id: 2, email: "b@example.com", text: "salut" },
  ]);
  await db.collection("fresh").createIndex({ email: 1 }, { unique: true, name: "email_unique" });
  // A text index cannot use the collection's collation: it is created with "simple".
  await db
    .collection("fresh")
    .createIndex({ text: "text" }, { collation: { locale: "simple" }, name: "text_simple" });
  await db.collection("fresh").createIndex({ n: -1 }, { sparse: true });
  await db.collection("fresh").dropIndex("n_-1");
  // `a` is dumped already: its dumped metadata has neither change.
  await db.collection("a").createIndex({ email: 1 }, { unique: true });
  await db.collection("a").dropIndex("n_1");
  // `c` is dumped later: its dumped metadata already has the index (an identical create).
  await db.collection("c").createIndex({ n: 1, email: -1 }, { name: "compound" });
  // `b` is dumped already, then dropped and recreated with other indexes.
  await db.collection("b").drop();
  await db.collection<TestDocument>("b").insertOne({ _id: "again", n: 7 });
  await db.collection("b").createIndex({ email: 1 }, { name: "b_new" });
}

describe("index changes during a converge backup", () => {
  it("restores the indexes created and dropped while the backup ran", async () => {
    const source = newDatabase("cvi_src");
    const target = newDatabase("cvi_dst");
    for (const name of ["a", "b", "c"]) await seed(source, name, 30);
    await client().db(source).collection("a").createIndex({ n: 1 });
    await client().db(source).collection("b").createIndex({ n: 1 }, { name: "b_old" });

    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (changed || !isDataFileOf(key, "c")) return;
      changed = true;
      await changeIndexes(source);
    });
    const manifest = await backup(storage, source);
    expect(changed).toBe(true);

    await restore(storage, { backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } });
    await expectSameCollectionsAndIndexes(source, target);
  });

  it("leaves the window's index changes out with skipIndexes", async () => {
    const source = newDatabase("cvi_skip");
    const target = newDatabase("cvi_skip_dst");
    for (const name of ["a", "b", "c"]) await seed(source, name, 10);
    await client().db(source).collection("a").createIndex({ n: 1 });
    await client().db(source).collection("b").createIndex({ n: 1 }, { name: "b_old" });

    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (changed || !isDataFileOf(key, "c")) return;
      changed = true;
      await changeIndexes(source);
    });
    const manifest = await backup(storage, source);

    await restore(storage, {
      backup: manifest.id,
      rename: { [`${source}.*`]: `${target}.*` },
      skipIndexes: true,
    });
    for (const name of await collectionNames(client(), target)) {
      const indexes = await client().db(target).collection(name).indexes();
      expect(
        indexes.map((index) => index.name),
        name,
      ).toEqual(["_id_"]);
    }
    expect(await collectionNames(client(), target)).toContain("fresh");
  });

  it("keeps the indexes a $out carries over its target", async () => {
    const source = newDatabase("cvi_out");
    const target = newDatabase("cvi_out_dst");
    await seed(source, "a", 20);
    await seed(source, "summary", 5);
    await client().db(source).collection("summary").createIndex({ email: 1 }, { unique: true });

    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (changed || !isDataFileOf(key, "summary")) return;
      changed = true;
      await client()
        .db(source)
        .collection("a")
        .aggregate([{ $match: { n: { $lt: 10 } } }, { $out: "summary" }])
        .toArray();
    });
    const manifest = await backup(storage, source);
    await restore(storage, { backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } });
    await expectSameCollectionsAndIndexes(source, target);
  });
});

describe("index changes after a journal's base backup", () => {
  it("restores the indexes created and dropped after the base backup", async () => {
    const source = newDatabase("pitri_src");
    const target = newDatabase("pitri_dst");
    for (const name of ["a", "b", "c"]) await seed(source, name, 20);
    await client().db(source).collection("a").createIndex({ n: 1 });
    await client().db(source).collection("b").createIndex({ n: 1 }, { name: "b_old" });
    const storage = memoryStorage();

    const journal = await startTestJournal(client(), storage, source);
    try {
      await backup(storage, source);
      await changeIndexes(source);
      const at = await readClusterTime(client());
      await waitForJournalToCatchUp(client(), storage);

      const plan = await planPointInTimeRestore(storage, at);
      const rename = { [`${source}.*`]: `${target}.*` };
      await restore(storage, { backup: plan.baseBackupId, rename });
      const replayed = await replayJournal({
        client: client(),
        storage,
        from: plan.baseTime,
        to: plan.at,
        rename,
        baseNamespaces: plan.baseNamespaces,
      });
      expect(replayed.indexesCreated).toBeGreaterThanOrEqual(4);
      expect(replayed.indexesDropped).toBeGreaterThanOrEqual(1);
      await expectSameCollectionsAndIndexes(source, target);
    } finally {
      await journal.stop();
    }
  });

  it("leaves them out with skipIndexes", async () => {
    const source = newDatabase("pitri_skip");
    const target = newDatabase("pitri_skip_dst");
    await seed(source, "a", 5);
    const storage = memoryStorage();
    const journal = await startTestJournal(client(), storage, source);
    try {
      await backup(storage, source);
      await client().db(source).collection("a").createIndex({ email: 1 });
      const at = await readClusterTime(client());
      await waitForJournalToCatchUp(client(), storage);

      const plan = await planPointInTimeRestore(storage, at);
      const rename = { [`${source}.*`]: `${target}.*` };
      await restore(storage, { backup: plan.baseBackupId, rename });
      const replayed = await replayJournal({
        client: client(),
        storage,
        from: plan.baseTime,
        to: plan.at,
        rename,
        baseNamespaces: plan.baseNamespaces,
        skipIndexes: true,
      });
      expect(replayed.indexesCreated).toBe(0);
      expect(await indexDefinitions(client(), target, "a")).toEqual([
        '{"key":{"_id":1},"name":"_id_"}',
      ]);
    } finally {
      await journal.stop();
    }
  });
});

describe("applyIndexChanges", () => {
  const options = { writeConcern: undefined, logger: silentLogger };

  it("skips an index that conflicts with one the target has, and missing drops", async () => {
    const database = newDatabase("aic");
    const collection = client().db(database).collection("a");
    await collection.createIndex({ email: 1 }, { name: "mine" });
    const applied = await applyIndexChanges(
      client(),
      `${database}.a`,
      {
        reset: false,
        changes: [
          { kind: "create", spec: { key: { email: 1 }, name: "theirs" } },
          { kind: "create", spec: { key: { n: 1 }, name: "n_1" } },
          { kind: "drop", name: "never_existed" },
        ],
      },
      options,
    );
    expect(applied).toEqual({ created: 1, dropped: 0, conflicts: ["theirs"] });
    expect((await collection.indexes()).map((index) => index.name).sort()).toEqual([
      "_id_",
      "mine",
      "n_1",
    ]);
  });

  it("drops indexes and never recreates _id_", async () => {
    const database = newDatabase("aic_drop");
    const collection = client().db(database).collection("a");
    await collection.createIndex({ old: 1 });
    const applied = await applyIndexChanges(
      client(),
      `${database}.a`,
      {
        reset: false,
        changes: [
          { kind: "create", spec: { v: 2, key: { _id: 1 }, name: "_id_" } },
          { kind: "drop", name: "old_1" },
        ],
      },
      options,
    );
    expect(applied).toEqual({ created: 0, dropped: 1, conflicts: [] });
    expect((await collection.indexes()).map((index) => index.name)).toEqual(["_id_"]);
  });

  it("drops every index but _id first when the collection was recreated", async () => {
    const database = newDatabase("aic_reset");
    const collection = client().db(database).collection("a");
    await collection.createIndex({ old: 1 });
    const applied = await applyIndexChanges(
      client(),
      `${database}.a`,
      { reset: true, changes: [{ kind: "create", spec: { key: { fresh: 1 }, name: "fresh_1" } }] },
      options,
    );
    expect(applied.created).toBe(1);
    expect((await collection.indexes()).map((index) => index.name).sort()).toEqual([
      "_id_",
      "fresh_1",
    ]);
  });

  it("does nothing for a target that is missing or a view", async () => {
    const database = newDatabase("aic_none");
    await client().db(database).createCollection("source");
    await client().db(database).createCollection("view", { viewOn: "source", pipeline: [] });
    const plan = {
      reset: true,
      changes: [{ kind: "create" as const, spec: { key: { a: 1 }, name: "a_1" } }],
    };
    for (const name of ["missing", "view"]) {
      expect(await applyIndexChanges(client(), `${database}.${name}`, plan, options)).toEqual({
        created: 0,
        dropped: 0,
        conflicts: [],
      });
    }
  });

  it("fails with MS_RESTORE_FAILED when the server rejects an index", async () => {
    const database = newDatabase("aic_bad");
    await client().db(database).createCollection("a");
    const error = await applyIndexChanges(
      client(),
      `${database}.a`,
      { reset: false, changes: [{ kind: "create", spec: { key: { a: "bogus" }, name: "bad" } }] },
      options,
    ).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_RESTORE_FAILED")).toBe(true);
  });
});
