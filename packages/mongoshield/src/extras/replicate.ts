/**
 * Replication between storage locations: the "2" and the "1" of a 3-2-1 backup
 * strategy (three copies, two kinds of media, one off-site).
 *
 *   await replicateBackups(primary, offsite, { backups: "latest", retainDays: 30 });
 *
 * Every object of each selected backup is streamed from one adapter straight into the
 * other (nothing is buffered in memory or on local disk), in the same order a backup is
 * written, so the copy is never visible as complete before it is:
 *
 *   1. the erasure ledger (`erasures/`): new records first, so a restore from the copy
 *      never brings back data that was erased (see erasure.ts)
 *   2. the backup's data, metadata, changes and key files, each checked against the
 *      SHA-256 recorded for it while it streams, and (with `verify`, the default) read
 *      back from the destination and checked again
 *   3. its annotations (verifications, hold, rekey records), which the destination's
 *      catalog needs to describe the backup the same way
 *   4. `manifest.json`, byte for byte, LAST: the commit marker, as in a backup run
 *
 * Backups already present at the destination are skipped when they are identical. A
 * backup rekeyed at the source since it was copied (src/extras/rekey.ts) has files with
 * new digests: only those files and the rekey record are copied ("updated").
 *
 * `retainDays` makes the copies write-once at the destination (S3 Object Lock and
 * similar). The manifest is still copied unchanged, so its `immutableUntil` describes the
 * source; prune at the destination then learns of the lock from the storage itself and
 * skips those backups (see src/catalog/prune.ts).
 */

import { listBackups } from "../catalog/catalog.ts";
import { writeStoredFile } from "../engine/backup-write.ts";
import { mapWithConcurrency } from "../engine/pool.ts";
import { checkStoredFile } from "../engine/read-pipeline.ts";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { backupDir, manifestKey, resolveBackupKey } from "../format/layout.ts";
import type { Manifest, StoredFile } from "../format/manifest.ts";
import { type Logger, silentLogger } from "../logger.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { readStreamToBuffer } from "../util/streams.ts";
import { ERASURES_PREFIX } from "./erasure.ts";
import {
  allFilesOf,
  type BackupSelection,
  createExpectedDigestCheck,
  type SelectedBackup,
  selectBackups,
} from "./stored-files.ts";

/** Options for {@link replicateBackups}. */
export interface ReplicateOptions {
  /** Which backups to copy. Defaults to `"all"`. */
  readonly backups?: BackupSelection;
  /** Read every copied file back from the destination and check its SHA-256. Defaults to true. */
  readonly verify?: boolean;
  /**
   * Make the copies write-once at the destination for this many days. The destination
   * must support object lock (`capabilities.objectLock`).
   */
  readonly retainDays?: number;
  /** Work out and report what would be copied, without copying anything. */
  readonly dryRun?: boolean;
  /** Files copied at the same time. Defaults to 4. */
  readonly concurrency?: number;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ReplicateProgressEvent) => void;
  /** The current time, for `retainDays`. For tests. */
  readonly now?: () => Date;
}

/** Progress of a replication, one event per backup started and per file copied. */
export type ReplicateProgressEvent =
  | {
      readonly type: "backup:start";
      readonly backupId: string;
      readonly action: ReplicatedBackup["action"];
      readonly files: number;
      readonly bytes: number;
    }
  | {
      readonly type: "file:done";
      readonly backupId: string;
      readonly key: string;
      readonly bytes: number;
    }
  | { readonly type: "backup:done"; readonly backupId: string };

/** What happened to one backup. */
export interface ReplicatedBackup {
  readonly backupId: string;
  /**
   * `copied`: newly copied; `updated`: present, but files rewritten by a rekey were
   * copied again; `skipped`: already present and identical. Dry runs report
   * `would-copy` / `would-update` instead.
   */
  readonly action: "copied" | "updated" | "skipped" | "would-copy" | "would-update";
  /** Files copied (or that would be). */
  readonly files: number;
  /** Bytes copied (or that would be). */
  readonly bytes: number;
}

