/**
 * Pruning: applying a retention policy to a storage location.
 *
 * The steps are: list the catalog, plan with the pure `planRetention`, then
 * (unless `dryRun`) delete every object of each backup the plan removes.
 * All decisions live in `retention.ts`; this file only gathers the inputs and
 * deletes carefully.
 *
 * Scopes: with `scope` (see scope.ts) only the backups of one source/selection
 * are planned over; every other backup in the location is left untouched and
 * reported in `outOfScope`. Without a scope the policy covers the whole location.
 *
 * Immutable backups: the planner keeps a backup until its manifest's
 * `immutableUntil`, so prune never asks the storage to delete a locked backup.
 * The storage can still refuse (a clock that runs ahead of the provider's, or an
 * incomplete run that never wrote its manifest but whose files are locked). Such
 * refusals (`MS_STORAGE_FORBIDDEN` with `details.objectLocked`) skip that backup
 * instead of failing the whole prune; any other error still stops it.
 */

import { readCheckpoint } from "../engine/backup-checkpoint.ts";
import { isMongoShieldError, throwIfAborted } from "../errors.ts";
import { backupDir, checkpointKey, manifestKey } from "../format/layout.ts";
import { type Logger, silentLogger } from "../logger.ts";
import { isObjectLockedError } from "../storage/retention.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { deleteAnnotations } from "./annotations.ts";
import {
  type CatalogEntry,
  type CatalogStatus,
  completedAtOf,
  immutableUntilOf,
  listBackups,
} from "./catalog.ts";
import {
  planRetention,
  type RetentionBackup,
  type RetentionPlan,
  type RetentionPolicy,
} from "./retention.ts";
import { type BackupOrigin, isInScope, type PruneScope, validateScope } from "./scope.ts";

