/**
 * Retention planning: deciding which backups to keep and which to delete.
 *
 * This is a pure function with no I/O, so every rule can be tested exhaustively.
 * `prune.ts` does the actual deleting. Deleting backups is the most dangerous
 * thing MongoShield does, so the planner is deliberately conservative: when in
 * doubt, it keeps.
 *
 * ## Count rules (what the policy asks for)
 *
 * `last: N` keeps the N most recently completed backups.
 *
 * `hourly`, `daily`, `weekly`, `monthly` and `yearly` are grandfather-father-son
 * buckets with the same semantics as restic's `forget --keep-*` and borg's
 * `prune --keep-*`: walk the complete backups from newest to oldest and keep the
 * newest backup of each calendar period, until N periods have been covered.
 * Only periods that contain a backup count, so `daily: 7` means "one backup for
 * each of the last 7 days that have a backup", not "the last 7 calendar days".
 * Periods are computed in UTC from `completedAt`:
 *
 *   hourly   2026-10-20T13      daily    2026-10-20
 *   weekly   2026-W43 (ISO 8601 week: weeks start on Monday, and the week-year
 *            can differ from the calendar year around 1 January)
 *   monthly  2026-10            yearly   2026
 *
 * One backup can satisfy several rules (e.g. the newest backup is usually
 * `last`, `daily`, `weekly`, `monthly` and `yearly` at once); every reason is
 * recorded so `mongoshield prune --dry-run` can explain itself.
 *
 * ## Safety rules (always applied, whatever the policy says)
 *
 * 1. A policy without any count keeps everything (see `hasAnyCount`).
 * 2. The newest complete backup is always kept.
 * 3. Held backups are always kept.
 * 4. At least `minVerified` verified backups are kept.
 * 5. Incomplete runs are only removed after a grace period; invalid ones never.
 * 6. Backups dated in the future are kept.
 * 7. Immutable backups are kept until their `immutableUntil` has passed.
 * 8. Chain integrity: a kept incremental backup keeps every backup it depends on
 *    (its parent, the parent's parent, … down to the full backup it starts from).
 *
 * Each rule is explained where it is applied below.
 *
 * ## Incremental backups
 *
 * Incrementals count as backups like any other: `last: 24` keeps the 24 newest,
 * whatever their kind, and `daily: 7` the newest backup of each day, which with hourly
 * incrementals is usually that day's last one. Rule 8 then keeps what each of them
 * needs to be restored, so a chain is only ever cut at its newest end: the members
 * after the newest kept one are removed, never one in the middle. A whole chain goes
 * once nothing keeps any of its members.
 */

import { MongoShieldError } from "../errors.ts";
import type { CatalogStatus } from "./catalog.ts";

/** What to keep. All counts are optional non-negative integers. */
export interface RetentionPolicy {
  /** Keep the N most recently completed backups. */
  readonly last?: number;
  /** Keep the newest backup of each of the last N hours that have one (UTC). */
  readonly hourly?: number;
  /** Keep the newest backup of each of the last N days that have one (UTC). */
  readonly daily?: number;
  /** Keep the newest backup of each of the last N ISO weeks that have one (UTC). */
  readonly weekly?: number;
  /** Keep the newest backup of each of the last N months that have one (UTC). */
  readonly monthly?: number;
  /** Keep the newest backup of each of the last N years that have one (UTC). */
  readonly yearly?: number;
  /** Always keep at least this many verified backups. Defaults to 0. */
  readonly minVerified?: number;
  /** Incomplete runs younger than this may still be running and are kept. Defaults to 24 hours. */
  readonly incompleteGraceMs?: number;
}

/** One backup as the planner sees it. */
export interface RetentionBackup {
  readonly id: string;
  /**
   * When the backup completed. For incomplete and invalid backups, which have no
   * usable completion time, pass the time of the last known activity (or the start time).
   */
  readonly completedAt: Date;
  readonly status: CatalogStatus;
  /** A verification run has confirmed the backup can be restored. */
  readonly verified: boolean;
  /** The backup is on hold (legal hold, pinned by a user) and must never be deleted. */
  readonly held: boolean;
  /**
   * End of the backup's write-once retention (the manifest's `immutableUntil`).
   * Until then the storage refuses to delete it, so the planner keeps it.
   */
  readonly immutableUntil?: Date;
  /**
   * Incremental backups: the backup this one continues (its manifest's `chain.parent`).
   * Restoring this one needs the parent, so keeping this one keeps the parent (rule 8).
   */
  readonly parent?: string;
  /**
   * Set (to that backup's id) when a backup this plan does not cover, such as another
   * scope's, depends on this one: it is kept like the parent of a kept backup.
   */
  readonly neededBy?: string;
}

