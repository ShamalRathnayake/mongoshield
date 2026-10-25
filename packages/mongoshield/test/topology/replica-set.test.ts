// A 3-member replica set: what real users run, unlike the single-node set every other
// test uses. Proves that
// - the default read preference (secondaryPreferred) really keeps data reads off the
//   primary (seen through command monitoring: the driver reports each command's member),
//   and a secondary that lags behind the window start waits for it instead of failing,
// - a converge backup taken from secondaries while writers hammer the primary restores
//   exactly the source as of T1 (the randomized harness's workload, compared byte for
//   byte with a snapshot read at T1),
// - the change journal and a point-in-time restore work across members,
// - a primary step-down in the middle of a backup either leaves a correct backup or
//   fails with a typed, retryable error and no committed manifest, and the scheduler
//   retries such a failure into a successful run.

import { setTimeout as sleep } from "node:timers/promises";
import type { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listBackups } from "../../src/catalog/catalog.ts";
import { readClusterTime } from "../../src/engine/converge-time.ts";
import { isMongoShieldError, MongoShieldError } from "../../src/errors.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { isTransientError } from "../../src/schedule/retry.ts";
import { runScheduledJob } from "../../src/schedule/runner.ts";
import { MongoShield } from "../../src/shield.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { BackupOptions } from "../../src/types.ts";
import { uniqueDb } from "../helpers/mongo.ts";
import { seedWorkload, startWriters, type WorkloadShape } from "../helpers/random-writes.ts";
import {
  collectionNames,
  firstDifference,
  hookedStorage,
  rawDocuments,
  slowStorage,
} from "../integration/converge-test-utils.ts";
import { startTestJournal, waitForJournalToCatchUp } from "../integration/journal-test-utils.ts";
import {
  failCommandsOnEveryMember,
  monitoredClient,
  pauseReplication,
  type ReplicaSetDeployment,
  startReplicaSet,
} from "./deployments.ts";

let deployment: ReplicaSetDeployment;
const shields: MongoShield[] = [];

beforeAll(async () => {
  deployment = await startReplicaSet({ members: 3 });
});

afterAll(async () => {
  for (const shield of shields) await shield.close();
  await deployment?.stop();
});

/** A shield over `client` and `storage`, closed after the file. */
function shieldFor(client: MongoClient, storage: MemoryStorage): MongoShield {
  const shield = new MongoShield({ source: { client }, storage, compression: "zstd" });
  shields.push(shield);
  return shield;
}

/** Documents of the small fixtures: numeric ids. */
interface Numbered {
  _id: number;
  total?: number;
}

/** The harness's workload, smaller: this suite runs on three members. */
const WORKLOAD: WorkloadShape = {
  collections: ["c0", "c1", "c2"],
  outCollection: "summary",
  initialDocuments: 150,
};
const ALL_COLLECTIONS = [...WORKLOAD.collections, "summary"];

/** Compares every collection of `target` with `source` as of `at` (raw BSON). */
async function differencesFromSource(
  source: string,
  target: string,
  at: Manifest["consistency"]["to"],
): Promise<string[]> {
  if (at === undefined) throw new Error("no cluster time to compare at");
  const differences: string[] = [];
  for (const name of ALL_COLLECTIONS) {
    const expected = await rawDocuments(deployment.admin, source, name, at);
    const actual = await rawDocuments(deployment.admin, target, name);
    const difference = firstDifference(expected, actual);
    if (difference !== undefined) differences.push(`${name}: ${difference}`);
  }
  return differences;
}

/** How many committed backups (manifests) the storage holds. */
async function committedBackups(storage: MemoryStorage): Promise<number> {
  const entries = await listBackups(storage);
  return entries.filter((entry) => entry.status === "complete").length;
}

