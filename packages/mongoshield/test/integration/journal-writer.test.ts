// The journal writer's settings, lease and side channels (src/journal/writer.ts):
// invalid options are refused before anything starts, a second writer can wait for the
// lease, a writer that loses its lease stops, a broken metrics callback or base
// backup never stops the journal, and gaps and segments reach the configured
// notification targets and heartbeat.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { readClusterTime } from "../../src/engine/converge-time.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { STATE_KEY } from "../../src/journal/layout.ts";
import { JOURNAL_FORMAT_VERSION, type JournalState } from "../../src/journal/records.ts";
import type { Logger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import type { AnyDocument } from "./converge-test-utils.ts";
import {
  clientWithOplogStartingAt,
  journaledEvents,
  startTestJournal,
  waitFor,
  waitForJournalToCatchUp,
} from "./journal-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];

/** A local HTTP server recording every request, standing in for webhooks and heartbeats. */
let server: Server;
let baseUrl = "";
const requests: { readonly url: string; readonly body: string }[] = [];

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push({ url: request.url ?? "", body });
      response.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function newDatabase(): string {
  const name = uniqueDb("jw");
  databases.push(name);
  return name;
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

async function startFailure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected startJournal to fail");
    },
    (error: unknown) => error,
  );
}

/** A journal whose last commit is older than the (simulated) oplog: history is lost. */
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

describe("journal writer settings", () => {
  it("refuses invalid settings before taking the lease", async () => {
    const storage = memoryStorage();
    for (const overrides of [
      { segmentSeconds: 0 },
      { segmentBytes: -1 },
      { leaseMs: Number.NaN },
      { retryDelayMs: 0 },
      { onGap: "backup" as const },
    ]) {
      const error = await startFailure(
        startTestJournal(client(), storage, newDatabase(), overrides),
      );
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID"), JSON.stringify(overrides)).toBe(true);
    }
    expect(storage.keys()).toEqual([]);
  });

  it("refuses storage without conditional writes", async () => {
    const base = memoryStorage();
    const storage: StorageAdapter = {
      ...base,
      capabilities: { ...base.capabilities, conditionalWrites: false },
    };
    const error = await startFailure(startTestJournal(client(), storage, newDatabase()));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });

  it("refuses a journal with segments but no state.json", async () => {
    const storage = memoryStorage();
    await storage.put(
      "journal/segments/2026-01-01/000000_1767225600-0000000001.bson.zst",
      Buffer.from("x"),
    );
    const error = await startFailure(startTestJournal(client(), storage, newDatabase()));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });
});

describe("journal writer lease", () => {
  it("lets a second writer wait for the lease and take over", async () => {
    const storage = memoryStorage();
    const database = newDatabase();
    const first = await startTestJournal(client(), storage, database, { leaseMs: 1000 });
    const { logger, messages } = recordingLogger();
    const second = startTestJournal(client(), storage, database, {
      leaseMs: 1000,
      waitForLease: true,
      logger,
    });
    await waitFor(() => messages.includes("info: Waiting for the journal writer lease"));
    await first.stop();
    const takeover = await second;
    try {
      await client().db(database).collection<AnyDocument>("items").insertOne({ _id: 1 });
      await waitForJournalToCatchUp(client(), storage);
    } finally {
      await takeover.stop();
    }
    expect(messages).toContain("info: Resuming the journal");
  });

  it("stops at once when another writer takes its lease", async () => {
    const storage = memoryStorage();
    const journal = await startTestJournal(client(), storage, newDatabase(), { leaseMs: 300 });
    // Another writer's lease: a higher generation than the current one.
    const [current] = storage.keys().filter((key) => key.startsWith("locks/journal/"));
    if (current === undefined) throw new Error("no lease object");
    const body = await storage.get(current);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    await storage.put("locks/journal/99999999999999999999.json", Buffer.concat(chunks));
    await expect(journal.done).rejects.toMatchObject({ code: "MS_STORAGE_PRECONDITION_FAILED" });
    expect(journal.status().running).toBe(false);
  });
});

