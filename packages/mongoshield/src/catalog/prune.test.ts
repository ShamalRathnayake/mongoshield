import { describe, expect, it, vi } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import { backupDir, manifestKey, resolveBackupKey } from "../format/layout.ts";
import { writeManifest } from "../format/manifest-io.ts";
import type { Logger } from "../logger.ts";
import { type MemoryStorage, memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { listBackups } from "./catalog.ts";
import { pruneBackups } from "./prune.ts";
import {
  idAt,
  makeManifest,
  putCompleteBackup,
  putIncompleteBackup,
  putInvalidBackup,
} from "./test-fixtures.ts";

const DAY = 24 * 60 * 60 * 1000;

const OLD = idAt("2026-10-18T03:00:00Z");
const MIDDLE = idAt("2026-10-19T03:00:00Z");
const NEW = idAt("2026-10-20T03:00:00Z");
const NOW = new Date("2026-10-20T12:00:00Z");

/** Storage with three complete backups (one data file + manifest each). */
async function threeBackups(): Promise<MemoryStorage> {
  const storage = memoryStorage();
  for (const id of [OLD, MIDDLE, NEW]) await putCompleteBackup(storage, id);
  return storage;
}

function keysUnder(storage: MemoryStorage, id: string): string[] {
  return storage.keys().filter((key) => key.startsWith(backupDir(id)));
}

/** A logger whose methods are typed spies. */
function spyLogger() {
  return {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  } satisfies Logger;
}

describe("pruneBackups", () => {
  it("deletes every object of the removed backups and keeps the rest", async () => {
    const storage = await threeBackups();
    const manifestSize = (await storage.head(manifestKey(OLD)))?.size ?? 0;

    const result = await pruneBackups(storage, { last: 2 }, { now: NOW });

    expect(result.plan.remove.map((removed) => removed.id)).toEqual([OLD]);
    expect(keysUnder(storage, OLD)).toEqual([]);
    expect(keysUnder(storage, MIDDLE)).toHaveLength(2);
    expect(keysUnder(storage, NEW)).toHaveLength(2);
    expect(result).toMatchObject({
      dryRun: false,
      deletedBackups: 1,
      deletedObjects: 2,
      deletedBytes: manifestSize + "data".length,
      skipped: [],
    });
  });

  it("deletes nothing in a dry run but returns the same plan", async () => {
    const storage = await threeBackups();
    const before = storage.keys();
    const logger = spyLogger();

    const result = await pruneBackups(storage, { last: 1 }, { now: NOW, dryRun: true, logger });

    expect(storage.keys()).toEqual(before);
    expect(result.plan.remove.map((removed) => removed.id)).toEqual([MIDDLE, OLD]);
    expect(result).toMatchObject({ dryRun: true, deletedBackups: 0, deletedObjects: 0 });
    expect(logger.info).toHaveBeenCalledWith("Would delete backup (dry run)", {
      id: OLD,
      reason: "not selected by any retention rule",
    });
  });

  it("deletes the manifest first, in its own call", async () => {
    const inner = await threeBackups();
    const calls: string[][] = [];
    const storage: StorageAdapter = {
      ...inner,
      delete: async (keys, options) => {
        calls.push([...keys]);
        return inner.delete(keys, options);
      },
    };

    await pruneBackups(storage, { last: 2 }, { now: NOW });

    expect(calls[0]).toEqual([manifestKey(OLD)]);
    expect(calls[1]).toEqual([resolveBackupKey(OLD, "app/users.bson")]);
  });

  it("leaves an incomplete (never a complete) backup behind if deletion fails halfway", async () => {
    const inner = await threeBackups();
    let deleteCalls = 0;
    const storage: StorageAdapter = {
      ...inner,
      delete: async (keys, options) => {
        deleteCalls++;
        if (deleteCalls === 2) throw new MongoShieldError("MS_STORAGE_IO", "network down");
        return inner.delete(keys, options);
      },
    };

    await expect(pruneBackups(storage, { last: 2 }, { now: NOW })).rejects.toMatchObject({
      code: "MS_STORAGE_IO",
    });

    const entries = await listBackups(inner);
    expect(entries.find((entry) => entry.id === OLD)?.status).toBe("incomplete");
  });

  it("deletes large backups in batches of at most 1000 keys", async () => {
    const inner = await threeBackups();
    for (let part = 0; part < 1500; part++) {
      await inner.put(resolveBackupKey(OLD, `app/big.${part}.bson`), Buffer.from("x"));
    }
    const batchSizes: number[] = [];
    const storage: StorageAdapter = {
      ...inner,
      delete: async (keys, options) => {
        batchSizes.push(keys.length);
        return inner.delete(keys, options);
      },
    };

    const result = await pruneBackups(storage, { last: 2 }, { now: NOW });

    expect(batchSizes).toEqual([1, 1000, 501]);
    expect(result.deletedObjects).toBe(1502);
    expect(keysUnder(inner, OLD)).toEqual([]);
  });

  it("never touches a sibling directory whose name starts with the backup id", async () => {
    const storage = await threeBackups();
    const sibling = `backups/${OLD}-copy/notes.txt`;
    await storage.put(sibling, Buffer.from("keep me"));

    await pruneBackups(storage, { last: 2 }, { now: NOW });

    expect(storage.keys()).toContain(sibling);
  });

  it("keeps everything and warns when the policy is empty", async () => {
    const storage = await threeBackups();
    const before = storage.keys();
    const logger = spyLogger();

    const result = await pruneBackups(storage, {}, { now: NOW, logger });

    expect(storage.keys()).toEqual(before);
    expect(result.deletedBackups).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/sets no counts/));
  });

  it("never deletes invalid backups", async () => {
    const storage = await threeBackups();
    const broken = idAt("2026-01-01T00:00:00Z");
    await putInvalidBackup(storage, broken);

    await pruneBackups(storage, { last: 1 }, { now: NOW });

    expect(keysUnder(storage, broken)).toHaveLength(2);
  });

  it("measures an incomplete run's age from its last write, not its start", async () => {
    const storage = await threeBackups();
    // Started days ago (per its id), but its files were written just now.
    const slow = idAt("2026-01-01T00:00:00Z");
    await putIncompleteBackup(storage, slow);

    const result = await pruneBackups(storage, { last: 3 });

    expect(result.plan.keep.map((kept) => kept.id)).toContain(slow);
    expect(keysUnder(storage, slow)).toHaveLength(1);
  });

  it("deletes incomplete runs that have been idle longer than the grace period", async () => {
    const storage = await threeBackups();
    const crashed = idAt("2026-01-01T00:00:00Z");
    await putIncompleteBackup(storage, crashed);

    const twoDaysFromNow = new Date(Date.now() + 2 * DAY);
    const result = await pruneBackups(storage, { last: 3 }, { now: twoDaysFromNow });

    expect(result.plan.remove.map((removed) => removed.id)).toEqual([crashed]);
    expect(keysUnder(storage, crashed)).toEqual([]);
  });

  it("skips an incomplete run that completes while pruning", async () => {
    const inner = await threeBackups();
    const racing = idAt("2026-01-01T00:00:00Z");
    await putIncompleteBackup(inner, racing);
    // When the catalog reads the (missing) manifest, the backup commits right after.
    const storage: StorageAdapter = {
      ...inner,
      get: async (key, options) => {
        try {
          return await inner.get(key, options);
        } catch (error) {
          if (key === manifestKey(racing) && isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")) {
            await writeManifest(inner, makeManifest(racing));
          }
          throw error;
        }
      },
    };
    const logger = spyLogger();

    const result = await pruneBackups(
      storage,
      { last: 3 },
      { now: new Date(Date.now() + 2 * DAY), logger },
    );

    expect(result.skipped).toEqual([racing]);
    expect(result.deletedBackups).toBe(0);
    expect(keysUnder(inner, racing)).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith("Skipping a backup that completed while pruning", {
      id: racing,
    });
  });

  it("stops when the signal is aborted", async () => {
    const storage = await threeBackups();
    const controller = new AbortController();
    controller.abort();
    await expect(
      pruneBackups(storage, { last: 1 }, { now: NOW, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "MS_ABORTED" });
    expect(keysUnder(storage, OLD)).toHaveLength(2);
  });

  describe("immutable backups", () => {
    /** Writes a complete backup whose data file and manifest are locked until `until`. */
    async function putImmutableBackup(storage: StorageAdapter, id: string, until: Date) {
      await storage.put(resolveBackupKey(id, "app/users.bson"), Buffer.from("data"), {
        retainUntil: until,
      });
      await writeManifest(storage, makeManifest(id, { immutableUntil: until.toISOString() }), {
        retainUntil: until,
      });
    }

    /** Wraps `inner` so every delete call is recorded. */
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

    it("keeps a backup until immutableUntil and never asks the storage to delete it", async () => {
      const inner = memoryStorage({ objectLock: true, now: () => NOW });
      const until = new Date("2026-10-25T03:00:00Z");
      await putImmutableBackup(inner, OLD, until);
      await putCompleteBackup(inner, MIDDLE);
      await putCompleteBackup(inner, NEW);
      const { storage, deleted } = recordingDeletes(inner);

      const result = await pruneBackups(storage, { last: 1 }, { now: NOW });

      expect(result.plan.keep.find((kept) => kept.id === OLD)?.reasons).toEqual([
        "immutable until 2026-10-25T03:00:00.000Z",
      ]);
      expect(result.plan.remove.map((removed) => removed.id)).toEqual([MIDDLE]);
      expect(deleted.flat().some((key) => key.startsWith(backupDir(OLD)))).toBe(false);
      expect(keysUnder(inner, OLD)).toHaveLength(2);
      expect(result.skipped).toEqual([]);
    });

    it("deletes the backup once its retention has passed", async () => {
      let storageNow = NOW;
      const storage = memoryStorage({ objectLock: true, now: () => storageNow });
      await putImmutableBackup(storage, OLD, new Date("2026-10-25T03:00:00Z"));
      await putCompleteBackup(storage, NEW);

      const later = new Date("2026-10-26T00:00:00Z");
      storageNow = later;
      const result = await pruneBackups(storage, { last: 1 }, { now: later });

      expect(result.deletedBackups).toBe(1);
      expect(keysUnder(storage, OLD)).toEqual([]);
    });

    it("skips (does not fail on) a backup the storage still locks, e.g. after clock skew", async () => {
      // Prune's clock says retention has ended; the storage's clock disagrees.
      const storage = memoryStorage({ objectLock: true, now: () => NOW });
      await putImmutableBackup(storage, OLD, new Date("2026-10-21T00:00:00Z"));
      await putCompleteBackup(storage, MIDDLE);
      await putCompleteBackup(storage, NEW);
      const logger = spyLogger();

      const result = await pruneBackups(
        storage,
        { last: 1 },
        { now: new Date("2026-10-22T00:00:00Z"), logger },
      );

      expect(result.skipped).toEqual([OLD]);
      expect(result.deletedBackups).toBe(1); // MIDDLE
      // The manifest goes first, so the refusal leaves the locked backup complete.
      const entries = await listBackups(storage);
      expect(entries.find((entry) => entry.id === OLD)?.status).toBe("complete");
      expect(logger.warn).toHaveBeenCalledWith(
        "Skipping a backup whose objects are still locked by the storage",
        expect.objectContaining({ id: OLD }),
      );
    });

    it("skips an abandoned incomplete run whose files are locked", async () => {
      const crashed = idAt("2026-10-10T03:00:00Z");
      let storageNow = new Date("2026-10-10T03:05:00Z");
      const storage = memoryStorage({ objectLock: true, now: () => storageNow });
      // The run died after writing a locked data file but before the manifest,
      // long enough ago to be past the incomplete-run grace period.
      await storage.put(resolveBackupKey(crashed, "app/users.bson"), Buffer.from("partial"), {
        retainUntil: new Date("2026-10-30T00:00:00Z"),
      });
      storageNow = NOW;
      await putCompleteBackup(storage, NEW);

      const result = await pruneBackups(storage, { last: 1 }, { now: NOW });

      expect(result.plan.remove.map((removed) => removed.id)).toEqual([crashed]);
      expect(result.skipped).toEqual([crashed]);
      expect(keysUnder(storage, crashed)).toHaveLength(1);
    });

    it("still fails on permission errors that are not object lock refusals", async () => {
      const inner = await threeBackups();
      const storage: StorageAdapter = {
        ...inner,
        delete: async () => {
          throw new MongoShieldError("MS_STORAGE_FORBIDDEN", "access denied");
        },
      };
      await expect(pruneBackups(storage, { last: 2 }, { now: NOW })).rejects.toMatchObject({
        code: "MS_STORAGE_FORBIDDEN",
      });
    });
  });
});
