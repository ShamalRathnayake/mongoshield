// Integration tests for the free-space check in runBackup (src/engine/backup-space.ts):
// a backup that clearly will not fit is refused before anything is written, a nearly
// full storage gives a warning in the logs, the result and a `storage:space` progress
// event, and storage without `space()` is not checked at all.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listBackups } from "../../src/catalog/catalog.ts";
import { runBackup } from "../../src/engine/backup.ts";
import { isMongoShieldError, throwIfAborted } from "../../src/errors.ts";
import type { Logger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter, StorageSpace } from "../../src/storage/types.ts";
import type { BackupOptions, ProgressEvent } from "../../src/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("bkspace");
const own: BackupOptions = { include: [`${database}.*`], consistency: "none" };

beforeAll(async () => {
  const db = client().db(database);
  await db.collection("orders").insertMany(Array.from({ length: 200 }, (_, n) => ({ n })));
});

afterAll(async () => {
  await client().db(database).dropDatabase();
});

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  const noop = (): void => {};
  return {
    warnings,
    debug: noop,
    info: noop,
    error: noop,
    warn: (message) => warnings.push(message),
  };
}

/** A memory store that reports whatever `space()` says now. */
function storageReporting(space: () => StorageSpace): {
  storage: StorageAdapter;
  memory: MemoryStorage;
} {
  const memory = memoryStorage();
  const storage: StorageAdapter = {
    ...memory,
    async space(options) {
      throwIfAborted(options?.signal);
      return space();
    },
  };
  return { storage, memory };
}

describe("the free-space check before a backup", () => {
  it("refuses a backup that will not fit after the previous one, writing nothing", async () => {
    let free = 1024 ** 3;
    const { storage, memory } = storageReporting(() => ({
      freeBytes: free,
      totalBytes: 2 * 1024 ** 3,
    }));
    const first = await runBackup(backupContext(client(), storage), own);
    expect(first.status).toBe("complete");
    const stored = first.status === "complete" ? first.manifest.totals.bytesStored : 0;
    expect(stored).toBeGreaterThan(0);

    free = stored - 1;
    const keysBefore = memory.keys();
    const error = await runBackup(backupContext(client(), storage), own).catch(
      (reason: unknown) => reason,
    );
    expect(isMongoShieldError(error, "MS_STORAGE_INSUFFICIENT_SPACE")).toBe(true);
    // Refused before the first write: no new backup directory, no lease, nothing.
    expect(memory.keys()).toEqual(keysBefore);
    expect((await listBackups(storage)).map((entry) => entry.id)).toEqual([first.id]);
  });

  it("warns past 80% full in the log, the result and a storage:space event", async () => {
    const { storage } = storageReporting(() => ({
      totalBytes: 100 * 1024 ** 3,
      usedBytes: 90 * 1024 ** 3,
      trashBytes: 10 * 1024 ** 3,
    }));
    const logger = recordingLogger();
    const events: ProgressEvent[] = [];
    const result = await runBackup(
      { ...backupContext(client(), storage), logger },
      { ...own, onProgress: (event) => events.push(event) },
    );
    expect(result.status).toBe("complete");
    const warning = logger.warnings.find((line) => line.includes("90% full"));
    expect(warning).toContain("in the trash");
    expect(result.status === "complete" && result.warnings).toContain(warning);
    const spaceEvents = events.filter((event) => event.type === "storage:space");
    expect(spaceEvents).toEqual([
      {
        type: "storage:space",
        space: {
          totalBytes: 100 * 1024 ** 3,
          usedBytes: 90 * 1024 ** 3,
          trashBytes: 10 * 1024 ** 3,
        },
        usedFraction: 0.9,
        estimatedBytes: undefined,
        warning,
      },
    ]);
    // The event comes before any namespace is dumped.
    expect(events[0]?.type).toBe("storage:space");
  });

  it("skips the check quietly for storage without space()", async () => {
    const logger = recordingLogger();
    const events: ProgressEvent[] = [];
    const result = await runBackup(
      { ...backupContext(client(), memoryStorage()), logger },
      { ...own, onProgress: (event) => events.push(event) },
    );
    expect(result.status === "complete" && result.warnings).toBeFalsy();
    expect(events.some((event) => event.type === "storage:space")).toBe(false);
    expect(logger.warnings).toEqual([]);
  });
});