describe("read preference on a 3-member replica set", () => {
  it("reads every collection from a secondary by default", async () => {
    const database = uniqueDb("rs_reads");
    await deployment.admin
      .db(database)
      .collection<Numbered>("orders")
      .insertMany(Array.from({ length: 500 }, (_, n) => ({ _id: n, total: n })));
    await deployment.admin
      .db(database)
      .collection<Numbered>("users")
      .insertMany(Array.from({ length: 100 }, (_, n) => ({ _id: n })));
    const primary = await deployment.primary();
    const { client, commands } = monitoredClient(deployment);
    const shield = shieldFor(client, memoryStorage());

    const backup = await shield.backup({ include: [`${database}.*`] });
    expect(backup.manifest.consistency.mode).toBe("converge");
    expect(backup.manifest.totals.documents).toBe(600);

    const dataReads = commands.filter(
      (seen) => seen.database === database && (seen.name === "find" || seen.name === "getMore"),
    );
    expect(dataReads.map((seen) => seen.command.find ?? seen.command.collection)).toEqual(
      expect.arrayContaining(["orders", "users"]),
    );
    for (const read of dataReads) {
      expect(read.address, `${read.name} went to the primary`).not.toBe(primary);
      expect(deployment.hosts).toContain(read.address);
    }
    // Converge reads are causally consistent from T0, so a lagging secondary waits
    // for the window start instead of returning older data.
    const finds = dataReads.filter((seen) => seen.name === "find");
    for (const find of finds) {
      expect(find.command.readConcern?.afterClusterTime).toBeDefined();
    }
    await deployment.admin.db(database).dropDatabase();
  });

  it("reads from the primary when readPreference is primary", async () => {
    const database = uniqueDb("rs_primary");
    await deployment.admin.db(database).collection<Numbered>("orders").insertOne({ _id: 1 });
    const primary = await deployment.primary();
    const { client, commands } = monitoredClient(deployment);
    const shield = shieldFor(client, memoryStorage());

    await shield.backup({ include: [`${database}.*`], readPreference: "primary" });
    const finds = commands.filter((seen) => seen.database === database && seen.name === "find");
    expect(finds.length).toBeGreaterThan(0);
    for (const find of finds) expect(find.address).toBe(primary);
    await deployment.admin.db(database).dropDatabase();
  });
});

describe("a secondary that lags the primary", () => {
  // Members normally learn the primary's cluster time from heartbeats and replication
  // within milliseconds, which hides the race this proves fixed: a secondary refuses
  // `afterClusterTime` later than its own clock. Slow heartbeats plus paused
  // replication keep the secondaries' clocks behind for as long as the test needs.
  let lagging: ReplicaSetDeployment;
  beforeAll(async () => {
    lagging = await startReplicaSet({ members: 3 });
    // Reconfigured once a primary exists: a long election timeout from the start
    // would delay the first election by as much.
    const reply = await lagging.admin.db("admin").command({ replSetGetConfig: 1 });
    const config = reply.config;
    config.version += 1;
    config.settings = {
      ...config.settings,
      heartbeatIntervalMillis: 60_000,
      electionTimeoutMillis: 120_000,
    };
    await lagging.admin.db("admin").command({ replSetReconfig: config });
  });
  afterAll(async () => {
    await lagging?.stop();
  });

  it("waits for lagging secondaries to reach T0 instead of failing the read", async () => {
    const source = uniqueDb("rs_lag");
    const orders = lagging.admin.db(source).collection<Numbered>("orders");
    await orders.insertMany(Array.from({ length: 50 }, (_, n) => ({ _id: n })));
    // The secondaries stop replicating; the primary moves on without them.
    const resume = await pauseReplication(lagging);
    let resumed = false;
    try {
      await orders.insertOne({ _id: 50 }, { writeConcern: { w: 1 } });
      const { client, commands } = monitoredClient(lagging);
      const shield = shieldFor(client, memoryStorage());
      const backup = shield.backup({ include: [`${source}.*`] });
      // Let replication go once the dump has asked a secondary for its documents.
      while (!commands.some((seen) => seen.database === source && seen.name === "find")) {
        await sleep(50);
      }
      await sleep(500);
      await resume();
      resumed = true;
      const { manifest } = await backup;
      expect(manifest.consistency.mode).toBe("converge");
      // The document written while the secondaries lagged is in the backup.
      expect(manifest.totals.documents).toBe(51);
    } finally {
      if (!resumed) await resume();
      await lagging.admin.db(source).dropDatabase();
    }
  });
});

