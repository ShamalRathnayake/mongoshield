// Integration tests for the change journal writer and reader (docs/specs/JOURNAL.md)
// against the shared replica set: segments, restarts, heartbeats, the segment chain,
// the writer lease, gaps and planning a point-in-time restore.

import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { runBackup } from "../../src/engine/backup.ts";
import { compareClusterTimes, readClusterTime } from "../../src/engine/converge-time.ts";
import { isMongoShieldError, type MongoShieldError } from "../../src/errors.ts";
import {
  type CommittedSegment,
  journalStatus,
  listBaseBackups,
  loadJournalCoverage,
  planPointInTimeRestore,
  pruneJournal,
  readJournalSegments,
  verifyJournal,
} from "../../src/journal/index.ts";
import { STATE_KEY } from "../../src/journal/layout.ts";
import { JOURNAL_FORMAT_VERSION, type JournalState } from "../../src/journal/records.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext, readObject } from "./backup-test-utils.ts";
import {
  clientWithOplogStartingAt,
  journaledEvents,
  startTestJournal,
  waitFor,
  waitForJournalToCatchUp,
} from "./journal-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

function newDatabase(prefix = "jr"): string {
  const name = uniqueDb(prefix);
  databases.push(name);
  return name;
}

/** Inserts documents with `_id`s in [from, to). */
async function insertRange(database: string, from: number, to: number): Promise<void> {
  const documents = Array.from({ length: to - from }, (_, index) => ({
    _id: from + index,
    payload: `payload-${from + index}`,
  }));
  await client()
    .db(database)
    .collection<{ _id: number; payload: string }>("items")
    .insertMany(documents);
}

