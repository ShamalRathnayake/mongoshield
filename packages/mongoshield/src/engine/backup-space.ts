/**
 * The free-space check before each backup: on storage that reports its size
 * (`StorageAdapter.space()`, e.g. a local disk or a drive's quota), refuse a backup
 * that clearly will not fit, and warn when the storage is more than 80% full.
 *
 *   space() undefined / not implemented ─▶ skip quietly (S3, GCS, Azure: no fixed size)
 *   space() fails                        ─▶ log at debug level and go on (the check is advisory)
 *   estimate > free                      ─▶ MS_STORAGE_INSUFFICIENT_SPACE, nothing written
 *   more than 80% full                   ─▶ a warning (logger, result.warnings, a progress event)
 *
 * The estimate is the size of the previous full backup in the same storage
 * (`manifest.totals.bytesStored`): databases change slowly from night to night, and
 * the stored size already reflects compression and encryption. A first backup has
 * nothing to go by, so only the "% full" warning applies to it. "Clearly" means the
 * estimate alone exceeds what is free; there is no safety margin on top, because a
 * refusal must never stop a backup that would have fit.
 *
 * The trash counts as used space (StorageSpace.usedBytes includes it): on a drive, the
 * files prune deleted can sit in the recycle bin and still fill the quota, so the
 * messages say how much emptying it would free.
 */

import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { BACKUPS_PREFIX, isBackupId } from "../format/layout.ts";
import { isIncrementalManifest } from "../format/manifest.ts";
import { readManifest } from "../format/manifest-io.ts";
import type { Logger } from "../logger.ts";
import type { StorageAdapter, StorageSpace } from "../storage/types.ts";

/** Above this fraction of the storage in use, a backup warns. */
export const SPACE_WARNING_FRACTION = 0.8;

/**
 * How many of the newest backup directories are read to find the previous full
 * backup. A few, because the newest can be incomplete (a run in progress or a
 * crashed one) or incremental; reading every manifest would be slow on a drive.
 */
const MAX_MANIFESTS_READ = 5;

/** What the check found, for the backup result and the `storage:space` progress event. */
export interface StorageSpaceReport {
  /** What the adapter reported. */
  readonly space: StorageSpace;
  /** Bytes still free (as reported, or total − used). Undefined when not known. */
  readonly freeBytes: number | undefined;
  /** The fraction of the storage in use, 0–1, trash included. Undefined without a total. */
  readonly usedFraction: number | undefined;
  /** The previous full backup's stored size, when there is one. */
  readonly estimatedBytes: number | undefined;
  /** Set when the storage is more than 80% full. */
  readonly warning: string | undefined;
}

