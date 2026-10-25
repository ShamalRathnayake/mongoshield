/**
 * The backup catalog: what backups exist in a storage location, and in what state.
 *
 * Every backup is a directory `backups/<id>/`. Its `manifest.json` is written
 * last and acts as the commit marker, so a directory is classified as:
 *
 *   complete    the manifest exists and is valid
 *   incomplete  there is no manifest (the run crashed, or is still running)
 *   invalid     a manifest exists but cannot be used (corrupt, wrong schema,
 *               written by a newer release, or describing a different backup)
 *
 * Listing never fails because of one bad manifest: it is reported as `invalid`
 * so the user can see it, and retention never deletes it automatically.
 * Storage errors (permissions, network) still fail the listing, because
 * pretending a backup does not exist would be worse than stopping.
 */

import { isMongoShieldError, throwIfAborted } from "../errors.ts";
import { BACKUPS_PREFIX, backupIdToDate, isBackupId } from "../format/layout.ts";
import type { Manifest } from "../format/manifest.ts";
import { readManifest } from "../format/manifest-io.ts";
import { type Logger, silentLogger } from "../logger.ts";
import type { StorageAdapter } from "../storage/types.ts";
import {
  type DrillRecord,
  type HoldRecord,
  readAnnotations,
  type VerificationRecord,
} from "./annotations.ts";
import { applyRekeyRecords } from "./rekey-records.ts";

/** State of one backup directory. See the file header for what each value means. */
export type CatalogStatus = "complete" | "incomplete" | "invalid";

/** One backup directory found in storage. */
export interface CatalogEntry {
  /** Backup id, which is also the directory name, e.g. `2026-11-14T03-00-04Z_7f3a9c`. */
  readonly id: string;
  /** Start time, decoded from the id (available even when there is no manifest). */
  readonly startedAt: Date;
  readonly status: CatalogStatus;
  /** The parsed manifest. Present only when `status` is `"complete"`. */
  readonly manifest?: Manifest;
  /** Why the manifest could not be used. Present only when `status` is `"invalid"`. */
  readonly error?: string;
  /** The newest verification run of a complete backup, if it was ever verified. */
  readonly verification?: VerificationRecord;
  /** The newest restore drill of a complete backup, if it was ever drilled. */
  readonly lastDrill?: DrillRecord;
  /** Present while a complete backup is on hold (never pruned). */
  readonly hold?: HoldRecord;
}

