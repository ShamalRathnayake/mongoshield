/**
 * Planning a point-in-time restore (docs/specs/JOURNAL.md, "Restore to a point in time"):
 *
 *   1. the newest complete base backup whose cluster time is at or before `at`;
 *   2. a covered journal range from that time through `at`, with no gap;
 *   3. the segments holding the events in `(base time, at]`.
 *
 * Only names, manifests and small records are read, so planning is quick and needs no
 * key. The segment chain itself is verified by `replayJournal` before it writes
 * anything.
 *
 * A base backup is any complete backup with a cluster time: `consistency.to` for
 * `converge` (the state at the end of its window), `consistency.from` for `snapshot`.
 * Backups made with consistency `none` mix moments and cannot be a base.
 */

import { listBackups } from "../catalog/catalog.ts";
import { compareClusterTimes, formatClusterTime } from "../engine/converge-time.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { ClusterTime, Manifest } from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";
import {
  type CoveredRange,
  type JournalSegment,
  loadJournalCoverage,
  rangeCovering,
  segmentsBetween,
} from "./coverage.ts";
import { dateOfClusterTime, isAfter, toJournalTime } from "./time.ts";

/** A backup a point-in-time restore can start from. */
export interface BaseBackup {
  readonly id: string;
  /** The cluster time the backup's data is consistent at. */
  readonly clusterTime: ClusterTime;
  readonly completedAt: Date;
  readonly manifest: Manifest;
}

/** A point-in-time restore: what to restore and which journal segments to replay. */
export interface PointInTimePlan {
  /** The cluster time the restore will reach (a `Date` rounded down, see time.ts). */
  readonly at: ClusterTime;
  readonly baseBackupId: string;
  readonly baseTime: ClusterTime;
  /** The base backup's namespaces (for `replayJournal`'s `baseNamespaces`). */
  readonly baseNamespaces: readonly string[];
  /** Segments holding the events in `(baseTime, at]`, oldest first. */
  readonly segments: readonly JournalSegment[];
  /** Stored size of those segments. */
  readonly bytes: number;
  /**
   * Roughly how many events will be replayed, from the journal's average stored bytes
   * per event (`undefined` before the journal has any events). Segments are not
   * opened while planning, so this is an estimate.
   */
  readonly estimatedEvents: number | undefined;
}

/** A stretch of time that can be restored to (any cluster time within it). */
export interface RecoverableRange {
  readonly from: ClusterTime;
  readonly to: ClusterTime;
}

/**
 * Every complete backup usable as a base, newest cluster time first.
 *
 * @throws MongoShieldError from storage.
 */
