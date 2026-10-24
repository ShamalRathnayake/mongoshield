/**
 * End-to-end tests of the public `MongoShield` class: the path most users take.
 * Everything runs against the real test replica set and real storage adapters.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal128, Double, Int32, Long, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateIdentity, isMongoShieldError, MongoShield } from "../../src/index.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const sourceDb = uniqueDb("shield");
let backupDirectory: string;

beforeAll(async () => {
  backupDirectory = await mkdtemp(join(tmpdir(), "mongoshield-shield-"));

  // A small but varied dataset: several BSON types that must survive exactly.
  const db = client().db(sourceDb);
  await db.collection("users").insertMany(
    Array.from({ length: 500 }, (_, index) => ({
      _id: new ObjectId(),
      index: new Int32(index),
      balance: new Decimal128(`${index}.25`),
      score: new Double(index), // an integral double must stay a double
      visits: Long.fromNumber(index * 1_000_000_000),
      tags: index % 2 === 0 ? ["even"] : ["odd", "prime-ish"],
      createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000),
    })),
  );
  await db.collection("users").createIndex({ index: 1 }, { unique: true });
  await db
    .collection("orders")
    .insertMany(Array.from({ length: 200 }, (_, index) => ({ order: index, total: index * 3 })));
  await db.createCollection("big_spenders", {
    viewOn: "orders",
    pipeline: [{ $match: { total: { $gt: 300 } } }],
  });
});

afterAll(async () => {
  await client().db(sourceDb).dropDatabase();
  await rm(backupDirectory, { recursive: true, force: true });
});

describe("MongoShield", () => {
  it("backs up, verifies, lists, holds, prunes and restores an encrypted backup", async () => {
    const { identity, recipient } = generateIdentity();
    const shield = new MongoShield({
      source: { uri: mongoUri() },
      storage: fileStorage({ path: backupDirectory }),
      encryption: { recipients: [recipient] },
    });

    // Back up just our test database.
    const backup = await shield.backup({ include: [`${sourceDb}.*`], labels: { test: "e2e" } });
    expect(backup.manifest.totals.documents).toBe(700);
    expect(backup.manifest.encryption?.scheme).toBe("age-v1");

    // A fast verification needs no key; it is recorded and shows up in the list.
    const report = await shield.verify({ backup: backup.id, mode: "fast" });
    expect(report.ok).toBe(true);
    const [entry] = await shield.list();
    expect(entry?.id).toBe(backup.id);
    expect(entry?.verification?.ok).toBe(true);

    // A deep verification decrypts and parses everything.
    const deep = await shield.verify({
      backup: backup.id,
      mode: "deep",
      decryption: { identities: [identity] },
    });
    expect(deep.ok).toBe(true);
    expect(deep.documentsChecked).toBe(700);

    // A held backup survives a prune that would otherwise delete everything but one.
    await shield.hold(backup.id, { reason: "e2e test" });
    const second = await shield.backup({ include: [`${sourceDb}.*`] });
    const pruned = await shield.prune({ last: 1 });
    expect(pruned.plan.remove.map((removed) => removed.id)).not.toContain(backup.id);
    expect((await shield.list()).map((listed) => listed.id)).toEqual([second.id, backup.id]);
    await shield.release(backup.id);

    // Restore next to the original and compare every document exactly.
    const restoredDb = `${sourceDb}_restored`;
    const result = await shield.restore({
      backup: backup.id,
      rename: { [`${sourceDb}.*`]: `${restoredDb}.*` },
      decryption: { identities: [identity] },
    });
    expect(result.documentsRestored).toBe(700);

    try {
      for (const name of ["users", "orders"]) {
        const original = await client()
          .db(sourceDb)
          .collection(name)
          .find({}, { sort: { _id: 1 }, raw: true })
          .toArray();
        const restored = await client()
          .db(restoredDb)
          .collection(name)
          .find({}, { sort: { _id: 1 }, raw: true })
          .toArray();
        // Raw BSON bytes are compared, so any type change (int vs double…) would fail here.
        expect(restored).toEqual(original);
      }

      // Indexes and views come back too.
      const indexes = await client().db(restoredDb).collection("users").indexes();
      expect(indexes.some((index) => index.unique && index.key.index === 1)).toBe(true);
      expect(await client().db(restoredDb).collection("big_spenders").countDocuments()).toBe(
        await client().db(sourceDb).collection("big_spenders").countDocuments(),
      );
    } finally {
      await client().db(restoredDb).dropDatabase();
    }
  });

  it("refuses to restore over existing data unless told how", async () => {
    const shield = new MongoShield({ source: { uri: mongoUri() }, storage: memoryStorage() });
    await shield.backup({ include: [`${sourceDb}.orders`] });

    const error = await shield.restore({ backup: "latest" }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_RESTORE_CONFLICT")).toBe(true);
  });

  it("reuses a caller's MongoClient without closing it", async () => {
    const shield = new MongoShield({ source: { client: client() }, storage: memoryStorage() });
    await shield.backup({ include: [`${sourceDb}.orders`] });
    // The client still works afterwards.
    expect(await client().db(sourceDb).collection("orders").countDocuments()).toBe(200);
  });

  it("explains what is missing when there is no source", async () => {
    const shield = new MongoShield({ storage: memoryStorage() });
    await expect(shield.backup()).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
  });

  it("refuses to hold a backup that does not exist", async () => {
    const shield = new MongoShield({ storage: memoryStorage() });
    await expect(
      shield.hold("2026-01-01T00-00-00Z_abcdef", { reason: "typo" }),
    ).rejects.toMatchObject({ code: "MS_BACKUP_NOT_FOUND" });
  });
});