describe("converge on a 3-member replica set", () => {
  it.each([7_001, 7_002, 7_003])(
    "restores exactly the source as of T1 under concurrent writes (seed %i)",
    async (seed) => {
      const source = uniqueDb("rs_cv_src");
      const target = uniqueDb("rs_cv_dst");
      const db = deployment.admin.db(source);
      await seedWorkload(db, WORKLOAD, seed);
      const { client, commands } = monitoredClient(deployment);
      const storage = slowStorage(memoryStorage(), 200);
      const shield = shieldFor(client, storage);
      const primary = await deployment.primary();

      const writers = startWriters(db, WORKLOAD, seed, 3);
      await sleep(50);
      let manifest: Manifest;
      try {
        ({ manifest } = await shield.backup({ include: [`${source}.*`], parallelism: 2 }));
      } finally {
        await writers.stop();
      }
      expect(manifest.consistency.mode).toBe("converge");
      expect(manifest.changes?.events ?? 0).toBeGreaterThan(0);
      // The data came from secondaries even though the writes went to the primary.
      // (Snapshot reads, which the capture makes for `$out` renames, go to the primary
      // by design: that is where the snapshot's time is pinned.)
      const finds = commands.filter(
        (seen) =>
          seen.database === source &&
          seen.name === "find" &&
          seen.command.readConcern?.level !== "snapshot",
      );
      expect(finds.length).toBeGreaterThan(0);
      const onPrimary = finds.filter((find) => find.address === primary);
      expect(onPrimary.map((find) => JSON.stringify(find.command))).toEqual([]);

      await shield.restore({
        backup: manifest.id,
        target: { client: deployment.admin },
        rename: { [`${source}.*`]: `${target}.*` },
      });
      expect(await differencesFromSource(source, target, manifest.consistency.to)).toEqual([]);
      await db.dropDatabase();
      await deployment.admin.db(target).dropDatabase();
    },
  );
});

describe("the journal on a 3-member replica set", () => {
  it("restores a base backup plus the journal to a point in time, exactly", async () => {
    const source = uniqueDb("rs_pitr_src");
    const target = uniqueDb("rs_pitr_dst");
    const storage = memoryStorage();
    const db = deployment.admin.db(source);
    await seedWorkload(db, WORKLOAD, 7_100);
    const journal = await startTestJournal(deployment.admin, storage, source);
    try {
      const shield = shieldFor(deployment.admin, storage);
      const writers = startWriters(db, WORKLOAD, 7_100, 2);
      try {
        await shield.backup({ include: [`${source}.*`] });
        await sleep(1_500); // writes after the base backup, over a segment boundary or two
      } finally {
        await writers.stop();
      }
      const beforeDisaster = await readClusterTime(deployment.admin);
      for (const name of WORKLOAD.collections) await db.collection(name).deleteMany({});
      await waitForJournalToCatchUp(deployment.admin, storage, 60_000);

      const result = await shield.restore({
        backup: "latest",
        at: beforeDisaster,
        target: { client: deployment.admin },
        rename: { [`${source}.*`]: `${target}.*` },
      });
      expect(result.pointInTime?.restoredTo).toEqual(beforeDisaster);
      expect(await collectionNames(deployment.admin, target)).toEqual(
        (await collectionNames(deployment.admin, source)).filter(
          (name) => !name.startsWith("tmp."),
        ),
      );
      expect(await differencesFromSource(source, target, beforeDisaster)).toEqual([]);
    } finally {
      await journal.stop();
      await db.dropDatabase();
      await deployment.admin.db(target).dropDatabase();
    }
  });

  it("keeps journaling across a primary step-down", async () => {
    const source = uniqueDb("rs_jstep");
    const storage = memoryStorage();
    const orders = deployment.admin.db(source).collection<{ _id: number }>("orders");
    await orders.insertOne({ _id: 0 });
    const journal = await startTestJournal(deployment.admin, storage, source);
    try {
      await waitForJournalToCatchUp(deployment.admin, storage, 60_000);
      await deployment.stepDown();
      await orders.insertOne({ _id: 1 });
      // The writer reopens its change stream on the new primary and catches up.
      await waitForJournalToCatchUp(deployment.admin, storage, 120_000);
      expect(journal.status().failure).toBeUndefined();
    } finally {
      await journal.stop();
      await deployment.admin.db(source).dropDatabase();
    }
  });
});

