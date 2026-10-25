// Integration tests for how runBackup fails: invalid options are rejected before
// any data is read, and a run that fails or is aborted mid-way leaves no manifest,
// no partial files and no open cursors behind.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { isMongoShieldError, MongoShieldError } from "../../src/errors.ts";
import type { Logger } from "../../src/logger.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { PutOptions, StorageAdapter } from "../../src/storage/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("bkfail");
const BIG_COUNT = 30_000;

beforeAll(async () => {
  const db = client().db(database);
  await db.collection("a_small").insertMany([{ n: 1 }, { n: 2 }]);
  await db.collection("b_small").insertMany([{ n: 3 }]);
  const big = db.collection("c_big");
  for (let start = 0; start < BIG_COUNT; start += 10_000) {
    await big.insertMany(
      Array.from({ length: 10_000 }, (_, offset) => ({ n: start + offset, pad: "y".repeat(500) })),
    );
  }
});

afterAll(async () => {
  await client().db(database).dropDatabase();
});

/** Runs a promise that must fail and returns its MongoShieldError. */
async function failure(promise: Promise<unknown>): Promise<MongoShieldError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof MongoShieldError))
    throw new Error(`expected a MongoShieldError, got ${String(error)}`);
  return error;
}

/** Idle server-side cursors on a namespace (left open by a failed run, if any). */
async function openCursors(ns: string): Promise<number> {
  const cursors = await client()
    .db("admin")
    .aggregate([
      { $currentOp: { idleCursors: true, allUsers: true } },
      { $match: { ns, type: "idleCursor" } },
    ])
    .toArray();
  return cursors.length;
}

/**
 * Wraps a memory storage so the put of `c_big`'s data file runs `onBigWrite` once
 * some of its bytes have arrived, then keeps reading as normal.
 */
function storageWithHook(
  onBigWrite: (body: Readable) => Promise<void> | void,
): MemoryStorage & { puts: string[] } {
  const inner = memoryStorage();
  const puts: string[] = [];
  return {
    ...inner,
    puts,
    async put(key: string, body: Readable | Uint8Array, options?: PutOptions) {
      puts.push(key);
      if (key.includes("/c_big.bson") && !(body instanceof Uint8Array)) {
        await onBigWrite(body);
      }
      return inner.put(key, body, options);
    },
  };
}

/** Reads the first chunk of a body (so data is flowing) without consuming the rest. */
async function waitForFirstChunk(body: Readable): Promise<void> {
  await new Promise<void>((resolve) => body.once("readable", () => resolve()));
}

const own = { include: [`${database}.*`] };

describe("runBackup validation", () => {
  it.each([
    ["a bad parallelism", { ...own, parallelism: 0 }, "MS_CONFIG_INVALID"],
    ["a malformed pattern", { include: ["no spaces allowed.x y"] }, "MS_CONFIG_INVALID"],
    [
      "a query for an unknown namespace",
      { ...own, query: { [`${database}.nope`]: {} } },
      "MS_CONFIG_INVALID",
    ],
  ])("rejects %s without writing anything", async (_name, options, code) => {
    const storage = memoryStorage();
    const error = await failure(runBackup(backupContext(client(), storage), options));
    expect(error.code).toBe(code);
    expect(storage.keys()).toEqual([]);
  });

  it("rejects an invalid recipient before reading any data", async () => {
    const storage = memoryStorage();
    const error = await failure(
      runBackup(
        backupContext(client(), storage, { encryption: { recipients: ["age1bogus"] } }),
        own,
      ),
    );
    expect(error.code).toBe("MS_CONFIG_INVALID");
    expect(storage.keys()).toEqual([]);
  });

  it("explains which namespaces exist when nothing matches", async () => {
    const error = await failure(
      runBackup(backupContext(client(), memoryStorage()), { include: [`${database}.zzz*`] }),
    );
    expect(error.code).toBe("MS_CONFIG_INVALID");
    expect(error.hint).toContain(`${database}.a_small`);
  });

  it("refuses the backup when beforeCommit throws, removing its files and keeping the error", async () => {
    const storage = memoryStorage();
    const refusal = new MongoShieldError("MS_CONFIG_INVALID", "the guard said no");
    let seenNamespaces = 0;
    const error = await failure(
      runBackup(backupContext(client(), storage), {
        include: [`${database}.a_small`, `${database}.b_small`],
        beforeCommit: async (manifest) => {
          seenNamespaces = manifest.namespaces.length;
          // The data files exist at this point; only the manifest is missing.
          expect(storage.keys().length).toBeGreaterThan(0);
          throw refusal;
        },
      }),
    );
    expect(error).toBe(refusal);
    expect(seenNamespaces).toBe(2);
    expect(storage.keys()).toEqual([]);
  });

  it("rejects an already-aborted signal with MS_ABORTED", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      runBackup(backupContext(client(), memoryStorage()), { ...own, signal: controller.signal }),
    );
    expect(error.code).toBe("MS_ABORTED");
  });
});

