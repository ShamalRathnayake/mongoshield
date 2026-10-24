// `mongodump --oplog` → importMongodump → mongoshield restore, with writes running
// during the dump: the imported backup must restore exactly the state at the end of
// the dump's oplog (T1), as `mongorestore --oplogReplay` would.
//
// mongodump --oplog only dumps whole deployments, and refuses to finish when a rename
// happens meanwhile, so this test runs its own single-node replica set instead of the
// shared one (whose other tests rename collections all the time). Expected data is
// read from that server as of T1 with a snapshot read; every restored collection must
// match it byte for byte.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Binary, Int32, Long, MongoClient, Timestamp } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRestore } from "../../src/engine/restore.ts";
import type { ClusterTime } from "../../src/format/manifest.ts";
import {
  type ImportResult,
  importMongodump,
  type MongodumpSource,
} from "../../src/interop/import.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { tool, toolsMissing } from "../helpers/mongo-tools.ts";
import {
  type AnyDocument,
  collectionNames,
  firstDifference,
  rawDocuments,
} from "./converge-test-utils.ts";

const DATABASE = "shop";

/** Thousands of 1 KB documents in `shop.filler`, so the dump takes long enough for many writes. */
const FILLER_BATCHES = 60;

/** Documents of the test collections: numeric ids, and the fields the writes change. */
interface Row {
  _id: number;
  total?: number | Int32;
  left?: number;
  items?: number[];
  note?: string;
  customer?: { name: string; city: string };
  status?: string;
  reserved?: boolean;
  touched?: Long;
  flag?: string;
  replaced?: boolean;
  at?: Date;
  sku?: Binary;
  pad?: string;
}

/** A tiny deterministic random generator, so a failure can be reproduced. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/**
 * Keeps changing `shop` until `stop` resolves: inserts, `$set` / `$unset` / `$inc` /
 * `$push` updates (version 2 diffs), array element updates and truncations,
 * replacements, deletes, multi-document transactions, an index, and a collection
 * created, filled and dropped during the dump. (Numeric field names are left out:
 * restore inserts documents through JavaScript objects, which put integer-like keys
 * first; oplog-events.test.ts covers their conversion.)
 */
async function writeUntil(mongo: MongoClient, stop: Promise<unknown>): Promise<number> {
  const next = random(42);
  const db = mongo.db(DATABASE);
  const orders = db.collection<Row>("orders");
  const stock = db.collection<Row>("stock");
  let stopped = false;
  void stop.finally(() => {
    stopped = true;
  });
  let writes = 0;
  let id = 100_000;
  while (!stopped) {
    const target = Math.floor(next() * 2000);
    switch (Math.floor(next() * 11)) {
      case 0:
        await orders.insertOne({
          _id: id++,
          total: new Int32(writes),
          items: [1, 2, 3],
          note: "new",
        });
        break;
      case 1:
        await orders.updateOne(
          { _id: target },
          { $set: { "customer.city": `c${writes}`, status: "paid" } },
        );
        break;
      case 2:
        await orders.updateOne({ _id: target }, { $unset: { note: "" }, $inc: { total: 1 } });
        break;
      case 3:
        await orders.updateOne(
          { _id: target, items: { $type: "array" } },
          { $push: { items: writes } },
        );
        break;
      case 4:
        await orders.updateOne(
          { _id: target, items: { $type: "array" } },
          { $set: { "items.0": -1, flag: "set by position" } },
        );
        break;
      case 5:
        // A pipeline update that truncates an array (truncatedArrays in the diff).
        await orders.updateOne({ _id: target, items: { $type: "array" } }, [
          { $set: { items: { $slice: ["$items", 1] } } },
        ]);
        break;
      case 6:
        await orders.replaceOne(
          { _id: target },
          { replaced: true, at: new Date(1_767_225_600_000 + writes) },
        );
        break;
      case 7:
        await orders.deleteOne({ _id: target });
        break;
      case 8: {
        const session = mongo.startSession();
        try {
          await session.withTransaction(async () => {
            await orders.updateOne({ _id: target }, { $set: { reserved: true } }, { session });
            await stock.updateOne({ _id: target % 100 }, { $inc: { left: -1 } }, { session });
          });
        } finally {
          await session.endSession();
        }
        break;
      }
      case 9:
        await stock.updateMany(
          { _id: { $lt: 10 } },
          { $set: { touched: Long.fromNumber(writes) } },
        );
        break;
      default:
        await stock.insertOne({ _id: id++, sku: new Binary(Buffer.from([writes & 255])), left: 5 });
    }
    writes += 1;
    if (writes === 50) {
      await db.createCollection("pending");
      await db
        .collection<AnyDocument>("pending")
        .insertMany([{ _id: 1 }, { _id: 2, during: true }]);
      await orders.createIndex({ status: 1 }, { name: "by_status" });
    }
    if (writes === 120) await db.collection<AnyDocument>("pending").drop();
    if (writes === 150) {
      await db.createCollection("late");
      await db.collection<AnyDocument>("late").insertOne({ _id: "made during the dump" });
    }
  }
  return writes;
}