/** What {@link replicateBackups} did. */
export interface ReplicateResult {
  readonly dryRun: boolean;
  readonly backups: readonly ReplicatedBackup[];
  /** Erasure ledger records copied (records already present are never rewritten). */
  readonly erasuresCopied: number;
  readonly durationMs: number;
}

/** Files copied at the same time when `concurrency` is not given. */
const DEFAULT_CONCURRENCY = 4;

/** Manifests are small; the same bound as src/format/manifest-io.ts. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/** Annotations and erasure records are tiny JSON files. */
const MAX_SMALL_OBJECT_BYTES = 1024 * 1024;

/** Every annotation lives under this prefix (see src/catalog/annotations.ts). */
const ANNOTATIONS_PREFIX = "annotations/";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Shared state of one replication run. */
interface ReplicateRun {
  readonly from: StorageAdapter;
  readonly to: StorageAdapter;
  readonly verify: boolean;
  readonly retainUntil: Date | undefined;
  readonly concurrency: number;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly onProgress: ((event: ReplicateProgressEvent) => void) | undefined;
}

/** A file to copy, with the digest it must have. */
interface PlannedFile {
  readonly file: StoredFile;
  /** True when the destination already holds it intact (resumed or identical copy). */
  readonly present: boolean;
}

/**
 * Copies backups from one storage location to another. See the file header for the
 * order of writes and what "identical" means.
 *
 * @throws MS_CONFIG_INVALID for a destination without object lock when `retainDays` is
 *   set, the same location on both sides, or invalid options; MS_BACKUP_NOT_FOUND for
 *   unknown ids; MS_INTEGRITY_FAILED when a source file does not match its recorded
 *   digest, a copy reads back wrong, or the destination holds a DIFFERENT backup under
 *   the same id; storage errors; MS_ABORTED.
 */