describe("a primary step-down during a backup", () => {
  it.each(["secondaryPreferred", "primary"] as const)(
    "either completes correctly or fails retryably without a manifest (readPreference %s)",
    async (readPreference) => {
      const source = uniqueDb("rs_step_src");
      const target = uniqueDb("rs_step_dst");
      const db = deployment.admin.db(source);
      await seedWorkload(db, WORKLOAD, 7_200);
      const base = memoryStorage();
      let steppedDown = false;
      // The step-down happens while the first data file is being written: its cursor
      // is open, the converge change stream is running, and writers are busy.
      const storage = hookedStorage(base, async (key) => {
        if (steppedDown || !key.includes(".bson")) return;
        steppedDown = true;
        await deployment.stepDown();
      });
      const client = deployment.client();
      const shield = shieldFor(client, storage);
      const writers = startWriters(db, WORKLOAD, 7_200, 2);
      let outcome: { manifest: Manifest } | { error: unknown };
      try {
        outcome = await shield
          .backup({ include: [`${source}.*`], readPreference, parallelism: 1 })
          .then(
            (result) => ({ manifest: result.manifest }),
            (error: unknown) => ({ error }),
          );
      } finally {
        await writers.stop();
      }
      expect(steppedDown).toBe(true);

      if ("error" in outcome) {
        const { error } = outcome;
        expect(error, String(error)).toBeInstanceOf(MongoShieldError);
        // A step-down is transient: the scheduler must be allowed to retry it.
        expect(isTransientError(error), String(error)).toBe(true);
        expect(await committedBackups(base)).toBe(0);
        expect(base.keys()).toEqual([]);
      } else {
        const { manifest } = outcome;
        expect(await committedBackups(base)).toBe(1);
        await shield.restore({
          backup: manifest.id,
          target: { client: deployment.admin },
          rename: { [`${source}.*`]: `${target}.*` },
        });
        expect(await differencesFromSource(source, target, manifest.consistency.to)).toEqual([]);
      }
      await db.dropDatabase();
      await deployment.admin.db(target).dropDatabase();
    },
  );

  it("is retried by the scheduler until the backup succeeds", async () => {
    const source = uniqueDb("rs_retry");
    await deployment.admin
      .db(source)
      .collection<Numbered>("orders")
      .insertMany(Array.from({ length: 200 }, (_, n) => ({ _id: n })));
    const appName = `retry-${source}`;
    const storage = memoryStorage();
    const shield = shieldFor(deployment.client({ appName }), storage);
    // The first attempt runs while every member answers reads with
    // InterruptedDueToReplStateChange (11602), the error a read gets when its member
    // steps down: the real engine sees real server errors, through the driver's own
    // retryable-read attempt. The election is "over" for the second attempt.
    let attempts = 0;
    const flakyShield = {
      storage: shield.storage,
      verify: shield.verify.bind(shield),
      prune: shield.prune.bind(shield),
      drill: shield.drill.bind(shield),
      backup: async (options?: BackupOptions) => {
        attempts += 1;
        if (attempts > 1) return shield.backup(options);
        const clear = await failCommandsOnEveryMember(deployment, {
          commands: ["find"],
          errorCode: 11602,
          appName,
        });
        try {
          return await shield.backup(options);
        } finally {
          await clear();
        }
      },
    };
    try {
      const report = await runScheduledJob(
        flakyShield,
        {
          storage,
          backup: { include: [`${source}.*`] },
          schedule: { cron: "0 3 * * *", retries: 2, lock: "none" },
        },
        { retryDelays: { baseDelayMs: 200, maxDelayMs: 1_000 }, logger: silentLogger },
      );
      expect(report.error, JSON.stringify(report.error)).toBeUndefined();
      expect(report.status).toBe("success");
      expect(report.backup?.attempts).toBe(2);
      expect(attempts).toBe(2);
      // The failed attempt left nothing behind: one committed backup, nothing else.
      expect(await committedBackups(storage)).toBe(1);
      expect((await listBackups(storage)).length).toBe(1);
    } finally {
      await deployment.admin.db(source).dropDatabase();
    }
  });
});

describe("typed errors", () => {
  it("classifies an interrupted read as a retryable connection failure", async () => {
    const source = uniqueDb("rs_typed");
    await deployment.admin.db(source).collection<Numbered>("orders").insertOne({ _id: 1 });
    const appName = `typed-${source}`;
    const clear = await failCommandsOnEveryMember(deployment, {
      commands: ["find"],
      errorCode: 11602,
      appName,
    });
    const storage = memoryStorage();
    const shield = shieldFor(deployment.client({ appName }), storage);
    try {
      const error: unknown = await shield.backup({ include: [`${source}.*`] }).catch((e) => e);
      expect(isMongoShieldError(error, "MS_CONNECTION_FAILED"), String(error)).toBe(true);
      expect(storage.keys()).toEqual([]);
    } finally {
      await clear();
      await deployment.admin.db(source).dropDatabase();
    }
  });
});
