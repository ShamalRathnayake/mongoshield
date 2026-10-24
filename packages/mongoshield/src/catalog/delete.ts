/**
 * Deleting one backup by id (`shield.deleteBackup()`, `mongoshield delete <id>`).
 *
 * Pruning deletes what a retention policy no longer needs; this deletes exactly the
 * backup you name, for the times a policy is not the right tool (a backup taken by
 * mistake, data that must go, the Kubernetes operator's `deletionPolicy: Delete`).
 * It applies the same protections as prune, and refuses rather than guesses:
 *
 *   - a backup on hold (`mongoshield hold`) is never deleted: release it first;
 *   - a backup whose manifest says it is write-once until a later date
 *     (`immutableUntil`, from `retainDays`) is refused before anything is touched,
 *     and if the storage itself still refuses (its clock or lock differs), the
 *     deletion stops with the same error;
 *   - a backup that an incremental backup depends on (its chain parent, or any
 *     ancestor of one) is refused, naming the dependents: deleting it would make
 *     every one of them unrestorable. Delete the dependents first, newest first.
 *
 * Order matters: the manifest goes first (it is the commit marker, so the backup
 * reads as "incomplete" everywhere from that moment and no restore can pick a
 * half-deleted backup), then the data files, then its annotations and checkpoint.
 * The deletion is logged at info level with id, objects, bytes and who asked, so a
 * log collector keeps an audit trail.
 */

import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { isBackupId } from "../format/layout.ts";
import { type Logger, silentLogger } from "../logger.ts";
import { isObjectLockedError } from "../storage/retention.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { deleteAnnotations } from "./annotations.ts";
import { type CatalogEntry, immutableUntilOf, listBackups } from "./catalog.ts";
import { chainAncestorIds } from "./chain.ts";
import { deleteBackup, deleteCheckpointOf } from "./prune.ts";

/** Options for {@link deleteBackupById}. */
export interface DeleteBackupOptions {
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  /** The current time, for the object-lock check. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Who asked, recorded in the log line (e.g. `user@host`, a Kubernetes object). */
  readonly requestedBy?: string;
}

/** What was deleted. */
export interface DeleteBackupResult {
  readonly id: string;
  /** `complete`, `incomplete` or `invalid`: what the backup was before deletion. */
  readonly status: CatalogEntry["status"];
  readonly deletedObjects: number;
  readonly deletedBytes: number;
  readonly deletedAt: string;
  readonly requestedBy?: string;
}

/**
 * Deletes one backup (see the file header for the rules).
 *
 * @throws MongoShieldError `MS_BACKUP_NOT_FOUND` when no backup has that id,
 *   `MS_BACKUP_PROTECTED` when it is held, locked or needed by an incremental.
 */
export async function deleteBackupById(
  storage: StorageAdapter,
  id: string,
  options: DeleteBackupOptions = {},
): Promise<DeleteBackupResult> {
  const { signal } = options;
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? new Date();
  if (!isBackupId(id)) throw notFound(id);

  const entries = await listBackups(storage, { logger, ...(signal ? { signal } : {}) });
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) throw notFound(id);
  assertDeletable(entries, entry, now);
  throwIfAborted(signal);

  const totals = { deletedObjects: 0, deletedBytes: 0 };
  try {
    await deleteBackup(storage, id, signal, totals);
  } catch (error) {
    if (!isObjectLockedError(error)) throw error;
    throw protectedError(
      id,
      "the storage refuses to delete its objects (object lock / retention)",
      "Wait until the lock expires; MongoShield cannot shorten a storage lock.",
    );
  }
  // Annotations and checkpoint last: until the data is gone they still describe it.
  await deleteAnnotations(storage, id);
  await deleteCheckpointOf(storage, id, signal);

  const result: DeleteBackupResult = {
    id,
    status: entry.status,
    deletedObjects: totals.deletedObjects,
    deletedBytes: totals.deletedBytes,
    deletedAt: new Date().toISOString(),
    ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
  };
  logger.info("Deleted backup", { ...result, reason: "requested" });
  return result;
}

/** Refuses held, locked and depended-on backups. */
function assertDeletable(entries: readonly CatalogEntry[], entry: CatalogEntry, now: Date): void {
  if (entry.hold) {
    throw protectedError(
      entry.id,
      `it is on hold (${entry.hold.reason})`,
      `Release the hold first: mongoshield release ${entry.id}`,
    );
  }
  const until = immutableUntilOf(entry);
  if (until !== undefined && until.getTime() > now.getTime()) {
    throw protectedError(
      entry.id,
      `it is write-once until ${until.toISOString()} (retainDays)`,
      "Wait until then; the storage would refuse the deletion anyway.",
    );
  }
  const dependents = dependentsOf(entries, entry.id);
  if (dependents.length > 0) {
    const listed = dependents.slice(0, 5).join(", ");
    const more = dependents.length > 5 ? ` and ${dependents.length - 5} more` : "";
    throw protectedError(
      entry.id,
      `${dependents.length} incremental backup(s) depend on it (${listed}${more})`,
      "Deleting it would make them unrestorable. Delete the dependents first, newest first.",
    );
  }
}

/** Backups whose chain includes `id` as an ancestor, newest first. */
export function dependentsOf(entries: readonly CatalogEntry[], id: string): string[] {
  const dependents: string[] = [];
  for (const candidate of entries) {
    if (candidate.id === id) continue;
    if (chainAncestorIds(entries, candidate.id).includes(id)) dependents.push(candidate.id);
  }
  return dependents.sort().reverse();
}

function notFound(id: string): MongoShieldError {
  return new MongoShieldError("MS_BACKUP_NOT_FOUND", `There is no backup "${id}".`, {
    hint: "Run `mongoshield list` to see the available backup ids.",
  });
}

function protectedError(id: string, why: string, hint: string): MongoShieldError {
  return new MongoShieldError("MS_BACKUP_PROTECTED", `Backup ${id} cannot be deleted: ${why}.`, {
    hint,
  });
}
