// Integration tests for less travelled paths of runBackup (src/engine/backup.ts):
// resumable runs with an explicit consistency mode, cleanup of a refused encrypted or
// resumable backup (key envelope and checkpoint included), cleanup that itself fails,
// and a checkpoint that cannot be deleted after the commit.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { checkpointKey } from "../../src/engine/backup-checkpoint.ts";
import { MongoShieldError } from "../../src/errors.ts";
import type { Logger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import type { BackupOptions, CompletedBackupResult } from "../../src/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("bkedge");
const own: BackupOptions = { include: [`${database}.*`] };

beforeAll(async () => {
  const db = client().db(database);
  await db.collection("orders").insertMany(Array.from({ length: 50 }, (_, n) => ({ n })));
  await db.collection("users").insertMany([{ name: "ada" }]);
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

function expectComplete(result: Awaited<ReturnType<typeof runBackup>>): CompletedBackupResult {
  if (result.status !== "complete") throw new Error(`expected complete, got ${result.status}`);
  return result;
}

/** A refusal from `beforeCommit`, after every data file was written. */
const refuse: BackupOptions["beforeCommit"] = async () => {
  throw new MongoShieldError("MS_CONFIG_INVALID", "refused by the test");
};

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("resumable runs", () => {
  it("records no warning when the consistency mode was chosen explicitly", async () => {
    const result = expectComplete(
      await runBackup(backupContext(client(), memoryStorage()), {
        ...own,
        consistency: "none",
        maxDurationMs: 600_000,
      }),
    );
    expect(result.manifest.consistency).toEqual({ mode: "none" });
  });

  it("names the span and the single invocation when auto had to use none", async () => {
    const result = expectComplete(
      await runBackup(backupContext(client(), memoryStorage()), { ...own, maxDurationMs: 600_000 }),
    );
    expect(result.manifest.consistency.warning).toMatch(/over 1 invocation\./);
  });

  it("completes, with a warning, when the checkpoint cannot be deleted afterwards", async () => {
    const base = memoryStorage();
    const storage: MemoryStorage = {
      ...base,
      async delete(keys, options) {
        if (keys.some((key) => key.endsWith(".json") && key.includes("checkpoint"))) {
          throw new Error("delete denied");
        }
        return base.delete(keys, options);
      },
    };
    const logger = recordingLogger();
    const result = expectComplete(
      await runBackup(
        { ...backupContext(client(), storage), logger },
        { ...own, maxDurationMs: 600_000 },
      ),
    );
    expect(logger.warnings).toContain("Could not delete the checkpoint of the completed backup");
    expect(base.keys()).toContain(checkpointKey(result.id));
  });

  it("removes its checkpoint with its files when the commit is refused", async () => {
    const storage = memoryStorage();
    const error = await failure(
      runBackup(backupContext(client(), storage), {
        ...own,
        maxDurationMs: 600_000,
        partSizeBytes: 1024,
        beforeCommit: refuse,
      }),
    );
    expect(String(error)).toMatch(/refused by the test/);
    expect(storage.keys()).toEqual([]);
  });
});

describe("cleanup of a failed backup", () => {
  it("removes the key envelope of a refused passphrase backup too", async () => {
    const storage = memoryStorage();
    const error = await failure(
      runBackup(backupContext(client(), storage, { encryption: { passphrase: "pw-for-tests" } }), {
        ...own,
        beforeCommit: refuse,
      }),
    );
    expect(String(error)).toMatch(/refused by the test/);
    expect(storage.keys()).toEqual([]);
  });

  it("deletes an attempted manifest before the data, and keeps the data when that fails", async () => {
    const base = memoryStorage();
    const storage: StorageAdapter = {
      ...base,
      async put(key, body, options) {
        if (key.endsWith("/manifest.json")) {
          await base.put(key, body, options);
          throw new Error("the reply was lost");
        }
        return base.put(key, body, options);
      },
      async delete(keys, options) {
        if (keys.some((key) => key.endsWith("/manifest.json"))) throw new Error("delete denied");
        return base.delete(keys, options);
      },
    };
    const logger = recordingLogger();
    const error = await failure(runBackup({ ...backupContext(client(), storage), logger }, own));
    expect(String(error)).toMatch(/the reply was lost/);
    expect(logger.warnings).toContain(
      "Could not remove the files of the failed backup; delete them by hand",
    );
    // The manifest landed and could not be removed: its data must stay, or a complete
    // backup would turn into a corrupt one.
    const manifests = base.keys().filter((key) => key.endsWith("/manifest.json"));
    expect(manifests).toHaveLength(1);
    expect(base.keys().some((key) => key.includes("/orders.bson"))).toBe(true);
  });

  it("deletes the manifest and the data when the manifest write fails and cleanup works", async () => {
    const base = memoryStorage();
    const storage: StorageAdapter = {
      ...base,
      async put(key, body, options) {
        if (key.endsWith("/manifest.json")) {
          await base.put(key, body, options);
          throw new Error("the reply was lost");
        }
        return base.put(key, body, options);
      },
    };
    const error = await failure(runBackup(backupContext(client(), storage), own));
    expect(String(error)).toMatch(/the reply was lost/);
    expect(base.keys()).toEqual([]);
  });
});