/** Input of {@link planRetention}. */
export interface RetentionInput {
  readonly backups: readonly RetentionBackup[];
  readonly policy: RetentionPolicy;
  /** The current time. Passed in so planning is deterministic and testable. */
  readonly now: Date;
}

/** A backup the plan keeps, with every rule that keeps it. */
export interface KeptBackup {
  readonly id: string;
  readonly reasons: string[];
}

/** A backup the plan removes, with the reason it is no longer needed. */
export interface RemovedBackup {
  readonly id: string;
  readonly reason: string;
}

/** Output of {@link planRetention}. Both lists are ordered newest first. */
export interface RetentionPlan {
  readonly keep: KeptBackup[];
  readonly remove: RemovedBackup[];
  /** Things the user should know about, such as invalid backups or an empty policy. */
  readonly warnings: string[];
}

/** The calendar-period bucket rules, from finest to coarsest. */
export type RetentionBucket = "hourly" | "daily" | "weekly" | "monthly" | "yearly";

const BUCKETS: readonly RetentionBucket[] = ["hourly", "daily", "weekly", "monthly", "yearly"];

/** The policy fields that ask for backups to be kept. */
const COUNT_FIELDS = ["last", ...BUCKETS] as const;

/** Default grace period for incomplete runs: a full day, longer than any sane backup. */
export const DEFAULT_INCOMPLETE_GRACE_MS = 24 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Decides which backups to keep and which to remove. Pure: no I/O, no clock.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when a count is negative or not an
 *   integer, or `now` is not a valid date.
 */
export function planRetention(input: RetentionInput): RetentionPlan {
  validatePolicy(input.policy);
  if (Number.isNaN(input.now.getTime())) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "Retention planning needs a valid `now`.");
  }

  const backups = sortNewestFirst(input.backups);
  const warnings: string[] = [];

  // Safety rule 1: a policy that asks to keep nothing is almost certainly a
  // mistake (a typo in a config key, an unset environment variable), not a
  // request to delete every backup. Refuse to plan any deletion.
  if (!hasAnyCount(input.policy)) {
    warnings.push(
      "The retention policy sets no counts (last, hourly, daily, weekly, monthly, yearly), " +
        "so nothing will be removed. Set at least one count to enable pruning.",
    );
    const keep = backups.map((backup) => ({
      id: backup.id,
      reasons: ["no retention counts configured"],
    }));
    return { keep, remove: [], warnings };
  }

  const reasons = new KeepReasons();
  const now = input.now.getTime();
  const graceMs = input.policy.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS;

  // Backups that the count rules may choose from: complete and not in the future.
  const candidates: RetentionBackup[] = [];

  for (const backup of backups) {
    const time = backup.completedAt.getTime();

    // Safety rule 3: holds exist precisely to override retention.
    if (backup.held) reasons.add(backup.id, "held");

    // Safety rule 7: the storage itself refuses to delete a locked backup (or, on
    // S3, would only hide it behind a delete marker while still billing it), so
    // planning its removal would only produce failures. Like a hold, this adds a
    // reason but leaves the backup in the count rules below: it is a real backup
    // and may as well fill a "last" or "daily" slot.
    if (isImmutableAt(backup, now)) {
      reasons.add(backup.id, `immutable until ${backup.immutableUntil?.toISOString()}`);
    }

    // A backup without a usable time cannot be placed in any period. Keeping it
    // is the only safe choice; it would otherwise fall through every rule.
    if (Number.isNaN(time)) {
      reasons.add(backup.id, "unknown completion time");
      warnings.push(`Backup ${backup.id} has no valid completion time; it is kept.`);
      continue;
    }

    // Safety rule 6: a backup dated after `now` means a skewed clock somewhere.
    // We cannot reason about its age, so it is kept and left out of the count
    // rules (it must not take a "last" slot from a real backup).
    if (time > now) {
      reasons.add(backup.id, "completed in the future");
      warnings.push(
        `Backup ${backup.id} is dated in the future (${backup.completedAt.toISOString()}); ` +
          "check the clocks of the machines that run backups. It is kept.",
      );
      continue;
    }

    if (backup.status === "complete") {
      candidates.push(backup);
    } else if (backup.status === "invalid") {
      // Safety rule 5b: an invalid backup might be from a newer MongoShield
      // release, or damaged in a way a human can still repair. Deleting it
      // automatically could destroy the only copy of something. Report it instead.
      reasons.add(backup.id, "invalid manifest (never removed automatically)");
      warnings.push(
        `Backup ${backup.id} has an invalid manifest and is never removed automatically. ` +
          "Inspect it and delete it by hand if it is not needed.",
      );
    } else if (now - time < graceMs) {
      // Safety rule 5a: a recent incomplete run may still be writing data. Only
      // once it has been idle longer than the grace period is it known to be dead.
      reasons.add(
        backup.id,
        `incomplete, within the ${formatDuration(graceMs)} grace period (it may still be running)`,
      );
    }
  }

  // Safety rule 2: whatever the counts say, never leave the user without their
  // most recent good backup. With every count >= 1 this is already implied, but
  // the rule makes it hold unconditionally.
  const newest = candidates[0];
  if (newest !== undefined) reasons.add(newest.id, "newest complete backup");

  const last = input.policy.last ?? 0;
  for (const backup of candidates.slice(0, last)) {
    reasons.add(backup.id, `last ${last}`);
  }

  for (const bucket of BUCKETS) {
    const count = input.policy[bucket] ?? 0;
    for (const [id, period] of selectByPeriod(candidates, bucket, count)) {
      reasons.add(id, `${bucket} ${period}`);
    }
  }

  // Safety rule 4: an unverified backup may be unrestorable. Make sure enough
  // verified backups survive, even if they fell out of every bucket.
  keepMinimumVerified(input.backups, candidates, input.policy.minVerified ?? 0, reasons, warnings);

  // Safety rule 8 comes last: whatever kept a backup above, deleting what it depends on
  // would make it unrestorable.
  keepChainParents(backups, reasons);

  return buildPlan(backups, reasons, graceMs, warnings);
}

