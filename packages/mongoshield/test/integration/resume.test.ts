// Integration tests for checkpoints and resumption (docs/specs/PARTS-AND-RESUME.md,
// section 2): a run with a tiny maxDurationMs stops after one part, later runs
// continue it until the manifest is committed, and the result restores exactly.
// Also: what a resume refuses (other options, damaged files), and that prune keeps
// a run with a fresh checkpoint.

import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pruneBackups } from "../../src/catalog/prune.ts";
import { runBackup } from "../../src/engine/backup.ts";
import { checkpointKey, readCheckpoint } from "../../src/engine/backup-checkpoint.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { backupDir, manifestKey, resolveBackupKey } from "../../src/format/layout.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type {
  BackupOptions,
  BackupResult,
  CheckpointedBackupResult,
  CompletedBackupResult,
} from "../../src/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext, sourceDocuments } from "./backup-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("resume");
const restored = uniqueDb("resume_r");

/** Small parts, so the 2000 orders make many of them. */
const sliced: BackupOptions = {
  include: [`${database}.*`],
  partSizeBytes: 16 * 1024,
  parallelism: 1,
  maxDurationMs: 1,
};

beforeAll(async () => {
  const db = client().db(database);
  await db
    .collection("orders")
    .insertMany(Array.from({ length: 2000 }, (_, index) => ({ index, payload: "y".repeat(60) })));
  await db.collection("users").insertMany([{ name: "ada" }, { name: "grace" }]);
  await db.createCollection("names_view", { viewOn: "users", pipeline: [] });
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await client().db(restored).dropDatabase();
});

function expectCheckpointed(result: BackupResult): CheckpointedBackupResult {
  if (result.status !== "checkpointed")
    throw new Error(`expected a checkpoint, got ${result.status}`);
  return result;
}

function expectComplete(result: BackupResult): CompletedBackupResult {
  if (result.status !== "complete")
    throw new Error(`expected a complete backup, got ${result.status}`);
  return result;
}

/** Resumes until the backup completes; returns the result and how many calls it took. */
async function resumeUntilComplete(
  storage: MemoryStorage,
  resume: string,
): Promise<{ result: CompletedBackupResult; calls: number }> {
  for (let calls = 1; calls <= 200; calls++) {
    const result = await runBackup(backupContext(client(), storage), { ...sliced, resume });
    if (result.status === "complete") return { result, calls };
  }
  throw new Error("the backup never completed");
}

async function rawSet(ns: string): Promise<string[]> {
  return (await sourceDocuments(client(), ns)).map((buffer) => buffer.toString("hex")).sort();
}