describe("journal writer", () => {
  it("captures inserts, updates and deletes across several segments", async () => {
    const database = newDatabase();
    const storage = memoryStorage();
    const segments: CommittedSegment[] = [];
    const journal = await startTestJournal(client(), storage, database, {
      onSegment: (segment) => segments.push(segment),
    });
    try {
      const items = client().db(database).collection<{ _id: number; n?: number }>("items");
      await items.insertMany([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
      await sleep(1300);
      await items.updateOne({ _id: 2 }, { $set: { n: 5 } });
      await sleep(1300);
      await items.deleteOne({ _id: 1 });
      await waitForJournalToCatchUp(client(), storage);
    } finally {
      await journal.stop();
    }

    expect(await journaledEvents(storage, database)).toEqual([
      { op: "create", ns: "items", id: undefined },
      { op: "insert", ns: "items", id: 1 },
      { op: "insert", ns: "items", id: 2 },
      { op: "insert", ns: "items", id: 3 },
      { op: "update", ns: "items", id: 2 },
      { op: "delete", ns: "items", id: 1 },
    ]);
    expect(segments.filter((segment) => segment.events > 0).length).toBeGreaterThanOrEqual(3);
    // Each segment starts where the previous one ended.
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]?.from).toEqual(segments[index - 1]?.to);
    }
    const status = journal.status();
    expect(status.running).toBe(false);
    expect(status.eventsWritten).toBe(6);
    expect(await verifyJournal(storage)).toMatchObject({ events: 6 });
  });

  it("resumes after a restart without losing or repeating events", async () => {
    const database = newDatabase();
    const storage = memoryStorage();
    const first = await startTestJournal(client(), storage, database);
    await insertRange(database, 0, 10);
    await waitForJournalToCatchUp(client(), storage);
    await first.stop();

    // Written while no writer runs: the next writer must pick them up.
    await insertRange(database, 10, 20);

    const second = await startTestJournal(client(), storage, database);
    await insertRange(database, 20, 30);
    await waitForJournalToCatchUp(client(), storage);
    await second.stop();

    const inserted = (await journaledEvents(storage, database))
      .filter((event) => event.op === "insert")
      .map((event) => event.id);
    expect(inserted).toEqual(Array.from({ length: 30 }, (_, index) => index));
  });

  it("writes heartbeat segments while the journaled namespaces are idle", async () => {
    const database = newDatabase();
    const elsewhere = newDatabase("jr_other");
    const storage = memoryStorage();
    const segments: CommittedSegment[] = [];
    const journal = await startTestJournal(client(), storage, database, {
      onSegment: (segment) => segments.push(segment),
    });
    try {
      await waitFor(() => segments.length > 0, 30_000, "a first segment");
      const firstPoint = (await journalStatus(storage)).recoveryPoint;
      // Writes outside the journal's scope move the oplog (as the server's periodic
      // no-op writes would, only faster) without producing journaled events.
      for (let round = 0; round < 12; round += 1) {
        await client().db(elsewhere).collection("noise").insertOne({ round });
        await sleep(250);
      }
      await waitForJournalToCatchUp(client(), storage);
      const status = await journalStatus(storage);
      expect(firstPoint).toBeDefined();
      expect(status.recoveryPoint).toBeDefined();
      if (firstPoint !== undefined && status.recoveryPoint !== undefined) {
        expect(compareClusterTimes(status.recoveryPoint, firstPoint)).toBeGreaterThan(0);
      }
      expect(segments.length).toBeGreaterThanOrEqual(2);
      expect(segments.every((segment) => segment.events === 0)).toBe(true);
      expect(status.rpoMs).toBeLessThan(15_000);
    } finally {
      await journal.stop();
    }
  });

  it("lets only one writer hold the lease", async () => {
    const database = newDatabase();
    const storage = memoryStorage();
    const first = await startTestJournal(client(), storage, database);
    try {
      const error = await startTestJournal(client(), storage, database).catch(
        (caught: unknown) => caught,
      );
      expect(isMongoShieldError(error, "MS_STORAGE_PRECONDITION_FAILED")).toBe(true);
    } finally {
      await first.stop();
    }
    // Once the first writer stopped (and released the lease) another may start.
    const second = await startTestJournal(client(), storage, database);
    await second.stop();
  });

  it("encrypts segments to recipients and reads them back with the identity", async () => {
    const database = newDatabase();
    const storage = memoryStorage();
    const key = generateIdentity();
    const journal = await startTestJournal(client(), storage, database, {
      encryption: { recipients: [key.recipient] },
    });
    await insertRange(database, 0, 5);
    await waitForJournalToCatchUp(client(), storage);
    await journal.stop();

    const coverage = await loadJournalCoverage(storage);
    expect(coverage.segments.every((segment) => segment.key.endsWith(".bson.zst.age"))).toBe(true);
    const to = coverage.state?.recoveryPoint ?? { t: 0, i: 0 };
    const from = coverage.segments[0]?.from ?? to;
    const withoutKey = async () => {
      for await (const _event of readJournalSegments(storage, { from, to })) {
        // read everything
      }
    };
    await expect(withoutKey()).rejects.toMatchObject({ code: "MS_NO_IDENTITY" });
    let inserts = 0;
    for await (const { event } of readJournalSegments(storage, {
      from,
      to,
      decryption: { identities: [key.identity] },
    })) {
      if (event.operationType === "insert" && event.ns?.db === database) inserts += 1;
    }
    expect(inserts).toBe(5);
  });

  it("refuses a passphrase for the journal", async () => {
    const error = await startTestJournal(client(), memoryStorage(), newDatabase(), {
      encryption: { passphrase: "correct horse" },
    }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });
});