export async function replicateBackups(
  from: StorageAdapter,
  to: StorageAdapter,
  options: ReplicateOptions = {},
): Promise<ReplicateResult> {
  const startedAt = performance.now();
  const run = prepareRun(from, to, options);
  const dryRun = options.dryRun === true;

  const selected = await selectBackups(from, options.backups ?? "all", {
    signal: options.signal,
    logger: run.logger,
  });
  // What the destination already has, as its own catalog sees it (rekeys applied).
  const existing = new Map<string, Manifest>();
  for (const entry of await listBackups(to, { signal: run.signal, logger: run.logger })) {
    if (entry.manifest !== undefined) existing.set(entry.id, entry.manifest);
  }

  const erasuresCopied = await copyErasureLedger(run, dryRun);
  const backups: ReplicatedBackup[] = [];
  for (const backup of selected) {
    throwIfAborted(run.signal);
    backups.push(await replicateOne(run, backup, existing.get(backup.id), dryRun));
  }
  return {
    dryRun,
    backups,
    erasuresCopied,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

/** Validates options and fixes the settings of the run. */
function prepareRun(
  from: StorageAdapter,
  to: StorageAdapter,
  options: ReplicateOptions,
): ReplicateRun {
  if (from === to || from.location === to.location) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Cannot replicate ${from.location} onto itself.`,
      { hint: "Pass a different destination storage (e.g. another bucket or region)." },
    );
  }
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "concurrency must be a whole number of at least 1.",
    );
  }
  let retainUntil: Date | undefined;
  if (options.retainDays !== undefined) {
    if (!Number.isInteger(options.retainDays) || options.retainDays < 1) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        "retainDays must be a whole number of at least 1.",
      );
    }
    if (!to.capabilities.objectLock) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `The destination ${to.location} does not support write-once retention (object lock).`,
        { hint: "Use a bucket with Object Lock enabled, or drop retainDays." },
      );
    }
    const now = options.now?.() ?? new Date();
    retainUntil = new Date(now.getTime() + options.retainDays * ONE_DAY_MS);
  }
  return {
    from,
    to,
    verify: options.verify ?? true,
    retainUntil,
    concurrency,
    logger: options.logger ?? silentLogger,
    signal: options.signal ?? new AbortController().signal,
    onProgress: options.onProgress,
  };
}

/** Copies or updates one backup; see the file header for the order. */
async function replicateOne(
  run: ReplicateRun,
  backup: SelectedBackup,
  atDestination: Manifest | undefined,
  dryRun: boolean,
): Promise<ReplicatedBackup> {
  const sourceManifest = await readRawManifest(run.from, backup.id, run.signal);
  if (atDestination !== undefined) {
    await assertSameBackup(run, backup.id, sourceManifest);
  }

  // Files whose digest at the destination differs from the source (all of them for a
  // new copy; only rekeyed ones for a backup that is already there).
  const planned = await planFiles(run, backup, atDestination);
  const toCopy = planned.filter((entry) => !entry.present);
  const bytes = toCopy.reduce((sum, entry) => sum + entry.file.size, 0);
  const action = chooseAction(atDestination, toCopy.length, dryRun);
  run.onProgress?.({
    type: "backup:start",
    backupId: backup.id,
    action,
    files: toCopy.length,
    bytes,
  });
  if (dryRun || action === "skipped") {
    if (action === "skipped") await copyAnnotations(run, backup.id);
    run.onProgress?.({ type: "backup:done", backupId: backup.id });
    return { backupId: backup.id, action, files: toCopy.length, bytes };
  }

  run.logger.info("Replicating backup", { backupId: backup.id, files: toCopy.length, action });
  await mapWithConcurrency(
    toCopy,
    async (entry, _index, signal) => {
      await copyFile(run, backup.id, entry.file, signal);
      run.onProgress?.({
        type: "file:done",
        backupId: backup.id,
        key: entry.file.key,
        bytes: entry.file.size,
      });
    },
    { concurrency: run.concurrency, signal: run.signal },
  );
  await copyUnlistedObjects(run, backup, atDestination !== undefined);
  await copyAnnotations(run, backup.id);
  if (atDestination === undefined) await writeManifestCopy(run, backup.id, sourceManifest);
  run.onProgress?.({ type: "backup:done", backupId: backup.id });
  return { backupId: backup.id, action, files: toCopy.length, bytes };
}

function chooseAction(
  atDestination: Manifest | undefined,
  filesToCopy: number,
  dryRun: boolean,
): ReplicatedBackup["action"] {
  if (atDestination === undefined) return dryRun ? "would-copy" : "copied";
  if (filesToCopy === 0) return "skipped";
  return dryRun ? "would-update" : "updated";
}

/**
 * Which files need copying. For a new copy, files a previous interrupted run already
 * copied intact (same size and SHA-256) are not copied again; for a present backup,
 * files whose effective digest matches the source's are left alone.
 */
async function planFiles(
  run: ReplicateRun,
  backup: SelectedBackup,
  atDestination: Manifest | undefined,
): Promise<PlannedFile[]> {
  const sourceFiles = allFilesOf(backup.manifest);
  if (atDestination !== undefined) {
    const destinationDigests = new Map(allFilesOf(atDestination).map((file) => [file.key, file]));
    return sourceFiles.map((file) => {
      const there = destinationDigests.get(file.key);
      const present =
        there !== undefined && there.sha256 === file.sha256 && there.size === file.size;
      return { file, present };
    });
  }
  return mapWithConcurrency(
    sourceFiles,
    async (file, _index, signal) => {
      const info = await run.to.head(resolveBackupKey(backup.id, file.key), { signal });
      if (info === undefined || info.size !== file.size) return { file, present: false };
      const check = await checkStoredFile({ storage: run.to, backupId: backup.id }, file, {
        signal,
      });
      return { file, present: check.ok };
    },
    { concurrency: run.concurrency, signal: run.signal },
  );
}

/**
 * Streams one file from source to destination, checking the source bytes against the
 * recorded digest on the way (a mismatch fails the put, so nothing is stored), then,
 * with `verify`, reads the stored copy back and checks it again.
 */
async function copyFile(
  run: ReplicateRun,
  backupId: string,
  file: StoredFile,
  signal: AbortSignal,
): Promise<void> {
  const key = resolveBackupKey(backupId, file.key);
  await writeStoredFile({
    storage: run.to,
    key,
    source: await run.from.get(key, { signal }),
    transforms: [createExpectedDigestCheck(file, `${run.from.location} (backup ${backupId})`)],
    contentType: "application/octet-stream",
    retainUntil: run.retainUntil,
    signal,
  });
  if (!run.verify) return;
  const check = await checkStoredFile({ storage: run.to, backupId }, file, { signal });
  if (!check.ok) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `The copy of ${file.key} (backup ${backupId}) at ${run.to.location} reads back wrong: ${check.problem}`,
      { hint: "The destination storage corrupted the upload. Run the replication again." },
    );
  }
}

/**
 * Copies objects in the backup directory that the manifest does not list (none are
 * written by MongoShield today; this keeps a replica a complete copy of the directory
 * should a future version or a user add any). Never the manifest itself.
 */
async function copyUnlistedObjects(
  run: ReplicateRun,
  backup: SelectedBackup,
  alreadyThere: boolean,
): Promise<void> {
  if (alreadyThere) return;
  const listed = new Set(
    allFilesOf(backup.manifest).map((file) => resolveBackupKey(backup.id, file.key)),
  );
  listed.add(manifestKey(backup.id));
  for await (const object of run.from.list(backupDir(backup.id), { signal: run.signal })) {
    if (listed.has(object.key)) continue;
    await run.to.put(object.key, await run.from.get(object.key, { signal: run.signal }), {
      sizeHint: object.size,
      signal: run.signal,
      ...(run.retainUntil ? { retainUntil: run.retainUntil } : {}),
    });
  }
}

/**
 * Copies the backup's annotations that are missing at the destination or differ
 * from the source (a pending rekey record that has since completed, a newer hold).
 * Annotations only present at the destination are left alone.
 */
async function copyAnnotations(run: ReplicateRun, backupId: string): Promise<void> {
  const prefix = `${ANNOTATIONS_PREFIX}${backupId}/`;
  for await (const object of run.from.list(prefix, { signal: run.signal })) {
    const body = await readSmall(run.from, object.key, run.signal);
    const existing = await readSmallIfPresent(run.to, object.key, run.signal);
    if (existing?.equals(body)) continue;
    await run.to.put(object.key, body, {
      contentType: "application/json",
      sizeHint: body.length,
      signal: run.signal,
    });
  }
}

/**
 * Copies erasure ledger records the destination does not have yet. Records are
 * append-only with unique names, so an existing record is never rewritten.
 */
async function copyErasureLedger(run: ReplicateRun, dryRun: boolean): Promise<number> {
  const present = new Set<string>();
  for await (const object of run.to.list(ERASURES_PREFIX, { signal: run.signal })) {
    present.add(object.key);
  }
  let copied = 0;
  for await (const object of run.from.list(ERASURES_PREFIX, { signal: run.signal })) {
    if (present.has(object.key)) continue;
    copied += 1;
    if (dryRun) continue;
    const body = await readSmall(run.from, object.key, run.signal);
    await run.to.put(object.key, body, {
      contentType: "application/json",
      sizeHint: body.length,
      signal: run.signal,
      ...(run.to.capabilities.conditionalWrites ? { ifNoneMatch: "*" as const } : {}),
    });
  }
  return copied;
}

/** Writes the source manifest's exact bytes: the commit marker of the copy. */
async function writeManifestCopy(
  run: ReplicateRun,
  backupId: string,
  bytes: Buffer,
): Promise<void> {
  await run.to.put(manifestKey(backupId), bytes, {
    contentType: "application/json",
    sizeHint: bytes.length,
    signal: run.signal,
    ...(run.to.capabilities.conditionalWrites ? { ifNoneMatch: "*" as const } : {}),
    ...(run.retainUntil ? { retainUntil: run.retainUntil } : {}),
  });
}

/** Refuses to "update" a destination backup that is a different backup with the same id. */
async function assertSameBackup(
  run: ReplicateRun,
  backupId: string,
  sourceManifest: Buffer,
): Promise<void> {
  const destination = await readRawManifest(run.to, backupId, run.signal);
  if (destination.equals(sourceManifest)) return;
  throw new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `${run.to.location} already holds a backup ${backupId} whose manifest differs from the source's.`,
    {
      hint: "Two different backups cannot share an id; inspect both copies before deleting either.",
    },
  );
}

/** The manifest's raw bytes (copied byte for byte, never re-serialized). */
async function readRawManifest(
  storage: StorageAdapter,
  backupId: string,
  signal: AbortSignal,
): Promise<Buffer> {
  return readStreamToBuffer(await storage.get(manifestKey(backupId), { signal }), {
    maxBytes: MAX_MANIFEST_BYTES,
  });
}

async function readSmall(
  storage: StorageAdapter,
  key: string,
  signal: AbortSignal,
): Promise<Buffer> {
  return readStreamToBuffer(await storage.get(key, { signal }), {
    maxBytes: MAX_SMALL_OBJECT_BYTES,
  });
}

async function readSmallIfPresent(
  storage: StorageAdapter,
  key: string,
  signal: AbortSignal,
): Promise<Buffer | undefined> {
  try {
    return await readSmall(storage, key, signal);
  } catch (error) {
    if (isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")) return undefined;
    throw error;
  }
}

/** One configured replication target (`replicate: [...]` in the config file). */
export interface ReplicateTarget {
  /** A storage URL or adapter. */
  readonly storage: string | StorageAdapter;
  readonly retainDays?: number | undefined;
}

/** What happened at one target in {@link replicateToTargets}. */
export interface TargetReplication {
  /** The destination's location (secrets removed). */
  readonly location: string;
  readonly result?: ReplicateResult;
  /** Set when this target failed; the other targets are still tried. */
  readonly error?: unknown;
}

/**
 * The scheduled-run hook: copies one fresh backup to every configured target. A failing
 * target does not stop the others; each outcome is returned so the run report can say
 * which copies exist. Storage URLs are opened with `resolve` and closed afterwards.
 */
export async function replicateToTargets(
  from: StorageAdapter,
  targets: readonly ReplicateTarget[],
  backupId: string,
  options: {
    readonly resolve: (url: string) => Promise<StorageAdapter>;
    readonly logger?: Logger;
    readonly signal?: AbortSignal;
  },
): Promise<TargetReplication[]> {
  const outcomes: TargetReplication[] = [];
  for (const target of targets) {
    throwIfAborted(options.signal);
    const opened = typeof target.storage === "string";
    let destination: StorageAdapter | undefined;
    try {
      destination =
        typeof target.storage === "string" ? await options.resolve(target.storage) : target.storage;
      const result = await replicateBackups(from, destination, {
        backups: [backupId],
        ...(target.retainDays !== undefined ? { retainDays: target.retainDays } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      outcomes.push({ location: destination.location, result });
    } catch (error) {
      options.logger?.warn("Replicating the backup failed", {
        backupId,
        target: destination?.location ?? "(unresolved storage)",
      });
      outcomes.push({ location: destination?.location ?? "(unresolved storage)", error });
    } finally {
      if (opened) await destination?.close?.();
    }
  }
  return outcomes;
}
