// Integration tests for restore's less common paths: namespaces the plan skips (views
// that already exist in merge modes), a manifest whose document counts are wrong, the
// server refusing to create a collection, conflicts in merge modes, and patterns that
// select nothing.

import type { Document } from "mongodb";
import { describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { isMongoShieldError, type MongoShieldError } from "../../src/errors.ts";
import { manifestKey } from "../../src/format/layout.ts";
import { serializeManifest } from "../../src/format/manifest-io.ts";
import { type Logger, silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { RestoreOptions } from "../../src/types.ts";
import { writeTestBackup } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";

const client = useMongoClient();

function restore(
  storage: MemoryStorage,
  target: string,
  options: Partial<RestoreOptions> = {},
  logger: Logger = silentLogger,
) {
  return runRestore(
    { client: client(), storage, logger },
    { backup: "latest", rename: { "app.*": `${target}.*` }, ...options },
  );
}

async function failure(promise: Promise<unknown>): Promise<MongoShieldError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the restore to fail");
    },
    (caught: unknown) => caught,
  );
  if (!isMongoShieldError(error)) throw error;
  return error;
}

function warningLogger(warnings: Document[]): Logger {
  return { ...silentLogger, warn: (message, fields) => warnings.push({ message, ...fields }) };
}

describe("restore edge cases", () => {
  it("skips views that already exist in insert mode, also with verifyFirst, and writes nothing else", async () => {
    const storage = memoryStorage();
    await writeTestBackup(storage, {
      namespaces: [{ ns: "app.v", type: "view", options: { viewOn: "c", pipeline: [] } }],
    });
    const target = uniqueDb("re");
    await client().db(target).createCollection("v", { viewOn: "other", pipeline: [] });
    const result = await restore(storage, target, { mode: "insert", verifyFirst: true });
    expect(result.plan.entries).toMatchObject([{ action: "skip" }]);
    const [info] = await client()
      .db(target)
      .listCollections({ name: "v" }, { nameOnly: false })
      .toArray();
    expect(info?.options?.viewOn).toBe("other");
  });

  it("replays a converge backup next to views the plan skips", async () => {
    const source = uniqueDb("resrc");
    const db = client().db(source);
    await db.collection("c").insertMany([{ n: 1 }, { n: 2 }]);
    await db.createCollection("v", { viewOn: "c", pipeline: [] });
    const storage = memoryStorage();
    const backup = await runBackup(backupContext(client(), storage), {
      include: [`${source}.*`],
      consistency: "converge",
    });
    if (backup.status !== "complete") throw new Error("expected a complete backup");
    const target = uniqueDb("re");
    await client().db(target).createCollection("v", { viewOn: "elsewhere", pipeline: [] });
    const result = await runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: backup.manifest.id, rename: { [`${source}.*`]: `${target}.*` }, mode: "insert" },
    );
    expect(result.documentsRestored).toBe(2);
    expect(result.plan.entries.find((entry) => entry.to === `${target}.v`)?.action).toBe("skip");
    await client().db(source).dropDatabase();
  });

  it("warns when the data files hold a different number of documents than the manifest", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.c", documents: [{ _id: 1 }, { _id: 2 }] }],
    });
    const [entry] = manifest.namespaces;
    if (entry === undefined) throw new Error("no entry");
    const edited = {
      ...manifest,
      namespaces: [{ ...entry, documents: 3 }],
      totals: { ...manifest.totals, documents: 3 },
    };
    await storage.put(manifestKey(manifest.id), Buffer.from(serializeManifest(edited), "utf8"));
    const warnings: Document[] = [];
    const result = await restore(storage, uniqueDb("re"), {}, warningLogger(warnings));
    expect(result.documentsRestored).toBe(2);
    expect(warnings).toContainEqual(expect.objectContaining({ manifest: 3, read: 2 }));
  });

  it("fails with MS_RESTORE_FAILED naming the step when the server refuses to create a collection", async () => {
    const storage = memoryStorage();
    await writeTestBackup(storage, {
      namespaces: [
        { ns: "app.a", options: { capped: true }, documents: [{ _id: 1 }] },
        { ns: "app.b", documents: [{ _id: 1 }] },
      ],
    });
    const error = await failure(restore(storage, uniqueDb("re"), { parallelism: 1 }));
    expect(error.code).toBe("MS_RESTORE_FAILED");
    expect(error.message).toMatch(
      /^Creating .*\.a failed: .*possibly partial: .*\.a; not started: 1\.$/,
    );
    expect(error.hint).toContain("restore again with --drop");
    expect(error.details?.notStartedNamespaces).toHaveLength(1);
  });

  it("reports a storage failure that is not a MongoShieldError as MS_RESTORE_FAILED", async () => {
    const base = memoryStorage();
    await writeTestBackup(base, { namespaces: [{ ns: "app.c", documents: [{ _id: 1 }] }] });
    const failing: MemoryStorage = {
      ...base,
      async get(key, options) {
        if (key.includes("/c.bson")) throw new Error("disk on fire");
        return base.get(key, options);
      },
    };
    const error = await failure(restore(failing, uniqueDb("re")));
    expect(error.code).toBe("MS_RESTORE_FAILED");
    expect(error.message).toMatch(/^Restore failed: disk on fire Restore stopped/);
  });

  it("refuses to merge into a time series that holds measurements, with the merge-mode hint", async () => {
    const storage = memoryStorage();
    await writeTestBackup(storage, {
      namespaces: [
        {
          ns: "app.m",
          type: "timeseries",
          options: { timeseries: { timeField: "at" } },
          documents: [{ at: new Date(0) }],
        },
      ],
    });
    const target = uniqueDb("re");
    await client()
      .db(target)
      .createCollection("m", { timeseries: { timeField: "at" } });
    await client()
      .db(target)
      .collection("m")
      .insertOne({ at: new Date(1) });
    const error = await failure(restore(storage, target, { mode: "upsert" }));
    expect(error.code).toBe("MS_RESTORE_CONFLICT");
    expect(error.message).toContain("cannot be merged without duplicates");
    expect(error.hint).toBe(
      "Restore with --drop to replace the targets, or --rename to restore elsewhere.",
    );
  });

  it("lists what the backup holds when the patterns select nothing", async () => {
    const storage = memoryStorage();
    await writeTestBackup(storage, {
      namespaces: Array.from({ length: 12 }, (_, n) => ({ ns: `app.c${n}`, documents: [] })),
    });
    const error = await failure(restore(storage, uniqueDb("re"), { include: ["nothing.*"] }));
    expect(error.code).toBe("MS_CONFIG_INVALID");
    expect(error.hint).toMatch(/^The backup holds: app\.c0, .*, …\.$/);
  });

  it("rejects invalid concurrency settings before reading anything", async () => {
    const storage = memoryStorage();
    for (const options of [{ parallelism: 0 }, { insertWorkers: 1.5 }]) {
      const error = await failure(restore(storage, uniqueDb("re"), options));
      expect(error.code).toBe("MS_CONFIG_INVALID");
    }
  });
});
