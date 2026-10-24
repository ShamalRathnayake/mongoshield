// Integration tests: stored field order outside the documents themselves. Field names
// that look like integers ("0", "1"), which JavaScript objects list first, must stay
// where they were in
//   - collection metadata: compound index keys, partial filters, validators and view
//     pipelines, through backup + restore, copy, and converge replay of index and
//     collection creations made during the backup;
//   - users' custom data, through backup + restore of users and roles;
//   - `_id`s used as bounds: part boundaries of split collections and the progress
//     `_id` of a resumed copy;
//   - values followed by a subset copy (reference sets).
// See src/format/field-order.ts and src/format/ordered-json.ts. Each case compares raw
// BSON read straight from the server (`raw: true`), not values parsed by MongoShield.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BSON, type Document, Int32 } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCopy } from "../../src/copy/copy.ts";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { createUsersWithoutCredentials } from "../../src/engine/restore-authz.ts";
import { deserializeInStoredOrder } from "../../src/format/field-order.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { BackupOptions } from "../../src/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { sortedBytes } from "../helpers/ordered-documents.ts";
import { backupContext } from "./backup-test-utils.ts";
import { hookedStorage, isDataFileOf } from "./converge-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-field-order-"));
});

afterAll(async () => {
  for (const database of databases) {
    await client().db(database).command({ dropAllUsersFromDatabase: 1 });
    await client().db(database).dropDatabase();
  }
  await rm(workDir, { recursive: true, force: true });
});

/** A fresh database name, dropped (with its users) after the file. */
function newDatabase(prefix: string): string {
  const name = uniqueDb(prefix);
  databases.push(name);
  return name;
}

/** A document in exactly the given field order (js-bson writes Maps in order). */
function ordered(...entries: [string, unknown][]): Map<string, unknown> {
  return new Map(entries);
}

/** A compound key whose order JavaScript would change: `b`, then "1", then `a`. */
const COMPOUND_KEY = ordered(["b", 1], ["1", 1], ["a", -1]);

/** A partial filter and a validator with integer-like field names after others. */
const PARTIAL_FILTER = ordered(["q", { $exists: true }], ["0", { $exists: true }]);
const VALIDATOR = ordered(["z", { $exists: true }], ["2", { $type: "string" }]);

/** A view pipeline: a `$sort` and `$facet` outputs whose order is the result. */
const VIEW_PIPELINE = [
  { $sort: ordered(["b", 1], ["1", -1]) },
  { $facet: ordered(["z", [{ $limit: 1 }]], ["0", [{ $count: "n" }]]) },
];

/** `docs` (validator, compound partial index) and the view `v` on it. */
async function seedCatalog(database: string): Promise<void> {
  const db = client().db(database);
  await db.command({ create: "docs", validator: VALIDATOR, validationAction: "warn" });
  await db.collection("docs").insertMany([
    { b: 1, 1: 2, a: 3, q: true, 0: "x" },
    { b: 2, 1: 1, a: 1 },
  ]);
  await db.command({
    createIndexes: "docs",
    indexes: [{ key: COMPOUND_KEY, name: "compound", partialFilterExpression: PARTIAL_FILTER }],
  });
  await db.command({ create: "v", viewOn: "docs", pipeline: VIEW_PIPELINE });
}

/**
 * A database's catalog as raw BSON: per collection, its `options` sub-document's bytes
 * and its index definitions' bytes. `raw: true` in `BSON.deserialize` keeps every
 * sub-document as the server's bytes, so no JavaScript object is involved.
 */
async function catalogOf(database: string): Promise<Record<string, Document>> {
  const db = client().db(database);
  const catalog: Record<string, Document> = {};
  for await (const raw of db.listCollections({}, { raw: true })) {
    const info = BSON.deserialize(raw as unknown as Uint8Array, { raw: true });
    const name = String(info.name);
    const indexes: Uint8Array[] = [];
    if (info.type === "collection") {
      for await (const index of db.collection(name).listIndexes({ raw: true })) {
        indexes.push(index as unknown as Uint8Array);
      }
    }
    catalog[name] = {
      type: info.type,
      options: Buffer.from(info.options as Uint8Array).toString("hex"),
      indexes: sortedBytes(indexes).map((bytes) => bytes.toString("hex")),
    };
  }
  return catalog;
}