/** Options for {@link checkStorageSpace}. */
export interface CheckStorageSpaceOptions {
  readonly logger: Logger;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Runs the check (see the file header).
 *
 * @returns the report, or `undefined` when the storage does not report its space.
 * @throws MS_STORAGE_INSUFFICIENT_SPACE when the previous full backup alone would not
 *   fit in what is free; MS_ABORTED when the signal fires.
 */
export async function checkStorageSpace(
  storage: StorageAdapter,
  options: CheckStorageSpaceOptions,
): Promise<StorageSpaceReport | undefined> {
  const { logger, signal } = options;
  if (storage.space === undefined) return undefined;
  let space: StorageSpace | undefined;
  try {
    space = await storage.space(signal === undefined ? {} : { signal });
  } catch (error) {
    if (signal?.aborted || isMongoShieldError(error, "MS_ABORTED")) throw error;
    // Advisory only: a flaky quota endpoint must never cost a night's backup.
    logger.debug("Could not read the free space of the storage; skipping the check", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (space === undefined) return undefined;

  const freeBytes = freeBytesOf(space);
  const usedFraction = usedFractionOf(space, freeBytes);
  // Without a free figure there is nothing to compare the estimate with.
  const estimatedBytes =
    freeBytes === undefined ? undefined : await previousFullBackupBytes(storage, signal);
  throwIfAborted(signal);

  if (freeBytes !== undefined && estimatedBytes !== undefined && estimatedBytes > freeBytes) {
    throw insufficientSpaceError(storage, space, freeBytes, estimatedBytes);
  }

  const warning =
    usedFraction !== undefined && usedFraction > SPACE_WARNING_FRACTION
      ? fullWarning(storage, space, usedFraction)
      : undefined;
  if (warning !== undefined) logger.warn(warning);
  logger.debug("Storage space checked", {
    ...space,
    ...(estimatedBytes === undefined ? {} : { estimatedBytes }),
  });
  return { space, freeBytes, usedFraction, estimatedBytes, warning };
}

/** What can still be written: `freeBytes`, else `totalBytes − usedBytes`, else unknown. */
function freeBytesOf(space: StorageSpace): number | undefined {
  if (isByteCount(space.freeBytes)) return space.freeBytes;
  if (isByteCount(space.totalBytes) && isByteCount(space.usedBytes)) {
    return Math.max(0, space.totalBytes - space.usedBytes);
  }
  return undefined;
}

/**
 * The fraction in use, trash included. `used / (used + free)` when both are known,
 * which is what `df` shows (a disk's blocks reserved for root count as neither);
 * otherwise from the total.
 */
function usedFractionOf(space: StorageSpace, freeBytes: number | undefined): number | undefined {
  const { totalBytes, usedBytes } = space;
  if (isByteCount(usedBytes) && freeBytes !== undefined && usedBytes + freeBytes > 0) {
    return usedBytes / (usedBytes + freeBytes);
  }
  if (!isByteCount(totalBytes) || totalBytes === 0) return undefined;
  if (freeBytes !== undefined)
    return Math.min(1, Math.max(0, (totalBytes - freeBytes) / totalBytes));
  return undefined;
}

/**
 * `bytesStored` of the newest complete full backup among the newest few directories,
 * or `undefined` when there is none (first backup, only incrementals, unreadable
 * manifests). Backup ids start with their UTC start time, so the newest sort last.
 */
async function previousFullBackupBytes(
  storage: StorageAdapter,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const ids: string[] = [];
  const signalOption = signal === undefined ? {} : { signal };
  for await (const prefix of storage.listPrefixes(BACKUPS_PREFIX, signalOption)) {
    const id = prefix.slice(BACKUPS_PREFIX.length, -1);
    if (isBackupId(id)) ids.push(id);
  }
  ids.sort();
  for (const id of ids.reverse().slice(0, MAX_MANIFESTS_READ)) {
    const manifest = await readManifest(storage, id, signalOption).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      // An invalid manifest says nothing about the size; try the next one.
      return undefined;
    });
    if (manifest !== undefined && !isIncrementalManifest(manifest)) {
      return manifest.totals.bytesStored;
    }
  }
  return undefined;
}

/** The refusal, naming both sizes and (when it helps) the trash. */
function insufficientSpaceError(
  storage: StorageAdapter,
  space: StorageSpace,
  freeBytes: number,
  estimatedBytes: number,
): MongoShieldError {
  const trash = trashNote(space);
  return new MongoShieldError(
    "MS_STORAGE_INSUFFICIENT_SPACE",
    `The storage at ${storage.location} has ${describeBytes(freeBytes)} free, but the previous ` +
      `backup took ${describeBytes(estimatedBytes)}, so this one will not fit.${trash}`,
    {
      hint:
        trash === ""
          ? "Free up space (run `mongoshield prune`, or delete old files), use a larger quota, or back up to another location."
          : "Empty the trash or recycle bin, run `mongoshield prune` (then empty the bin again), or use a larger quota.",
      details: { freeBytes, estimatedBytes, ...space },
    },
  );
}

/** The 80% warning. */
function fullWarning(storage: StorageAdapter, space: StorageSpace, usedFraction: number): string {
  const percent = Math.floor(usedFraction * 100);
  const total = isByteCount(space.totalBytes) ? ` of ${describeBytes(space.totalBytes)}` : "";
  return (
    `The storage at ${storage.location} is ${percent}% full${total}.${trashNote(space)} ` +
    "Run `mongoshield prune` or free up space before backups start to fail."
  );
}

/** " 2.0 GiB of it is in the trash; emptying it frees that space." or "". */
function trashNote(space: StorageSpace): string {
  if (!isByteCount(space.trashBytes) || space.trashBytes === 0) return "";
  return ` ${describeBytes(space.trashBytes)} of the used space is in the trash or recycle bin; emptying it frees that space.`;
}

/** A finite, non-negative number of bytes (adapters may report odd values). */
function isByteCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** 1536 → "1.5 KiB": binary units, like the CLI's formatter (which library code cannot use). */
function describeBytes(bytes: number): string {
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}