describe.skipIf(toolsMissing)("mongodump --oplog with writes during the dump", () => {
  let replSet: MongoMemoryReplSet;
  let uri: string;
  let mongo: MongoClient;
  const temporaryPaths: string[] = [];

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await replSet.waitUntilRunning();
    uri = replSet.getUri();
    mongo = new MongoClient(uri);
  });

  afterAll(async () => {
    await mongo?.close();
    await replSet?.stop();
    for (const path of temporaryPaths) await rm(path, { recursive: true, force: true });
  });

  /** Fresh data, then mongodump with writes running until it is done. */
  async function dumpWhileWriting(args: (directory: string) => string[]): Promise<MongodumpSource> {
    await mongo.db(DATABASE).dropDatabase();
    const orders = Array.from(
      { length: 2000 },
      (_, index): Row => ({
        _id: index,
        total: new Int32(index),
        items: [index, index + 1, index + 2],
        customer: { name: `n${index}`, city: "x" },
        note: "x".repeat(2000),
      }),
    );
    await mongo.db(DATABASE).collection<Row>("orders").insertMany(orders);
    await mongo
      .db(DATABASE)
      .collection<Row>("stock")
      .insertMany(Array.from({ length: 100 }, (_, index) => ({ _id: index, left: 100 })));
    // A large collection that is never written to keeps mongodump busy while the writes run.
    const filler = Array.from({ length: 1000 }, (_, index) => ({
      _id: index,
      pad: "p".repeat(1000),
    }));
    for (let batch = 0; batch < FILLER_BATCHES; batch += 1) {
      await mongo
        .db(DATABASE)
        .collection<Row>("filler")
        .insertMany(filler.map((document) => ({ ...document, _id: batch * 1000 + document._id })));
    }

    const directory = await mkdtemp(join(tmpdir(), "mongoshield-interop-oplog-"));
    temporaryPaths.push(directory);
    const dump = tool(
      "mongodump",
      ["--oplog", "--numParallelCollections", "1", ...args(directory)],
      { uri },
    );
    const writes = await writeUntil(
      mongo,
      dump.catch(() => undefined),
    );
    await dump;
    expect(writes).toBeGreaterThan(0);
    return args(directory).some((arg) => arg.startsWith("--archive"))
      ? { archive: join(directory, "dump.archive") }
      : { directory: join(directory, "dump") };
  }

  /** Every collection of `shop` as of `time`. */
  /**
   * The collections of `shop` as of `time`. listCollections has no snapshot reads, so
   * they are worked out from the server's oplog: creates, drops and database drops up
   * to `time` (a collection the writes create or drop just after the dump may not
   * have existed then).
   */
  async function collectionsAt(time: ClusterTime): Promise<string[]> {
    const ddl = await mongo
      .db("local")
      .collection("oplog.rs")
      .find({
        ns: `${DATABASE}.$cmd`,
        ts: { $lte: new Timestamp({ t: time.t, i: time.i }) },
        $or: [
          { "o.create": { $exists: true } },
          { "o.drop": { $exists: true } },
          { "o.dropDatabase": { $exists: true } },
        ],
      })
      .sort({ $natural: 1 })
      .toArray();
    const names = new Set<string>();
    for (const entry of ddl) {
      const command = entry.o as { create?: string; drop?: string; dropDatabase?: number };
      if (command.dropDatabase !== undefined) names.clear();
      else if (command.create !== undefined) names.add(command.create);
      else if (command.drop !== undefined) names.delete(command.drop);
    }
    return [...names].sort();
  }

  async function stateAt(time: ClusterTime): Promise<Record<string, Buffer[]>> {
    const state: Record<string, Buffer[]> = {};
    for (const name of await collectionsAt(time)) {
      state[name] = await rawDocuments(mongo, DATABASE, name, time);
    }
    return state;
  }

  async function expectRestoredAsOfTheOplogEnd(
    storage: StorageAdapter,
    result: ImportResult,
  ): Promise<void> {
    const { consistency } = result.manifest;
    expect(consistency.mode).toBe("converge");
    const to = consistency.to;
    if (to === undefined) throw new Error("no consistency.to");
    expect(result.manifest.changes?.events).toBeGreaterThan(0);
    const expected = await stateAt(to);

    const target = "shop_restored";
    await mongo.db(target).dropDatabase();
    await runRestore(
      { client: mongo, storage, logger: silentLogger },
      {
        backup: result.id,
        include: [`${DATABASE}.*`],
        rename: { [`${DATABASE}.*`]: `${target}.*` },
      },
    );
    expect(await collectionNames(mongo, target)).toEqual(Object.keys(expected).sort());
    for (const [name, documents] of Object.entries(expected)) {
      const restored = await rawDocuments(mongo, target, name);
      expect(firstDifference(documents, restored), name).toBeUndefined();
    }
  }

  it("restores a dump directory with its oplog as of the end of the dump", async () => {
    const dump = await dumpWhileWriting((directory) => ["--out", join(directory, "dump")]);
    const storage = memoryStorage();
    const result = await importMongodump(dump, storage, { include: [`${DATABASE}.*`] });
    await expectRestoredAsOfTheOplogEnd(storage, result);
  });

  it("restores a gzipped archive with its oplog as of the end of the dump", async () => {
    const dump = await dumpWhileWriting((directory) => [
      `--archive=${join(directory, "dump.archive")}`,
      "--gzip",
    ]);
    const storage = memoryStorage();
    const result = await importMongodump(dump, storage, { include: [`${DATABASE}.*`] });
    await expectRestoredAsOfTheOplogEnd(storage, result);
  });

  it("imports the collections as read when asked to ignore the oplog", async () => {
    const dump = await dumpWhileWriting((directory) => ["--out", join(directory, "dump")]);
    const storage = memoryStorage();
    const result = await importMongodump(dump, storage, {
      include: [`${DATABASE}.*`],
      ignoreOplog: true,
    });
    expect(result.manifest.consistency.mode).toBe("none");
    expect(result.manifest.changes).toBeUndefined();
    expect(result.skipped.map((item) => item.reason)).toContainEqual(
      expect.stringContaining("ignoreOplog"),
    );
  });
});
