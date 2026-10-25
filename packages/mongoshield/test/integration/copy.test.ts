// Integration tests for the copy engine: collections, options, indexes and views copied
// with renames, modes and conflicts, dry runs, masking that keeps joins working, and
// subsets that follow references.

import { Collection, Decimal128, type Document, Int32, Long, MongoClient, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { runCopy } from "../../src/copy/copy.ts";
import type { CopyEngineOptions } from "../../src/copy/copy-plan.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { silentLogger } from "../../src/logger.ts";
import { defineMask } from "../../src/mask/index.ts";
import { MongoShield } from "../../src/shield.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { defineSubset, TEMP_COLLECTION_PREFIX } from "../../src/subset/index.ts";
import type { ProgressEvent } from "../../src/types.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** The driver's own `listSearchIndexes`, for collections a test does not stand in for. */
const realListSearchIndexes = Collection.prototype.listSearchIndexes;

const SECRET = "integration-test-secret-0123456789";

/** Copies within the test replica set (source and target are the same deployment). */
function copy(options: CopyEngineOptions) {
  return runCopy({ source: client(), target: client(), logger: silentLogger }, options);
}

/** Every document of a collection, sorted by `_id`. */
async function documentsOf(database: string, collection: string): Promise<Document[]> {
  return client().db(database).collection(collection).find().sort({ _id: 1 }).toArray();
}

async function collectionNames(database: string): Promise<string[]> {
  const infos = await client().db(database).listCollections().toArray();
  return infos
    .map((info) => info.name)
    .filter((name) => !name.startsWith("system."))
    .sort();
}

/** Test documents with Int32 ids (the driver's typings assume ObjectId otherwise). */
interface NumberedDocument {
  _id: Int32;
  [field: string]: unknown;
}

/** A small shop: users, orders referencing users, a validated, collated collection and a view. */
async function seedShop(database: string): Promise<void> {
  const db = client().db(database);
  await db.createCollection("users", {
    validator: { $jsonSchema: { bsonType: "object", required: ["email"] } },
    collation: { locale: "en", strength: 2 },
  });
  await db.collection<NumberedDocument>("users").insertMany([
    { _id: new Int32(1), email: "ada@corp.com", name: "Ada", age: new Int32(36), managerId: null },
    {
      _id: new Int32(2),
      email: "grace@corp.com",
      name: "Grace",
      age: new Int32(45),
      managerId: new Int32(1),
    },
    {
      _id: new Int32(3),
      email: "linus@corp.com",
      name: "Linus",
      age: new Int32(28),
      managerId: new Int32(2),
    },
    {
      _id: new Int32(4),
      email: "unused@corp.com",
      name: "Unused",
      age: new Int32(50),
      managerId: null,
    },
  ]);
  await db.collection("users").createIndex({ email: 1 }, { unique: true, name: "email_1" });
  await db.collection("orders").insertMany([
    {
      _id: new ObjectId(),
      userId: new Int32(3),
      total: Decimal128.fromString("19.99"),
      placedAt: new Date("2026-09-10"),
      qty: Long.fromNumber(2),
    },
    {
      _id: new ObjectId(),
      userId: new Int32(3),
      total: Decimal128.fromString("5.00"),
      placedAt: new Date("2026-09-12"),
      qty: Long.fromNumber(1),
    },
    {
      _id: new ObjectId(),
      userId: new Int32(4),
      total: Decimal128.fromString("7.50"),
      placedAt: new Date("2025-01-01"),
      qty: Long.fromNumber(3),
    },
  ]);
  await db.collection("orders").createIndex({ userId: 1, placedAt: -1 }, { name: "user_recent" });
  await db.createCollection("big_orders", {
    viewOn: "orders",
    pipeline: [{ $match: { qty: { $gte: 2 } } }],
  });
}

describe("copy", () => {
  it("copies collections with their options, documents, indexes and views under a new name", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);

    const result = await copy({
      include: [`${source}.*`],
      rename: { [`${source}.*`]: `${target}.*` },
    });

    expect(result.dryRun).toBe(false);
    expect(result.documentsCopied).toBe(7);
    expect(await collectionNames(target)).toEqual(["big_orders", "orders", "users"]);
    // Every BSON type survives (Int32 stays Int32, Decimal128 and Long too).
    expect(await documentsOf(target, "orders")).toEqual(await documentsOf(source, "orders"));
    expect(await documentsOf(target, "users")).toEqual(await documentsOf(source, "users"));

    const [users] = await client()
      .db(target)
      .listCollections({ name: "users" }, { nameOnly: false })
      .toArray();
    expect(users?.options).toMatchObject({ collation: { locale: "en", strength: 2 } });
    expect(users?.options?.validator).toBeDefined();
    const [view] = await client()
      .db(target)
      .listCollections({ name: "big_orders" }, { nameOnly: false })
      .toArray();
    expect(view?.options).toMatchObject({ viewOn: "orders" });
    expect(await client().db(target).collection("big_orders").countDocuments()).toBe(2);

    const indexes = await client().db(target).collection("users").listIndexes().toArray();
    expect(indexes.find((index) => index.name === "email_1")).toMatchObject({ unique: true });
    const orderIndexes = await client().db(target).collection("orders").listIndexes().toArray();
    expect(orderIndexes.map((index) => index.name)).toContain("user_recent");
  });

  it("writes nothing in a dry run but still plans every namespace", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);

    const result = await copy({
      include: [`${source}.*`],
      rename: { [`${source}.*`]: `${target}.*` },
      dryRun: true,
      mask: { secret: SECRET, rules: { [`${source}.users`]: { email: { fake: "email" } } } },
      subset: { filters: { [`${source}.orders`]: { qty: { $gte: 2 } } } },
    });

    expect(result).toMatchObject({ dryRun: true, documentsCopied: 0 });
    expect(result.plan.entries.map((entry) => [entry.from, entry.action, entry.subset])).toEqual([
      [`${source}.big_orders`, "create", "all"],
      [`${source}.orders`, "create", "filtered"],
      [`${source}.users`, "create", "all"],
    ]);
    expect(result.plan.entries.find((entry) => entry.from.endsWith(".users"))?.masked).toEqual([
      "email: fake:email",
    ]);
    expect(await collectionNames(target)).toEqual([]);
  });

  it("refuses to overwrite existing data by default and replaces it in drop mode", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);
    await client().db(target).collection("users").insertOne({ _id: new ObjectId(), stale: true });
    const options = { include: [`${source}.*`], rename: { [`${source}.*`]: `${target}.*` } };

    const conflict = await copy(options).catch((error: unknown) => error);
    expect(isMongoShieldError(conflict, "MS_RESTORE_CONFLICT")).toBe(true);
    expect(String(conflict)).toContain(`${target}.users: it already holds 1 documents`);
    expect(await collectionNames(target)).toEqual(["users"]);

    await copy({ ...options, mode: "drop" });
    expect(await documentsOf(target, "users")).toEqual(await documentsOf(source, "users"));
  });

  it("refuses to copy a namespace onto itself, even through a different client", async () => {
    const source = uniqueDb("src");
    await seedShop(source);
    const other = new MongoClient(mongoUri());
    try {
      const error = await runCopy(
        { source: client(), target: other, logger: silentLogger },
        { include: [`${source}.users`], mode: "drop" },
      ).catch((caught: unknown) => caught);
      expect(isMongoShieldError(error, "MS_RESTORE_CONFLICT")).toBe(true);
      expect(String(error)).toContain("it is the source itself");
    } finally {
      await other.close();
    }
    expect(await client().db(source).collection("users").countDocuments()).toBe(4);
  });

  it("reports progress per namespace", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);
    const events: ProgressEvent[] = [];
    await copy({
      include: [`${source}.orders`],
      rename: { [`${source}.*`]: `${target}.*` },
      onProgress: (event) => events.push(event),
    });
    expect(events).toContainEqual({ type: "namespace:done", ns: `${target}.orders`, documents: 3 });
  });
});