/** Options for {@link pruneBackups}. */
export interface PruneOptions {
  /** The current time. Defaults to `new Date()`; pass it to make runs reproducible. */
  readonly now?: Date;
  /** Plan and report, but delete nothing. */
  readonly dryRun?: boolean;
  /**
   * Apply the policy only to the backups of one source/selection (see scope.ts).
   * Every other backup is left alone and listed in `outOfScope`. Omit it to apply
   * the policy to every backup in the storage location.
   */
  readonly scope?: PruneScope;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

/**
 * Why a scoped prune left a backup alone:
 *
 *   other-scope   it belongs to another source or selection
 *   unattributed  an incomplete run without a (readable) checkpoint: nothing says
 *                 whose it is, so only an unscoped prune may remove it
 *   invalid       its manifest is unusable; never removed automatically anyway
 */
export type OutOfScopeReason = "other-scope" | "unattributed" | "invalid";

/** A backup a scoped prune did not plan over (and never touched). */
export interface OutOfScopeBackup {
  readonly id: string;
  readonly status: CatalogStatus;
  readonly reason: OutOfScopeReason;
}

/** What a prune run decided and did. */
export interface PruneResult {
  readonly plan: RetentionPlan;
  readonly dryRun: boolean;
  /** Backups whose objects were deleted. Always 0 for a dry run. */
  readonly deletedBackups: number;
  /** Objects deleted, manifests included. */
  readonly deletedObjects: number;
  /** Total size in bytes of the deleted objects. */
  readonly deletedBytes: number;
  /**
   * Ids that the plan removed but that were skipped: they completed meanwhile, or
   * the storage refused to delete them because their objects are still locked.
   * Deleted counts include any objects of a skipped backup removed before the refusal.
   */
  readonly skipped: string[];
  /**
   * Backups outside `scope`, newest first. They were not planned over, so they
   * appear in neither `plan.keep` nor `plan.remove`. Always empty without a scope.
   */
  readonly outOfScope: OutOfScopeBackup[];
}

/**
 * S3 `DeleteObjects` accepts at most 1000 keys per request; other adapters
 * are happy with any batch size, so this is a safe common limit.
 */
const DELETE_BATCH_SIZE = 1000;

/**
 * Applies `policy` to the backups in `storage` (only those in `options.scope`, when given).
 *
 * Verification results and holds come from the backup's annotations (see
 * annotations.ts): a backup whose latest verification passed counts as verified,
 * and a backup with a hold is never deleted.
 */
export async function pruneBackups(
  storage: StorageAdapter,
  policy: RetentionPolicy,
  options: PruneOptions = {},
): Promise<PruneResult> {
  const logger = options.logger ?? silentLogger;
  const signal = options.signal;
  const dryRun = options.dryRun ?? false;

  const scope = options.scope;
  if (scope !== undefined) validateScope(scope);

  const entries = await listBackups(storage, {
    logger,
    ...(signal ? { signal } : {}),
  });
  const { inScope, outOfScope } = await splitByScope(storage, entries, scope, signal);
  const backups: RetentionBackup[] = [];
  for (const entry of inScope) {
    backups.push(await toRetentionBackup(storage, entry, signal));
  }

  const planned = planRetention({ backups, policy, now: options.now ?? new Date() });
  const plan: RetentionPlan = {
    ...planned,
    warnings: [...planned.warnings, ...outOfScopeWarnings(outOfScope)],
  };
  for (const warning of plan.warnings) logger.warn(warning);
  if (outOfScope.length > 0) {
    logger.info("Left backups of other sources or selections alone", {
      outOfScope: outOfScope.length,
    });
  }

  const skipped: string[] = [];
  const result = {
    plan,
    dryRun,
    deletedBackups: 0,
    deletedObjects: 0,
    deletedBytes: 0,
    skipped,
    outOfScope,
  };
  if (dryRun) {
    for (const removed of plan.remove) {
      logger.info("Would delete backup (dry run)", { id: removed.id, reason: removed.reason });
    }
    return result;
  }

  const statusById = new Map(entries.map((entry) => [entry.id, entry.status]));
  for (const removed of plan.remove) {
    throwIfAborted(signal);

    // An incomplete run that was planned for removal may have committed its
    // manifest since we listed (a very slow backup finishing just now). Re-check
    // right before deleting so we never destroy a backup that just became good.
    if (
      statusById.get(removed.id) === "incomplete" &&
      (await hasManifest(storage, removed.id, signal))
    ) {
      logger.warn("Skipping a backup that completed while pruning", { id: removed.id });
      skipped.push(removed.id);
      continue;
    }

    let deleted: DeletedCounts;
    try {
      deleted = await deleteBackup(storage, removed.id, signal, result);
    } catch (error) {
      if (!isObjectLockedError(error)) throw error;
      logger.warn("Skipping a backup whose objects are still locked by the storage", {
        id: removed.id,
        error: error instanceof Error ? error.message : String(error),
      });
      skipped.push(removed.id);
      continue;
    }
    // Annotations and the checkpoint of a resumable run go last: until the data is
    // gone they still describe it.
    await deleteAnnotations(storage, removed.id);
    await deleteCheckpointOf(storage, removed.id, signal);
    result.deletedBackups++;
    logger.info("Deleted backup", { id: removed.id, reason: removed.reason, ...deleted });
  }

  return result;
}

/** The catalog entries a prune plans over, and the ones it leaves alone. */
interface ScopeSplit {
  readonly inScope: CatalogEntry[];
  readonly outOfScope: OutOfScopeBackup[];
}

/**
 * Splits the catalog by `scope`. Without a scope everything is in scope. With one,
 * a backup is in scope only when its origin is known and matches; anything that
 * cannot be attributed stays out (the safe side: it is kept).
 */
async function splitByScope(
  storage: StorageAdapter,
  entries: readonly CatalogEntry[],
  scope: PruneScope | undefined,
  signal: AbortSignal | undefined,
): Promise<ScopeSplit> {
  if (scope === undefined) return { inScope: [...entries], outOfScope: [] };

  const inScope: CatalogEntry[] = [];
  const outOfScope: OutOfScopeBackup[] = [];
  for (const entry of entries) {
    if (entry.status === "invalid") {
      outOfScope.push({ id: entry.id, status: entry.status, reason: "invalid" });
      continue;
    }
    const origin = await originOf(storage, entry, signal);
    if (origin === undefined) {
      outOfScope.push({ id: entry.id, status: entry.status, reason: "unattributed" });
    } else if (isInScope(origin, scope)) {
      inScope.push(entry);
    } else {
      outOfScope.push({ id: entry.id, status: entry.status, reason: "other-scope" });
    }
  }
  return { inScope, outOfScope };
}

/**
 * Where a backup came from: its manifest's source and labels, or for an
 * incomplete run those recorded in its checkpoint (written with the same labels
 * and source the manifest will have). `undefined` when nothing records it.
 */
async function originOf(
  storage: StorageAdapter,
  entry: CatalogEntry,
  signal: AbortSignal | undefined,
): Promise<BackupOrigin | undefined> {
  if (entry.manifest !== undefined) {
    return { clusterId: entry.manifest.source.clusterId, labels: entry.manifest.labels };
  }
  try {
    const checkpoint = await readCheckpoint(storage, entry.id, signal);
    if (checkpoint === undefined) return undefined;
    return { clusterId: checkpoint.source.clusterId, labels: checkpoint.labels };
  } catch (error) {
    // A damaged checkpoint says nothing reliable about the run: leave it alone.
    if (isMongoShieldError(error, "MS_MANIFEST_INVALID")) return undefined;
    throw error;
  }
}

/**
 * The warnings a scoped prune adds about what it left alone. Invalid backups were
 * warned about by the planner before scopes existed; they are out of every scope
 * now, but the user still needs to hear about them.
 */
function outOfScopeWarnings(outOfScope: readonly OutOfScopeBackup[]): string[] {
  const warnings: string[] = [];
  for (const backup of outOfScope) {
    if (backup.reason !== "invalid") continue;
    warnings.push(
      `Backup ${backup.id} has an invalid manifest and is never removed automatically. ` +
        "Inspect it and delete it by hand if it is not needed.",
    );
  }
  return warnings;
}

/** Objects and bytes removed for one backup. */
interface DeletedCounts {
  objects: number;
  bytes: number;
}

/**
 * Deletes every object of one backup.
 *
 * The manifest goes FIRST. The manifest is the commit marker, so once it is
 * gone the backup reads as "incomplete" everywhere. If we crash or are aborted
 * halfway, what is left is an incomplete directory that the next prune cleans
 * up, never a "complete" backup with missing data files that a restore would
 * pick and then fail on (or, worse, restore partially). It also means a backup
 * still under object lock is refused at its first delete, before anything changed.
 *
 * Counts are added to `totals` as each batch succeeds, so objects removed before
 * a refusal are still reported.
 */
async function deleteBackup(
  storage: StorageAdapter,
  id: string,
  signal: AbortSignal | undefined,
  totals: { deletedObjects: number; deletedBytes: number },
): Promise<DeletedCounts> {
  const signalOption = signal ? { signal } : {};
  const counts: DeletedCounts = { objects: 0, bytes: 0 };
  const record = (size: number): void => {
    counts.objects++;
    counts.bytes += size;
    totals.deletedObjects++;
    totals.deletedBytes += size;
  };

  const manifest = await storage.head(manifestKey(id), signalOption);
  if (manifest) {
    await storage.delete([manifest.key], signalOption);
    record(manifest.size);
  }

  // Collect the keys before deleting: some adapters (e.g. a directory walk on
  // disk) may misbehave if objects disappear while they are being listed.
  // The trailing slash in `backupDir` matters: it stops a prefix match from
  // reaching a sibling directory whose name merely starts with this id.
  const remaining: { key: string; size: number }[] = [];
  for await (const object of storage.list(backupDir(id), signalOption)) {
    remaining.push({ key: object.key, size: object.size });
  }

  for (let start = 0; start < remaining.length; start += DELETE_BATCH_SIZE) {
    throwIfAborted(signal);
    const batch = remaining.slice(start, start + DELETE_BATCH_SIZE);
    await storage.delete(
      batch.map((object) => object.key),
      signalOption,
    );
    for (const object of batch) record(object.size);
  }

  return counts;
}

/** Converts a catalog entry into the planner's input. */
async function toRetentionBackup(
  storage: StorageAdapter,
  entry: CatalogEntry,
  signal: AbortSignal | undefined,
): Promise<RetentionBackup> {
  const flags = {
    // A passed drill (a real test restore) is the strongest proof a backup works,
    // so it counts as verified just like a passed verify run.
    verified: entry.verification?.ok === true || entry.lastDrill?.ok === true,
    held: entry.hold !== undefined,
  };
  const completedAt = completedAtOf(entry);
  if (entry.status === "complete" && completedAt !== undefined) {
    const immutableUntil = immutableUntilOf(entry);
    return {
      id: entry.id,
      status: entry.status,
      completedAt,
      ...flags,
      ...(immutableUntil === undefined ? {} : { immutableUntil }),
    };
  }

  // An incomplete run has no completion time. Its age for the grace period is
  // measured from its LAST write, not its start: a long backup that started
  // more than a day ago but is still writing must not be deleted under it.
  const time =
    entry.status === "incomplete" ? await lastActivity(storage, entry, signal) : entry.startedAt;
  return { id: entry.id, status: entry.status, completedAt: time, ...flags };
}

/**
 * The newest modification time of any object in a backup directory or of its
 * checkpoint (or its start time). A checkpointed run between two invocations is
 * therefore kept for the grace period after its last checkpoint, and pruned with
 * its checkpoint once it has been idle for longer.
 */
async function lastActivity(
  storage: StorageAdapter,
  entry: CatalogEntry,
  signal: AbortSignal | undefined,
): Promise<Date> {
  let latest = entry.startedAt.getTime();
  const checkpoint = await storage.head(checkpointKey(entry.id), signal ? { signal } : {});
  if (checkpoint !== undefined) latest = Math.max(latest, checkpoint.lastModified.getTime());
  for await (const object of storage.list(backupDir(entry.id), signal ? { signal } : {})) {
    latest = Math.max(latest, object.lastModified.getTime());
  }
  return new Date(latest);
}

/** Deletes the checkpoint of a resumable run, if it has one. */
async function deleteCheckpointOf(
  storage: StorageAdapter,
  id: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const key = checkpointKey(id);
  const signalOption = signal ? { signal } : {};
  if ((await storage.head(key, signalOption)) !== undefined) {
    await storage.delete([key], signalOption);
  }
}

/** True if the backup's manifest exists right now. */
async function hasManifest(
  storage: StorageAdapter,
  id: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const info = await storage.head(manifestKey(id), signal ? { signal } : {});
  return info !== undefined;
}