/** Options for {@link listBackups}. */
export interface ListBackupsOptions {
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

/**
 * How many manifests are read at the same time. Manifests are small, so the
 * cost is round trips; 8 keeps listing fast on S3 without flooding the store.
 */
const MANIFEST_READ_CONCURRENCY = 8;

/**
 * Error codes that mean "this manifest is unusable" rather than "storage is broken".
 * `MS_INTEGRITY_FAILED` is raised when the object is far too large to be a manifest.
 */
const INVALID_MANIFEST_CODES = [
  "MS_MANIFEST_INVALID",
  "MS_FORMAT_UNSUPPORTED",
  "MS_INTEGRITY_FAILED",
] as const;

/**
 * Lists every backup in `storage`, newest first.
 *
 * Directories under `backups/` whose name is not a backup id are ignored
 * (logged at debug level), so stray folders never show up as backups.
 */
export async function listBackups(
  storage: StorageAdapter,
  options: ListBackupsOptions = {},
): Promise<CatalogEntry[]> {
  const logger = options.logger ?? silentLogger;
  const signalOption = options.signal ? { signal: options.signal } : {};

  const ids: string[] = [];
  for await (const prefix of storage.listPrefixes(BACKUPS_PREFIX, signalOption)) {
    const name = directoryName(prefix);
    if (isBackupId(name)) {
      ids.push(name);
    } else {
      logger.debug("Ignoring a directory that is not a backup", { prefix });
    }
  }

  const entries = await mapWithConcurrency(ids, MANIFEST_READ_CONCURRENCY, async (id) => {
    throwIfAborted(options.signal);
    return readCatalogEntry(storage, id, options.signal);
  });

  return entries.sort(newestFirst);
}

/**
 * Orders entries newest first. Ids only carry the start time to the second, and
 * two backups can start in the same second (tests, retries), so complete backups
 * are ordered by the millisecond start time in their manifest. The id breaks any
 * remaining tie so the order is always stable.
 */
function newestFirst(a: CatalogEntry, b: CatalogEntry): number {
  const byStart = preciseStartTime(b) - preciseStartTime(a);
  return byStart !== 0 ? byStart : compareStrings(b.id, a.id);
}

/** Start time with milliseconds when the manifest is available, else from the id. */
function preciseStartTime(entry: CatalogEntry): number {
  return entry.manifest ? Date.parse(entry.manifest.startedAt) : entry.startedAt.getTime();
}

/**
 * The completion time recorded in a complete backup's manifest, or `undefined`
 * for incomplete and invalid backups (they never completed, as far as we know).
 */
export function completedAtOf(entry: CatalogEntry): Date | undefined {
  return entry.manifest ? new Date(entry.manifest.completedAt) : undefined;
}

/**
 * When a complete backup's write-once retention ends (the manifest's
 * `immutableUntil`), or `undefined` if it was written without retention.
 * Until this time the storage refuses to delete the backup's objects.
 * (`list` and `inspect` show it; prune keeps the backup until then.)
 */
export function immutableUntilOf(entry: CatalogEntry): Date | undefined {
  const until = entry.manifest?.immutableUntil;
  return until === undefined ? undefined : new Date(until);
}

/** Reads one backup's manifest and classifies the directory. */
async function readCatalogEntry(
  storage: StorageAdapter,
  id: string,
  signal: AbortSignal | undefined,
): Promise<CatalogEntry> {
  const startedAt = backupIdToDate(id);

  let manifest: Manifest | undefined;
  try {
    manifest = await readManifest(storage, id, signal ? { signal } : {});
  } catch (error) {
    if (isUnusableManifestError(error)) {
      return { id, startedAt, status: "invalid", error: error.message };
    }
    throw error;
  }

  if (manifest === undefined) {
    return { id, startedAt, status: "incomplete" };
  }

  // (readManifest has already checked that the manifest's id matches its
  // directory, so a manifest copied into the wrong place reads as invalid.)

  // Verification results and holds are stored next to, not inside, the backup.
  const annotations = await readAnnotations(storage, id, signal ? { signal } : {});
  return {
    id,
    startedAt,
    status: "complete",
    // A rekey rewrote some file headers after the manifest was written: report the
    // backup as it is stored now (new digests and recipients, see rekey-records.ts).
    manifest: applyRekeyRecords(manifest, annotations.rekeys),
    ...(annotations.lastVerification ? { verification: annotations.lastVerification } : {}),
    ...(annotations.lastDrill ? { lastDrill: annotations.lastDrill } : {}),
    ...(annotations.hold ? { hold: annotations.hold } : {}),
  };
}

/** True for errors that mean the manifest itself is unusable. */
function isUnusableManifestError(error: unknown): error is Error {
  return INVALID_MANIFEST_CODES.some((code) => isMongoShieldError(error, code));
}

/** `backups/2026-11-14T03-00-04Z_7f3a9c/` → `2026-11-14T03-00-04Z_7f3a9c`. */
function directoryName(prefix: string): string {
  const withoutParent = prefix.slice(BACKUPS_PREFIX.length);
  return withoutParent.endsWith("/") ? withoutParent.slice(0, -1) : withoutParent;
}

/** Plain code-unit string comparison (not locale-aware, so it matches storage order). */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Like `Promise.all(items.map(task))`, but runs at most `limit` tasks at once.
 * Results keep the order of `items`.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);

  // All workers share one iterator. Each `next()` call is synchronous, so two
  // workers can never claim the same item.
  const queue = items.entries();
  async function worker(): Promise<void> {
    for (const [index, item] of queue) {
      results[index] = await task(item);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
