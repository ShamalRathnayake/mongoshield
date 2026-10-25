// Integration tests for restore modes (fail-if-exists, drop, insert, upsert),
// conflicts, dry runs, rename, include/exclude, concurrency options and progress.

import type { Document, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { planRestore, runRestore } from "../../src/engine/restore.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { ProgressEvent, RestoreOptions } from "../../src/types.ts";
import { writeTestBackup } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** Test documents use numbers, strings and dates as _id, not only ObjectIds. */
interface TestDocument {
  _id?: number | string | Date | ObjectId;
  [field: string]: unknown;
}

const users = [
  { _id: 1, name: "Ada", email: "ada@example.com" },
  { _id: 2, name: "Grace", email: "grace@example.com" },
  { _id: 3, name: "Linus", email: "linus@example.com" },
];
const orders = Array.from({ length: 2500 }, (_, index) => ({ _id: index, total: index * 2 }));

/** A backup of database `app` with two collections and a view on one of them. */
async function appBackup(): Promise<MemoryStorage> {
  const storage = memoryStorage();
  await writeTestBackup(storage, {
    namespaces: [
      {
        ns: "app.users",
        documents: users,
        indexes: [
          { v: 2, key: { _id: 1 }, name: "_id_" },
          { v: 2, key: { email: 1 }, name: "email_1", unique: true },
        ],
      },
      { ns: "app.orders", documents: orders, documentsPerPart: 1000 },
      {
        ns: "app.big_orders",
        type: "view",
        options: { viewOn: "orders", pipeline: [{ $match: { total: { $gte: 4990 } } }] },
      },
    ],
  });
  return storage;
}

/** Restores `app.*` into `target`, with extra options. */
function restore(storage: MemoryStorage, target: string, options: Partial<RestoreOptions> = {}) {
  return runRestore(
    { client: client(), storage, logger: silentLogger },
    { backup: "latest", rename: { "app.*": `${target}.*` }, ...options },
  );
}

async function documentsOf(database: string, collection: string): Promise<Document[]> {
  return client()
    .db(database)
    .collection<TestDocument>(collection)
    .find()
    .sort({ _id: 1 })
    .toArray();
}

/** Collection and view names, without the server's own `system.*` collections. */
async function collectionNames(database: string): Promise<string[]> {
  const infos = await client().db(database).listCollections().toArray();
  return infos
    .map((info) => info.name)
    .filter((name) => !name.startsWith("system."))
    .sort();
}

async function databaseExists(database: string): Promise<boolean> {
  const collections = await client().db(database).listCollections().toArray();
  return collections.length > 0;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error,
  );
}

describe("fail-if-exists (the default)", () => {
  it("restores into a fresh database and reports the plan", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    const result = await restore(storage, target, { parallelism: 2, insertWorkers: 3 });

    expect(result.plan.mode).toBe("fail-if-exists");
    expect(result.documentsRestored).toBe(2503);
    expect(result.plan.entries).toContainEqual({
      from: "app.orders",
      to: `${target}.orders`,
      type: "collection",
      documents: 2500,
      action: "create",
      existingDocuments: 0,
    });
    expect(await documentsOf(target, "users")).toEqual(users);
    expect(await client().db(target).collection<TestDocument>("orders").countDocuments()).toBe(
      2500,
    );
    expect(await client().db(target).collection<TestDocument>("big_orders").countDocuments()).toBe(
      5,
    );
    const indexNames = (await client().db(target).collection<TestDocument>("users").indexes()).map(
      (index) => index.name,
    );
    expect(indexNames.sort()).toEqual(["_id_", "email_1"]);
  });

  it("refuses non-empty targets, lists them, and writes nothing", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    await client()
      .db(target)
      .collection<TestDocument>("users")
      .insertOne({ _id: 99, name: "existing" });
    await client().db(target).createCollection("big_orders", { viewOn: "x", pipeline: [] });

    const error = await caught(restore(storage, target));
    expect(isMongoShieldError(error, "MS_RESTORE_CONFLICT")).toBe(true);
    if (!isMongoShieldError(error)) return;
    expect(error.message).toContain(`${target}.users: it already holds 1 documents`);
    expect(error.message).toContain(`${target}.big_orders: a view with this name already exists`);
    expect(error.hint).toMatch(/--drop.*--mode insert.*--rename/);
    // Nothing was created: not even the non-conflicting orders collection.
    expect(await collectionNames(target)).toEqual(["big_orders", "users"]);
  });

  it("refuses conflicts in a dry run and in planRestore too", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    await client().db(target).collection<TestDocument>("orders").insertOne({ _id: "existing" });
    const error = await caught(restore(storage, target, { dryRun: true }));
    expect(isMongoShieldError(error, "MS_RESTORE_CONFLICT")).toBe(true);
    // Planning never throws for conflicts: it reports them so they can be shown.
    const plan = await planRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: "latest", rename: { "app.*": `${target}.*` } },
    );
    const conflicts = plan.entries.filter((entry) => entry.action === "conflict");
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]?.reason).toBeTypeOf("string");
  });

  it("restores into an existing empty collection", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    await client().db(target).createCollection("users");
    const result = await restore(storage, target);
    expect(result.plan.entries.find((entry) => entry.from === "app.users")?.action).toBe("insert");
    expect(await documentsOf(target, "users")).toEqual(users);
  });
});

describe("dry run", () => {
  it("returns the plan without writing anything", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    const result = await restore(storage, target, { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, documentsRestored: 0 });
    expect(result.plan.entries).toHaveLength(3);
    expect(await databaseExists(target)).toBe(false);
  });
});