/**
 * Safety rule 8 (chain integrity): every backup a kept incremental depends on is kept
 * too, transitively, and so is every backup that a backup outside the plan depends on
 * (`neededBy`). A kept backup always has a parent in the same chain, so the walk ends
 * at the chain's full backup.
 */
function keepChainParents(backups: readonly RetentionBackup[], reasons: KeepReasons): void {
  const byId = new Map(backups.map((backup) => [backup.id, backup]));
  for (const backup of backups) {
    if (backup.neededBy !== undefined) {
      reasons.add(backup.id, `needed by incremental ${backup.neededBy} (outside this scope)`);
    }
  }
  // Each pass walks from every kept backup to its parent; parents are older, so a
  // second pass is only needed for unusual clocks. Stops once nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    for (const backup of backups) {
      const parent = backup.parent === undefined ? undefined : byId.get(backup.parent);
      if (parent === undefined || !reasons.has(backup.id) || reasons.has(parent.id)) continue;
      reasons.add(parent.id, `chain of kept incremental ${backup.id}`);
      changed = true;
    }
  }
}

/**
 * The GFS bucket walk (restic/borg semantics): going from newest to oldest, keep
 * a backup whenever its period differs from the previously kept one, until
 * `count` periods are covered. Because `candidates` is sorted newest first and
 * periods are contiguous in that order, the backup kept for each period is the
 * newest one in it.
 *
 * @returns backup id → period label, for the kept backups.
 */
export function selectByPeriod(
  candidates: readonly RetentionBackup[],
  bucket: RetentionBucket,
  count: number,
): Map<string, string> {
  const selected = new Map<string, string>();
  let previousPeriod: string | undefined;

  for (const backup of candidates) {
    if (selected.size >= count) break;
    const period = periodOf(bucket, backup.completedAt);
    if (period !== previousPeriod) {
      selected.set(backup.id, period);
      previousPeriod = period;
    }
  }
  return selected;
}

/**
 * The calendar period (UTC) a moment falls in, as a sortable label:
 * `2026-10-20T13`, `2026-10-20`, `2026-W43`, `2026-10` or `2026`.
 */
export function periodOf(bucket: RetentionBucket, date: Date): string {
  const iso = date.toISOString(); // "2026-10-20T13:45:00.000Z", always UTC
  switch (bucket) {
    case "hourly":
      return iso.slice(0, 13);
    case "daily":
      return iso.slice(0, 10);
    case "weekly": {
      const { year, week } = isoWeekOf(date);
      return `${year}-W${String(week).padStart(2, "0")}`;
    }
    case "monthly":
      return iso.slice(0, 7);
    case "yearly":
      return iso.slice(0, 4);
  }
}

/**
 * ISO 8601 week number and week-year of a moment (in UTC).
 *
 * ISO weeks start on Monday, and week 1 is the week containing the year's first
 * Thursday. So every week belongs to the year its Thursday falls in: Monday
 * 2024-12-30 is in 2025-W01, and Friday 2027-01-01 is in 2026-W53.
 */