describe("copy with masking", () => {
  it("masks both sides of a reference identically, so joins still match after copying", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);

    const result = await copy({
      include: [`${source}.users`, `${source}.orders`],
      rename: { [`${source}.*`]: `${target}.*` },
      mask: defineMask({
        secret: SECRET,
        rules: {
          [`${source}.users`]: {
            _id: "hash",
            email: { fake: "email" },
            name: { fake: "name" },
            managerId: "hash",
          },
          [`${source}.orders`]: { userId: "hash", total: "null" },
        },
      }),
    });

    const users = await documentsOf(target, "users");
    const orders = await documentsOf(target, "orders");
    const sourceUsers = await documentsOf(source, "users");
    // Nothing identifying survives…
    const sourceIds = sourceUsers.map((user) => user._id);
    for (const user of users) {
      expect(sourceIds).not.toContain(user._id);
      expect(user.email).toMatch(/@example\.(com|net|org)$/);
    }
    expect(orders.every((order) => order.total === null)).toBe(true);
    // …but every order still points at its (masked) user, and managers at managers.
    const joined = await client()
      .db(target)
      .collection("orders")
      .aggregate([
        { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
      ])
      .toArray();
    expect(joined.every((order) => order.user.length === 1)).toBe(true);
    const managers = users.filter((user) => user.managerId !== null);
    for (const user of managers) {
      expect(users.some((candidate) => candidate._id === user.managerId)).toBe(true);
    }
    // Types survive: Int32 ids stay Int32 (the driver promotes them to numbers on read).
    const raw = await client().db(target).collection("users").findOne({}, { promoteValues: false });
    expect(raw?._id).toBeInstanceOf(Int32);
    // The unique index on the faked emails builds.
    const indexes = await client().db(target).collection("users").listIndexes().toArray();
    expect(indexes.map((index) => index.name)).toContain("email_1");

    expect(result.mask?.rules.find((rule) => rule.path === "email")).toMatchObject({ values: 4 });
  });

  it("produces the same masked values on every run with the same secret", async () => {
    const source = uniqueDb("src");
    await seedShop(source);
    const mask = {
      secret: SECRET,
      rules: { [`${source}.users`]: { email: { fake: "email" as const } } },
    };
    const first = uniqueDb("dst");
    const second = uniqueDb("dst");
    await copy({ include: [`${source}.users`], rename: { [`${source}.*`]: `${first}.*` }, mask });
    await copy({ include: [`${source}.users`], rename: { [`${source}.*`]: `${second}.*` }, mask });
    expect(await documentsOf(first, "users")).toEqual(await documentsOf(second, "users"));
  });
});