/** The field names of the index `name` of `database.collection`, in stored order. */
async function keyOrderOf(database: string, collection: string, name: string): Promise<string[]> {
  for await (const raw of client().db(database).collection(collection).listIndexes({ raw: true })) {
    const index = BSON.deserialize(raw as unknown as Uint8Array, { raw: true });
    if (index.name !== name) continue;
    return namesOf(index.key as Uint8Array);
  }
  return [];
}

/**
 * The top-level field names of one raw BSON document, in stored order. Read from the
 * bytes (type byte, NUL-terminated name, value; see bsonspec.org), because the keys
 * of any parsed JavaScript object would be reordered again.
 */
function namesOf(bytes: Uint8Array): string[] {
  const names: string[] = [];
  const buffer = Buffer.from(bytes);
  let position = 4;
  while (position < buffer.length - 1) {
    const type = buffer[position] ?? 0;
    const nameEnd = buffer.indexOf(0, position + 1);
    names.push(buffer.toString("utf8", position + 1, nameEnd));
    position = nameEnd + 1 + elementLength(buffer, type, nameEnd + 1);
  }
  return names;
}

/** Bytes of a value of the few BSON types index keys hold (numbers and strings). */
function elementLength(buffer: Buffer, type: number, at: number): number {
  if (type === 0x10) return 4; // int32
  if (type === 0x01 || type === 0x12) return 8; // double, int64
  if (type === 0x02) return 4 + buffer.readInt32LE(at); // string
  throw new Error(`unexpected BSON type ${type} in an index key`);
}

/** The documents of a collection as raw BSON, in a canonical order. */
async function rawOf(database: string, collection: string): Promise<Buffer[]> {
  const raw: Uint8Array[] = [];
  const cursor = client().db(database).collection(collection).find({}, { raw: true });
  for await (const document of cursor) raw.push(document as unknown as Uint8Array);
  return sortedBytes(raw);
}

async function backup(
  storage: MemoryStorage,
  database: string,
  options: Partial<BackupOptions> = {},
): Promise<Manifest> {
  const result = await runBackup(backupContext(client(), storage), {
    include: [`${database}.*`],
    parallelism: 1,
    ...options,
  });
  if (result.status !== "complete") throw new Error("expected a complete backup");
  return result.manifest;
}

function restoreContext(storage: MemoryStorage) {
  return { client: client(), storage, logger: silentLogger };
}

function copyContext() {
  return { source: client(), target: client(), logger: silentLogger };
}

describe("stored field order in collection metadata", () => {
  it("keeps index keys, partial filters, validators and view pipelines through backup and restore", async () => {
    const source = newDatabase("foc_src");
    const target = newDatabase("foc_dst");
    await seedCatalog(source);
    const storage = memoryStorage();
    const manifest = await backup(storage, source);

    await runRestore(restoreContext(storage), {
      backup: manifest.id,
      rename: { [`${source}.*`]: `${target}.*` },
    });
    expect(await keyOrderOf(target, "docs", "compound")).toEqual(["b", "1", "a"]);
    expect(await catalogOf(target)).toEqual(await catalogOf(source));
  });

  it("keeps them through copy", async () => {
    const source = newDatabase("foc_csrc");
    const target = newDatabase("foc_cdst");
    await seedCatalog(source);
    await runCopy(copyContext(), {
      include: [`${source}.*`],
      rename: { [`${source}.*`]: `${target}.*` },
    });
    expect(await keyOrderOf(target, "docs", "compound")).toEqual(["b", "1", "a"]);
    expect(await catalogOf(target)).toEqual(await catalogOf(source));
  });

  it("keeps indexes and collections created during a converge backup", async () => {
    const source = newDatabase("foc_vsrc");
    const target = newDatabase("foc_vdst");
    const db = client().db(source);
    await db.collection("a").insertOne(ordered(["_id", 1], ["b", 1]));
    await db.collection("b").insertOne(ordered(["_id", 1]));
    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (changed || !isDataFileOf(key, "b")) return;
      changed = true;
      // While `b` is dumped (after `a`): an index on `a` and a new collection `c`.
      await db.command({
        createIndexes: "a",
        indexes: [{ key: COMPOUND_KEY, name: "compound", partialFilterExpression: PARTIAL_FILTER }],
      });
      await db.command({ create: "c", validator: VALIDATOR, validationAction: "warn" });
    });
    const manifest = await backup(storage, source, { consistency: "converge" });
    expect(changed).toBe(true);

    await runRestore(restoreContext(storage), {
      backup: manifest.id,
      rename: { [`${source}.*`]: `${target}.*` },
    });
    expect(await keyOrderOf(target, "a", "compound")).toEqual(["b", "1", "a"]);
    expect(await catalogOf(target)).toEqual(await catalogOf(source));
  });
});

