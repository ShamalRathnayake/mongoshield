// Integration tests for what change events cannot carry and an incremental chain still
// restores (FORMAT.md, "Incremental backups"): time series writes after the base (each
// incremental copies its time series whole), collection option and index property
// changes made with collMod (validators, TTL, hidden indexes), and view definitions
// changed, created or dropped after the base (each incremental records every
// namespace's metadata).

import {
  type Db,
  type DbOptions,
  type Document,
  type MongoClient,
  MongoServerError,
  type RunCommandOptions,
} from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { deserializeInStoredOrder } from "../../src/format/field-order.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { stringifyExtendedJson } from "../../src/format/ordered-json.ts";
import { silentLogger } from "../../src/logger.ts";
import { MongoShield } from "../../src/shield.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { BackupOptions } from "../../src/types.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import { type AnyDocument, firstDifference } from "./converge-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

function newDatabase(prefix: string): string {
  const name = uniqueDb(prefix);
  databases.push(name);
  return name;
}

async function backup(
  storage: MemoryStorage,
  database: string,
  options: Partial<BackupOptions> = {},
): Promise<Manifest> {
  const result = await runBackup(backupContext(client(), storage), {
    include: [`${database}.*`],
    ...options,
  });
  if (result.status !== "complete") throw new Error("expected a complete backup");
  return result.manifest;
}

/** `listCollections` of a database: name → its info, read in stored field order. */
async function namespaces(database: string): Promise<Map<string, Document>> {
  const reply = await client()
    .db(database)
    .command({ listCollections: 1 }, { fieldsAsRaw: { firstBatch: true } });
  const infos = (reply.cursor.firstBatch as Uint8Array[]).map((raw) =>
    deserializeInStoredOrder(raw),
  );
  return new Map(
    infos
      .filter((info) => !String(info.name).startsWith("system."))
      .map((info) => [String(info.name), info]),
  );
}

/**
 * Every measurement of a time series, sorted by `_id`, as canonical Extended JSON with
 * sorted keys: the server unpacks measurements from its buckets in a field order of its
 * own (open and closed buckets differ), for the source as for any restore of it.
 */
async function timeSeries(database: string, collection: string): Promise<string[]> {
  const documents = await client()
    .db(database)
    .collection(collection)
    .find({}, { sort: { _id: 1 }, promoteValues: false })
    .toArray();
  return documents.map((document) => {
    const sorted = Object.fromEntries(
      Object.entries(document).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    return stringifyExtendedJson(sorted, { relaxed: false });
  });
}

/** What a restore must reproduce besides documents: types, options, view definitions. */
async function definitions(database: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, info] of await namespaces(database)) {
    const { uuid: _uuid, ...options } = info.options as Document;
    result[name] = `${info.type} ${stringifyExtendedJson(options, { relaxed: false })}`;
  }
  return result;
}

/** Index name → its TTL and hidden flag (what collMod can change in place). */
async function indexProperties(database: string, collection: string): Promise<string[]> {
  const indexes = await client().db(database).collection(collection).listIndexes().toArray();
  return indexes
    .map(
      (index) =>
        `${index.name} ttl=${index.expireAfterSeconds ?? "-"} hidden=${index.hidden === true}`,
    )
    .sort();
}

/**
 * Every document of a collection or time series, sorted by `_id`, as raw BSON. (A
 * time series refuses `singleBatch`, which the converge helper uses.)
 */
async function measurements(database: string, collection: string): Promise<Buffer[]> {
  const documents = await client()
    .db(database)
    .collection(collection)
    .find({}, { raw: true, sort: { _id: 1 } })
    .toArray();
  return documents.map((document) => Buffer.from(document as unknown as Uint8Array));
}

