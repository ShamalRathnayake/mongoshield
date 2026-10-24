/**
 * Picking one backup from the catalog, for restore and verify.
 *
 * A selector is one of:
 *   "latest"          the most recently completed backup
 *   "<backup id>"     exactly that backup
 *   { before: date }  the newest backup that completed at or before `date`
 *                     (the state of the data "as of" that moment)
 *
 * Only complete backups can be selected: an incomplete one has no manifest to
 * restore from, and an invalid one cannot be trusted.
 */

import { MongoShieldError } from "../errors.ts";
import { backupIdToDate, isBackupId } from "../format/layout.ts";
import type { BackupSelector } from "../types.ts";
import { type CatalogEntry, completedAtOf } from "./catalog.ts";

/** How many alternative ids an error hint suggests. */
const SUGGESTION_COUNT = 3;

/** Hint used when there is nothing to select at all. */
const NO_BACKUPS_HINT = "There are no complete backups yet. Run `mongoshield backup` first.";

/** A complete backup together with its completion time, for sorting and comparing. */
interface CompletedBackup {
  readonly entry: CatalogEntry;
  readonly completedAt: Date;
}

/**
 * Selects one complete backup from `entries` (as returned by `listBackups`).
 *
 * @throws MongoShieldError `MS_BACKUP_NOT_FOUND` when nothing matches, with a hint
 *   naming the closest available backups. `MS_MANIFEST_INVALID` when the requested id
 *   exists but its manifest is unusable. `MS_CONFIG_INVALID` for an unparseable date.
 */
export function selectBackup(
  entries: readonly CatalogEntry[],
  selector: BackupSelector,
): CatalogEntry {
  const completed = completedNewestFirst(entries);

  if (selector === "latest") return selectLatest(completed);
  if (typeof selector === "string") return selectById(entries, completed, selector);
  return selectBefore(completed, parseSelectorDate(selector.before));
}

/** The most recently completed backup. */
function selectLatest(completed: readonly CompletedBackup[]): CatalogEntry {
  const newest = completed[0];
  if (newest === undefined) {
    throw new MongoShieldError("MS_BACKUP_NOT_FOUND", "There is no latest backup.", {
      hint: NO_BACKUPS_HINT,
    });
  }
  return newest.entry;
}

/** Exactly the backup with this id, which must be complete. */
function selectById(
  entries: readonly CatalogEntry[],
  completed: readonly CompletedBackup[],
  id: string,
): CatalogEntry {
  const entry = entries.find((candidate) => candidate.id === id);

  if (entry?.status === "complete") return entry;

  if (entry?.status === "incomplete") {
    throw new MongoShieldError(
      "MS_BACKUP_NOT_FOUND",
      `Backup ${id} is incomplete (it has no manifest), so it cannot be used.`,
      {
        hint: `The run may still be in progress or may have crashed. ${suggestionHint(closestTo(completed, entry.startedAt))}`,
      },
    );
  }

  if (entry?.status === "invalid") {
    throw new MongoShieldError(
      "MS_MANIFEST_INVALID",
      `Backup ${id} has an unusable manifest: ${entry.error ?? "unknown reason"}`,
      { hint: suggestionHint(closestTo(completed, entry.startedAt)) },
    );
  }

  // Not found. If the id is well-formed, suggest backups that started near the
  // same time (a typo in the suffix is common); otherwise suggest the newest ones.
  const suggestions = isBackupId(id)
    ? closestTo(completed, backupIdToDate(id))
    : completed.slice(0, SUGGESTION_COUNT);
  throw new MongoShieldError("MS_BACKUP_NOT_FOUND", `No backup with id "${id}" exists.`, {
    hint: suggestionHint(suggestions),
  });
}

/** The newest backup that completed at or before `before`. */
function selectBefore(completed: readonly CompletedBackup[], before: Date): CatalogEntry {
  // `completed` is newest first, so the first match is the newest one.
  const match = completed.find((backup) => backup.completedAt.getTime() <= before.getTime());
  if (match) return match.entry;

  // Every backup completed after the date, so the oldest ones are the closest.
  const oldestFirst = [...completed].reverse();
  throw new MongoShieldError(
    "MS_BACKUP_NOT_FOUND",
    `No backup completed at or before ${before.toISOString()}.`,
    { hint: suggestionHint(oldestFirst.slice(0, SUGGESTION_COUNT)) },
  );
}

/** Accepts a Date or any string `Date` can parse (ISO 8601 recommended). */
function parseSelectorDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `"${String(value)}" is not a valid date.`, {
      hint: 'Use an ISO 8601 date such as "2026-11-14T03:00:00Z".',
    });
  }
  return date;
}

/** Complete backups only, most recently completed first (ties broken by id, newest first). */
function completedNewestFirst(entries: readonly CatalogEntry[]): CompletedBackup[] {
  const completed: CompletedBackup[] = [];
  for (const entry of entries) {
    const completedAt = completedAtOf(entry);
    if (entry.status === "complete" && completedAt !== undefined) {
      completed.push({ entry, completedAt });
    }
  }
  return completed.sort((a, b) => {
    const byTime = b.completedAt.getTime() - a.completedAt.getTime();
    if (byTime !== 0) return byTime;
    return b.entry.id < a.entry.id ? -1 : 1;
  });
}

/** The backups whose start time is nearest to `target`, nearest first. */
function closestTo(completed: readonly CompletedBackup[], target: Date): CompletedBackup[] {
  const distance = (backup: CompletedBackup): number =>
    Math.abs(backup.entry.startedAt.getTime() - target.getTime());
  return [...completed].sort((a, b) => distance(a) - distance(b)).slice(0, SUGGESTION_COUNT);
}

/** "Closest available backups: a, b, c." or the no-backups hint. */
function suggestionHint(suggestions: readonly CompletedBackup[]): string {
  if (suggestions.length === 0) return NO_BACKUPS_HINT;
  const ids = suggestions.map((backup) => backup.entry.id).join(", ");
  return `Closest available backups: ${ids}. Run \`mongoshield list\` to see all of them.`;
}
