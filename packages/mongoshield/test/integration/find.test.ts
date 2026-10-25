// Integration tests for `find` over a backup (findInBackup) and single-document
// restore (restoreDocuments): results equal the server's own find(), streaming stops
// at the limit, encrypted multi-part backups work, and every restore mode, dry run
// and target rule does what the docs say.

import {
  BSON,
  Decimal128,
  type Document,
  Double,
  Int32,
  Long,
  type MongoClient,
  ObjectId,
} from "mongodb";
import { describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { findInBackup } from "../../src/engine/find.ts";
import { type RestoreDocumentsOptions, restoreDocuments } from "../../src/engine/find-restore.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { silentLogger } from "../../src/logger.ts";
import { MongoShield } from "../../src/shield.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { backupDatabaseForTest, writeTestBackup } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** 300 users with a mix of types, nested documents and arrays. */
function sampleUsers(): Document[] {
  return Array.from({ length: 300 }, (_, index) => ({
    _id: new ObjectId(index.toString(16).padStart(24, "0")),
    n: new Int32(index),
    name: `user${index}`,
    email: `user${index}@${index % 3 === 0 ? "example.com" : "test.org"}`,
    score: index % 2 === 0 ? new Double(index / 2) : Long.fromNumber(index),
    balance: Decimal128.fromString(`${index}.25`),
    tags: index % 5 === 0 ? ["vip", "early"] : ["regular"],
    address: { city: ["Oslo", "Lima", "Kyiv"][index % 3], zip: index % 7 },
    orders: Array.from({ length: index % 4 }, (_unused, order) => ({
      sku: `s${order}`,
      qty: order,
    })),
    ...(index % 10 === 0 ? { deletedAt: new Date(1_700_000_000_000 + index) } : {}),
  }));
}

/** Seeds `<db>.users`, backs it up (with options), and returns db name and storage. */
async function seededBackup(
  options: { documentsPerPart?: number; recipients?: string[] } = {},
): Promise<{ database: string; storage: MemoryStorage }> {
  const database = uniqueDb("find");
  const storage = memoryStorage();
  const users = client().db(database).collection("users");
  await users.insertMany(sampleUsers());
  await users.createIndex({ email: 1 }, { unique: true });
  await client()
    .db(database)
    .createCollection("active", {
      viewOn: "users",
      pipeline: [{ $match: { deletedAt: { $exists: false } } }],
    });
  if (options.documentsPerPart === undefined && options.recipients === undefined) {
    await backupDatabaseForTest(client(), storage, { include: [`${database}.*`] });
  } else {
    // Same documents, but split into parts and/or encrypted.
    const raw = await client().db(database).collection("users").find({}, { raw: true }).toArray();
    await writeTestBackup(storage, {
      namespaces: [
        {
          ns: `${database}.users`,
          rawDocuments: raw.map((bytes) => bytes as unknown as Uint8Array),
          ...(options.documentsPerPart ? { documentsPerPart: options.documentsPerPart } : {}),
        },
      ],
      ...(options.recipients ? { recipients: options.recipients } : {}),
    });
  }
  return { database, storage };
}

function context(storage: MemoryStorage, mongo: MongoClient = client()) {
  return { client: mongo, storage, logger: silentLogger };
}

async function collect(iterable: AsyncIterable<Document>): Promise<Document[]> {
  const documents: Document[] = [];
  for await (const document of iterable) documents.push(document);
  return documents;
}

/** Canonical EJSON of documents, so types (Int32 vs Double, …) are part of the comparison. */
function canonical(documents: readonly Document[]): string {
  return BSON.EJSON.stringify(documents, { relaxed: false });
}

/** Raw server results in natural (backup) order, deserialized like backup documents. */
async function serverFind(database: string, filter: Document): Promise<Document[]> {
  const raw = await client()
    .db(database)
    .collection("users")
    .find(filter, { raw: true, hint: { $natural: 1 } })
    .toArray();
  return raw.map((bytes) =>
    BSON.deserialize(bytes as unknown as Uint8Array, {
      promoteValues: false,
      promoteLongs: false,
      promoteBuffers: false,
      bsonRegExp: true,
    }),
  );
}

const FILTERS: readonly Document[] = [
  {},
  { name: "user42" },
  { _id: new ObjectId((7).toString(16).padStart(24, "0")) },
  { "address.city": "Oslo", n: { $gte: 100, $lt: 200 } },
  { email: /@example\.com$/ },
  { tags: "vip" },
  { score: { $gt: 100.5 } },
  { balance: { $lte: Decimal128.fromString("10.25") } },
  { deletedAt: { $exists: true } },
  { orders: { $size: 2 } },
  { orders: { $elemMatch: { sku: "s1", qty: { $gte: 1 } } } },
  { "orders.sku": { $in: ["s2", "s9"] } },
  { $or: [{ n: 1 }, { "address.zip": 6 }], tags: { $nin: ["vip"] } },
  { score: { $type: "long" } },
  { name: { $not: /^user1/ } },
];

describe("findInBackup", () => {
  it("returns exactly what collection.find returns, with types preserved", async () => {
    const { database, storage } = await seededBackup();
    for (const filter of FILTERS) {
      const found = await collect(
        findInBackup(context(storage), {
          backup: "latest",
          namespace: `${database}.users`,
          filter,
        }),
      );
      expect(canonical(found), BSON.EJSON.stringify(filter)).toBe(
        canonical(await serverFind(database, filter)),
      );
    }
  });

  it("reads encrypted backups split into several parts", async () => {
    const { identity, recipient } = generateIdentity();
    const { database, storage } = await seededBackup({
      documentsPerPart: 40,
      recipients: [recipient],
    });
    const found = await collect(
      findInBackup(context(storage), {
        backup: "latest",
        namespace: `${database}.users`,
        filter: { "address.city": "Kyiv" },
        decryption: { identities: [identity] },
      }),
    );
    expect(found).toHaveLength(100);
    expect(canonical(found)).toBe(
      canonical(await serverFind(database, { "address.city": "Kyiv" })),
    );
  });

  it("stops at the limit and applies the projection", async () => {
    const { database, storage } = await seededBackup({ documentsPerPart: 50 });
    const found = await collect(
      findInBackup(context(storage), {
        backup: "latest",
        namespace: `${database}.users`,
        filter: { tags: "vip" },
        projection: { name: 1, "address.city": 1, _id: 0 },
        limit: 3,
      }),
    );
    expect(found).toEqual([
      { name: "user0", address: { city: "Oslo" } },
      { name: "user5", address: { city: "Kyiv" } },
      { name: "user10", address: { city: "Lima" } },
    ]);
  });

  it("rejects unsupported operators immediately, naming each of them", () => {
    const storage = memoryStorage();
    let thrown: unknown;
    try {
      findInBackup(context(storage), {
        backup: "latest",
        namespace: "app.users",
        filter: { tags: { $all: ["a"] }, $where: "true" },
      });
    } catch (error) {
      thrown = error;
    }
    expect(isMongoShieldError(thrown, "MS_CONFIG_INVALID")).toBe(true);
    expect(String((thrown as Error).message)).toContain("$all, $where");
  });

  it("explains a namespace the backup does not hold, and refuses views", async () => {
    const { database, storage } = await seededBackup();
    await expect(
      collect(findInBackup(context(storage), { backup: "latest", namespace: `${database}.nope` })),
    ).rejects.toMatchObject({
      code: "MS_CONFIG_INVALID",
      hint: expect.stringContaining(`${database}.users`),
    });
    await expect(
      collect(
        findInBackup(context(storage), { backup: "latest", namespace: `${database}.active` }),
      ),
    ).rejects.toMatchObject({
      code: "MS_CONFIG_INVALID",
      message: expect.stringContaining("view"),
    });
  });
});

describe("restoreDocuments", () => {
  function restore(
    storage: MemoryStorage,
    options: Partial<RestoreDocumentsOptions> & { namespace: string },
  ) {
    return restoreDocuments(context(storage), { backup: "latest", filter: {}, ...options });
  }

  it("puts deleted documents back and skips the ones that still exist (insert mode)", async () => {
    const { database, storage } = await seededBackup();
    const users = client().db(database).collection("users");
    await users.deleteMany({ "address.city": "Oslo", n: { $lt: 30 } });

    const result = await restore(storage, {
      namespace: `${database}.users`,
      filter: { n: { $lt: 30 } },
    });
    expect(result).toMatchObject({
      mode: "insert",
      matched: 30,
      inserted: 10,
      skipped: 20,
      replaced: 0,
    });
    expect(await users.countDocuments()).toBe(300);
    // Types survive the round trip: n is still an Int32, score a Long for odd n.
    const restored = await users.findOne({ name: "user3" }, { promoteValues: false });
    expect(restored?.n).toBeInstanceOf(Int32);
    expect(restored?.score).toBeInstanceOf(Long);
  });

  it("replaces modified documents in upsert mode and leaves the rest alone", async () => {
    const { database, storage } = await seededBackup();
    const users = client().db(database).collection("users");
    await users.updateMany({ n: { $lt: 5 } }, { $set: { name: "changed" } });
    await users.updateOne({ n: 200 }, { $set: { name: "kept" } });

    const result = await restore(storage, {
      namespace: `${database}.users`,
      filter: { n: { $lt: 5 } },
      mode: "upsert",
    });
    expect(result).toMatchObject({ matched: 5, replaced: 5, inserted: 0, skipped: 0 });
    expect(await users.countDocuments({ name: "changed" })).toBe(0);
    expect(await users.countDocuments({ name: "kept" })).toBe(1);
  });

  it("counts what would happen in a dry run, without writing", async () => {
    const { database, storage } = await seededBackup();
    const users = client().db(database).collection("users");
    await users.deleteMany({ n: { $in: [1, 2] } });

    const insert = await restore(storage, {
      namespace: `${database}.users`,
      filter: { n: { $lte: 3 } },
      dryRun: true,
    });
    expect(insert).toMatchObject({ dryRun: true, matched: 4, inserted: 2, skipped: 2 });
    const upsert = await restore(storage, {
      namespace: `${database}.users`,
      filter: { n: { $lte: 3 } },
      dryRun: true,
      mode: "upsert",
    });
    expect(upsert).toMatchObject({ matched: 4, inserted: 2, replaced: 2 });
    expect(await users.countDocuments()).toBe(298);
  });

  it("refuses a missing target unless createIfMissing, which copies options and indexes", async () => {
    const { database, storage } = await seededBackup();
    await expect(
      restore(storage, {
        namespace: `${database}.users`,
        targetNamespace: `${database}.users_copy`,
      }),
    ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });

    const result = await restore(storage, {
      namespace: `${database}.users`,
      targetNamespace: `${database}.users_copy`,
      filter: { tags: "vip" },
      createIfMissing: true,
    });
    expect(result).toMatchObject({ createdCollection: true, matched: 60, inserted: 60 });
    const indexes = await client().db(database).collection("users_copy").listIndexes().toArray();
    expect(indexes.map((index) => index.name).sort()).toEqual(["_id_", "email_1"]);
  });

  it("refuses views and time series collections as targets", async () => {
    const { database, storage } = await seededBackup();
    await client()
      .db(database)
      .createCollection("metrics", { timeseries: { timeField: "at" } });
    await expect(
      restore(storage, { namespace: `${database}.users`, targetNamespace: `${database}.active` }),
    ).rejects.toMatchObject({ code: "MS_RESTORE_CONFLICT" });
    await expect(
      restore(storage, { namespace: `${database}.users`, targetNamespace: `${database}.metrics` }),
    ).rejects.toMatchObject({ code: "MS_RESTORE_CONFLICT" });
  });

  it("writes in batches when many documents match", async () => {
    const { database, storage } = await seededBackup();
    await client().db(database).collection("users").deleteMany({});
    const result = await restore(storage, {
      namespace: `${database}.users`,
      batchLimits: { maxDocuments: 7, maxBytes: 1024 * 1024 },
    });
    expect(result).toMatchObject({ matched: 300, inserted: 300 });
    expect(await client().db(database).collection("users").countDocuments()).toBe(300);
  });
});

describe("MongoShield.find / restoreDocuments", () => {
  it("search a backup and restore matching documents through the main class", async () => {
    const { database, storage } = await seededBackup();
    const shield = new MongoShield({ storage, source: { client: client() } });
    const found = await collect(
      shield.find({ backup: "latest", namespace: `${database}.users`, filter: { n: 9 } }),
    );
    expect(found.map((document) => document.name)).toEqual(["user9"]);

    await client().db(database).collection("users").deleteOne({ name: "user9" });
    const result = await shield.restoreDocuments({
      backup: "latest",
      namespace: `${database}.users`,
      filter: { n: 9 },
    });
    expect(result).toMatchObject({ matched: 1, inserted: 1 });
    expect(await client().db(database).collection("users").countDocuments()).toBe(300);
  });
});