export async function listBaseBackups(
  storage: StorageAdapter,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<BaseBackup[]> {
  const entries = await listBackups(
    storage,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  const bases: BaseBackup[] = [];
  for (const entry of entries) {
    const manifest = entry.manifest;
    if (entry.status !== "complete" || manifest === undefined) continue;
    const clusterTime = baseTimeOf(manifest);
    if (clusterTime === undefined) continue;
    bases.push({
      id: entry.id,
      clusterTime,
      completedAt: new Date(manifest.completedAt),
      manifest,
    });
  }
  return bases.sort((a, b) => compareClusterTimes(b.clusterTime, a.clusterTime));
}

/** The cluster time a backup is consistent at, or `undefined` if it has none. */
export function baseTimeOf(manifest: Manifest): ClusterTime | undefined {
  const { consistency } = manifest;
  if (consistency.mode === "converge") return consistency.to;
  if (consistency.mode === "snapshot") return consistency.from;
  return undefined;
}

/**
 * Plans a restore to `at` (a `Date` is rounded down to its second; see time.ts).
 *
 * @throws MongoShieldError `MS_CHANGE_HISTORY_LOST` when no base backup plus journal
 *   reaches `at`; the message and `details.recoverableRanges` list what can be restored.
 */
export async function planPointInTimeRestore(
  storage: StorageAdapter,
  at: Date | ClusterTime,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<PointInTimePlan> {
  const target = toJournalTime(at);
  const bases = await listBaseBackups(storage, options);
  throwIfAborted(options.signal);
  const coverage = await loadJournalCoverage(storage, options.signal);

  const base = bases.find((candidate) => !isAfter(candidate.clusterTime, target));
  const range =
    base === undefined ? undefined : coveringRange(coverage.ranges, base.clusterTime, target);
  if (base === undefined || range === undefined) {
    throw notRecoverable(target, bases, coverage.ranges);
  }

  const segments = segmentsBetween(coverage.segments, base.clusterTime, target);
  const bytes = segments.reduce((total, segment) => total + segment.size, 0);
  const totals = coverage.state?.totals;
  const estimatedEvents =
    totals === undefined || totals.bytes === 0
      ? undefined
      : Math.round((bytes * totals.events) / totals.bytes);
  return {
    at: target,
    baseBackupId: base.id,
    baseTime: base.clusterTime,
    baseNamespaces: base.manifest.namespaces.map((entry) => entry.ns),
    segments,
    bytes,
    estimatedEvents,
  };
}

/**
 * The covered range that reaches from `from` through `to`, or a trivial one when they
 * are equal (restoring exactly to a base backup needs no journal).
 */
function coveringRange(
  ranges: readonly CoveredRange[],
  from: ClusterTime,
  to: ClusterTime,
): CoveredRange | RecoverableRange | undefined {
  if (compareClusterTimes(from, to) === 0) return { from, to };
  return rangeCovering(ranges, from, to);
}

/**
 * What can be restored: within each covered range, from its oldest base backup to its
 * end; and every base backup on its own (restoring exactly to it needs no journal).
 */
export function recoverableRanges(
  bases: readonly BaseBackup[],
  ranges: readonly CoveredRange[],
): RecoverableRange[] {
  const recoverable: RecoverableRange[] = [];
  const covered = new Set<string>();
  for (const range of ranges) {
    const inside = bases.filter(
      (base) => !isAfter(range.from, base.clusterTime) && !isAfter(base.clusterTime, range.to),
    );
    const oldest = inside.at(-1);
    if (oldest === undefined) continue;
    recoverable.push({ from: oldest.clusterTime, to: range.to });
    for (const base of inside) covered.add(base.id);
  }
  for (const base of bases) {
    if (!covered.has(base.id)) recoverable.push({ from: base.clusterTime, to: base.clusterTime });
  }
  return recoverable.sort((a, b) => compareClusterTimes(a.from, b.from));
}

function notRecoverable(
  at: ClusterTime,
  bases: readonly BaseBackup[],
  ranges: readonly CoveredRange[],
): MongoShieldError {
  const recoverable = recoverableRanges(bases, ranges);
  const listed =
    recoverable.length === 0
      ? "nothing (no base backup with a cluster time)"
      : recoverable.map((range) => `\n  ${describeRange(range)}`).join("");
  const reason =
    bases.length === 0
      ? "there is no base backup (a converge or snapshot backup)"
      : bases.every((base) => isAfter(base.clusterTime, at))
        ? "every base backup is newer than that"
        : "the journal does not cover the time from the newest earlier base backup to that point";
  return new MongoShieldError(
    "MS_CHANGE_HISTORY_LOST",
    `Cannot restore to ${describeTime(at)}: ${reason}. Recoverable: ${listed}`,
    {
      hint: "Pick a time inside a recoverable range. `mongoshield journal status` shows the covered ranges and gaps.",
      details: { recoverableRanges: recoverable },
    },
  );
}

function describeRange(range: RecoverableRange): string {
  if (compareClusterTimes(range.from, range.to) === 0)
    return `${describeTime(range.from)} (a base backup)`;
  return `${describeTime(range.from)} → ${describeTime(range.to)}`;
}

/** `2026-11-14T03:17:42Z (1763090262:5)`. */
export function describeTime(time: ClusterTime): string {
  return `${dateOfClusterTime(time).toISOString().replace(".000Z", "Z")} (${formatClusterTime(time)})`;
}