export function isoWeekOf(date: Date): { year: number; week: number } {
  // Days since Monday: getUTCDay() is 0 for Sunday, so shift it to Monday = 0.
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const thursday = new Date(midnight + (3 - daysSinceMonday) * MS_PER_DAY);

  const year = thursday.getUTCFullYear();
  // The Thursday of week 1 lies within 1–7 January, so (day of year / 7) + 1 is the week.
  const dayOfYear = Math.round((thursday.getTime() - Date.UTC(year, 0, 1)) / MS_PER_DAY);
  return { year, week: Math.floor(dayOfYear / 7) + 1 };
}

/** True while `backup` is under write-once retention at time `now` (ms since the epoch). */
function isImmutableAt(backup: RetentionBackup, now: number): boolean {
  const until = backup.immutableUntil?.getTime();
  return until !== undefined && !Number.isNaN(until) && until > now;
}

/** True if the policy asks to keep at least one backup through a count rule. */
export function hasAnyCount(policy: RetentionPolicy): boolean {
  // Explicit zeros count as "not set": `{ last: 0 }` alone would otherwise ask
  // to delete everything but the newest backup, which is never what people mean.
  return COUNT_FIELDS.some((field) => (policy[field] ?? 0) > 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collects keep reasons per backup id, without duplicates. */
class KeepReasons {
  private readonly byId = new Map<string, string[]>();

  add(id: string, reason: string): void {
    const existing = this.byId.get(id);
    if (existing === undefined) {
      this.byId.set(id, [reason]);
    } else if (!existing.includes(reason)) {
      existing.push(reason);
    }
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): string[] | undefined {
    return this.byId.get(id);
  }
}

/** Adds the newest verified candidates until `minVerified` verified backups are kept. */
function keepMinimumVerified(
  allBackups: readonly RetentionBackup[],
  candidates: readonly RetentionBackup[],
  minVerified: number,
  reasons: KeepReasons,
  warnings: string[],
): void {
  if (minVerified <= 0) return;

  // Count verified complete backups that are already kept for other reasons
  // (including held or future-dated ones).
  let verifiedKept = allBackups.filter(
    (backup) => backup.status === "complete" && backup.verified && reasons.has(backup.id),
  ).length;

  for (const backup of candidates) {
    if (verifiedKept >= minVerified) break;
    if (backup.verified && !reasons.has(backup.id)) {
      reasons.add(backup.id, `min verified ${minVerified}`);
      verifiedKept++;
    }
  }

  if (verifiedKept < minVerified) {
    warnings.push(
      `Only ${verifiedKept} verified backup(s) exist, fewer than minVerified (${minVerified}). ` +
        "Run `mongoshield verify` on recent backups.",
    );
  }
}

/** Splits the backups into the final keep and remove lists. */
function buildPlan(
  backups: readonly RetentionBackup[],
  reasons: KeepReasons,
  graceMs: number,
  warnings: string[],
): RetentionPlan {
  const keep: KeptBackup[] = [];
  const remove: RemovedBackup[] = [];

  for (const backup of backups) {
    const keptFor = reasons.get(backup.id);
    if (keptFor !== undefined) {
      keep.push({ id: backup.id, reasons: keptFor });
    } else if (backup.status === "incomplete") {
      remove.push({
        id: backup.id,
        reason: `incomplete run idle for longer than the ${formatDuration(graceMs)} grace period`,
      });
    } else {
      // Only complete backups reach this point: invalid ones were always given a
      // keep reason above.
      remove.push({ id: backup.id, reason: "not selected by any retention rule" });
    }
  }
  return { keep, remove, warnings };
}

/** Newest first by time, then by id, so the order (and the plan) is deterministic. */
function sortNewestFirst(backups: readonly RetentionBackup[]): RetentionBackup[] {
  const seen = new Set<string>();
  for (const backup of backups) {
    // Duplicate ids would make keep/remove ambiguous for the same directory.
    if (seen.has(backup.id)) {
      throw new MongoShieldError("MS_INTERNAL", `Backup ${backup.id} was listed twice.`);
    }
    seen.add(backup.id);
  }

  return [...backups].sort((a, b) => {
    const byTime = timeOrZero(b) - timeOrZero(a);
    if (byTime !== 0) return byTime;
    if (a.id === b.id) return 0;
    return b.id < a.id ? -1 : 1;
  });
}

/** Sort key for a backup; invalid dates sort as the oldest. */
function timeOrZero(backup: RetentionBackup): number {
  const time = backup.completedAt.getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** Rejects counts that are negative, fractional or not numbers at all. */
function validatePolicy(policy: RetentionPolicy): void {
  for (const field of [...COUNT_FIELDS, "minVerified", "incompleteGraceMs"] as const) {
    const value = policy[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `Retention option "${field}" must be a non-negative integer, got ${String(value)}.`,
      );
    }
  }
}

/** 86_400_000 → "24h", 90_000 → "1.5m". Only used in human-readable reasons. */
function formatDuration(ms: number): string {
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}