describe("journal chain", () => {
  /** A journal of 3+ segments with events, stored uncompressed so bytes can be edited. */
  async function journalWithSegments(): Promise<{ storage: MemoryStorage; database: string }> {
    const database = newDatabase();
    const storage = memoryStorage();
    const journal = await startTestJournal(client(), storage, database, { compression: "none" });
    for (let round = 0; round < 3; round += 1) {
      await insertRange(database, round * 10, round * 10 + 10);
      await sleep(1300);
    }
    await waitForJournalToCatchUp(client(), storage);
    await journal.stop();
    return { storage, database };
  }

  /** The committed segments holding events. */
  async function segmentsWithEvents(storage: MemoryStorage): Promise<string[]> {
    const keys: string[] = [];
    for (const segment of (await loadJournalCoverage(storage)).segments) {
      const bytes = await readObject(storage, segment.key);
      if (bytes.includes("payload-")) keys.push(segment.key);
    }
    return keys;
  }

  it("detects an altered segment", async () => {
    const { storage } = await journalWithSegments();
    const [key] = await segmentsWithEvents(storage);
    if (key === undefined) throw new Error("no segment with events");
    const bytes = await readObject(storage, key);
    const offset = bytes.indexOf("payload-");
    // Still valid BSON, a different value: only the chain can tell.
    bytes[offset] = "P".charCodeAt(0);
    await storage.put(key, bytes);

    await expect(verifyJournal(storage)).rejects.toMatchObject({ code: "MS_INTEGRITY_FAILED" });
  });

  it("detects a missing segment", async () => {
    const { storage } = await journalWithSegments();
    const coverage = await loadJournalCoverage(storage);
    const middle = coverage.segments[Math.floor(coverage.segments.length / 2)];
    if (middle === undefined || coverage.segments.length < 3) throw new Error("too few segments");
    await storage.delete([middle.key]);

    const error = await verifyJournal(storage).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect((error as MongoShieldError).message).toMatch(/missing|chain/);
  });

  it("ignores a segment whose upload was never committed, and the next writer replaces it", async () => {
    const { storage, database } = await journalWithSegments();
    const state = (await journalStatus(storage)).recoveryPoint;
    // An interrupted upload: a segment object after the last commit.
    const orphan = `journal/segments/2099-01-01/000000_4070908800-0000000001.bson`;
    await storage.put(orphan, Buffer.from("not a segment"));
    expect((await journalStatus(storage)).uncommittedSegments).toBe(1);
    expect((await journalStatus(storage)).recoveryPoint).toEqual(state);

    const journal = await startTestJournal(client(), storage, database, { compression: "none" });
    await journal.stop();
    expect(await storage.head(orphan)).toBeUndefined();
    await verifyJournal(storage);
  });
});

describe("journal gaps", () => {
  /** The oplog of the (simulated) deployment starts here, after the journal's last commit. */
  const OPLOG_START = { t: 2_000_000, i: 1 };

  /** A journal whose last commit is older than the oplog: history is lost. */
  async function journalWithLostHistory(): Promise<MemoryStorage> {
    const storage = memoryStorage();
    const state: JournalState = {
      formatVersion: JOURNAL_FORMAT_VERSION,
      recoveryPoint: { t: 1_000_000, i: 1 },
      lastSegment: {
        key: "journal/segments/1970-01-12/134640_0001000000-0000000000.bson.zst",
        from: { t: 1_000_000, i: 0 },
        to: { t: 1_000_000, i: 1 },
        size: 10,
        sha256: "0".repeat(64),
        events: 0,
      },
      totals: { segments: 1, events: 0, bytes: 10 },
      updatedAt: new Date().toISOString(),
      writer: { host: "test", pid: 1 },
    };
    await storage.put(STATE_KEY, Buffer.from(JSON.stringify(state)));
    return storage;
  }

  it('records a gap, takes a base backup and keeps journaling (onGap "backup")', async () => {
    const database = newDatabase();
    const storage = await journalWithLostHistory();
    let backups = 0;
    const journal = await startTestJournal(
      clientWithOplogStartingAt(client(), OPLOG_START),
      storage,
      database,
      {
        takeBaseBackup: async () => {
          backups += 1;
        },
      },
    );
    try {
      await insertRange(database, 0, 3);
      await waitForJournalToCatchUp(client(), storage);
    } finally {
      await journal.stop();
    }
    expect(backups).toBe(1);
    expect(journal.status().gaps).toBe(1);
    const status = await journalStatus(storage);
    expect(status.gaps).toHaveLength(1);
    expect(status.gaps[0]?.from).toEqual({ t: 1_000_000, i: 1 });
    expect(status.coveredRanges.length).toBeGreaterThanOrEqual(1);
    // The journal after the gap is readable on its own.
    const after = status.coveredRanges.at(-1);
    if (after === undefined) throw new Error("no covered range");
    let inserts = 0;
    for await (const { event } of readJournalSegments(storage, {
      from: after.from,
      to: after.to,
    })) {
      if (event.operationType === "insert" && event.ns?.db === database) inserts += 1;
    }
    expect(inserts).toBe(3);
  });

  it('records the gap and stops (onGap "fail")', async () => {
    const storage = await journalWithLostHistory();
    const journal = await startTestJournal(
      clientWithOplogStartingAt(client(), OPLOG_START),
      storage,
      newDatabase(),
      { onGap: "fail" },
    );
    await expect(journal.done).rejects.toMatchObject({ code: "MS_CHANGE_HISTORY_LOST" });
    expect((await journalStatus(storage)).gaps).toHaveLength(1);
  });
});

