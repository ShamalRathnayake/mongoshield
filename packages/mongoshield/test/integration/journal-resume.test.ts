// The journal writer rides out transient failures of its change stream without
// abandoning the segment it is writing: when its connections drop, the stream is
// reopened after the last batch (bounded retries with backoff), and every event is
// journaled exactly once. Lost history while reopening is still a gap.

import { MongoClient, MongoServerError } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { journalStatus } from "../../src/journal/index.ts";
import type { Logger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import {
  changeStreamStage,
  clientWithFaults,
  type FaultInjector,
  firstHostOf,
  isChangeStreamGetMore,
  startTcpProxy,
} from "../helpers/faults.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import {
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

function newDatabase(): string {
  const name = uniqueDb("jr");
  databases.push(name);
  return name;
}

async function insertRange(database: string, from: number, to: number): Promise<void> {
  const documents = [];
  for (let n = from; n < to; n += 1) documents.push({ _id: n, n });
  await client().db(database).collection<{ _id: number; n: number }>("items").insertMany(documents);
}

function recordingLogger(): { logger: Logger; messages: string[] } {
  const messages: string[] = [];
  const record = (level: string) => (message: string) => messages.push(`${level}: ${message}`);
  return {
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
    messages,
  };
}

const RESUMED = "warn: The change stream was interrupted and has been resumed";

describe("journal stream resume", () => {
  it("resumes after its connections drop, without abandoning the open segment", async () => {
    const database = newDatabase();
    const storage = memoryStorage();
    const proxy = await startTcpProxy(firstHostOf(mongoUri()));
    // Only the writer goes through the proxy; the test writes through its own client.
    const proxied = new MongoClient(`mongodb://${proxy.address}/?directConnection=true`);
    const { logger, messages } = recordingLogger();
    try {
      await proxied.connect();
      const journal = await startTestJournal(proxied, storage, database, { logger });
      try {
        await insertRange(database, 0, 10);
        // The stream is almost always inside a getMore (they wait up to 1 s for
        // events); cut the connections until one of them was interrupted.
        await waitFor(
          () => {
            proxy.dropConnections();
            return messages.includes(RESUMED);
          },
          60_000,
          "the stream to be interrupted and resumed",
        );
        await insertRange(database, 10, 20);
        await waitForJournalToCatchUp(client(), storage);
      } finally {
        await journal.stop();
      }
      expect(journal.status().lastError).toBeUndefined();
      // A writer that abandoned its segment says so ("…retrying from the last committed
      // segment") and reports the error in its status.
      expect(messages.filter((message) => message.includes("retrying"))).toEqual([]);
      const ids = (await journaledEvents(storage, database))
        .filter((event) => event.op === "insert")
        .map((event) => event.id);
      expect(ids).toEqual(Array.from({ length: 20 }, (_, n) => n));
    } finally {
      await proxied.close().catch(() => {});
      await proxy.close();
    }
  });

  it("records a gap when the history is gone by the time it resumes", async () => {
    const database = newDatabase();
    const storage = memoryStorage();
    let armed = false;
    const inject: FaultInjector = (command) => {
      if (!armed) return undefined;
      if (isChangeStreamGetMore(command)) {
        return new MongoServerError({
          message: "cursor id 1 not found",
          code: 43,
          codeName: "CursorNotFound",
        });
      }
      if (changeStreamStage(command)?.resumeAfter !== undefined) {
        return new MongoServerError({
          message:
            "Resume of change stream was not possible, as the resume point may no longer be in the oplog.",
          code: 286,
          codeName: "ChangeStreamHistoryLost",
        });
      }
      return undefined;
    };
    const journal = await startTestJournal(clientWithFaults(client(), inject), storage, database, {
      onGap: "fail",
    });
    await insertRange(database, 0, 3);
    await waitForJournalToCatchUp(client(), storage);
    armed = true;
    await expect(journal.done).rejects.toMatchObject({ code: "MS_CHANGE_HISTORY_LOST" });
    expect((await journalStatus(storage)).gaps).toHaveLength(1);
  });
});