describe("drop", () => {
  it("replaces existing collections and views with the backed-up ones", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    const db = client().db(target);
    await db.createCollection("users", { capped: true, size: 4096 });
    await db.collection<TestDocument>("users").insertMany([
      { _id: 1, name: "old" },
      { _id: 50, name: "extra" },
    ]);
    await db.createCollection("big_orders", { viewOn: "users", pipeline: [] });

    const result = await restore(storage, target, { mode: "drop" });
    const users_ = result.plan.entries.find((entry) => entry.from === "app.users");
    expect(users_).toMatchObject({ action: "drop-and-create", existingDocuments: 2 });
    expect(await documentsOf(target, "users")).toEqual(users);
    // The old capped options are gone with the old collection.
    expect(await db.collection<TestDocument>("users").isCapped()).toBe(false);
    expect(await db.collection<TestDocument>("big_orders").countDocuments()).toBe(5);
  });
});

describe("insert", () => {
  it("keeps existing documents and skips backed-up duplicates", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    await client()
      .db(target)
      .collection<TestDocument>("users")
      .insertMany([
        { _id: 1, name: "changed", email: "changed@example.com" },
        { _id: 77, name: "only in target", email: "t@example.com" },
      ]);
    await client().db(target).createCollection("big_orders", { viewOn: "users", pipeline: [] });

    const result = await restore(storage, target, { mode: "insert" });
    expect(result.plan.entries.find((entry) => entry.from === "app.big_orders")?.action).toBe(
      "skip",
    );
    // 2 new users + 2500 orders; user 1 was a duplicate.
    expect(result.documentsRestored).toBe(2502);
    const restored = await documentsOf(target, "users");
    expect(restored.map((user) => [user._id, user.name])).toEqual([
      [1, "changed"],
      [2, "Grace"],
      [3, "Linus"],
      [77, "only in target"],
    ]);
  });
});

describe("upsert", () => {
  it("replaces documents with the same _id and keeps the others", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    await client()
      .db(target)
      .collection<TestDocument>("users")
      .insertMany([
        { _id: 1, name: "changed", extra: true },
        { _id: 77, name: "only in target", email: "t@example.com" },
      ]);

    const result = await restore(storage, target, { mode: "upsert" });
    expect(result.plan.entries.find((entry) => entry.from === "app.users")).toMatchObject({
      action: "upsert",
      existingDocuments: 2,
    });
    expect(result.documentsRestored).toBe(2503);
    const restored = await documentsOf(target, "users");
    expect(restored).toEqual([
      ...users,
      { _id: 77, name: "only in target", email: "t@example.com" },
    ]);
  });
});

describe("rename, include and exclude", () => {
  it("renames one collection exactly and points the view at it", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    const result = await runRestore(
      { client: client(), storage, logger: silentLogger },
      {
        backup: "latest",
        rename: { "app.*": `${target}.*`, "app.orders": `${target}.orders_2025` },
      },
    );
    expect(result.plan.entries.map((entry) => entry.to).sort()).toEqual(
      [`${target}.big_orders`, `${target}.orders_2025`, `${target}.users`].sort(),
    );
    const views = await client().db(target).listCollections({ name: "big_orders" }).toArray();
    expect(views[0]).toMatchObject({ options: { viewOn: "orders_2025" } });
    expect(await client().db(target).collection<TestDocument>("big_orders").countDocuments()).toBe(
      5,
    );
  });

  it("restores only the included namespaces, minus the excluded ones", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    const result = await restore(storage, target, {
      include: ["app.*"],
      exclude: ["app.orders", "app.big_*"],
    });
    expect(result.plan.entries.map((entry) => entry.from)).toEqual(["app.users"]);
    expect(await collectionNames(target)).toEqual(["users"]);
  });

  it("rejects patterns that match nothing", async () => {
    const storage = await appBackup();
    const error = await caught(restore(storage, uniqueDb("rm"), { include: ["nope.*"] }));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });

  it("rejects rename rules that send two namespaces to one target", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    const error = await caught(
      runRestore(
        { client: client(), storage, logger: silentLogger },
        {
          backup: "latest",
          rename: { "app.users": `${target}.x`, "app.orders": `${target}.x` },
        },
      ),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(await databaseExists(target)).toBe(false);
  });
});

describe("options", () => {
  it("rejects invalid concurrency settings", async () => {
    const storage = await appBackup();
    for (const options of [{ parallelism: 0 }, { insertWorkers: 1.5 }]) {
      const error = await caught(restore(storage, uniqueDb("rm"), options));
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    }
  });

  it("applies the write concern", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    const result = await restore(storage, target, {
      writeConcern: { w: "majority", journal: true },
    });
    expect(result.documentsRestored).toBe(2503);
  });

  it("skips indexes when asked", async () => {
    const storage = await appBackup();
    const target = uniqueDb("rm");
    await restore(storage, target, { skipIndexes: true });
    const indexNames = (await client().db(target).collection<TestDocument>("users").indexes()).map(
      (index) => index.name,
    );
    expect(indexNames).toEqual(["_id_"]);
  });

  it("reports progress for every namespace", async () => {
    const storage = await appBackup();
    const events: ProgressEvent[] = [];
    await restore(storage, uniqueDb("rm"), { onProgress: (event) => events.push(event) });
    const done = events.filter((event) => event.type === "namespace:done");
    expect(done).toHaveLength(3);
    expect(done.find((event) => event.ns.endsWith(".orders"))).toMatchObject({ documents: 2500 });
    expect(events.at(-1)).toMatchObject({ type: "overall", documents: 2503, etaMs: 0 });
  });
});