describe("copy with a subset", () => {
  it("copies the filtered documents and exactly the documents they reference, transitively", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);

    const result = await copy({
      include: [`${source}.users`, `${source}.orders`],
      rename: { [`${source}.*`]: `${target}.*` },
      subset: defineSubset({
        filters: { [`${source}.orders`]: { placedAt: { $gte: new Date("2026-09-01") } } },
        follow: [
          { from: `${source}.orders.userId`, to: `${source}.users._id` },
          // A self-reference: managers of copied users are copied too, all the way up.
          { from: `${source}.users.managerId`, to: `${source}.users._id` },
        ],
        batchSize: 1,
      }),
    });

    expect((await documentsOf(target, "orders")).map((order) => Number(order.userId))).toEqual([
      3, 3,
    ]);
    // Linus (3) placed the orders; Grace (2) manages Linus; Ada (1) manages Grace.
    expect((await documentsOf(target, "users")).map((user) => Number(user._id))).toEqual([1, 2, 3]);
    expect(result.documentsCopied).toBe(5);
    expect(result.plan.entries.find((entry) => entry.from.endsWith(".users"))?.subset).toBe(
      "referenced",
    );
    // The temporary reference collections are gone.
    const names = await collectionNames(target);
    expect(names.some((name) => name.startsWith(TEMP_COLLECTION_PREFIX))).toBe(false);
  });

  it("follows references by their source values when both sides are masked", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);

    await copy({
      include: [`${source}.users`, `${source}.orders`],
      rename: { [`${source}.*`]: `${target}.*` },
      mask: {
        secret: SECRET,
        rules: { "*.users": { _id: "hash" }, "*.orders": { userId: "hash" } },
      },
      subset: {
        filters: { [`${source}.orders`]: { qty: { $gte: 3 } } },
        follow: [{ from: `${source}.orders.userId`, to: `${source}.users._id` }],
      },
    });

    const users = await documentsOf(target, "users");
    const orders = await documentsOf(target, "orders");
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe("unused@corp.com");
    expect(orders.map((order) => order.userId)).toEqual([users[0]?._id]);
  });

  it("keeps filtered documents and adds referenced ones when a namespace has both", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);

    await copy({
      include: [`${source}.users`, `${source}.orders`],
      rename: { [`${source}.*`]: `${target}.*` },
      subset: {
        filters: {
          [`${source}.orders`]: { qty: { $gte: 3 } },
          [`${source}.users`]: { name: "Ada" },
        },
        follow: [{ from: `${source}.orders.userId`, to: `${source}.users._id` }],
      },
    });
    expect((await documentsOf(target, "users")).map((user) => user.name).sort()).toEqual([
      "Ada",
      "Unused",
    ]);
  });

  it("rejects subset rules that name namespaces not being copied", async () => {
    const source = uniqueDb("src");
    await seedShop(source);
    const error = await copy({
      include: [`${source}.orders`],
      rename: { [`${source}.*`]: `${uniqueDb("dst")}.*` },
      subset: { follow: [{ from: `${source}.orders.userId`, to: `${source}.users._id` }] },
    }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(error)).toContain("does not start with a copied namespace");
  });
});

