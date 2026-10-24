// Change events near and over MongoDB's 16 MiB limit. An event the server can send
// (up to 16 MiB + 16 KiB) is captured and replayed like any other. An event it cannot
// send fails the converge backup and stops the journal writer with a clear error that
// names the change's cluster time, both with `$changeStreamSplitLargeEvent` (MongoDB
// 7.0+, which cannot split an event whose one large field plus the resume token is too
// big) and on servers without it.
//
// These tests run against a replica set of their own: a too-large event fails every
// deployment-wide change stream that does not filter its database out on the server,
// and other test files run such streams in parallel.

import { MongoClient, MongoServerError } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { isMongoShieldError, type MongoShieldError } from "../../src/errors.ts";
import type { ClusterTime } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { clientWithFaults, type FaultInjector } from "../helpers/faults.ts";
import { uniqueDb } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import {
  type AnyDocument,
  firstDifference,
  hookedStorage,
  isDataFileOf,
  rawDocuments,
} from "./converge-test-utils.ts";
import { startTestJournal } from "./journal-test-utils.ts";

let replSet: MongoMemoryReplSet | undefined;
let connected: MongoClient | undefined;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await replSet.waitUntilRunning();
  connected = await new MongoClient(replSet.getUri()).connect();
}, 120_000);

afterAll(async () => {
  await connected?.close();
  await replSet?.stop();
});

function client(): MongoClient {
  if (connected === undefined) throw new Error("not connected");
  return connected;
}

/** BSON size of `{ _id, s }` without the string's characters. */
const ENVELOPE_BYTES = 30;

/**
 * A document of about `bytes` BSON bytes whose `_id` is a string of `idLength`
 * characters. A change event holds the `_id` three times (resume token as hex,
 * documentKey, fullDocument): a 6000-character `_id` on a 16 MiB document makes the
 * insert event larger than the server can send, and its fullDocument fragment plus the
 * resume token too large to split off.
 */
function bigDocument(bytes: number, idLength: number): { _id: string; s: string } {
  const _id = "i".repeat(idLength);
  return { _id, s: "x".repeat(bytes - idLength - ENVELOPE_BYTES) };
}

/** The largest document MongoDB accepts, minus a little slack. */
const NEARLY_16_MIB = 16 * 1024 * 1024 - 200;

/** Inserts `document` and returns the insert's cluster time. */
async function insertAt(
  database: string,
  document: { _id: string; s: string },
): Promise<ClusterTime> {
  const session = client().startSession();
  try {
    await client()
      .db(database)
      .collection<{ _id: string; s: string }>("big")
      .insertOne(document, { session });
    const time = session.operationTime;
    if (time === undefined) throw new Error("no operation time");
    return { t: time.t, i: time.i };
  } finally {
    await session.endSession();
  }
}

async function convergeBackup(storage: MemoryStorage, database: string, backupClient = client()) {
  const result = await runBackup(backupContext(backupClient, storage), {
    include: [`${database}.*`],
    consistency: "converge",
    parallelism: 1,
  });
  if (result.status !== "complete") throw new Error("expected a complete backup");
  return result.manifest;
}

