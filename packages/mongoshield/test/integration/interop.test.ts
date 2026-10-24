// Compatibility with the real mongodump and mongorestore, both directions:
//
//   mongodump --out / --archive [--gzip]  → importMongodump → MongoShield restore
//   MongoShield backup → exportBackup (directory / archive, [gzip]) → mongorestore
//
// Each round trip restores into a fresh database and compares it with the source:
// every document as raw BSON bytes, every index, and the collection options.
//
// The tools come from MONGO_TOOLS_BIN, or from packages/mongoshield/.tools/ (fill it
// with `node scripts/fetch-mongo-tools.ts`). Without them these tests are skipped.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  Binary,
  BSON,
  BSONRegExp,
  Code,
  Decimal128,
  type Document,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  type MongoClient,
  ObjectId,
  Timestamp,
  UUID,
} from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { exportBackup } from "../../src/interop/export.ts";
import { importMongodump, type MongodumpSource } from "../../src/interop/import.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const run = promisify(execFile);

/** The directory holding mongodump and mongorestore, or undefined when they are not installed. */
function findToolsBin(): string | undefined {
  const fromEnv = process.env.MONGO_TOOLS_BIN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const toolsRoot = fileURLToPath(new URL("../../.tools/", import.meta.url));
  if (!existsSync(toolsRoot)) return undefined;
  for (const entry of readdirSync(toolsRoot)) {
    const bin = join(toolsRoot, entry, "bin");
    if (existsSync(join(bin, "mongodump")) || existsSync(join(bin, "mongodump.exe"))) return bin;
  }
  return undefined;
}

const toolsBin = findToolsBin();
const client = useMongoClient();
const source = uniqueDb("io");

/** A collection name that mongodump has to shorten in file names (escaped, it is 600 bytes). */
const LONG_NAME = "é".repeat(100);