describe("copy options", () => {
  it("merges into existing collections in insert and upsert modes", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);
    const options = {
      include: [`${source}.users`],
      rename: { [`${source}.*`]: `${target}.*` },
    };
    await client()
      .db(target)
      .collection<NumberedDocument>("users")
      .insertMany([
        { _id: new Int32(1), email: "kept@corp.com" },
        { _id: new Int32(99), email: "extra@corp.com" },
      ]);

    await copy({ ...options, mode: "insert" });
    const inserted = await documentsOf(target, "users");
    expect(inserted.map((user) => user.email)).toEqual([
      "kept@corp.com",
      "grace@corp.com",
      "linus@corp.com",
      "unused@corp.com",
      "extra@corp.com",
    ]);

    await copy({ ...options, mode: "upsert" });
    expect((await documentsOf(target, "users"))[0]?.email).toBe("ada@corp.com");
  });

  it("copies time series collections", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    const db = client().db(source);
    await db.createCollection("metrics", { timeseries: { timeField: "at", metaField: "host" } });
    await db.collection("metrics").insertMany([
      { at: new Date("2026-10-01"), host: "a", cpu: 1 },
      { at: new Date("2026-10-02"), host: "b", cpu: 2 },
    ]);
    await copy({ include: [`${source}.*`], rename: { [`${source}.*`]: `${target}.*` } });
    const [info] = await client()
      .db(target)
      .listCollections({ name: "metrics" }, { nameOnly: false })
      .toArray();
    expect(info?.type).toBe("timeseries");
    expect(await client().db(target).collection("metrics").countDocuments()).toBe(2);
  });

  it("skips secondary indexes with skipIndexes and reads with the requested read preference", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);
    await copy({
      include: [`${source}.users`],
      rename: { [`${source}.*`]: `${target}.*` },
      skipIndexes: true,
      readPreference: "primary",
    });
    const indexes = await client().db(target).collection("users").listIndexes().toArray();
    expect(indexes.map((index) => index.name)).toEqual(["_id_"]);
  });

  it("validates parallelism and stops when the signal has fired", async () => {
    const source = uniqueDb("src");
    await seedShop(source);
    const rename = { [`${source}.*`]: `${uniqueDb("dst")}.*` };
    await expect(copy({ include: [`${source}.*`], rename, parallelism: 0 })).rejects.toThrow(
      /parallelism must be a whole number/,
    );
    const aborted = await copy({
      include: [`${source}.*`],
      rename,
      signal: AbortSignal.abort(),
    }).catch((error: unknown) => error);
    expect(isMongoShieldError(aborted, "MS_ABORTED")).toBe(true);
  });

  it("refuses rename rules that send two namespaces to one target", async () => {
    const source = uniqueDb("src");
    await seedShop(source);
    await expect(
      copy({
        include: [`${source}.users`, `${source}.orders`],
        rename: { [`${source}.users`]: "x.y", [`${source}.orders`]: "x.y" },
      }),
    ).rejects.toThrow(/would be copied to x\.y/);
  });
});

describe("MongoShield.copy", () => {
  it("copies from the configured source into a target given by client", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);
    const shield = new MongoShield({ source: { client: client() }, storage: memoryStorage() });

    const result = await shield.copy({
      to: { client: client() },
      include: [`${source}.orders`],
      rename: { [`${source}.*`]: `${target}.*` },
    });
    expect(result.documentsCopied).toBe(3);
    expect(await documentsOf(target, "orders")).toHaveLength(3);
  });
});

