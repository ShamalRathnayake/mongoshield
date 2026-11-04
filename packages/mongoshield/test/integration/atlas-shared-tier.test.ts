// Integration tests for backing up and restoring an Atlas Free/Flex cluster, end to
// end against the real test replica set. Real Atlas cannot be reached from the test
// suite, so Atlas detection (src/mongo/atlas.ts) is replaced with one that reports a
// shared tier; everything else is the real engine against a real server:
//   - the shared-tier defaults are applied and logged (parallelism, read limit);
//   - converge backups work with the regex-only change stream filter the tier needs,
//     and capture a change made during the backup;
//   - users and roles are refused before anything is read or written;
//   - restores use the gentler concurrency;
//   - incremental backups and the change journal use the regex-only filter too, and
//     incrementals read at the gentler pace (they used to skip every adaptation).

import { type Document, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import type { LogFields, Logger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { startTestJournal, waitForJournalToCatchUp } from "./journal-test-utils.ts";

// Every deployment this file connects to "is" an Atlas Free cluster.
vi.mock("../../src/mongo/atlas.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/mongo/atlas.ts")>();
  return {
    ...original,
    detectAtlas: async () => ({ tier: "shared", signals: ["test: pretend Atlas Free"] }),
  };
});

const client = useMongoClient();
const database = uniqueDb("atlas");
const restored = uniqueDb("atlas_restored");
const own = { include: [`${database}.*`] };

/** About 1 KiB per document, so a slow read limit makes the backup last a while. */
const DOCUMENTS = 2_000;
const PADDING = "x".repeat(1_000);