/** Runs a tool from the tools directory; fails the test with its output on error. */
async function tool(name: "mongodump" | "mongorestore", args: readonly string[]): Promise<void> {
  if (toolsBin === undefined) throw new Error("tools not installed");
  try {
    await run(join(toolsBin, name), ["--uri", mongoUri(), ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = String(Reflect.get(Object(error), "stderr") ?? "");
    throw new Error(`${name} ${args.join(" ")} failed:\n${stderr}`);
  }
}

/** One document with every BSON type mongodump and mongorestore must carry unchanged. */
function everyBsonType(index: number): Document {
  return {
    _id: new ObjectId(),
    index,
    double: new Double(1.0),
    negativeZero: new Double(-0),
    string: `héllo ✓ ${index}`,
    nested: { deep: [1, { a: null }], empty: {} },
    binary: new Binary(Buffer.from([0, 1, 2, 255])),
    uuid: new UUID(),
    customBinary: new Binary(Buffer.from("custom"), 0x80),
    date: new Date(1_700_000_000_000 + index),
    regex: new BSONRegExp("^a.*b$", "imsx"),
    code: new Code("function () { return 1; }"),
    int32: new Int32(-42),
    timestamp: new Timestamp({ t: 1_700_000_000, i: 7 }),
    int64: Long.fromString("9223372036854775807"),
    decimal: Decimal128.fromString("1234.5678901234567890123456789"),
    minKey: new MinKey(),
    maxKey: new MaxKey(),
  };
}

/** Everything that must survive a round trip, in a comparable form. */
interface DatabaseSnapshot {
  readonly collections: Record<
    string,
    { type: string; options: string; indexes: string; documents: Buffer[] }
  >;
}

/** Reads a database's collections, options, indexes and raw documents. */
async function snapshot(mongo: MongoClient, database: string): Promise<DatabaseSnapshot> {
  const db = mongo.db(database);
  const collections: DatabaseSnapshot["collections"] = {};
  const infos = await db.listCollections({}, { nameOnly: false }).toArray();
  for (const info of infos.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (info.name.startsWith("system.")) continue;
    const type = String(info.type ?? "collection");
    const options = BSON.EJSON.stringify(info.options ?? {}, { relaxed: false });
    if (type === "view") {
      collections[info.name] = { type, options, indexes: "[]", documents: [] };
      continue;
    }
    const collection = db.collection(info.name);
    const indexes = (await collection.listIndexes().toArray())
      .map(({ ns: _ns, ...spec }) => spec)
      .sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
    const documents: Buffer[] = [];
    // raw: true returns the stored bytes, so any change of type or field order shows.
    for await (const raw of collection.find({}, { raw: true, sort: { _id: 1 } })) {
      documents.push(Buffer.from(raw as unknown as Uint8Array));
    }
    collections[info.name] = {
      type,
      options,
      indexes: BSON.EJSON.stringify(indexes, { relaxed: false }),
      documents,
    };
  }
  return { collections };
}

/** Restores a MongoShield backup into `target` with MongoShield's own restore. */
async function restoreWithMongoShield(storage: StorageAdapter, id: string, target: string) {
  await runRestore(
    { client: client(), storage, logger: silentLogger },
    { backup: id, rename: { [`${source}.*`]: `${target}.*` } },
  );
}

const temporaryPaths: string[] = [];
async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mongoshield-interop-it-"));
  temporaryPaths.push(path);
  return path;
}

const restoredDatabases: string[] = [];
function newTarget(): string {
  const name = uniqueDb("io_r");
  restoredDatabases.push(name);
  return name;
}

describe.skipIf(toolsBin === undefined)("compatibility with mongodump and mongorestore", () => {
  let expected: DatabaseSnapshot;

  beforeAll(async () => {
    const db = client().db(source);
    await db
      .collection("types")
      .insertMany(Array.from({ length: 200 }, (_, index) => everyBsonType(index)));
    await db.collection("types").createIndex({ index: 1 }, { unique: true, name: "by_index" });
    await db
      .collection("types")
      .createIndex({ date: 1 }, { expireAfterSeconds: 3600, name: "ttl" });
    await db
      .collection("types")
      .createIndex(
        { string: 1 },
        { partialFilterExpression: { index: { $gt: 10 } }, name: "partial" },
      );
    await db.createCollection("validated", {
      validator: { $jsonSchema: { bsonType: "object", required: ["name"] } },
      collation: { locale: "fr", strength: 2 },
    });
    await db.collection("validated").insertMany([{ name: "Élodie" }, { name: "zoé" }]);
    await db.createCollection("capped", { capped: true, size: 64 * 1024, max: 100 });
    await db.collection("capped").insertMany(Array.from({ length: 20 }, (_, n) => ({ n })));
    await db.createCollection("empty");
    await db.collection("we/ird name+é").insertOne({ odd: true });
    await db.collection(LONG_NAME).insertOne({ long: true });
    await db.createCollection("first_ten", {
      viewOn: "types",
      pipeline: [{ $match: { index: { $lt: 10 } } }],
    });
    expected = await snapshot(client(), source);
    // Guard the comparisons below against comparing two empty snapshots.
    expect(Object.keys(expected.collections).sort()).toEqual(
      ["capped", "empty", "first_ten", "types", "validated", "we/ird name+é", LONG_NAME].sort(),
    );
    expect(expected.collections.types?.documents).toHaveLength(200);
    expect(expected.collections.types?.indexes).toContain("partialFilterExpression");
    expect(expected.collections.validated?.options).toContain("$jsonSchema");
  });

  afterAll(async () => {
    for (const database of [source, ...restoredDatabases]) {
      await client().db(database).dropDatabase();
    }
    for (const path of temporaryPaths) await rm(path, { recursive: true, force: true });
  });

  describe("mongodump → importMongodump → mongoshield restore", () => {
    async function importAndRestore(dump: MongodumpSource): Promise<DatabaseSnapshot> {
      const storage = memoryStorage();
      const result = await importMongodump(dump, storage);
      expect(result.skipped).toEqual([]);
      const target = newTarget();
      await restoreWithMongoShield(storage, result.id, target);
      return snapshot(client(), target);
    }

    it("round-trips a dump directory", async () => {
      const out = await tempDirectory();
      await tool("mongodump", ["--db", source, "--out", out]);
      expect(await importAndRestore({ directory: out })).toEqual(expected);
    });

    it("round-trips a gzipped dump directory", async () => {
      const out = await tempDirectory();
      await tool("mongodump", ["--db", source, "--out", out, "--gzip"]);
      expect(await importAndRestore({ directory: out })).toEqual(expected);
    });

    it("round-trips an archive", async () => {
      const archive = join(await tempDirectory(), "dump.archive");
      await tool("mongodump", ["--db", source, `--archive=${archive}`]);
      expect(await importAndRestore({ archive })).toEqual(expected);
    });

    it("round-trips a gzipped archive", async () => {
      const archive = join(await tempDirectory(), "dump.archive.gz");
      await tool("mongodump", ["--db", source, `--archive=${archive}`, "--gzip"]);
      expect(await importAndRestore({ archive })).toEqual(expected);
    });
  });

  describe("mongoshield backup → exportBackup → mongorestore", () => {
    let storage: StorageAdapter;
    let backupId: string;

    beforeAll(async () => {
      storage = memoryStorage();
      const result = await runBackup(
        {
          client: client(),
          storage,
          logger: silentLogger,
          compression: "zstd",
          encryption: undefined,
        },
        { include: [`${source}.*`] },
      );
      backupId = result.id;
    });

    const nsMapping = (target: string) => ["--nsFrom", `${source}.*`, "--nsTo", `${target}.*`];

    it("restores an exported directory", async () => {
      const output = join(await tempDirectory(), "dump");
      await exportBackup(storage, backupId, { format: "directory", output });
      const target = newTarget();
      await tool("mongorestore", ["--dir", output, ...nsMapping(target)]);
      expect(await snapshot(client(), target)).toEqual(expected);
    });

    it("restores an exported gzipped directory", async () => {
      const output = join(await tempDirectory(), "dump");
      await exportBackup(storage, backupId, { format: "directory", output, gzip: true });
      const target = newTarget();
      await tool("mongorestore", ["--gzip", "--dir", output, ...nsMapping(target)]);
      expect(await snapshot(client(), target)).toEqual(expected);
    });

    it("restores an exported archive", async () => {
      const output = join(await tempDirectory(), "backup.archive");
      await exportBackup(storage, backupId, { format: "archive", output });
      const target = newTarget();
      await tool("mongorestore", [`--archive=${output}`, ...nsMapping(target)]);
      expect(await snapshot(client(), target)).toEqual(expected);
    });

    it("restores an exported gzipped archive", async () => {
      const output = join(await tempDirectory(), "backup.archive.gz");
      await exportBackup(storage, backupId, { format: "archive", output, gzip: true });
      const target = newTarget();
      await tool("mongorestore", ["--gzip", `--archive=${output}`, ...nsMapping(target)]);
      expect(await snapshot(client(), target)).toEqual(expected);
    });
  });
});
