/**
 * Tests for the free-space check before a backup (backup-space.ts): it refuses a
 * backup that clearly will not fit, warns past 80% full, counts the trash as used, and
 * skips quietly when the storage does not report its space.
 */

import { describe, expect, it } from "vitest";
import {
  idAt,
  makeChainBase,
  makeIncremental,
  putCompleteBackup,
  putIncompleteBackup,
} from "../catalog/test-fixtures.ts";
import { isMongoShieldError, throwIfAborted } from "../errors.ts";
import { writeManifest } from "../format/manifest-io.ts";
import type { Logger } from "../logger.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter, StorageSpace } from "../storage/types.ts";
import { checkStorageSpace } from "./backup-space.ts";

const GIB = 1024 ** 3;

/** A logger that keeps what it was told. */
function recordingLogger(): Logger & { warnings: string[]; debugs: string[] } {
  const warnings: string[] = [];
  const debugs: string[] = [];
  return {
    warnings,
    debugs,
    debug: (message) => {
      debugs.push(message);
    },
    info: () => {},
    warn: (message) => {
      warnings.push(message);
    },
    error: () => {},
  };
}

/** Memory storage that reports `space` (or runs `space` when it is a function). */
function storageWithSpace(
  space: StorageSpace | undefined | (() => Promise<StorageSpace | undefined>),
): StorageAdapter {
  const storage = memoryStorage({ name: "space" });
  return {
    ...storage,
    async space(options) {
      throwIfAborted(options?.signal);
      return typeof space === "function" ? space() : space;
    },
  };
}

/** Stores a complete full backup whose files took `bytesStored`. */
async function previousBackup(storage: StorageAdapter, iso: string, bytesStored: number) {
  await putCompleteBackup(storage, idAt(iso), {
    totals: { namespaces: 1, documents: 10, bytesRaw: bytesStored * 2, bytesStored },
  });
}