/** A logger that keeps every message with its level. */
function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (message: string, _fields?: LogFields): void => {
      lines.push(`${level}: ${message}`);
    };
  return {
    lines,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

/** The customers collection, whose `_id`s are names. */
function customers(db: string) {
  return client().db(db).collection<{ _id: string }>("customers");
}

/** Every key in a storage location. */
async function storedKeys(storage: ReturnType<typeof memoryStorage>): Promise<string[]> {
  const keys: string[] = [];
  for await (const object of storage.list("")) keys.push(object.key);
  return keys;
}

beforeAll(async () => {
  const documents: Document[] = [];
  for (let index = 0; index < DOCUMENTS; index++) documents.push({ _id: index, padding: PADDING });
  await client().db(database).collection("orders").insertMany(documents);
  await customers(database).insertOne({ _id: "alice" });
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await client().db(restored).dropDatabase();
});

describe("backups of an Atlas Free/Flex cluster", () => {
  it("applies and logs the shared-tier defaults", async () => {
    const logger = recordingLogger();
    const storage = memoryStorage();
    const result = await runBackup(
      { client: client(), storage, logger, compression: "zstd", encryption: undefined },
      own,
    );
    expect(result.manifest.totals.documents).toBe(DOCUMENTS + 1);
    expect(logger.lines).toContain("debug: MongoDB Atlas detected");
    expect(
      logger.lines.some((line) => line.includes("parallelism 2, reads limited to 4 MiB/s")),
    ).toBe(true);
  });

  it("captures a change made during a converge backup through the regex-only filter", async () => {
    const storage = memoryStorage();
    let write: Promise<unknown> | undefined;
    const result = await runBackup(
      {
        client: client(),
        storage,
        logger: recordingLogger(),
        compression: "zstd",
        encryption: undefined,
      },
      {
        ...own,
        consistency: "converge",
        // Slow enough (about 2 MB at 1 MB/s) that the write lands inside the window.
        maxBytesPerSecond: 1024 * 1024,
        onProgress: () => {
          write ??= customers(database).insertOne({ _id: "bob" });
        },
      },
    );
    await write;
    expect(result.manifest.consistency.mode).toBe("converge");
    // The insert went through the change stream, so the server accepted the filter
    // and delivered the event (the documents may or may not include it as well).
    expect(result.manifest.changes?.events).toBeGreaterThanOrEqual(1);

    await runRestore(
      { client: client(), storage, logger: recordingLogger() },
      { backup: "latest", rename: { [`${database}.*`]: `${restored}.*` } },
    );
    const restoredCustomers = await customers(restored).find().sort({ _id: 1 }).toArray();
    expect(restoredCustomers.map((customer) => customer._id)).toEqual(["alice", "bob"]);
    await customers(database).deleteOne({ _id: "bob" });
    await client().db(restored).dropDatabase();
  });

  it("refuses users and roles before reading anything", async () => {
    const storage = memoryStorage();
    const error: unknown = await runBackup(
      {
        client: client(),
        storage,
        logger: recordingLogger(),
        compression: "zstd",
        encryption: undefined,
      },
      { ...own, includeUsersAndRoles: true },
    ).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_UNSUPPORTED_TOPOLOGY")).toBe(true);
    expect(await storedKeys(storage)).toEqual([]);
  });
});

describe("restores into an Atlas Free/Flex cluster", () => {
  it("uses the gentler concurrency, and says so", async () => {
    const storage = memoryStorage();
    await runBackup(
      {
        client: client(),
        storage,
        logger: recordingLogger(),
        compression: "zstd",
        encryption: undefined,
      },
      own,
    );
    const logger = recordingLogger();
    const result = await runRestore(
      { client: client(), storage, logger },
      { backup: "latest", rename: { [`${database}.*`]: `${restored}.*` } },
    );
    expect(result.documentsRestored).toBe(DOCUMENTS + 1);
    expect(
      logger.lines.some((line) => line.includes("parallelism 2, 1 insert worker per collection")),
    ).toBe(true);
    await client().db(restored).dropDatabase();
  });

  it("refuses to restore users and roles before writing anything", async () => {
    const storage = memoryStorage();
    await runBackup(
      {
        client: client(),
        storage,
        logger: recordingLogger(),
        compression: "zstd",
        encryption: undefined,
      },
      own,
    );
    const error: unknown = await runRestore(
      { client: client(), storage, logger: recordingLogger() },
      {
        backup: "latest",
        rename: { [`${database}.*`]: `${restored}.*` },
        usersAndRoles: "create",
      },
    ).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_UNSUPPORTED_TOPOLOGY")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toContain("atlas dbusers list");
    const names = await client().db(restored).listCollections().toArray();
    expect(names).toEqual([]);
  });
});

describe("incremental backups and the journal on an Atlas Free/Flex cluster", () => {
  // A second client that records the change streams it opens, to see their filters.
  const watching = new MongoClient(mongoUri(), { monitorCommands: true });
  const pipelines: Document[][] = [];
  watching.on("commandStarted", (event) => {
    const pipeline: unknown = event.command.pipeline;
    if (event.commandName === "aggregate" && Array.isArray(pipeline)) pipelines.push(pipeline);
  });
  afterAll(async () => {
    await watching.close();
  });

  /** The server-side `$match` of every change stream opened since the last call. */
  function changeStreamFilters(): Document[] {
    const filters = pipelines
      .filter((pipeline) => pipeline[0]?.$changeStream !== undefined)
      .map((pipeline) => pipeline[1]?.$match)
      .filter((match): match is Document => match !== undefined);
    pipelines.length = 0;
    return filters;
  }

  /** True when a filter uses regular expressions and no `$in` / `$nin` (what the tier needs). */
  function isRegexOnly(filter: Document): boolean {
    const text = JSON.stringify(filter);
    let hasRegex = false;
    const visit = (value: unknown): void => {
      if (value instanceof RegExp) hasRegex = true;
      else if (Array.isArray(value)) value.forEach(visit);
      else if (typeof value === "object" && value !== null) Object.values(value).forEach(visit);
    };
    visit(filter);
    return hasRegex && !text.includes("$in") && !text.includes("$nin");
  }

  const context = (logger: Logger, storage: ReturnType<typeof memoryStorage>) => ({
    client: watching,
    storage,
    logger,
    compression: "zstd" as const,
    encryption: undefined,
  });

  it("takes incrementals with the regex-only filter and the gentler pace", async () => {
    const storage = memoryStorage();
    await runBackup(context(recordingLogger(), storage), { ...own, consistency: "converge" });
    changeStreamFilters();
    await customers(database).insertOne({ _id: "carol" });

    const logger = recordingLogger();
    const result = await runBackup(context(logger, storage), { ...own, incremental: true });
    expect(result.manifest.chain?.length).toBe(1);
    expect(result.manifest.changes?.events).toBeGreaterThanOrEqual(1);
    const filters = changeStreamFilters();
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.every(isRegexOnly)).toBe(true);
    expect(
      logger.lines.some((line) => line.includes("parallelism 2, reads limited to 4 MiB/s")),
    ).toBe(true);
    await customers(database).deleteOne({ _id: "carol" });
  });

  it("refuses incremental users and roles up front, even with fallbackToFull", async () => {
    const storage = memoryStorage();
    const error: unknown = await runBackup(context(recordingLogger(), storage), {
      ...own,
      incremental: { fallbackToFull: true },
      includeUsersAndRoles: true,
    }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_UNSUPPORTED_TOPOLOGY")).toBe(true);
    expect(await storedKeys(storage)).toEqual([]);
  });

  it("journals changes with the regex-only filter", async () => {
    const storage = memoryStorage();
    const logger = recordingLogger();
    changeStreamFilters();
    const journal = await startTestJournal(watching, storage, database, { logger });
    try {
      await customers(database).insertOne({ _id: "dave" });
      await waitForJournalToCatchUp(watching, storage);
      expect(journal.status().eventsWritten).toBeGreaterThanOrEqual(1);
    } finally {
      await journal.stop();
      await customers(database).deleteOne({ _id: "dave" });
    }
    const filters = changeStreamFilters();
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.every(isRegexOnly)).toBe(true);
    expect(logger.lines.some((line) => line.includes("Atlas Free/Flex tier detected"))).toBe(true);
  });
});