describe("checkpoints and resume", () => {
  it("checkpoints, resumes repeatedly, completes and restores equal to the source", async () => {
    const storage = memoryStorage();
    const first = expectCheckpointed(await runBackup(backupContext(client(), storage), sliced));
    expect(first.checkpoint.key).toBe(checkpointKey(first.id));
    expect(first.checkpoint.partsDone).toBe(1);
    expect(first.checkpoint.partsTotal).toBeGreaterThan(3);
    // No manifest until the very end: the run is incomplete, not a backup yet.
    expect(await storage.head(manifestKey(first.id))).toBeUndefined();

    const second = expectCheckpointed(
      await runBackup(backupContext(client(), storage), { ...sliced, resume: "latest" }),
    );
    expect(second.id).toBe(first.id);
    expect(second.checkpoint.partsDone).toBe(2);

    const { result, calls } = await resumeUntilComplete(storage, first.id);
    expect(calls).toBeGreaterThan(1);
    const manifest = result.manifest;
    expect(manifest.id).toBe(first.id);
    expect(manifest.consistency.mode).toBe("none");
    expect(manifest.consistency.warning).toMatch(/between .* and .*, over \d+ invocations/);
    expect(await storage.head(checkpointKey(first.id))).toBeUndefined();

    await runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: manifest.id, rename: { [`${database}.*`]: `${restored}.*` } },
    );
    expect(await rawSet(`${restored}.orders`)).toEqual(await rawSet(`${database}.orders`));
    expect(await rawSet(`${restored}.users`)).toEqual(await rawSet(`${database}.users`));
  });

  it("records the plan and finished parts in the checkpoint", async () => {
    const storage = memoryStorage();
    const first = expectCheckpointed(await runBackup(backupContext(client(), storage), sliced));
    const checkpoint = await readCheckpoint(storage, first.id, undefined);
    const orders = checkpoint?.namespaces.find((entry) => entry.ns === `${database}.orders`);
    expect(orders?.boundaries?.length).toBe((orders?.parts.length ?? 0) - 1);
    expect(checkpoint?.namespaces.find((entry) => entry.type === "view")?.parts).toEqual([]);
    expect(checkpoint?.fingerprint.include).toEqual([`${database}.*`]);
  });

  it("completes in one call when the budget is large enough", async () => {
    const storage = memoryStorage();
    const result = await runBackup(backupContext(client(), storage), {
      ...sliced,
      maxDurationMs: 60_000,
    });
    expect(expectComplete(result).manifest.namespaces).toHaveLength(3);
    expect(storage.keys().some((key) => key.startsWith("_state/"))).toBe(false);
  });

  it('starts a new backup for resume "auto" when there is nothing to resume', async () => {
    const storage = memoryStorage();
    const result = await runBackup(backupContext(client(), storage), {
      include: [`${database}.users`],
      resume: "auto",
    });
    expect(expectComplete(result).manifest.consistency.mode).toBe("none");
  });

  it('resumes the matching checkpoint for resume "auto"', async () => {
    const storage = memoryStorage();
    const first = expectCheckpointed(await runBackup(backupContext(client(), storage), sliced));
    const next = await runBackup(backupContext(client(), storage), { ...sliced, resume: "auto" });
    expect(next.id).toBe(first.id);
  });

  it("refuses to resume with different options", async () => {
    const storage = memoryStorage();
    const first = expectCheckpointed(await runBackup(backupContext(client(), storage), sliced));
    await expect(
      runBackup(backupContext(client(), storage), {
        ...sliced,
        include: [`${database}.orders`],
        resume: first.id,
      }),
    ).rejects.toMatchObject({
      code: "MS_CONFIG_INVALID",
      message: expect.stringMatching(/include/),
    });
    await expect(
      runBackup(backupContext(client(), storage, { compression: "gzip" }), {
        ...sliced,
        resume: first.id,
      }),
    ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
  });

  it("detects a finished part that went missing or changed", async () => {
    const storage = memoryStorage();
    const first = expectCheckpointed(await runBackup(backupContext(client(), storage), sliced));
    const checkpoint = await readCheckpoint(storage, first.id, undefined);
    const done = checkpoint?.namespaces
      .flatMap((entry) => entry.parts)
      .find((part) => part.done !== undefined);
    if (done === undefined) throw new Error("no finished part");
    const key = resolveBackupKey(first.id, done.key);

    await storage.put(key, Readable.from([Buffer.from("truncated")]));
    await expect(
      runBackup(backupContext(client(), storage), { ...sliced, resume: first.id }),
    ).rejects.toMatchObject({ code: "MS_INTEGRITY_FAILED" });

    await storage.delete([key]);
    await expect(
      runBackup(backupContext(client(), storage), { ...sliced, resume: "latest" }),
    ).rejects.toMatchObject({
      code: "MS_INTEGRITY_FAILED",
      message: expect.stringMatching(/missing/),
    });
  });

  it("refuses snapshot or converge consistency with maxDurationMs", async () => {
    for (const consistency of ["snapshot", "converge"] as const) {
      await expect(
        runBackup(backupContext(client(), memoryStorage()), { ...sliced, consistency }),
      ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
    }
  });

  it("fails clearly when there is nothing to resume", async () => {
    await expect(
      runBackup(backupContext(client(), memoryStorage()), { ...sliced, resume: "latest" }),
    ).rejects.toMatchObject({ code: "MS_BACKUP_NOT_FOUND" });
  });

  it("resumes an encrypted (passphrase) backup with the same passphrase only", async () => {
    const storage = memoryStorage();
    const encryption = { passphrase: "correct horse" };
    const first = expectCheckpointed(
      await runBackup(backupContext(client(), storage, { encryption }), {
        ...sliced,
        include: [`${database}.orders`],
      }),
    );
    await expect(
      runBackup(backupContext(client(), storage, { encryption: { passphrase: "wrong" } }), {
        ...sliced,
        include: [`${database}.orders`],
        resume: first.id,
      }),
    ).rejects.toMatchObject({ code: "MS_DECRYPTION_FAILED" });

    let result: BackupResult | undefined;
    for (let calls = 0; calls < 200 && result?.status !== "complete"; calls++) {
      result = await runBackup(backupContext(client(), storage, { encryption }), {
        ...sliced,
        include: [`${database}.orders`],
        resume: first.id,
        maxDurationMs: 60_000,
      });
    }
    const manifest = expectComplete(result ?? first).manifest;
    await client()
      .db(restored)
      .collection("orders_enc")
      .drop()
      .catch(() => undefined);
    await runRestore(
      { client: client(), storage, logger: silentLogger },
      {
        backup: manifest.id,
        decryption: encryption,
        rename: { [`${database}.orders`]: `${restored}.orders_enc` },
      },
    );
    expect(await rawSet(`${restored}.orders_enc`)).toEqual(await rawSet(`${database}.orders`));
  });
});

describe("pruning checkpointed runs", () => {
  it("keeps a run with a fresh checkpoint and deletes a stale one with its checkpoint", async () => {
    const storage = memoryStorage();
    const complete = expectComplete(
      await runBackup(backupContext(client(), storage), { include: [`${database}.users`] }),
    );
    const checkpointed = expectCheckpointed(
      await runBackup(backupContext(client(), storage), sliced),
    );

    const fresh = await pruneBackups(storage, { last: 1 }, { now: new Date() });
    expect(fresh.plan.keep.map((kept) => kept.id)).toContain(checkpointed.id);
    expect(await storage.head(checkpointKey(checkpointed.id))).toBeDefined();

    const later = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const stale = await pruneBackups(storage, { last: 1 }, { now: later });
    expect(stale.plan.remove.map((removed) => removed.id)).toEqual([checkpointed.id]);
    expect(await storage.head(checkpointKey(checkpointed.id))).toBeUndefined();
    expect(storage.keys().filter((key) => key.startsWith(backupDir(checkpointed.id)))).toEqual([]);
    expect(await storage.head(manifestKey(complete.id))).toBeDefined();
  });
});
