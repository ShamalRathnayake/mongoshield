// The deployment-wide change stream shared by the converge capture and the journal
// (src/engine/converge-stream.ts), against the real server: it resumes after its
// session is killed without losing or repeating an event, retries a failed open,
// falls back when the server lacks `$changeStreamSplitLargeEvent`, and leaves no
// cursor behind when closed in the middle of a resume.

import { randomUUID } from "node:crypto";
import { type Document, MongoNetworkError, MongoServerError } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { toCaptureError } from "../../src/engine/converge-capture.ts";
import {
  type ChangeStreamOptions,
  ResumableChangeStream,
  serverDatabaseFilter,
} from "../../src/engine/converge-stream.ts";
import { readClusterTime } from "../../src/engine/converge-time.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { silentLogger } from "../../src/logger.ts";
import { compileNamespaceRules } from "../../src/mongo/namespace-filter.ts";
import {
  changeStreamStage,
  clientWithFaults,
  type FaultInjector,
  isChangeStreamGetMore,
} from "../helpers/faults.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

/** A stream over one fresh database, with a comment that finds it in `$currentOp`. */
async function openStream(
  overrides: Partial<ChangeStreamOptions> = {},
): Promise<{ stream: ResumableChangeStream; database: string; comment: string }> {
  const database = uniqueDb("cs");
  databases.push(database);
  const comment = `test stream ${randomUUID()}`;
  const startAt = await readClusterTime(client());
  const stream = await ResumableChangeStream.open({
    client: client(),
    startAt,
    match: serverDatabaseFilter(compileNamespaceRules({ include: [`${database}.*`] }), [], []),
    comment,
    logger: silentLogger,
    awaitDataMs: 200,
    resume: { attempts: 5, initialDelayMs: 10, maxDelayMs: 100 },
    toError: (error) => toCaptureError(error, startAt),
    ...overrides,
  });
  return { stream, database, comment };
}

async function insert(database: string, from: number, to: number): Promise<void> {
  const documents = [];
  for (let n = from; n < to; n += 1) documents.push({ _id: n });
  await client().db(database).collection<{ _id: number }>("items").insertMany(documents);
}

/** Reads batches until `count` insert events have arrived; returns their `_id`s. */
async function readInserts(stream: ResumableChangeStream, count: number): Promise<unknown[]> {
  const ids: unknown[] = [];
  for (let batches = 0; ids.length < count && batches < 200; batches += 1) {
    const batch = await stream.next();
    for (const { event } of batch.events) {
      if (event.operationType === "insert") ids.push(Number(event.documentKey?._id));
    }
  }
  return ids;
}

/** The server cursors (idle or running) opened with `comment`. */
async function cursorsWith(comment: string): Promise<Document[]> {
  return client()
    .db("admin")
    .aggregate<Document>([
      { $currentOp: { idleCursors: true, allUsers: true } },
      { $match: { "cursor.originatingCommand.comment": comment } },
    ])
    .toArray();
}

describe("ResumableChangeStream", () => {
  it("resumes after its session is killed, without losing or repeating events", async () => {
    const { stream, database, comment } = await openStream();
    try {
      await insert(database, 0, 5);
      expect(await readInserts(stream, 5)).toEqual([0, 1, 2, 3, 4]);

      const sessions = (await cursorsWith(comment)).map((cursor) => ({ id: cursor.lsid.id }));
      expect(sessions.length).toBeGreaterThan(0);
      await client().db("admin").command({ killSessions: sessions });

      await insert(database, 5, 10);
      expect(await readInserts(stream, 5)).toEqual([5, 6, 7, 8, 9]);
      expect(stream.resumes).toBe(1);
    } finally {
      await stream.close();
    }
    expect(await cursorsWith(comment)).toEqual([]);
  });

  it("retries an open that fails with a transient error", async () => {
    let failures = 0;
    const inject: FaultInjector = (command) => {
      if (changeStreamStage(command) === undefined || failures >= 2) return undefined;
      failures += 1;
      return new MongoNetworkError("connection reset by peer");
    };
    const { stream, database } = await openStream({ client: clientWithFaults(client(), inject) });
    try {
      expect(failures).toBe(2);
      await insert(database, 0, 2);
      expect(await readInserts(stream, 2)).toEqual([0, 1]);
    } finally {
      await stream.close();
    }
  });

  it("does not retry an open the server refuses", async () => {
    const inject: FaultInjector = (command) =>
      changeStreamStage(command) === undefined
        ? undefined
        : new MongoServerError({ message: "not authorized", code: 13, codeName: "Unauthorized" });
    const error = await openStream({ client: clientWithFaults(client(), inject) }).catch(
      (caught: unknown) => caught,
    );
    expect(isMongoShieldError(error, "MS_PERMISSION_DENIED")).toBe(true);
  });

  it("opens without the split stage on a server that does not know it", async () => {
    const pipelines: unknown[][] = [];
    let killGetMore = false;
    const inject: FaultInjector = (command) => {
      if (isChangeStreamGetMore(command) && killGetMore) {
        killGetMore = false;
        return new MongoServerError({
          message: "cursor not found",
          code: 43,
          codeName: "CursorNotFound",
        });
      }
      const pipeline: unknown = command.pipeline;
      if (changeStreamStage(command) === undefined || !Array.isArray(pipeline)) return undefined;
      pipelines.push(pipeline);
      const splits = pipeline.some((stage) => "$changeStreamSplitLargeEvent" in stage);
      return splits
        ? new MongoServerError({
            message: "Unrecognized pipeline stage name",
            code: 40324,
            codeName: "Location40324",
          })
        : undefined;
    };
    const { stream, database } = await openStream({ client: clientWithFaults(client(), inject) });
    try {
      await insert(database, 0, 1);
      expect(await readInserts(stream, 1)).toEqual([0]);
      killGetMore = true;
      await insert(database, 1, 2);
      expect(await readInserts(stream, 1)).toEqual([1]);
    } finally {
      await stream.close();
    }
    // Asked once with the stage, then without it, and the resume remembered that.
    expect(pipelines.map((pipeline) => pipeline.length)).toEqual([3, 2, 2]);
  });

  it("fails with the translated error when a getMore fails for good", async () => {
    let refuse = false;
    const inject: FaultInjector = (command) =>
      refuse && isChangeStreamGetMore(command)
        ? new MongoServerError({ message: "not authorized", code: 13, codeName: "Unauthorized" })
        : undefined;
    const { stream } = await openStream({ client: clientWithFaults(client(), inject) });
    try {
      await stream.next();
      refuse = true;
      await expect(stream.next()).rejects.toMatchObject({ code: "MS_PERMISSION_DENIED" });
    } finally {
      await stream.close();
    }
  });

  it("leaves no cursor behind when closed while resuming", async () => {
    let target: ResumableChangeStream | undefined;
    let interrupted = false;
    const inject: FaultInjector = (command) => {
      if (isChangeStreamGetMore(command) && !interrupted) {
        interrupted = true;
        return new MongoServerError({
          message: "interrupted",
          code: 11601,
          codeName: "Interrupted",
        });
      }
      // The resume is under way: close the stream before its new cursor is known.
      if (changeStreamStage(command)?.resumeAfter !== undefined) void target?.close();
      return undefined;
    };
    const { stream, comment } = await openStream({ client: clientWithFaults(client(), inject) });
    target = stream;
    await stream.next();
    await expect(stream.next()).rejects.toMatchObject({ code: "MS_INTERNAL" });
    expect(await cursorsWith(comment)).toEqual([]);
    await expect(stream.next()).rejects.toMatchObject({ code: "MS_INTERNAL" });
  });
});
