// A sharded cluster (config server + two shards + mongos, in Docker; see
// sharded-cluster.ts), used only through mongos as applications use it. Proves that
// - the deployment is recognised as sharded and every collection is discovered,
//   sharded (chunks on both shards) and unsharded alike,
// - backups of both restore byte for byte into the cluster, also into a collection
//   the user sharded beforehand,
// - converge (one cluster-wide change stream through mongos) restores exactly the
//   source as of T1 under concurrent writes to both shards,
// - snapshot backups work through mongos,
// - split collections (parts) and restore drills work.
// Skipped, not failed, without Docker.

import { setTimeout as sleep } from "node:timers/promises";
import type { Document, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { describeDeployment, discoverNamespaces } from "../../src/mongo/index.ts";
import { MongoShield } from "../../src/shield.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { isDockerAvailable } from "../helpers/docker.ts";
import { clientWithFaults, type FaultInjector } from "../helpers/faults.ts";
import { uniqueDb } from "../helpers/mongo.ts";
import { seedWorkload, startWriters, type WorkloadShape } from "../helpers/random-writes.ts";
import {
  firstDifference,
  hookedStorage,
  indexDefinitions,
  isDataFileOf,
  rawDocuments,
  slowStorage,
} from "../integration/converge-test-utils.ts";
import { type ShardedCluster, startShardedCluster } from "./sharded-cluster.ts";

const dockerAvailable = await isDockerAvailable();

let cluster: ShardedCluster;
const shields: MongoShield[] = [];
const source = uniqueDb("sh_src");

/** Documents of the fixtures. */
interface Order {
  _id: number;
  customer: number;
  total: number;
  note: string;
}

/** The cluster's client. */
function mongos(): MongoClient {
  return cluster.client;
}

/** A shield over the cluster's client and `storage`, closed after the file. */
function shieldFor(storage: MemoryStorage): MongoShield {
  const shield = new MongoShield({ source: { client: mongos() }, storage, compression: "zstd" });
  shields.push(shield);
  return shield;
}

/** Shards `database.collection` on a hashed `_id`, which spreads chunks over both shards. */
async function shardHashed(database: string, collection: string): Promise<void> {
  await mongos().db("admin").command({ enableSharding: database });
  await mongos()
    .db("admin")
    .command({ shardCollection: `${database}.${collection}`, key: { _id: "hashed" } });
}

/** The shards holding documents of a collection (`$collStats` reports one entry per shard). */
async function shardsWithDocuments(database: string, collection: string): Promise<string[]> {
  const stats = await mongos()
    .db(database)
    .collection(collection)
    .aggregate<Document>([{ $collStats: { count: {} } }])
    .toArray();
  return stats
    .filter((entry) => Number(entry.count) > 0)
    .map((entry) => String(entry.shard))
    .sort();
}

/** Every difference between `target` and `sourceDb` (as of `at`) for `collections`. */
async function differences(
  sourceDb: string,
  target: string,
  collections: readonly string[],
  at?: Manifest["consistency"]["to"],
): Promise<string[]> {
  const found: string[] = [];
  for (const name of collections) {
    const expected = await rawDocuments(mongos(), sourceDb, name, at);
    const actual = await rawDocuments(mongos(), target, name);
    const difference = firstDifference(expected, actual);
    if (difference !== undefined) found.push(`${name}: ${difference}`);
  }
  return found;
}

describe.skipIf(!dockerAvailable)("a sharded cluster (through mongos)", () => {
  beforeAll(async () => {
    cluster = await startShardedCluster();
    await shardHashed(source, "orders");
    const orders = mongos().db(source).collection<Order>("orders");
    await orders.insertMany(
      Array.from({ length: 2_000 }, (_, n) => ({
        _id: n,
        customer: n % 37,
        total: n * 3,
        note: `order ${n} `.repeat(4),
      })),
    );
    await orders.createIndex({ customer: 1, total: -1 });
    // Unsharded: lives on the database's primary shard only.
    await mongos()
      .db(source)
      .collection<{ _id: number; name: string }>("customers")
      .insertMany(Array.from({ length: 37 }, (_, n) => ({ _id: n, name: `customer ${n}` })));
  });

  afterAll(async () => {
    for (const shield of shields) await shield.close();
    await cluster?.stop();
  });

  it("is described as sharded, and discovery finds sharded and unsharded collections", async () => {
    const deployment = await describeDeployment(mongos());
    expect(deployment.topology).toBe("sharded");
    expect(deployment.supportsChangeStreams).toBe(true);
    expect(deployment.supportsSnapshotReads).toBe(true);

    const specs = await discoverNamespaces(mongos(), { include: [`${source}.*`] });
    expect(specs.map((spec) => spec.ns).sort()).toEqual([
      `${source}.customers`,
      `${source}.orders`,
    ]);
    // The hashed shard key index is an ordinary index to discovery.
    const orders = specs.find((spec) => spec.ns === `${source}.orders`);
    expect(orders?.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["_id_", "_id_hashed", "customer_1_total_-1"]),
    );
    expect(await shardsWithDocuments(source, "orders")).toEqual(cluster.shards);
  });

  it("backs up sharded and unsharded collections and restores them byte for byte", async () => {
    const storage = memoryStorage();
    const shield = shieldFor(storage);
    const { manifest } = await shield.backup({ include: [`${source}.*`] });
    expect(manifest.source.topology).toBe("sharded");
    expect(manifest.consistency.mode).toBe("converge");
    expect(manifest.totals.documents).toBe(2_037);

    const target = uniqueDb("sh_dst");
    await shield.restore({ backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } });
    expect(await differences(source, target, ["orders", "customers"])).toEqual([]);
    expect(await indexDefinitions(mongos(), target, "orders")).toEqual(
      await indexDefinitions(mongos(), source, "orders"),
    );
    // A restore creates ordinary (unsharded) collections, all on one shard: sharding
    // is a property of the target cluster, not of the data (see the next test).
    expect(await shardsWithDocuments(target, "orders")).toHaveLength(1);
    await mongos().db(target).dropDatabase();
  });

  it("restores into a collection sharded beforehand, spreading the documents again", async () => {
    const storage = memoryStorage();
    const shield = shieldFor(storage);
    const { manifest } = await shield.backup({ include: [`${source}.orders`] });
    const target = uniqueDb("sh_presharded");
    await shardHashed(target, "orders");
    const result = await shield.restore({
      backup: manifest.id,
      rename: { [`${source}.*`]: `${target}.*` },
      mode: "insert",
    });
    expect(result.documentsRestored).toBe(2_000);
    expect(await differences(source, target, ["orders"])).toEqual([]);
    expect(await shardsWithDocuments(target, "orders")).toEqual(cluster.shards);
    await mongos().db(target).dropDatabase();
  });

  it("takes snapshot backups through mongos", async () => {
    const storage = memoryStorage();
    const shield = shieldFor(storage);
    const { manifest } = await shield.backup({
      include: [`${source}.*`],
      consistency: "snapshot",
    });
    expect(manifest.consistency.mode).toBe("snapshot");
    const target = uniqueDb("sh_snap");
    await shield.restore({ backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } });
    expect(await differences(source, target, ["orders", "customers"])).toEqual([]);
    await mongos().db(target).dropDatabase();
  });

  it("splits a large sharded collection into parts and restores every part", async () => {
    const storage = memoryStorage();
    const shield = shieldFor(storage);
    const { manifest } = await shield.backup({
      include: [`${source}.orders`],
      consistency: "none",
      // About 300 KB of orders: several parts of ~64 KiB each.
      partSizeBytes: 64 * 1024,
      parallelism: 3,
    });
    const entry = manifest.namespaces.find((candidate) => candidate.ns === `${source}.orders`);
    expect(entry?.files.length ?? 0).toBeGreaterThan(1);
    const target = uniqueDb("sh_parts");
    await shield.restore({ backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } });
    expect(await differences(source, target, ["orders"])).toEqual([]);
    await mongos().db(target).dropDatabase();
  });

  it("drills a backup into temporary databases of the cluster", async () => {
    const storage = memoryStorage();
    const shield = shieldFor(storage);
    const { manifest } = await shield.backup({ include: [`${source}.*`] });
    const report = await shield.drill({
      backup: manifest.id,
      target: { client: mongos() },
      allowSameDeployment: true,
      sample: 50,
    });
    expect(report.problems, JSON.stringify(report.problems)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.documentsRestored).toBe(2_037);
    const { databases } = await mongos().db().admin().listDatabases({ nameOnly: true });
    expect(databases.some((database) => database.name.startsWith("msdrill_"))).toBe(false);
  });

  describe("converge with concurrent writes to both shards", () => {
    // No `$out` here: see the next test.
    const WORKLOAD: WorkloadShape = { collections: ["c0", "c1", "c2"], initialDocuments: 150 };

    /** Seeds a source database with c0 and c1 sharded (events from both shards). */
    async function seededSource(seed: number, shape: WorkloadShape): Promise<string> {
      const database = uniqueDb("sh_cv_src");
      await shardHashed(database, "c0");
      await shardHashed(database, "c1");
      await seedWorkload(mongos().db(database), shape, seed);
      return database;
    }

    /** A slow converge backup of `database` while three writers run. */
    async function backupUnderWrites(
      database: string,
      shape: WorkloadShape,
      seed: number,
      storage: MemoryStorage,
    ): Promise<Manifest> {
      const writers = startWriters(mongos().db(database), shape, seed, 3);
      await sleep(100);
      try {
        const { manifest } = await shieldFor(storage).backup({
          include: [`${database}.*`],
          parallelism: 2,
        });
        return manifest;
      } finally {
        await writers.stop();
      }
    }

    it.each([9_001, 9_002, 9_003])(
      "restores exactly the source as of T1 (seed %i)",
      async (seed) => {
        const database = await seededSource(seed, WORKLOAD);
        const target = uniqueDb("sh_cv_dst");
        const storage = slowStorage(memoryStorage(), 200);
        const manifest = await backupUnderWrites(database, WORKLOAD, seed, storage);
        expect(manifest.consistency.mode).toBe("converge");
        expect(manifest.changes?.events ?? 0).toBeGreaterThan(0);

        await shieldFor(storage).restore({
          backup: manifest.id,
          rename: { [`${database}.*`]: `${target}.*` },
        });
        expect(
          await differences(database, target, WORKLOAD.collections, manifest.consistency.to),
        ).toEqual([]);
        await mongos().db(database).dropDatabase();
        await mongos().db(target).dropDatabase();
      },
    );

    it("converges when $out replaces a collection during the window", async () => {
      // `$out` into an unsharded collection renames a scratch collection over it. When
      // the scratch collection was created before the window, the capture reads the
      // destination as of the rename (snapshot read), which a shard refuses: the
      // sharded rename commits its catalog change after the event's cluster time
      // (SnapshotUnavailable, "has undergone a catalog change"). The capture then
      // reads it a little later (never after T1), and the backup must still be exact.
      const shape: WorkloadShape = { ...WORKLOAD, outCollection: "summary" };
      const database = await seededSource(9_100, shape);
      const db = mongos().db(database);
      const storage = slowStorage(memoryStorage(), 200);
      // The writers rebuild `summary` with $out over and over, as in the harness, so
      // some rebuild always straddles the window start.
      const manifest = await backupUnderWrites(database, shape, 9_100, storage);
      const target = uniqueDb("sh_out_dst");
      await shieldFor(storage).restore({
        backup: manifest.id,
        rename: { [`${database}.*`]: `${target}.*` },
      });
      const at = manifest.consistency.to;
      expect(await differences(database, target, WORKLOAD.collections, at)).toEqual([]);
      // The reference itself is a snapshot read at T1, which a shard refuses for the
      // same reason when `summary` was replaced again right after T1; compare it when
      // it can be read.
      const summary = await differences(database, target, ["summary"], at).catch(
        (error: unknown) => {
          if (!String(error).includes("catalog change")) throw error;
          return [];
        },
      );
      expect(summary).toEqual([]);
      await mongos().db(target).dropDatabase();
      await db.dropDatabase();
    });

    it("records a renamed collection that is replaced again before the capture reads it", async () => {
      // `z_last` is renamed to `z_moved` before its dump, so the capture must record
      // `z_moved` as of the rename. The read is held back until `z_moved` has been
      // replaced again (as a `$out` loop does): the shard then refuses the read as of
      // the first rename ("has undergone a catalog change"), and the capture reads at
      // a later time instead, which still converges.
      const database = uniqueDb("sh_ren_src");
      const target = uniqueDb("sh_ren_dst");
      const db = mongos().db(database);
      await db.collection<Order>("a").insertOne({ _id: 1, customer: 1, total: 1, note: "a" });
      await db
        .collection<Order>("z_last")
        .insertMany(
          Array.from({ length: 20 }, (_, n) => ({ _id: n, customer: n, total: n, note: "z" })),
        );
      let renamed = false;
      let replaced = false;
      const storage = hookedStorage(memoryStorage(), async (key) => {
        if (renamed || !isDataFileOf(key, "a")) return;
        renamed = true;
        await db.collection<Order>("z_last").rename("z_moved");
      });
      const holdFirstRead: FaultInjector = async (command) => {
        const atClusterTime: unknown = command.readConcern?.atClusterTime;
        if (command.find !== "z_moved" || atClusterTime === undefined || replaced) return undefined;
        replaced = true;
        await db
          .collection<Order>("a")
          .aggregate([{ $set: { note: "replaced" } }, { $out: "z_moved" }])
          .toArray();
        return undefined;
      };
      const debug: string[] = [];
      const logger = { ...silentLogger, debug: (message: string) => debug.push(message) };
      const shield = new MongoShield({
        source: { client: clientWithFaults(mongos(), holdFirstRead) },
        storage,
        logger,
      });
      shields.push(shield);
      const { manifest } = await shield.backup({
        include: [`${database}.*`],
        consistency: "converge",
        parallelism: 1,
      });
      expect(renamed && replaced).toBe(true);
      expect(debug).toContain("Reading a rename's destination at a later time");

      await shieldFor(storage).restore({
        backup: manifest.id,
        rename: { [`${database}.*`]: `${target}.*` },
      });
      expect(await differences(database, target, ["a", "z_moved"])).toEqual([]);
      await db.dropDatabase();
      await mongos().db(target).dropDatabase();
    });
  });
});
