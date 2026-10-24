// The recovery extras through the MongoShield class (src/shield.ts): document history,
// diff, text export, tenant restore and single-document restore, each wired to the
// shield's storage and source connection. The engines themselves are tested in
// test/integration/extras and find*.test.ts; this proves the wiring.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMongoShieldError, MongoShield } from "../../src/index.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const database = uniqueDb("shx");
let storage: MemoryStorage;
let shield: MongoShield;
let backupId: string;

interface Account {
  _id: number;
  tenant: string;
  plan: string;
}

beforeAll(async () => {
  await client()
    .db(database)
    .collection<Account>("accounts")
    .insertMany(
      Array.from({ length: 10 }, (_, id) => ({
        _id: id,
        tenant: id % 2 === 0 ? "acme" : "globex",
        plan: "basic",
      })),
    );
  storage = memoryStorage();
  shield = new MongoShield({ source: { uri: mongoUri() }, storage });
  const backup = await shield.backup({ include: [`${database}.*`], consistency: "none" });
  backupId = backup.id;
});

afterAll(async () => {
  await client().db(database).dropDatabase();
});

describe("MongoShield recovery extras", () => {
  it("shows a document's history across backups", async () => {
    const history = await shield.history({ namespace: `${database}.accounts`, id: 3 });
    expect(history.versions).toHaveLength(1);
    expect(history.backupsSearched).toBe(1);
  });

  it("diffs a backup against itself as identical", async () => {
    const result = await shield.diff({ from: backupId, to: backupId });
    expect(result.identical).toBe(true);
  });

  it("exports a collection as JSON Lines", async () => {
    const chunks: string[] = [];
    const { Writable } = await import("node:stream");
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString("utf8"));
        callback();
      },
    });
    const result = await shield.exportDocuments({
      backup: backupId,
      namespace: `${database}.accounts`,
      format: "jsonl",
      output,
    });
    expect(result.documents).toBe(10);
    expect(chunks.join("").trim().split("\n")).toHaveLength(10);
  });

  it("restores one tenant into the source without touching the other", async () => {
    const accounts = client().db(database).collection<Account>("accounts");
    await accounts.updateMany({}, { $set: { plan: "BROKEN" } });
    const result = await shield.restoreTenant({
      backup: backupId,
      include: [`${database}.accounts`],
      tenantFilter: { tenant: "acme" },
      mode: "upsert",
    });
    expect(result.totals.replaced).toBe(5);
    expect(await accounts.countDocuments({ plan: "basic" })).toBe(5);
    expect(await accounts.countDocuments({ tenant: "globex", plan: "BROKEN" })).toBe(5);
  });

  it("restores single documents into the source, counting them in a dry run first", async () => {
    const accounts = client().db(database).collection<Account>("accounts");
    await accounts.deleteOne({ _id: 1 });
    const options = {
      backup: backupId,
      namespace: `${database}.accounts`,
      filter: { _id: 1 },
    };
    const dry = await shield.restoreDocuments({ ...options, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, matched: 1 });
    expect(await accounts.findOne({ _id: 1 })).toBeNull();
    expect(await shield.restoreDocuments(options)).toMatchObject({ matched: 1, inserted: 1 });
    expect(await accounts.findOne({ _id: 1 })).toMatchObject({ tenant: "globex", plan: "basic" });
  });

  it("refuses a tenant restore and a document restore without a source or target", async () => {
    const storageOnly = new MongoShield({ storage });
    for (const attempt of [
      () => storageOnly.restoreTenant({ backup: backupId, tenantFilter: { tenant: "acme" } }),
      () =>
        storageOnly.restoreDocuments({
          backup: backupId,
          namespace: `${database}.accounts`,
          filter: {},
        }),
    ]) {
      const error: unknown = await attempt().catch((caught: unknown) => caught);
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    }
  });
});

describe("new MongoShield", () => {
  it("needs a storage adapter, even from plain JavaScript", () => {
    const options: unknown = { source: { uri: mongoUri() } };
    expect(() => new MongoShield(options as ConstructorParameters<typeof MongoShield>[0])).toThrow(
      /needs a storage adapter/,
    );
  });
});
