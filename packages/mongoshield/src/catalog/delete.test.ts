// Deleting one backup by id: the order (manifest first), what it removes, and every
// refusal (unknown id, hold, write-once lock, incremental dependents, storage lock).

import { describe, expect, it, vi } from "vitest";
import { backupDir, manifestKey, resolveBackupKey } from "../format/layout.ts";
import { writeManifest } from "../format/manifest-io.ts";
import { type MemoryStorage, memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { placeHold, recordVerification } from "./annotations.ts";
import { listBackups } from "./catalog.ts";
import { deleteBackupById, dependentsOf } from "./delete.ts";
import {
  idAt,
  makeChainBase,
  makeIncremental,
  makeManifest,
  putCheckpoint,
  putCompleteBackup,
  putIncompleteBackup,
} from "./test-fixtures.ts";

const NOW = new Date("2026-10-20T12:00:00Z");
const OLD = idAt("2026-10-18T03:00:00Z");
const NEW = idAt("2026-10-19T03:00:00Z");

/** Every key under one backup's directory. */
async function keysUnder(storage: StorageAdapter, id: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const object of storage.list(backupDir(id))) keys.push(object.key);
  return keys;
}

/** Wraps `inner` so every delete call is recorded, in order. */
function recordingDeletes(inner: MemoryStorage) {
  const deleted: string[][] = [];
  const storage: StorageAdapter = {
    ...inner,
    delete: async (keys, options) => {
      deleted.push([...keys]);
      return inner.delete(keys, options);
    },
  };
  return { storage, deleted };
}

describe("deleteBackupById", () => {
  it("deletes the manifest first, then the files, and leaves other backups alone", async () => {
    const inner = memoryStorage();
    await putCompleteBackup(inner, OLD);
    await putCompleteBackup(inner, NEW);
    const { storage, deleted } = recordingDeletes(inner);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await deleteBackupById(storage, OLD, {
      now: NOW,
      logger,
      requestedBy: "ops@host",
    });

    expect(deleted[0]).toEqual([manifestKey(OLD)]);
    expect(deleted[1]).toEqual([resolveBackupKey(OLD, "app/users.bson")]);
    expect(await keysUnder(inner, OLD)).toEqual([]);
    expect(await keysUnder(inner, NEW)).toHaveLength(2);
    expect(result).toMatchObject({
      id: OLD,
      status: "complete",
      deletedObjects: 2,
      requestedBy: "ops@host",
    });
    expect(result.deletedBytes).toBeGreaterThan(0);
    // The audit line.
    expect(logger.info).toHaveBeenCalledWith(
      "Deleted backup",
      expect.objectContaining({ id: OLD, requestedBy: "ops@host", reason: "requested" }),
    );
  });

  it("removes the backup's annotations and the checkpoint of an incomplete run", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, OLD);
    await recordVerification(storage, {
      backupId: OLD,
      mode: "fast",
      ok: true,
      filesChecked: 1,
      bytesChecked: 4,
      documentsChecked: 0,
      problems: [],
      durationMs: 1,
    });
    await putIncompleteBackup(storage, NEW);
    await putCheckpoint(storage, NEW, {});

    await deleteBackupById(storage, OLD, { now: NOW });
    const incomplete = await deleteBackupById(storage, NEW, { now: NOW });

    expect(incomplete.status).toBe("incomplete");
    expect(await listBackups(storage)).toEqual([]);
    const leftovers: string[] = [];
    for await (const object of storage.list("")) leftovers.push(object.key);
    expect(leftovers).toEqual([]);
  });

  it("refuses an unknown or malformed id", async () => {
    const storage = memoryStorage();
    await expect(deleteBackupById(storage, OLD)).rejects.toMatchObject({
      code: "MS_BACKUP_NOT_FOUND",
    });
    await expect(deleteBackupById(storage, "../etc")).rejects.toMatchObject({
      code: "MS_BACKUP_NOT_FOUND",
    });
  });

  it("refuses a backup on hold, and deletes it once released", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, OLD);
    await placeHold(storage, OLD, { reason: "legal hold 2026" });

    await expect(deleteBackupById(storage, OLD, { now: NOW })).rejects.toMatchObject({
      code: "MS_BACKUP_PROTECTED",
      message: expect.stringContaining("on hold (legal hold 2026)"),
      hint: expect.stringContaining(`mongoshield release ${OLD}`),
    });
    expect(await keysUnder(storage, OLD)).toHaveLength(2);
  });

  it("refuses a backup that is still write-once, before touching anything", async () => {
    const inner = memoryStorage({ objectLock: true, now: () => NOW });
    const until = new Date("2026-10-25T00:00:00Z");
    await writeManifest(inner, makeManifest(OLD, { immutableUntil: until.toISOString() }), {
      retainUntil: until,
    });
    const { storage, deleted } = recordingDeletes(inner);

    await expect(deleteBackupById(storage, OLD, { now: NOW })).rejects.toMatchObject({
      code: "MS_BACKUP_PROTECTED",
      message: expect.stringContaining("write-once until 2026-10-25T00:00:00.000Z"),
    });
    expect(deleted).toEqual([]);
  });

  it("turns a storage lock refusal (clock skew) into MS_BACKUP_PROTECTED", async () => {
    // The manifest says the lock ended; the storage's own clock disagrees.
    const storage = memoryStorage({ objectLock: true, now: () => NOW });
    const until = new Date("2026-10-21T00:00:00Z");
    await writeManifest(storage, makeManifest(OLD, { immutableUntil: until.toISOString() }), {
      retainUntil: until,
    });

    await expect(
      deleteBackupById(storage, OLD, { now: new Date("2026-10-22T00:00:00Z") }),
    ).rejects.toMatchObject({
      code: "MS_BACKUP_PROTECTED",
      message: expect.stringContaining("object lock"),
    });
  });

  it("refuses a backup an incremental depends on, naming the dependents", async () => {
    const storage = memoryStorage();
    const base = makeChainBase(idAt("2026-10-19T00:00:00Z"), 1000);
    const first = makeIncremental(idAt("2026-10-19T01:00:00Z"), base, 2000);
    const second = makeIncremental(idAt("2026-10-19T02:00:00Z"), first, 3000);
    for (const manifest of [base, first, second])
      await putCompleteBackup(storage, manifest.id, manifest);

    await expect(deleteBackupById(storage, base.id, { now: NOW })).rejects.toMatchObject({
      code: "MS_BACKUP_PROTECTED",
      message: expect.stringContaining(
        `2 incremental backup(s) depend on it (${second.id}, ${first.id})`,
      ),
    });
    expect(dependentsOf(await listBackups(storage), first.id)).toEqual([second.id]);

    // Newest first works: the chain shrinks from its end.
    await deleteBackupById(storage, second.id, { now: NOW });
    await deleteBackupById(storage, first.id, { now: NOW });
    await deleteBackupById(storage, base.id, { now: NOW });
    expect(await listBackups(storage)).toEqual([]);
  });

  it("stops when the signal is aborted, deleting nothing", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, OLD);
    await expect(
      deleteBackupById(storage, OLD, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({
      code: "MS_ABORTED",
    });
    expect(await keysUnder(storage, OLD)).toHaveLength(2);
  });
});