describe("planning a point-in-time restore", () => {
  it("picks the newest base backup at or before the requested time", async () => {
    const database = newDatabase();
    const storage = memoryStorage();
    await insertRange(database, 0, 5);
    const context = backupContext(client(), storage);
    const options = { include: [`${database}.*`], consistency: "converge" as const };

    const firstBackup = await runBackup(context, options);
    const journal = await startTestJournal(client(), storage, database);
    try {
      await insertRange(database, 5, 10);
      const between = await readClusterTime(client());
      await sleep(1100);
      // A write after `between`, so the second backup's cluster time is later.
      await insertRange(database, 10, 12);
      const secondBackup = await runBackup(context, options);
      await insertRange(database, 12, 15);
      await waitForJournalToCatchUp(client(), storage);

      const bases = await listBaseBackups(storage);
      const [second, first] = bases;
      expect(first?.id).toBe(firstBackup.id);
      expect(second?.id).toBe(secondBackup.id);
      if (first === undefined || second === undefined) return;

      const early = await planPointInTimeRestore(storage, between);
      expect(early.baseBackupId).toBe(firstBackup.id);
      expect(early.baseTime).toEqual(first.clusterTime);
      expect(early.segments.length).toBeGreaterThan(0);
      expect(early.baseNamespaces).toEqual([`${database}.items`]);

      const now = (await journalStatus(storage)).recoveryPoint ?? between;
      const late = await planPointInTimeRestore(storage, now);
      expect(late.baseBackupId).toBe(secondBackup.id);

      const tooEarly = await planPointInTimeRestore(storage, {
        t: first.clusterTime.t - 3600,
        i: 0,
      }).catch((caught: unknown) => caught);
      expect(isMongoShieldError(tooEarly, "MS_CHANGE_HISTORY_LOST")).toBe(true);
      expect((tooEarly as MongoShieldError).details?.recoverableRanges).toBeDefined();

      // Pruning before the oldest base keeps everything a restore can still use.
      const pruned = await pruneJournal(storage, { olderThan: first.clusterTime });
      expect(pruned.kept).toBeGreaterThan(0);
      expect((await planPointInTimeRestore(storage, between)).baseBackupId).toBe(firstBackup.id);
      // Pruning up to the newer base removes what only the older one needed.
      await pruneJournal(storage, { olderThan: second.clusterTime });
      await expect(planPointInTimeRestore(storage, between)).rejects.toMatchObject({
        code: "MS_CHANGE_HISTORY_LOST",
      });
      expect((await planPointInTimeRestore(storage, now)).baseBackupId).toBe(secondBackup.id);
    } finally {
      await journal.stop();
    }
  });
});
