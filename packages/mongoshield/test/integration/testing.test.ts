// Integration tests for `mongoshield/testing`: snapshots put databases back exactly
// (documents, indexes, options, views), drop what tests created, leave excluded
// namespaces alone, and `useMongoSnapshot` snapshots on the first reset. Also
// measures how long a reset of 10 collections × 1000 documents takes.

import { type Document, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../../src/errors.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { createDatabaseSnapshot, useMongoSnapshot } from "../../src/testing/index.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** Test documents use numbers as _id (the driver assumes ObjectId otherwise). */
interface Item {
  _id: number;
  [field: string]: unknown;
}

/** Everything a reset must restore: names, options, indexes and documents. */
async function describeDatabase(mongo: MongoClient, database: string): Promise<Document> {
  const db = mongo.db(database);
  const infos = await db.listCollections().toArray();
  const state: Document = {};
  for (const info of infos.sort((left, right) => left.name.localeCompare(right.name))) {
    if (info.name.startsWith("system.")) continue;
    const entry: Document = { type: info.type, options: "options" in info ? info.options : {} };
    if (info.type !== "view") {
      const collection = db.collection<Item>(info.name);
      entry.indexes = (await collection.listIndexes().toArray())
        .map((index) => ({ name: index.name, key: index.key, unique: index.unique }))
        .sort((left, right) => String(left.name).localeCompare(String(right.name)));
      entry.documents = await collection.find().sort({ _id: 1 }).toArray();
    }
    state[info.name] = entry;
  }
  return state;
}

/** The UUID of a collection, which changes when it is dropped and recreated. */
async function collectionUuid(mongo: MongoClient, database: string, name: string): Promise<string> {
  const [info] = await mongo.db(database).listCollections({ name }).toArray();
  return info && "info" in info ? String(info.info.uuid) : "";
}

/** A database with a validated collection, a unique index, a capped collection and a view. */
async function seed(mongo: MongoClient, database: string): Promise<void> {
  const db = mongo.db(database);
  await db.createCollection("users", {
    validator: { $jsonSchema: { required: ["name"] } },
  });
  await db.collection<Item>("users").insertMany([
    { _id: 1, name: "Ada" },
    { _id: 2, name: "Grace" },
  ]);
  await db.collection("users").createIndex({ name: 1 }, { unique: true });
  await db.createCollection("log", { capped: true, size: 4096 });
  await db.collection<Item>("log").insertOne({ _id: 1, line: "start" });
  await db.createCollection("names", { viewOn: "users", pipeline: [{ $project: { name: 1 } }] });
}

/** Changes everything a test might change. */
async function mutate(mongo: MongoClient, database: string): Promise<void> {
  const db = mongo.db(database);
  await db.collection<Item>("users").deleteOne({ _id: 1 });
  await db.collection<Item>("users").updateOne({ _id: 2 }, { $set: { name: "Changed" } });
  await db.collection<Item>("users").insertOne({ _id: 3, name: "New" });
  await db.collection("users").createIndex({ extra: 1 });
  await db.collection("log").drop();
  await db.collection<Item>("created_by_test").insertOne({ _id: 1 });
  await db.createCollection("view_by_test", { viewOn: "created_by_test", pipeline: [] });
}

describe("createDatabaseSnapshot", () => {
  it("restores documents, indexes, options and views, and drops what was created", async () => {
    const database = uniqueDb("snap");
    await seed(client(), database);
    const before = await describeDatabase(client(), database);

    const snapshot = await createDatabaseSnapshot(client(), { databases: [database] });
    expect(snapshot.namespaces).toEqual([
      `${database}.log`,
      `${database}.names`,
      `${database}.users`,
    ]);
    await mutate(client(), database);
    await snapshot.restore();
    expect(await describeDatabase(client(), database)).toEqual(before);

    // Restoring is repeatable.
    await mutate(client(), database);
    await snapshot.restore();
    expect(await describeDatabase(client(), database)).toEqual(before);
    await snapshot.dispose();
  });

  it("restores documents exactly when only data changed (no collection is recreated)", async () => {
    const database = uniqueDb("snap");
    await seed(client(), database);
    const before = await describeDatabase(client(), database);
    const snapshot = await createDatabaseSnapshot(client(), { databases: [database] });
    const uuidBefore = await collectionUuid(client(), database, "users");

    await client().db(database).collection<Item>("users").deleteOne({ _id: 1 });
    await client()
      .db(database)
      .collection<Item>("users")
      .updateOne({ _id: 2 }, { $set: { age: 3 } });
    await snapshot.restore();

    expect(await describeDatabase(client(), database)).toEqual(before);
    // Same collection (same UUID): documents were reloaded, not the collection rebuilt.
    expect(await collectionUuid(client(), database, "users")).toEqual(uuidBefore);
  });

  it("snapshots an empty database, whose restore drops everything created later", async () => {
    const database = uniqueDb("snap");
    const snapshot = await createDatabaseSnapshot(client(), { databases: [database] });
    expect(snapshot.namespaces).toEqual([]);
    await client().db(database).collection<Item>("scratch").insertOne({ _id: 1 });
    await snapshot.restore();
    expect(await describeDatabase(client(), database)).toEqual({});
  });

  it("leaves excluded and unrelated namespaces alone", async () => {
    const database = uniqueDb("snap");
    const other = uniqueDb("other");
    await seed(client(), database);
    await client().db(other).collection<Item>("keep").insertOne({ _id: 1 });

    const snapshot = await createDatabaseSnapshot(client(), {
      include: [`${database}.*`],
      exclude: [`${database}.log`],
    });
    await client().db(database).collection<Item>("log").insertOne({ _id: 2, line: "kept" });
    await client().db(other).collection<Item>("keep").insertOne({ _id: 2 });
    await snapshot.restore();

    expect(await client().db(database).collection("log").countDocuments()).toBe(2);
    expect(await client().db(other).collection("keep").countDocuments()).toBe(2);
  });

  it("frees its storage on dispose and refuses to restore afterwards", async () => {
    const database = uniqueDb("snap");
    await seed(client(), database);
    const storage = memoryStorage();
    const snapshot = await createDatabaseSnapshot(client(), { databases: [database], storage });
    expect(storage.keys().length).toBeGreaterThan(0);
    await snapshot.dispose();
    expect(storage.keys()).toEqual([]);
    await expect(snapshot.restore()).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
  });

  it("needs databases or patterns, and refuses MongoDB's own databases", async () => {
    for (const options of [{}, { databases: ["admin"] }]) {
      const error = await createDatabaseSnapshot(client(), options).catch(
        (caught: unknown) => caught,
      );
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    }
  });

  it("works with a standalone mongodb-memory-server", async () => {
    const server = await MongoMemoryServer.create();
    const standalone = await MongoClient.connect(server.getUri());
    try {
      await seed(standalone, "app_test");
      const before = await describeDatabase(standalone, "app_test");
      const snapshot = await createDatabaseSnapshot(standalone, { databases: ["app_test"] });
      await mutate(standalone, "app_test");
      await snapshot.restore();
      expect(await describeDatabase(standalone, "app_test")).toEqual(before);
    } finally {
      await standalone.close();
      await server.stop();
    }
  });
});

describe("useMongoSnapshot", () => {
  it("snapshots on the first reset and restores on every later one", async () => {
    const database = uniqueDb("use");
    const db = useMongoSnapshot(() => client(), { databases: [database] });
    await client().db(database).collection<Item>("items").insertOne({ _id: 1 });

    await db.reset(); // takes the snapshot: { _id: 1 }
    await client().db(database).collection<Item>("items").insertOne({ _id: 2 });
    await db.reset();
    expect(await client().db(database).collection("items").countDocuments()).toBe(1);

    // snapshot() replaces the baseline.
    await client().db(database).collection<Item>("items").insertOne({ _id: 3 });
    await db.snapshot();
    await client().db(database).collection<Item>("items").deleteMany({});
    await db.reset();
    expect(await client().db(database).collection("items").countDocuments()).toBe(2);
    await db.dispose();
  });

  it("resets 10 collections × 1000 documents quickly", async ({ annotate }) => {
    const database = uniqueDb("bench");
    const names = Array.from({ length: 10 }, (_, index) => `c${index}`);
    for (const name of names) {
      const documents = Array.from({ length: 1000 }, (_, index) => ({
        _id: index,
        name: `item ${index}`,
        price: index * 1.5,
        tags: ["a", "b"],
        createdAt: new Date(1_700_000_000_000 + index),
      }));
      await client().db(database).collection<Item>(name).insertMany(documents);
      await client().db(database).collection(name).createIndex({ name: 1 });
    }
    const db = useMongoSnapshot(client(), { databases: [database] });

    /** Median time of 5 resets, each after `change` modified the database. */
    async function medianReset(change: () => Promise<unknown>): Promise<number> {
      const timings: number[] = [];
      for (let round = 0; round < 5; round++) {
        await change();
        const start = performance.now();
        await db.reset();
        timings.push(performance.now() - start);
      }
      return [...timings].sort((left, right) => left - right)[2] ?? 0;
    }
    const collection = (name: string) => client().db(database).collection<Item>(name);

    const snapshotStart = performance.now();
    await db.reset();
    const snapshotMs = performance.now() - snapshotStart;
    const unchanged = await medianReset(async () => undefined);
    const oneCollection = await medianReset(() =>
      collection("c0").deleteMany({ _id: { $lt: 500 } }),
    );
    const everyCollection = await medianReset(() =>
      Promise.all(
        names.map((name) =>
          client()
            .db(database)
            .collection(name)
            .updateMany({}, { $inc: { price: 1 } }),
        ),
      ),
    );
    const newIndexes = await medianReset(() =>
      Promise.all(names.map((name) => collection(name).createIndex({ price: 1 }))),
    );

    for (const name of names) {
      expect(await collection(name).countDocuments({ price: { $gte: 1498.5 } })).toBe(1);
      expect(await collection(name).listIndexes().toArray()).toHaveLength(2);
    }
    await annotate(
      [
        `snapshot ${snapshotMs.toFixed(0)} ms`,
        `reset, nothing changed ${unchanged.toFixed(0)} ms`,
        `1 collection's documents changed ${oneCollection.toFixed(0)} ms`,
        `all 10 collections' documents changed ${everyCollection.toFixed(0)} ms`,
        `an index added to all 10 ${newIndexes.toFixed(0)} ms`,
      ].join("; "),
    );
    // Generous bounds: the point is "fast enough for beforeEach", not a benchmark.
    expect(oneCollection).toBeLessThan(2000);
    expect(newIndexes).toBeLessThan(5000);
    await db.dispose();
  });
});
