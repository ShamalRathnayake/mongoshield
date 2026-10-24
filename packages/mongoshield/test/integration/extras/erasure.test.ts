/**
 * The GDPR erasure ledger (src/extras/erasure.ts) against the real test replica set:
 * erasures recorded after a backup are applied again after a restore of that backup,
 * through `withErasures` exactly as `shield.restore` will use it.
 */

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyErasures,
  eraseLiveDocuments,
  listErasures,
  recordErasure,
} from "../../../src/extras/erasure.ts";
import { MongoShield } from "../../../src/index.ts";
import { memoryStorage } from "../../../src/storage/memory.ts";
import type { RestoreOptions } from "../../../src/types.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../../helpers/mongo.ts";

const client = useMongoClient();
const sourceDb = uniqueDb("erase");
const SECRET = "erasure-secret-for-tests";
const adaId = new ObjectId();

interface User {
  _id: ObjectId | number;
  email: string;
  contacts?: { email: string }[];
}

beforeAll(async () => {
  const users = client().db(sourceDb).collection<User>("users");
  await users.insertMany([
    { _id: adaId, email: "ada@example.com" },
    { _id: 2, email: "bob@example.com", contacts: [{ email: "carol@example.com" }] },
    { _id: 3, email: "dan@example.com" },
    { _id: 4, email: "erin@example.com" },
  ]);
  await client()
    .db(sourceDb)
    .collection("orders")
    .insertMany([{ userId: 3 }, { userId: 4 }]);
});

afterAll(async () => {
  await client().db(sourceDb).dropDatabase();
});

describe("the erasure ledger", () => {
  it("deletes erased documents again after a restore of an older backup", async () => {
    const storage = memoryStorage();
    const shield = new MongoShield({ source: { uri: mongoUri() }, storage });
    const backup = await shield.backup({ include: [`${sourceDb}.*`], consistency: "none" });

    // After the backup, four erasures: hashed (email, keyed), hashed dotted path,
    // plain id filter, and a pattern over every collection.
    await recordErasure(storage, {
      namespace: `${sourceDb}.users`,
      filter: { email: "ada@example.com" },
      reason: "request 1",
      secret: SECRET,
    });
    await recordErasure(storage, {
      namespace: `${sourceDb}.users`,
      filter: { "contacts.email": "carol@example.com" },
      reason: "request 2",
      secret: SECRET,
    });
    await recordErasure(storage, {
      namespace: `${sourceDb}.users`,
      filter: { _id: 3 },
      reason: "request 3",
    });
    await recordErasure(storage, {
      namespace: `${sourceDb}.*`,
      filter: { userId: 4 },
      reason: "request 4",
    });
    const records = await listErasures(storage);
    expect(records).toHaveLength(4);
    expect(JSON.stringify(records)).not.toContain("ada@example.com");

    const target = uniqueDb("erase_restored");
    const options: RestoreOptions = {
      backup: backup.id,
      rename: { [`${sourceDb}.*`]: `${target}.*` },
    };
    try {
      // shield.restore applies the ledger itself; the secret comes from the options.
      const restoring = new MongoShield({
        source: { uri: mongoUri() },
        storage,
        erasures: { secret: SECRET },
      });
      const result = await restoring.restore(options);
      expect(result.erasures?.documentsDeleted).toBe(4);
      const users = await client().db(target).collection<User>("users").find().toArray();
      expect(users.map((user) => user.email)).toEqual(["erin@example.com"]);
      expect(await client().db(target).collection("orders").countDocuments()).toBe(1);
    } finally {
      await client().db(target).dropDatabase();
    }
  });

  it("refuses to restore when keyed records exist but the secret is missing or wrong", async () => {
    const storage = memoryStorage();
    const shield = new MongoShield({ source: { uri: mongoUri() }, storage });
    const backup = await shield.backup({ include: [`${sourceDb}.users`], consistency: "none" });
    await recordErasure(storage, {
      namespace: `${sourceDb}.users`,
      filter: { email: "ada@example.com" },
      reason: "request",
      secret: SECRET,
    });
    const target = uniqueDb("erase_refused");
    const options: RestoreOptions = {
      backup: backup.id,
      rename: { [`${sourceDb}.*`]: `${target}.*` },
    };
    // Without the secret, and with a wrong one, the restore is refused before it writes.
    await expect(shield.restore(options)).rejects.toThrow(/none was given/);
    const wrongSecret = new MongoShield({
      source: { uri: mongoUri() },
      storage,
      erasures: { secret: "a-different-secret-entirely" },
    });
    await expect(wrongSecret.restore(options)).rejects.toThrow(/different erasure secret/);
    expect(await client().db(target).listCollections().toArray()).toEqual([]);

    // skipErasures runs the restore alone.
    try {
      const result = await shield.restore({ ...options, skipErasures: true });
      expect(result.documentsRestored).toBe(4);
    } finally {
      await client().db(target).dropDatabase();
    }
  });

  it("counts without deleting in a dry run, and erases live data now", async () => {
    const storage = memoryStorage();
    const live = uniqueDb("erase_live");
    await client()
      .db(live)
      .collection<User>("users")
      .insertMany([
        { _id: 1, email: "ada@example.com" },
        { _id: 2, email: "bob@example.com" },
      ]);
    try {
      await recordErasure(storage, {
        namespace: `${live}.users`,
        filter: { email: "ada@example.com" },
        reason: "request",
      });
      const dry = await applyErasures(client(), storage, {
        namespaces: [`${live}.users`],
        dryRun: true,
      });
      expect(dry.documentsDeleted).toBe(1);
      expect(await client().db(live).collection("users").countDocuments()).toBe(2);

      const now = await eraseLiveDocuments(client(), {
        namespace: `${live}.*`,
        filter: { email: "ada@example.com" },
      });
      expect(now).toEqual([{ ns: `${live}.users`, erasures: 1, deleted: 1 }]);
      expect(await client().db(live).collection("users").countDocuments()).toBe(1);
    } finally {
      await client().db(live).dropDatabase();
    }
  });

  it("only applies erasures recorded since a given time", async () => {
    const storage = memoryStorage();
    await recordErasure(storage, {
      namespace: "*",
      filter: { _id: 1 },
      reason: "old",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    await recordErasure(storage, {
      namespace: "*",
      filter: { _id: 2 },
      reason: "new",
      now: new Date("2026-06-01T00:00:00Z"),
    });
    expect(
      (await listErasures(storage, { since: new Date("2026-03-01T00:00:00Z") })).map(
        (record) => record.reason,
      ),
    ).toEqual(["new"]);
  });

  it("treats an unreadable ledger record as an error", async () => {
    const storage = memoryStorage();
    await storage.put("erasures/broken.json", Buffer.from("{ not json"));
    await expect(listErasures(storage)).rejects.toThrow(/cannot be read/);
  });
});