describe("incremental chains and what change events do not carry", () => {
  it("restore time series, collMod changes and views as of the newest member", async () => {
    const source = newDatabase("incs_src");
    const db = client().db(source);
    // A validator with an integer-like field name: its field order must survive.
    await db.createCollection("orders", {
      validator: { b: { $exists: true }, "2": { $exists: false } },
    });
    await db
      .collection<AnyDocument>("orders")
      .insertMany(Array.from({ length: 10 }, (_, n) => ({ _id: n, b: n, createdAt: new Date() })));
    await db.collection("orders").createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
    await db.collection("orders").createIndex({ b: 1 });
    await db.createCollection("metrics", { timeseries: { timeField: "t", metaField: "k" } });
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 10, minute));
    await db
      .collection("metrics")
      .insertMany(Array.from({ length: 5 }, (_, n) => ({ t: at(n), k: "a", v: n })));
    await db.createCollection("big", {
      viewOn: "orders",
      pipeline: [{ $match: { b: { $gt: 5 } } }],
    });
    await db.createCollection("gone", { viewOn: "orders", pipeline: [] });

    const storage = memoryStorage();
    const base = await backup(storage, source, { consistency: "converge" });

    // After the base: time series writes (and a new time series), collMod of the
    // validator, the TTL and a hidden index, a redefined, a new and a dropped view.
    await db
      .collection("metrics")
      .insertMany(Array.from({ length: 4 }, (_, n) => ({ t: at(10 + n), k: "b", v: n })));
    await db.createCollection("metrics2", { timeseries: { timeField: "t" } });
    await db.collection("metrics2").insertOne({ t: at(30), v: 1 });
    await db.command({
      collMod: "orders",
      validator: { b: { $type: "number" }, "10": { $exists: false } },
      validationAction: "warn",
    });
    await db.command({
      collMod: "orders",
      index: { keyPattern: { createdAt: 1 }, expireAfterSeconds: 7200 },
    });
    await db.command({ collMod: "orders", index: { name: "b_1", hidden: true } });
    await db.command({
      collMod: "big",
      viewOn: "orders",
      pipeline: [{ $match: { b: { $gt: 7 } } }],
    });
    await db.createCollection("small", {
      viewOn: "orders",
      pipeline: [{ $match: { b: { $lt: 3 } } }],
    });
    await db.collection("gone").drop();
    const first = await backup(storage, source, { incremental: true });
    const afterFirst = {
      definitions: await definitions(source),
      metrics: await timeSeries(source, "metrics"),
    };

    await db
      .collection("metrics")
      .insertMany(Array.from({ length: 3 }, (_, n) => ({ t: at(20 + n), k: "c", v: n })));
    const second = await backup(storage, source, { incremental: true });

    expect(first.namespaces.find((entry) => entry.collection === "metrics")).toMatchObject({
      type: "timeseries",
      content: "full",
      documents: 9,
    });
    expect(first.namespaces.find((entry) => entry.collection === "orders")?.content).toBe(
      "metadata",
    );
    // The time series snapshot is where the incremental ends.
    expect(second.consistency.from).toEqual(first.consistency.to);
    expect(base.namespaces.find((entry) => entry.collection === "metrics")?.documents).toBe(5);

    // The newest member: everything as the source is now.
    const target = newDatabase("incs_dst");
    await runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: second.id, rename: { [`${source}.*`]: `${target}.*` } },
    );
    // Time series writes after the base: 5 in the base, 4 + 3 after it.
    expect(await client().db(target).collection("metrics").countDocuments()).toBe(12);
    expect(await definitions(target)).toEqual(await definitions(source));
    expect(await indexProperties(target, "orders")).toEqual(
      await indexProperties(source, "orders"),
    );
    expect(
      firstDifference(await measurements(source, "orders"), await measurements(target, "orders")),
    ).toBeUndefined();
    for (const name of ["metrics", "metrics2"]) {
      expect(await timeSeries(target, name), name).toEqual(await timeSeries(source, name));
    }
    expect(await client().db(target).collection("big").countDocuments()).toBe(2);

    // find, diff and drill read the chain's time series from the incremental's copy.
    const shield = new MongoShield({ source: { uri: mongoUri() }, storage });
    const found = [];
    for await (const document of shield.find({
      backup: second.id,
      namespace: `${source}.metrics`,
    })) {
      found.push(document);
    }
    expect(found).toHaveLength(12);
    const diff = await shield.diff({ from: base.id, to: second.id });
    const metricsDiff = diff.namespaces.find((entry) => entry.namespace === `${source}.metrics`);
    expect(metricsDiff?.documents).toMatchObject({ from: 5, to: 12, added: 7 });
    expect(diff.namespaces.find((entry) => entry.namespace === `${source}.gone`)?.presence).toBe(
      "only-from",
    );
    const drill = await shield.drill({
      backup: second.id,
      target: { uri: mongoUri() },
      allowSameDeployment: true,
    });
    expect(drill.ok, JSON.stringify(drill.problems)).toBe(true);
    await shield.close();

    // A member in the middle: its own time series copy and metadata.
    const middle = newDatabase("incs_mid");
    await runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: first.id, rename: { [`${source}.*`]: `${middle}.*` } },
    );
    expect(await definitions(middle)).toEqual(afterFirst.definitions);
    expect(await timeSeries(middle, "metrics")).toEqual(afterFirst.metrics);
  });
});

describe("time series that cannot be read consistently", () => {
  /** The client, with every snapshot read refused as too old (SnapshotTooOld, code 239). */
  function clientWithoutSnapshots(real: MongoClient): MongoClient {
    const wrapDb = (db: Db): Db =>
      new Proxy(db, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (property !== "command")
            return typeof value === "function" ? value.bind(target) : value;
          return async (command: Document, options?: RunCommandOptions) => {
            if (options?.session?.snapshotEnabled === true) {
              throw new MongoServerError({
                message: "Read timestamp is older than the oldest available timestamp.",
                code: 239,
                codeName: "SnapshotTooOld",
              });
            }
            return target.command(command, options);
          };
        },
      });
    return new Proxy(real, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property !== "db") return typeof value === "function" ? value.bind(target) : value;
        return (name?: string, options?: DbOptions) => wrapDb(target.db(name, options));
      },
    });
  }

  it("fail the incremental (never a silent omission), or take a full backup with fallbackToFull", async () => {
    const source = newDatabase("incs_ts_fail");
    const db = client().db(source);
    await db.createCollection("metrics", { timeseries: { timeField: "t" } });
    await db.collection("metrics").insertOne({ t: new Date(), v: 1 });
    const storage = memoryStorage();
    await backup(storage, source, { consistency: "converge" });

    const refusing = clientWithoutSnapshots(client());
    const failed = await runBackup(backupContext(refusing, storage), {
      include: [`${source}.*`],
      incremental: true,
    }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: "MS_SNAPSHOT_TOO_OLD" });

    const full = await runBackup(backupContext(refusing, storage), {
      include: [`${source}.*`],
      incremental: { fallbackToFull: true },
    });
    expect(full.status === "complete" && full.manifest.kind).toBeUndefined();
    expect(full.status === "complete" && full.fullBackupReason).toContain("snapshot");
  });
});