describe("copy with a subset of a time series", () => {
  /** Hosts, and a time series of their measurements (`meta.host` holds the host's name). */
  async function seedMetrics(database: string): Promise<void> {
    const db = client().db(database);
    await db.collection("hosts").insertMany([
      { _id: new ObjectId(), name: "a" },
      { _id: new ObjectId(), name: "b" },
    ]);
    await db.createCollection("metrics", { timeseries: { timeField: "at", metaField: "meta" } });
    await db.collection("metrics").insertMany([
      { at: new Date("2026-10-01"), meta: { host: "a" }, cpu: 1 },
      { at: new Date("2026-10-02"), meta: { host: "a" }, cpu: 2 },
      { at: new Date("2026-10-03"), meta: { host: "b" }, cpu: 3 },
    ]);
  }

  it("refuses a time series that is both filtered and referenced (it would duplicate measurements)", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedMetrics(source);
    const error = await copy({
      include: [`${source}.*`],
      rename: { [`${source}.*`]: `${target}.*` },
      subset: {
        filters: { [`${source}.metrics`]: { cpu: { $gte: 2 } } },
        follow: [{ from: `${source}.hosts.name`, to: `${source}.metrics.meta.host` }],
      },
    }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(error)).toContain("has a filter AND is followed into");
    expect(await collectionNames(target)).toEqual([]);
  });

  it("copies each referenced measurement exactly once", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedMetrics(source);
    await copy({
      include: [`${source}.*`],
      rename: { [`${source}.*`]: `${target}.*` },
      subset: {
        filters: { [`${source}.hosts`]: { name: "a" } },
        follow: [{ from: `${source}.hosts.name`, to: `${source}.metrics.meta.host` }],
        batchSize: 1,
      },
    });
    const cpus = (await client().db(target).collection("metrics").find().toArray()).map(
      (measurement) => measurement.cpu,
    );
    expect(cpus.sort()).toEqual([1, 2]);
  });

  it("stops instead of duplicating a measurement that holds several referenced values", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    const db = client().db(source);
    await db.collection("hosts").insertMany([{ name: "a" }, { name: "b" }]);
    await db.createCollection("metrics", { timeseries: { timeField: "at", metaField: "meta" } });
    await db.collection("metrics").insertOne({ at: new Date(), meta: { hosts: ["a", "b"] } });
    const error = await copy({
      include: [`${source}.*`],
      rename: { [`${source}.*`]: `${target}.*` },
      subset: {
        follow: [{ from: `${source}.hosts.name`, to: `${source}.metrics.meta.hosts` }],
        batchSize: 1,
      },
    }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(error)).toContain("holds 2 values at the followed field meta.hosts");
  });
});

describe("copy and Atlas Search indexes", () => {
  it("carries the source's search index definitions to the target, reporting those the target cannot have", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedShop(source);
    // The local test server has no Atlas Search, so the SOURCE side's listing is
    // stood in for; the target is the real server, which refuses search indexes.
    const definitions = [
      {
        name: "default",
        type: "search",
        latestDefinition: { mappings: { dynamic: true } },
      },
    ];
    const listing = vi
      .spyOn(Collection.prototype, "listSearchIndexes")
      .mockImplementation(function (this: Collection) {
        const fromSource = this.dbName === source && this.collectionName === "users";
        if (!fromSource) return Reflect.apply(realListSearchIndexes, this, []);
        return { toArray: async () => definitions } as never;
      });
    try {
      const result = await copy({
        include: [`${source}.users`],
        rename: { [`${source}.*`]: `${target}.*` },
      });
      expect(result.searchIndexes).toEqual({
        created: [],
        notCreated: [{ ns: `${target}.users`, name: "default" }],
      });
      const skipped = await copy({
        include: [`${source}.users`],
        rename: { [`${source}.*`]: `${uniqueDb("dst")}.*` },
        skipSearchIndexes: true,
      });
      expect(skipped.searchIndexes).toBeUndefined();

      // A target with Atlas Search (stood in for too) gets the definitions.
      const atlas = uniqueDb("dst");
      listing.mockImplementation(function (this: Collection) {
        if (this.dbName === atlas) return { toArray: async () => [] } as never;
        const fromSource = this.dbName === source && this.collectionName === "users";
        if (!fromSource) return Reflect.apply(realListSearchIndexes, this, []);
        return { toArray: async () => definitions } as never;
      });
      const created: unknown[] = [];
      const creating = vi
        .spyOn(Collection.prototype, "createSearchIndexes")
        .mockImplementation(async (descriptions) => {
          created.push(...descriptions);
          return descriptions.map((description) => String(description.name));
        });
      try {
        const onAtlas = await copy({
          include: [`${source}.users`],
          rename: { [`${source}.*`]: `${atlas}.*` },
        });
        expect(onAtlas.searchIndexes?.created).toEqual([{ ns: `${atlas}.users`, name: "default" }]);
        expect(created).toEqual([
          { name: "default", type: "search", definition: { mappings: { dynamic: true } } },
        ]);
      } finally {
        creating.mockRestore();
      }
    } finally {
      listing.mockRestore();
    }
  });
});
