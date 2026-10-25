// Integration tests for `verifyFirst` (src/engine/restore-verify-first.ts): a restore
// that checksums every file it will read before its first write. Without it, a data
// file damaged late in a large collection is only found after the earlier batches
// were inserted; with it, the restore refuses and the target stays exactly as it was.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRestore } from "../../src/engine/restore.ts";
import { isMongoShieldError, type MongoShieldError } from "../../src/errors.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import type { RestoreOptions } from "../../src/types.ts";
import { flipByte, replaceStoredFile, writeTestBackup } from "../helpers/backup-fixtures.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { runTestCli } from "./extras/cli-utils.ts";

const client = useMongoClient();

const documents = Array.from({ length: 3000 }, (_, index) => ({ _id: index, value: `v${index}` }));

/** A backup of `app.a` in three parts of 1000 documents, with its LAST part damaged. */
async function backupWithDamagedLastPart(storage: StorageAdapter): Promise<Manifest> {
  const manifest = await writeTestBackup(storage, {
    namespaces: [
      { ns: "app.a", documents, documentsPerPart: 1000 },
      { ns: "app.b", documents: documents.slice(0, 10) },
    ],
  });
  const lastPart = manifest.namespaces[0]?.files[2];
  if (lastPart === undefined) throw new Error("no third part");
  await replaceStoredFile(storage, manifest, lastPart.key, (bytes) =>
    flipByte(bytes, Math.floor(bytes.length / 2)),
  );
  return manifest;
}

function restore(storage: MemoryStorage, target: string, options: Partial<RestoreOptions> = {}) {
  return runRestore(
    { client: client(), storage, logger: silentLogger },
    { backup: "latest", rename: { "app.*": `${target}.*` }, parallelism: 1, ...options },
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

describe("restore with verifyFirst", () => {
  it("without it, a damaged last part is found only after earlier parts were inserted", async () => {
    const storage = memoryStorage();
    await backupWithDamagedLastPart(storage);
    const target = uniqueDb("vf");
    const error = await failure(restore(storage, target));
    expect(error.code).toBe("MS_INTEGRITY_FAILED");
    // This is the problem verifyFirst solves: data was written before the failure.
    expect(await client().db(target).collection("a").countDocuments()).toBeGreaterThan(0);
  });

  it("fails with MS_INTEGRITY_FAILED and writes nothing when a late part is damaged", async () => {
    const storage = memoryStorage();
    const manifest = await backupWithDamagedLastPart(storage);
    const target = uniqueDb("vf");
    const error = await failure(restore(storage, target, { verifyFirst: true }));
    expect(error.code).toBe("MS_INTEGRITY_FAILED");
    expect(error.message).toContain("nothing was written");
    expect(error.message).toContain(manifest.namespaces[0]?.files[2]?.key ?? "?");
    expect(error.details?.problems).toHaveLength(1);
    expect(await client().db(target).listCollections().toArray()).toEqual([]);
  });

  it("leaves existing data untouched in drop mode when a file is damaged", async () => {
    const storage = memoryStorage();
    await backupWithDamagedLastPart(storage);
    const target = uniqueDb("vf");
    await client()
      .db(target)
      .collection("a")
      .insertOne({ _id: "live" } as never);
    const error = await failure(restore(storage, target, { verifyFirst: true, mode: "drop" }));
    expect(error.code).toBe("MS_INTEGRITY_FAILED");
    const live = await client().db(target).collection("a").find().toArray();
    expect(live).toEqual([{ _id: "live" }]);
  });

  it("reports every missing and damaged file at once", async () => {
    const storage = memoryStorage();
    const manifest = await backupWithDamagedLastPart(storage);
    const missing = manifest.namespaces[1]?.files[0];
    if (missing === undefined) throw new Error("no file");
    await storage.delete([`backups/${manifest.id}/${missing.key}`]);
    const error = await failure(restore(storage, uniqueDb("vf"), { verifyFirst: true }));
    expect(error.details?.problems).toEqual([
      {
        subject: manifest.namespaces[0]?.files[2]?.key,
        problem: expect.stringContaining("SHA-256"),
      },
      { subject: missing.key, problem: "The file is missing from storage." },
    ]);
  });

  it("only checks the files of the namespaces being restored", async () => {
    const storage = memoryStorage();
    await backupWithDamagedLastPart(storage);
    const target = uniqueDb("vf");
    const result = await restore(storage, target, { verifyFirst: true, include: ["app.b"] });
    expect(result.documentsRestored).toBe(10);
  });

  it("restores normally when every file is intact, also in a dry run", async () => {
    const storage = memoryStorage();
    await writeTestBackup(storage, { namespaces: [{ ns: "app.a", documents }] });
    const target = uniqueDb("vf");
    const dry = await restore(storage, target, { verifyFirst: true, dryRun: true });
    expect(dry.dryRun).toBe(true);
    const result = await restore(storage, target, { verifyFirst: true });
    expect(result.documentsRestored).toBe(3000);
  });
});

describe("mongoshield restore --verify-first", () => {
  let workDir: string;
  let storagePath: string;
  let backupId: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "mongoshield-vf-"));
    storagePath = join(workDir, "storage");
    backupId = (await backupWithDamagedLastPart(fileStorage({ path: storagePath }))).id;
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function restoreCli(target: string, ...extra: string[]) {
    return runTestCli(
      [
        "restore",
        backupId,
        "--from",
        storagePath,
        "--to-uri",
        mongoUri(),
        "--rename",
        `app.*=${target}.*`,
        "--yes",
        ...extra,
      ],
      workDir,
    );
  }

  it("verifies first by default when a target already holds documents", async () => {
    const target = uniqueDb("vfc");
    await client()
      .db(target)
      .collection("a")
      .insertOne({ _id: "live" } as never);
    const run = await restoreCli(target, "--mode", "insert");
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("MS_INTEGRITY_FAILED");
    expect(run.stderr).toContain("nothing was written");
    expect(await client().db(target).collection("a").countDocuments()).toBe(1);
    expect(await client().db(target).listCollections().toArray()).toHaveLength(1);
  });

  it("does not verify first into empty targets unless asked", async () => {
    const target = uniqueDb("vfc");
    const run = await restoreCli(target);
    expect(run.stderr).toContain("MS_INTEGRITY_FAILED");
    expect(run.stderr).not.toContain("nothing was written");

    const asked = uniqueDb("vfc");
    const verified = await restoreCli(asked, "--verify-first");
    expect(verified.stderr).toContain("nothing was written");
    expect(await client().db(asked).listCollections().toArray()).toEqual([]);
  });

  it("skips the check with --no-verify-first and refuses contradicting flags", async () => {
    const target = uniqueDb("vfc");
    await client()
      .db(target)
      .collection("a")
      .insertOne({ _id: "live" } as never);
    const skipped = await restoreCli(target, "--mode", "insert", "--no-verify-first");
    expect(skipped.stderr).toContain("MS_INTEGRITY_FAILED");
    expect(skipped.stderr).not.toContain("nothing was written");

    const both = await restoreCli(uniqueDb("vfc"), "--verify-first", "--no-verify-first");
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("contradicts");
  });
});