describe("runBackup failing mid-run", () => {
  it("cleans up written files and closes the cursor when aborted mid-write", async () => {
    const controller = new AbortController();
    const storage = storageWithHook(async (body) => {
      await waitForFirstChunk(body);
      controller.abort();
    });
    const error = await failure(
      runBackup(backupContext(client(), storage), {
        ...own,
        parallelism: 1,
        signal: controller.signal,
      }),
    );
    expect(error.code).toBe("MS_ABORTED");
    // The small collections had been written completely before the abort…
    expect(storage.puts.some((key) => key.includes("/a_small.bson"))).toBe(true);
    // …and were removed again, together with everything else.
    expect(storage.keys()).toEqual([]);
    expect(await openCursors(`${database}.c_big`)).toBe(0);
  });

  it("reports a timeout as MS_TIMEOUT", async () => {
    const storage = storageWithHook(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const error = await failure(
      runBackup(backupContext(client(), storage), { ...own, signal: AbortSignal.timeout(100) }),
    );
    expect(error.code).toBe("MS_TIMEOUT");
    expect(storage.keys()).toEqual([]);
  });

  it("fails cleanly when storage fails in the middle of a data file", async () => {
    const inner = memoryStorage();
    const storage: StorageAdapter = {
      ...inner,
      async put(key, body, options) {
        if (!key.includes("/c_big.bson") || body instanceof Uint8Array) {
          return inner.put(key, body, options);
        }
        let received = 0;
        for await (const chunk of body) {
          received += (chunk as Uint8Array).length;
          if (received > 64 * 1024) {
            throw new MongoShieldError("MS_STORAGE_IO", "The disk caught fire.");
          }
        }
        throw new Error("the data file should be larger than 64 KiB");
      },
    };
    const warnings: string[] = [];
    const noop = (): void => {};
    const logger: Logger = { debug: noop, info: noop, error: noop, warn: (m) => warnings.push(m) };

    const error = await failure(
      // Uncompressed, so the data file is surely larger than 64 KiB.
      runBackup(
        { ...backupContext(client(), storage, { compression: "none" }), logger },
        { ...own, parallelism: 3 },
      ),
    );
    expect(error.code).toBe("MS_STORAGE_IO");
    expect(error.message).toContain("caught fire");
    expect(inner.keys()).toEqual([]);
    expect(warnings).toEqual([]);
    expect(await openCursors(`${database}.c_big`)).toBe(0);
  });

  it("leaves no files or temp files behind in file storage when aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mongoshield-abort-"));
    try {
      const inner = fileStorage({ path: directory });
      const controller = new AbortController();
      const storage: StorageAdapter = {
        ...inner,
        async put(key, body, options) {
          if (key.includes("/c_big.bson") && !(body instanceof Uint8Array)) {
            // Abort once the adapter has started streaming the file to disk.
            setTimeout(() => controller.abort(), 50);
          }
          return inner.put(key, body, options);
        },
      };
      const error = await failure(
        runBackup(backupContext(client(), storage), {
          ...own,
          parallelism: 1,
          signal: controller.signal,
        }),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(await listFiles(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/** Every regular file under `directory`, recursively (including hidden temp files). */
async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}