describe("stored field order in users' custom data", () => {
  /** Custom data with integer-like names after others, nested too. */
  const CUSTOM_DATA = ordered(["b", 1], ["1", 2], ["nested", ordered(["z", true], ["0", "x"])]);

  /** The raw `customData` of a user, read from `admin.system.users`. */
  async function customDataOf(database: string, user: string): Promise<Buffer | undefined> {
    const raw = await client()
      .db("admin")
      .collection("system.users")
      .findOne({ _id: `${database}.${user}` as never }, { raw: true });
    if (raw === null) return undefined;
    const parsed = BSON.deserialize(raw as unknown as Uint8Array, { raw: true });
    return Buffer.from(parsed.customData as Uint8Array);
  }

  it("restores users with their custom data in stored order", async () => {
    const source = newDatabase("fou_src");
    const target = newDatabase("fou_dst");
    await client().db(source).collection("things").insertOne({ name: "thing" });
    await client()
      .db(source)
      .command({ createUser: "alice", pwd: "secret-password", roles: [], customData: CUSTOM_DATA });
    const expected = await customDataOf(source, "alice");
    expect(expected).toEqual(Buffer.from(BSON.serialize(CUSTOM_DATA)));

    const storage = memoryStorage();
    const manifest = await backup(storage, source, { includeUsersAndRoles: true });
    const result = await runRestore(restoreContext(storage), {
      backup: manifest.id,
      rename: { [`${source}.*`]: `${target}.*` },
      usersAndRoles: "create",
    });
    expect(result.usersAndRoles?.method).toBe("merge");
    expect(await customDataOf(target, "alice")).toEqual(expected);
  });

  it("creates users with createUser (no password hashes) with custom data in stored order", async () => {
    const target = newDatabase("fou_cu");
    // A backed-up user as restore parses it.
    const user = deserializeInStoredOrder(
      BSON.serialize(
        ordered(
          ["_id", `${target}.bob`],
          ["user", "bob"],
          ["db", target],
          ["roles", []],
          ["customData", CUSTOM_DATA],
        ),
      ),
    );
    await createUsersWithoutCredentials(client(), [user], { mode: "create", logger: silentLogger });
    expect(await customDataOf(target, "bob")).toEqual(Buffer.from(BSON.serialize(CUSTOM_DATA)));
  });
});

