// The converge capture survives transient failures of its change stream: when its
// session is killed or its connection drops mid-backup, it reopens the stream after
// the last batch it stored (bounded retries with backoff) and the backup still
// converges. Lost history while reopening still fails the backup, as does a server
// that stays unreachable. Events over MongoDB's size limit fail with a clear error.

import { setTimeout as sleep } from "node:timers/promises";
import { type Document, MongoNetworkError, MongoServerError } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { isMongoShieldError, type MongoShieldError } from "../../src/errors.ts";
import type { Logger } from "../../src/logger.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import {
  changeStreamStage,
  clientWithFaults,
  type FaultInjector,
  isChangeStreamGetMore,
} from "../helpers/faults.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import {
  collectionNames,
  firstDifference,
  hookedStorage,
  isDataFileOf,
  rawDocuments,
} from "./converge-test-utils.ts";

interface TestDocument {
  _id: number | string;
  n?: number;
  [field: string]: unknown;
}

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

async function seed(database: string, collection: string, count: number): Promise<void> {
  await client()
    .db(database)
    .collection<TestDocument>(collection)
    .insertMany(Array.from({ length: count }, (_, n) => ({ _id: n, n })));
}

/** A logger that keeps every message, to see what the capture reported. */
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

async function convergeBackup(
  storage: MemoryStorage,
  database: string,
  options: { readonly client?: ReturnType<typeof client>; readonly logger?: Logger } = {},
) {
  const context = {
    ...backupContext(options.client ?? client(), storage),
    logger: options.logger ?? silentLogger,
  };
  const result = await runBackup(context, {
    include: [`${database}.*`],
    consistency: "converge",
    parallelism: 1,
  });
  if (result.status !== "complete") throw new Error("expected a complete backup");
  return result.manifest;
}

async function expectSameCollections(source: string, target: string): Promise<void> {
  const names = await collectionNames(client(), source);
  expect(await collectionNames(client(), target)).toEqual(names);
  for (const name of names) {
    const expected = await rawDocuments(client(), source, name);
    const actual = await rawDocuments(client(), target, name);
    expect(firstDifference(expected, actual), `${target}.${name}`).toBeUndefined();
  }
}

/** Kills the session of the capture of backup `backupId` (found by its comment). */
async function killCaptureSession(backupId: string): Promise<void> {
  const comment = `mongoshield backup ${backupId} (converge)`;
  const operations = await client()
    .db("admin")
    .aggregate<Document>([
      { $currentOp: { idleCursors: true, allUsers: true } },
      {
        $match: {
          $or: [{ "cursor.originatingCommand.comment": comment }, { "command.comment": comment }],
        },
      },
    ])
    .toArray();
  const sessions = operations.flatMap((operation) =>
    operation.lsid?.id === undefined ? [] : [{ id: operation.lsid.id }],
  );
  if (sessions.length === 0) throw new Error(`no change stream found for ${comment}`);
  await client().db("admin").command({ killSessions: sessions });
}

/** The backup id in a storage key (`…/<id>/…`), for `killCaptureSession`. */
function backupIdOf(key: string): string {
  const [, id] = /backups\/([^/]+)\//.exec(key) ?? [];
  if (id === undefined) throw new Error(`no backup id in ${key}`);
  return id;
}

/** Waits (up to 30 s) until `condition` holds: the capture's next getMore has run. */
async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition() && waited < 30_000; waited += 50) await sleep(50);
}

function catchError(promise: Promise<unknown>): Promise<MongoShieldError> {
  return promise.then(
    () => {
      throw new Error("expected the backup to fail");
    },
    (error: unknown) => {
      if (!isMongoShieldError(error)) throw error;
      return error;
    },
  );
}

describe("converge capture resume", () => {
  it("resumes after its session is killed mid-backup, and still converges", async () => {
    const source = newDatabase("cvr_kill");
    const target = newDatabase("cvr_kill_dst");
    for (const name of ["a", "b", "c"]) await seed(source, name, 20);
    const { logger, messages } = recordingLogger();

    let killed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (killed || !isDataFileOf(key, "b")) return;
      killed = true;
      const db = client().db(source);
      await db.collection<TestDocument>("a").updateMany({}, { $set: { before: true } });
      await killCaptureSession(backupIdOf(key));
      // Made after the kill: only a resumed stream can record them.
      await db.collection<TestDocument>("a").updateMany({ n: { $lt: 10 } }, { $set: { after: 1 } });
      await db.collection<TestDocument>("a").deleteOne({ _id: 19 });
      await db.collection<TestDocument>("fresh").insertOne({ _id: "new" });
    });
    const manifest = await convergeBackup(storage, source, { logger });
    expect(killed).toBe(true);
    expect(messages).toContain("warn: The change stream was interrupted and has been resumed");

    await runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } },
    );
    await expectSameCollections(source, target);
  });

  it("fails with MS_CHANGE_HISTORY_LOST when the history is gone by the time it resumes", async () => {
    const source = newDatabase("cvr_lost");
    await seed(source, "a", 5);
    await seed(source, "b", 5);
    let armed = false;
    let fired = false;
    const inject: FaultInjector = (command) => {
      if (!armed) return undefined;
      if (isChangeStreamGetMore(command)) {
        fired = true;
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
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (!isDataFileOf(key, "b")) return;
      armed = true;
      // Hold the dump until the capture has hit the fault (its getMores never stop).
      await until(() => fired);
    });
    const error = await catchError(
      convergeBackup(storage, source, { client: clientWithFaults(client(), inject) }),
    );
    expect(fired).toBe(true);
    expect(error.code).toBe("MS_CHANGE_HISTORY_LOST");
  });

  it("gives up after a bounded number of attempts when the server stays unreachable", async () => {
    const source = newDatabase("cvr_down");
    await seed(source, "a", 5);
    await seed(source, "b", 5);
    let armed = false;
    let reopenAttempts = 0;
    const inject: FaultInjector = (command) => {
      if (!armed) return undefined;
      if (changeStreamStage(command)?.resumeAfter !== undefined) reopenAttempts += 1;
      if (isChangeStreamGetMore(command) || changeStreamStage(command) !== undefined) {
        return new MongoNetworkError("connection reset by peer");
      }
      return undefined;
    };
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (!isDataFileOf(key, "b")) return;
      armed = true;
      await until(() => reopenAttempts >= 5);
    });
    const error = await catchError(
      convergeBackup(storage, source, { client: clientWithFaults(client(), inject) }),
    );
    expect(error.code).toBe("MS_CONNECTION_FAILED");
    expect(reopenAttempts).toBe(5);
  });
});
