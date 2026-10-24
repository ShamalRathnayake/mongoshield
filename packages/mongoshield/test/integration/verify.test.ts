// Integration test for verifyBackup on a backup of real collections, stored with the
// file storage adapter: deep verification parses real metadata and documents, and
// both modes notice a file damaged on disk.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { verifyBackup } from "../../src/engine/verify.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { fileStorage } from "../../src/storage/file.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { backupDatabaseForTest, flipByte } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const database = uniqueDb("ver");
const { identity, recipient } = generateIdentity();
let directory: string;
let storage: StorageAdapter;
let manifest: Manifest;

beforeAll(async () => {
  const db = client().db(database);
  await db.collection("items").insertMany(Array.from({ length: 500 }, (_, index) => ({ index })));
  await db.createCollection("metrics", { timeseries: { timeField: "t", metaField: "m" } });
  await db.collection("metrics").insertOne({ t: new Date(), m: 1, v: 2 });
  await db.createCollection("recent", { viewOn: "items", pipeline: [{ $limit: 5 }] });

  directory = await mkdtemp(join(tmpdir(), "mongoshield-verify-"));
  storage = fileStorage({ path: directory });
  manifest = await backupDatabaseForTest(client(), storage, {
    include: [`${database}.*`],
    recipients: [recipient],
  });
});

afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

describe("verifyBackup on a real backup", () => {
  it("passes fast and deep verification", async () => {
    const context = { storage, logger: silentLogger };
    expect((await verifyBackup(context, { backup: manifest.id })).ok).toBe(true);
    const deep = await verifyBackup(context, {
      backup: manifest.id,
      mode: "deep",
      decryption: { identities: [identity] },
    });
    expect(deep).toMatchObject({ ok: true, documentsChecked: 501, problems: [] });
  });

  it("notices a data file damaged on disk in both modes", async () => {
    const entry = manifest.namespaces.find((namespace) => namespace.collection === "items");
    const key = entry?.files[0]?.key;
    if (key === undefined) throw new Error("no data file");
    const path = join(directory, "backups", manifest.id, key);
    await writeFile(path, flipByte(await readFile(path), 100));

    const context = { storage, logger: silentLogger };
    const fast = await verifyBackup(context, { backup: manifest.id });
    expect(fast.problems).toEqual([{ subject: key, problem: expect.stringMatching(/SHA-256/) }]);
    const deep = await verifyBackup(context, {
      backup: manifest.id,
      mode: "deep",
      decryption: { identities: [identity] },
    });
    expect(deep.ok).toBe(false);
    expect(deep.problems.map((problem) => problem.subject)).toEqual([key]);
  });
});