describe("stored field order in _id bounds", () => {
  /**
   * `_id`s chosen so that JavaScript order breaks the `_id` order of sampled part
   * boundaries: `{ "1": w }` documents, then `{ a: i, "1": 1999 - i }` documents (all
   * after them: "1" < "a"). In JavaScript order a boundary of the second kind becomes
   * `{ "1": 1999 - i, a: i }`, which lands among the first kind and decreases as `i`
   * grows, so parts would overlap or be refused.
   */
  async function seedInterleaved(database: string): Promise<void> {
    const pad = "p".repeat(60);
    const documents: Map<string, unknown>[] = [];
    for (let w = 0; w < 2000; w++)
      documents.push(ordered(["_id", ordered(["1", new Int32(w)])], ["pad", pad]));
    for (let i = 0; i < 1000; i++) {
      const id = ordered(["a", new Int32(i)], ["1", new Int32(1999 - i)]);
      documents.push(ordered(["_id", id], ["pad", pad]));
    }
    await client().db(database).collection("orders").insertMany(documents);
  }

  it("splits a collection with embedded-document _ids into parts that hold every document once", async () => {
    const source = newDatabase("fob_src");
    const target = newDatabase("fob_dst");
    await seedInterleaved(source);
    const storage = memoryStorage();
    const manifest = await backup(storage, source, { partSizeBytes: 40_000, parallelism: 3 });
    const entry = manifest.namespaces.find((namespace) => namespace.ns === `${source}.orders`);
    expect(entry?.files.length).toBeGreaterThan(3);
    expect(entry?.documents).toBe(3000);

    await runRestore(restoreContext(storage), {
      backup: manifest.id,
      rename: { [`${source}.*`]: `${target}.*` },
    });
    expect(await rawOf(target, "orders")).toEqual(await rawOf(source, "orders"));
  });

  it("resumes a checkpointed backup of such a collection at the same boundaries", async () => {
    const source = newDatabase("fob_bsrc");
    const target = newDatabase("fob_bdst");
    await seedInterleaved(source);
    const storage = memoryStorage();
    // `maxDurationMs: 1` stops each run after one part; the boundaries of the first
    // run are read back from the checkpoint by every later one.
    const sliced = { include: [`${source}.*`], partSizeBytes: 40_000, maxDurationMs: 1 };
    const first = await runBackup(backupContext(client(), storage), sliced);
    if (first.status !== "checkpointed") throw new Error("expected a checkpoint");
    let result = first as Awaited<ReturnType<typeof runBackup>>;
    for (let calls = 0; result.status !== "complete" && calls < 100; calls++) {
      result = await runBackup(backupContext(client(), storage), { ...sliced, resume: first.id });
    }
    if (result.status !== "complete") throw new Error("the backup never completed");

    await runRestore(restoreContext(storage), {
      backup: result.manifest.id,
      rename: { [`${source}.*`]: `${target}.*` },
    });
    expect(await rawOf(target, "orders")).toEqual(await rawOf(source, "orders"));
  });

  it("resumes an interrupted copy exactly after its last copied embedded-document _id", async () => {
    const source = newDatabase("fob_rsrc");
    const target = newDatabase("fob_rdst");
    // More than one checkpoint chunk (10 000 documents). In JavaScript order the
    // progress `_id` `{ "-": i, "1": 0 }` becomes `{ "1": 0, "-": i }`, which sorts
    // after every `_id` ("-" < "1"): a resume from there would copy nothing more.
    const documents = Array.from({ length: 12_000 }, (_, i) =>
      ordered(["_id", ordered(["-", new Int32(i)], ["1", new Int32(0)])], ["group", i % 10]),
    );
    for (let start = 0; start < documents.length; start += 4000) {
      await client()
        .db(source)
        .collection("users")
        .insertMany(documents.slice(start, start + 4000));
    }
    // A mask function that fails after `limit` documents interrupts the copy.
    let seen = 0;
    let limit: number | undefined = 11_000;
    const options = {
      include: [`${source}.users`],
      rename: { [`${source}.*`]: `${target}.*` },
      checkpoint: join(workDir, `${target}.json`),
      mask: {
        secret: "field-order-test-secret-0123456789abcdef",
        rules: {
          [`${source}.users`]: {
            group: (value: unknown) => {
              seen += 1;
              if (limit !== undefined && seen > limit) throw new Error("interrupted on purpose");
              return value;
            },
          },
        },
      },
    };
    await expect(runCopy(copyContext(), options)).rejects.toThrow(/interrupted on purpose/);
    const copiedBefore = await client().db(target).collection("users").countDocuments();
    expect(copiedBefore).toBeGreaterThanOrEqual(10_000);
    expect(copiedBefore).toBeLessThan(12_000);

    limit = undefined;
    const resumed = await runCopy(copyContext(), { ...options, resume: true });
    expect(resumed.resumed).toBe(true);
    expect(await rawOf(target, "users")).toEqual(await rawOf(source, "users"));
  });
});

describe("stored field order in subset references", () => {
  it("follows references that are embedded documents with integer-like names", async () => {
    const source = newDatabase("fos_src");
    const target = newDatabase("fos_dst");
    const db = client().db(source);
    const referenced = ordered(["b", new Int32(1)], ["1", new Int32(2)]);
    await db
      .collection("customers")
      .insertMany([
        ordered(["_id", referenced], ["name", "referenced"]),
        ordered(
          ["_id", ordered(["b", new Int32(9)], ["1", new Int32(9)])],
          ["name", "not referenced"],
        ),
      ]);
    await db.collection("orders").insertOne(ordered(["_id", 1], ["customer", referenced]));

    await runCopy(copyContext(), {
      include: [`${source}.*`],
      rename: { [`${source}.*`]: `${target}.*` },
      subset: {
        filters: { [`${source}.orders`]: {} },
        follow: [{ from: `${source}.orders.customer`, to: `${source}.customers._id` }],
      },
    });
    const copied = await rawOf(target, "customers");
    expect(copied).toEqual(sortedBytes([BSON.serialize({ _id: referenced, name: "referenced" })]));
  });
});