describe("checkStorageSpace", () => {
  it("refuses a backup that clearly will not fit", async () => {
    const storage = storageWithSpace({ totalBytes: 15 * GIB, usedBytes: 14 * GIB });
    await previousBackup(storage, "2026-11-01T03:00:00Z", 2 * GIB);
    const error = await checkStorageSpace(storage, { logger: recordingLogger() }).catch(
      (reason: unknown) => reason,
    );
    expect(isMongoShieldError(error, "MS_STORAGE_INSUFFICIENT_SPACE")).toBe(true);
    expect(String(error)).toContain("1.0 GiB free");
    expect(String(error)).toContain("previous backup took 2.0 GiB");
    expect(isMongoShieldError(error) && error.details).toMatchObject({
      freeBytes: GIB,
      estimatedBytes: 2 * GIB,
    });
  });

  it("uses the newest complete FULL backup as the estimate, skipping incomplete and incremental ones", async () => {
    const storage = storageWithSpace({ totalBytes: 10 * GIB, freeBytes: 3 * GIB });
    await previousBackup(storage, "2026-11-01T03:00:00Z", 1 * GIB);
    const base = makeChainBase(idAt("2026-11-02T03:00:00Z"), 100, {
      totals: { namespaces: 1, documents: 1, bytesRaw: 1, bytesStored: 4 * GIB },
    });
    await writeManifest(storage, base);
    await writeManifest(
      storage,
      makeIncremental(idAt("2026-11-03T03:00:00Z"), base, 200, {
        totals: { namespaces: 1, documents: 1, bytesRaw: 1, bytesStored: 1 },
      }),
    );
    await putIncompleteBackup(storage, idAt("2026-11-04T03:00:00Z"));

    // The newest full backup (4 GiB) does not fit in 3 GiB, although the incremental would.
    const error = await checkStorageSpace(storage, { logger: recordingLogger() }).catch(
      (reason: unknown) => reason,
    );
    expect(isMongoShieldError(error, "MS_STORAGE_INSUFFICIENT_SPACE")).toBe(true);
    expect(String(error)).toContain("4.0 GiB");
  });

  it("lets a backup that fits through, with a report and no warning below 80% full", async () => {
    const storage = storageWithSpace({ totalBytes: 15 * GIB, usedBytes: 6 * GIB });
    await previousBackup(storage, "2026-11-01T03:00:00Z", GIB);
    const logger = recordingLogger();
    const report = await checkStorageSpace(storage, { logger });
    expect(report).toEqual({
      space: { totalBytes: 15 * GIB, usedBytes: 6 * GIB },
      freeBytes: 9 * GIB,
      usedFraction: 0.4,
      estimatedBytes: GIB,
      warning: undefined,
    });
    expect(logger.warnings).toEqual([]);
  });

  it("warns past 80% full, through the logger and the report", async () => {
    const storage = storageWithSpace({ totalBytes: 100 * GIB, usedBytes: 85 * GIB });
    const logger = recordingLogger();
    const report = await checkStorageSpace(storage, { logger });
    expect(report?.usedFraction).toBeCloseTo(0.85);
    expect(report?.warning).toContain("is 85% full of 100.0 GiB");
    expect(report?.warning).toContain("mongoshield prune");
    expect(logger.warnings).toEqual([report?.warning]);
  });

  it("does not warn at exactly 80%", async () => {
    const storage = storageWithSpace({ totalBytes: 100, usedBytes: 80 });
    expect((await checkStorageSpace(storage, { logger: recordingLogger() }))?.warning).toBe(
      undefined,
    );
  });

  it("counts the trash as used, and says how much emptying it frees", async () => {
    // 85 GiB used, 40 of it in the trash: 85% full, not 45%.
    const storage = storageWithSpace({
      totalBytes: 100 * GIB,
      usedBytes: 85 * GIB,
      trashBytes: 40 * GIB,
    });
    const report = await checkStorageSpace(storage, { logger: recordingLogger() });
    expect(report?.usedFraction).toBeCloseTo(0.85);
    expect(report?.warning).toContain("40.0 GiB of the used space is in the trash");
  });

  it("refuses when only emptying the trash would make room, and says so", async () => {
    const storage = storageWithSpace({
      totalBytes: 15 * GIB,
      usedBytes: 14.5 * GIB,
      trashBytes: 5 * GIB,
    });
    await previousBackup(storage, "2026-11-01T03:00:00Z", 2 * GIB);
    const error = await checkStorageSpace(storage, { logger: recordingLogger() }).catch(
      (reason: unknown) => reason,
    );
    expect(isMongoShieldError(error, "MS_STORAGE_INSUFFICIENT_SPACE")).toBe(true);
    expect(String(error)).toContain("5.0 GiB of the used space is in the trash");
    expect(isMongoShieldError(error) && error.hint).toContain("Empty the trash");
  });

  it("prefers freeBytes over total minus used, and measures fullness like df", async () => {
    // A disk with blocks reserved for root: total 100, used 70, available 20.
    const storage = storageWithSpace({ totalBytes: 100, usedBytes: 70, freeBytes: 20 });
    const report = await checkStorageSpace(storage, { logger: recordingLogger() });
    expect(report?.freeBytes).toBe(20);
    expect(report?.usedFraction).toBeCloseTo(70 / 90);
  });

  it("skips quietly when the adapter has no space()", async () => {
    const logger = recordingLogger();
    expect(await checkStorageSpace(memoryStorage(), { logger })).toBeUndefined();
    expect(logger.warnings).toEqual([]);
    expect(logger.debugs).toEqual([]);
  });

  it("skips quietly when space() reports nothing", async () => {
    const logger = recordingLogger();
    expect(await checkStorageSpace(storageWithSpace(undefined), { logger })).toBeUndefined();
    expect(logger.warnings).toEqual([]);
  });

  it("goes on when space() fails, logging only at debug level", async () => {
    const logger = recordingLogger();
    const storage = storageWithSpace(async () => {
      throw new Error("quota endpoint is down");
    });
    expect(await checkStorageSpace(storage, { logger })).toBeUndefined();
    expect(logger.warnings).toEqual([]);
    expect(logger.debugs[0]).toContain("Could not read the free space");
  });

  it("does not estimate without a free figure, and has no fraction without a total", async () => {
    const storage = storageWithSpace({ usedBytes: 5 * GIB });
    await previousBackup(storage, "2026-11-01T03:00:00Z", 100 * GIB);
    const report = await checkStorageSpace(storage, { logger: recordingLogger() });
    expect(report).toMatchObject({ freeBytes: undefined, usedFraction: undefined });
    expect(report?.estimatedBytes).toBeUndefined();
  });

  it("lets a first backup through when only free space is known", async () => {
    const storage = storageWithSpace({ freeBytes: 1 });
    const report = await checkStorageSpace(storage, { logger: recordingLogger() });
    expect(report).toMatchObject({ freeBytes: 1, estimatedBytes: undefined, warning: undefined });
  });

  it("rejects with MS_ABORTED when the signal fires", async () => {
    const storage = storageWithSpace({ totalBytes: 100, usedBytes: 1 });
    const error = await checkStorageSpace(storage, {
      logger: recordingLogger(),
      signal: AbortSignal.abort(),
    }).catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
  });
});