async function failure(promise: Promise<unknown>): Promise<MongoShieldError> {
  try {
    await promise;
  } catch (error) {
    if (isMongoShieldError(error)) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

/** Pretends to be a server without `$changeStreamSplitLargeEvent` (before 6.0.9 / 7.0). */
const withoutSplitStage: FaultInjector = (command) => {
  const pipeline: unknown = command.pipeline;
  if (!Array.isArray(pipeline)) return undefined;
  const splits = pipeline.some(
    (stage) =>
      typeof stage === "object" && stage !== null && "$changeStreamSplitLargeEvent" in stage,
  );
  if (!splits) return undefined;
  return new MongoServerError({
    message: "Unrecognized pipeline stage name: '$changeStreamSplitLargeEvent'",
    code: 40324,
    codeName: "Location40324",
  });
};

describe("large change events", () => {
  it("captures and replays an event just under the server's limit", async () => {
    const source = uniqueDb("cvl_ok");
    const target = uniqueDb("cvl_ok_dst");
    await client().db(source).collection<AnyDocument>("a").insertOne({ _id: 1 });
    let inserted = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (inserted || !isDataFileOf(key, "a")) return;
      inserted = true;
      // A small _id: the event is a little over 16 MiB, which the server still sends.
      await insertAt(source, bigDocument(NEARLY_16_MIB, 10));
    });
    const manifest = await convergeBackup(storage, source);
    expect(manifest.changes?.events).toBeGreaterThanOrEqual(2);
    await runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } },
    );
    const expected = await rawDocuments(client(), source, "big");
    const actual = await rawDocuments(client(), target, "big");
    expect(firstDifference(expected, actual)).toBeUndefined();
  });

  it("records an update to a dotted field name on a large document in full", async () => {
    // The capture stores such an update with the whole document added (the event's
    // 8 MiB plus the 16 MiB document): larger than js-bson's default buffer.
    const source = uniqueDb("cvl_dot");
    const target = uniqueDb("cvl_dot_dst");
    const eightMiB = 8 * 1024 * 1024;
    await client().db(source).collection<AnyDocument>("a").insertOne({ _id: 1 });
    await client()
      .db(source)
      .collection<{ _id: number; pad: string }>("docs")
      .insertOne({ _id: 1, pad: "p".repeat(eightMiB) });
    let updated = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (updated || !isDataFileOf(key, "docs")) return;
      updated = true;
      await client()
        .db(source)
        .collection<AnyDocument>("docs")
        .updateOne({ _id: 1 }, [
          {
            $replaceWith: {
              $setField: { field: "a.b", input: "$$ROOT", value: "v".repeat(eightMiB - 1000) },
            },
          },
        ]);
    });
    const manifest = await convergeBackup(storage, source);
    expect(updated).toBe(true);
    await runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } },
    );
    const expected = await rawDocuments(client(), source, "docs");
    const actual = await rawDocuments(client(), target, "docs");
    expect(firstDifference(expected, actual)).toBeUndefined();
  });

  for (const variant of ["with the split stage", "on a server that cannot split events"]) {
    it(`fails the backup with a clear error for an event over the limit (${variant})`, async () => {
      const source = uniqueDb("cvl_big");
      await client().db(source).collection<AnyDocument>("a").insertOne({ _id: 1 });
      let insertedAt: ClusterTime | undefined;
      const storage = hookedStorage(memoryStorage(), async (key) => {
        if (insertedAt !== undefined || !isDataFileOf(key, "a")) return;
        insertedAt = await insertAt(source, bigDocument(NEARLY_16_MIB, 6000));
      });
      const backupClient = variant.startsWith("with")
        ? client()
        : clientWithFaults(client(), withoutSplitStage);
      const error = await failure(convergeBackup(storage, source, backupClient));
      expect(error.code).toBe("MS_UNSUPPORTED_TOPOLOGY");
      expect(error.message).toContain("larger than MongoDB's 16 MiB limit");
      if (variant.startsWith("with")) {
        // "Splitting change event failed: fragment size … is greater than …"
        expect(error.details?.serverCode).toBe(7182500);
      } else {
        // BSONObjectTooLarge quotes the event's resume token, which encodes its time.
        expect(error.details?.serverCode).toBe(10334);
        expect(error.details?.clusterTime).toEqual(insertedAt);
      }
    });
  }

  it("stops the journal writer with the same error", async () => {
    const database = uniqueDb("jl_big");
    const journal = await startTestJournal(client(), memoryStorage(), database);
    await insertAt(database, bigDocument(NEARLY_16_MIB, 6000));
    const error = await failure(journal.done);
    expect(error.code).toBe("MS_UNSUPPORTED_TOPOLOGY");
    expect(journal.status().failure?.code).toBe("MS_UNSUPPORTED_TOPOLOGY");
  });
});