describe("journal writer side channels", () => {
  it("survives a throwing onSegment callback and pings the heartbeat per segment", async () => {
    const storage = memoryStorage();
    const database = newDatabase();
    const { logger, messages } = recordingLogger();
    const journal = await startTestJournal(client(), storage, database, {
      logger,
      notify: { heartbeat: `${baseUrl}/beat`, retryDelayMs: 10 },
      onSegment: () => {
        throw new Error("metrics are down");
      },
    });
    try {
      await client().db(database).collection<AnyDocument>("items").insertOne({ _id: 1 });
      await waitForJournalToCatchUp(client(), storage);
      await waitFor(() => requests.some((request) => request.url === "/beat"));
    } finally {
      await journal.stop();
    }
    expect(messages).toContain("warn: The onSegment callback threw");
    expect(journal.status().segmentsWritten).toBeGreaterThan(0);
    expect(journal.status().lastSegmentLatencyMs).toBeGreaterThanOrEqual(0);
    expect(journal.status().rpoMs).toBeGreaterThanOrEqual(0);
  });

  it("alerts the targets about a gap and keeps journaling when the base backup fails", async () => {
    const storage = await journalWithLostHistory();
    const database = newDatabase();
    const { logger, messages } = recordingLogger();
    const journal = await startTestJournal(
      clientWithOplogStartingAt(client(), { t: 2_000_000, i: 1 }),
      storage,
      database,
      {
        logger,
        takeBaseBackup: async () => {
          throw new Error("no space left");
        },
        notify: {
          targets: [{ type: "webhook", url: `${baseUrl}/alerts`, on: ["failure"] }],
          heartbeat: `${baseUrl}/gap-beat`,
          retryDelayMs: 10,
        },
      },
    );
    try {
      await client().db(database).collection<AnyDocument>("items").insertOne({ _id: 1 });
      await waitForJournalToCatchUp(client(), storage);
      await waitFor(() =>
        messages.some((message) => message.includes("The base backup after the gap failed")),
      );
    } finally {
      await journal.stop();
    }
    expect(journal.status().gaps).toBe(1);
    const alert = requests.find((request) => request.url === "/alerts");
    expect(alert?.body).toContain("The change journal has a gap");
    expect(requests.some((request) => request.url === "/gap-beat/fail")).toBe(true);
  });
});

describe("journal writer segments and starts", () => {
  it("closes segments by size between two cluster times, losing nothing", async () => {
    const storage = memoryStorage();
    const database = newDatabase();
    // Every event fills a segment: each closes before the next cluster time.
    const journal = await startTestJournal(client(), storage, database, {
      segmentBytes: 1,
      segmentSeconds: 3600,
    });
    try {
      for (let n = 0; n < 5; n += 1) {
        await client().db(database).collection<AnyDocument>("items").insertOne({ _id: n });
      }
      await waitForJournalToCatchUp(client(), storage);
    } finally {
      await journal.stop();
    }
    expect(journal.status().segmentsWritten).toBeGreaterThanOrEqual(5);
    const ids = (await journaledEvents(storage, database))
      .filter((event) => event.op === "insert")
      .map((event) => event.id);
    expect(ids).toEqual([0, 1, 2, 3, 4]);
  });

  it("starts a new journal now when the newest base backup is older than the oplog", async () => {
    const storage = memoryStorage();
    const database = newDatabase();
    await client().db(database).collection<AnyDocument>("items").insertOne({ _id: "base" });
    const backup = await runBackup(backupContext(client(), storage), {
      include: [`${database}.*`],
      consistency: "converge",
    });
    if (backup.status !== "complete") throw new Error("backup failed");
    const { logger, messages } = recordingLogger();
    // The simulated oplog starts a second after the backup ended.
    const now = await readClusterTime(client());
    const oplogStart = { t: now.t + 1, i: 0 };
    const journal = await startTestJournal(
      clientWithOplogStartingAt(client(), oplogStart),
      storage,
      database,
      { logger },
    );
    try {
      await client().db(database).collection<AnyDocument>("items").insertOne({ _id: "after" });
      await waitForJournalToCatchUp(client(), storage);
    } finally {
      await journal.stop();
    }
    expect(messages).toContain("info: Starting a new journal at the newest base backup");
    expect(messages.some((message) => message.includes("starts now"))).toBe(true);
    // Not a gap: the new journal had nothing to lose.
    expect(journal.status().gaps).toBe(0);
  });
});
