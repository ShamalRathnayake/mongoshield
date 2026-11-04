/**
 * Planning a point-in-time restore (docs/specs/JOURNAL.md, "Restore to a point in time"):
 *
 *   1. the newest complete base backup whose cluster time is at or before `at` and that
 *      suits the restore: it covers every selected namespace, has no query filter on
 *      them, and comes from the journal's deployment (base-suitability.ts);
 *   2. a covered journal range from that time through `at`, with no gap;
 *   3. the segments holding the events in `(base time, at]`.
 *
 * Only names, manifests and small records are read, so planning is quick and needs no
 * key. The events themselves are checked by `preflightJournal` (replay.ts) before the
 * base restore writes anything.
 *
 * Deployments: the journal does not record which deployment it follows. With a
 * `clusterId` (the source's identity) only that deployment's bases qualify. Without
 * one, each base is judged against its own deployment's backups, and the newest
 * suitable one at or before `at` decides; a plan warning says so when bases of other
 * deployments lie in the journal range it uses. One plan never mixes deployments: its
 * base is one backup, judged against its own deployment's namespaces only.
 *
 * A base backup is any complete backup with a cluster time: `consistency.to` for
 * `converge` (the state at the end of its window), `consistency.from` for `snapshot`.
 * Backups made with consistency `none` mix moments and cannot be a base. Incremental
 * backups are not bases either: the journal is replayed onto full backups, and a time
 * an incremental chain covers is restored through the chain (src/shield.ts).
 */

import { type CatalogEntry, listBackups } from "../catalog/catalog.ts";
import { compareClusterTimes, formatClusterTime } from "../engine/converge-time.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { type ClusterTime, isIncrementalManifest, type Manifest } from "../format/manifest.ts";
import { sameDeployment } from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";
import {
  type BaseRequest,
  type CompiledBaseRequest,
  compileBaseRequest,
  whyNotBase,
} from "./base-suitability.ts";
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
  /**
   * The deployment the base backup was taken from, when its manifest records one. Pass
   * it as the `clusterId` / `instanceId` of a later plan to get the same base.
   */
  readonly baseDeployment?: { readonly clusterId: string; readonly instanceId?: string };
  /** The base backup's namespaces (for `replayJournal`'s `baseNamespaces`). */
  readonly baseNamespaces: readonly string[];
  /**
   * The include/exclude selection the base backup was taken with (for `replayJournal`'s
   * `baseSelection`), when its manifest records one.
   */
  readonly baseSelection?: {
    readonly include: readonly string[];
    readonly exclude: readonly string[];
  };
  /**
   * Things the caller should hear about, e.g. that the base was picked among bases of
   * several deployments without a `clusterId` to say which.
   */
  readonly warnings: readonly string[];
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
  return basesOf(entries);
}

/** The base backups among catalog entries, newest cluster time first. */
function basesOf(entries: readonly CatalogEntry[]): BaseBackup[] {
  const bases: BaseBackup[] = [];
  for (const entry of entries) {
    const manifest = entry.manifest;
    if (entry.status !== "complete" || manifest === undefined) continue;
    // Incrementals hold changes, not data (see the file header).
    if (isIncrementalManifest(manifest)) continue;
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

/** Options for {@link planPointInTimeRestore}. */
export interface PlanPointInTimeOptions extends BaseRequest {
  readonly signal?: AbortSignal | undefined;
}

/** A base backup passed over, and why (for the error when none is left). */
interface SkippedBase {
  readonly id: string;
  readonly reason: string;
}

/**
 * Plans a restore to `at` (a `Date` is rounded down to its second; see time.ts).
 *
 * The base is the newest SUITABLE base backup at or before `at`: one that covers every
 * namespace the restore selects (`include` / `exclude`), was not filtered with a query
 * for any of them, and comes from the same deployment (base-suitability.ts). Newer but
 * unsuitable bases are passed over; when none is suitable, the restore is refused.
 * Without `clusterId`, see the file header ("Deployments").
 *
 * @throws MongoShieldError `MS_CHANGE_HISTORY_LOST` when no suitable base backup plus
 *   journal reaches `at`; the message and `details.recoverableRanges` list what can be
 *   restored, and `details.skippedBases` the bases passed over and why.
 *   `MS_CONFIG_INVALID` for malformed include/exclude patterns.
 */
export async function planPointInTimeRestore(
  storage: StorageAdapter,
  at: Date | ClusterTime,
  options: PlanPointInTimeOptions = {},
): Promise<PointInTimePlan> {
  const target = toJournalTime(at);
  const entries = await listBackups(
    storage,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  const requestFor = baseRequests(options, entries);
  const bases = basesOf(entries);
  throwIfAborted(options.signal);
  const coverage = await loadJournalCoverage(storage, options.signal);

  // Newest first: the first suitable base at or before `at` is the one to use.
  const skipped: SkippedBase[] = [];
  const suitable: BaseBackup[] = [];
  for (const candidate of bases) {
    const reason = whyNotBase(candidate.manifest, requestFor(candidate.manifest));
    if (reason === undefined) suitable.push(candidate);
    else if (!isAfter(candidate.clusterTime, target)) skipped.push({ id: candidate.id, reason });
  }
  const base = suitable.find((candidate) => !isAfter(candidate.clusterTime, target));
  const range =
    base === undefined ? undefined : coveringRange(coverage.ranges, base.clusterTime, target);
  if (base === undefined || range === undefined) {
    throw notRecoverable(target, suitable, coverage.ranges, skipped);
  }
  const warnings =
    options.clusterId === undefined ? deploymentWarnings(base, suitable, range.from, target) : [];

  const segments = segmentsBetween(coverage.segments, base.clusterTime, target);
  const bytes = segments.reduce((total, segment) => total + segment.size, 0);
  const totals = coverage.state?.totals;
  const estimatedEvents =
    totals === undefined || totals.bytes === 0
      ? undefined
      : Math.round((bytes * totals.events) / totals.bytes);
  const { clusterId, instanceId } = base.manifest.source;
  return {
    at: target,
    baseBackupId: base.id,
    baseTime: base.clusterTime,
    ...(clusterId === undefined
      ? {}
      : { baseDeployment: instanceId === undefined ? { clusterId } : { clusterId, instanceId } }),
    baseNamespaces: base.manifest.namespaces.map((entry) => entry.ns),
    ...(base.manifest.selection === undefined
      ? {}
      : {
          baseSelection: {
            include: base.manifest.selection.include,
            exclude: base.manifest.selection.exclude,
          },
        }),
    warnings,
    segments,
    bytes,
    estimatedEvents,
  };
}

/**
 * The compiled request each candidate base is judged by. With `clusterId`, one
 * request for every candidate. Without it, each candidate is judged against its own
 * deployment (see the file header): another deployment's collections must not make a
 * base look incomplete. Compiled once per deployment.
 */
function baseRequests(
  options: PlanPointInTimeOptions,
  entries: readonly CatalogEntry[],
): (manifest: Manifest) => CompiledBaseRequest {
  if (options.clusterId !== undefined) {
    const pinned = compileBaseRequest(options, entries);
    return () => pinned;
  }
  const compiled = new Map<string, CompiledBaseRequest>();
  return (manifest) => {
    const { clusterId, instanceId } = manifest.source;
    const key = `${clusterId ?? ""}/${instanceId ?? ""}`;
    let request = compiled.get(key);
    if (request === undefined) {
      request = compileBaseRequest(
        { include: options.include, exclude: options.exclude, clusterId, instanceId },
        entries,
      );
      compiled.set(key, request);
    }
    return request;
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

/**
 * Says so when the base was picked without a `clusterId` while suitable bases of other
 * deployments lie within the journal range the restore uses (staging and production
 * writing to one bucket): the journal does not record which deployment it follows, so
 * the newest base before `at` decided. Bases that record no deployment are not counted.
 */
function deploymentWarnings(
  base: BaseBackup,
  suitable: readonly BaseBackup[],
  from: ClusterTime,
  to: ClusterTime,
): string[] {
  const others = new Set<string>();
  for (const candidate of suitable) {
    if (isAfter(from, candidate.clusterTime) || isAfter(candidate.clusterTime, to)) continue;
    const source = candidate.manifest.source;
    if (source.clusterId === undefined || sameDeployment(source, base.manifest.source)) continue;
    others.add(
      source.instanceId === undefined
        ? source.clusterId
        : `${source.clusterId} (instance ${source.instanceId})`,
    );
  }
  if (others.size === 0) return [];
  const chosen = base.manifest.source.clusterId ?? "a deployment it does not record";
  return [
    `The storage location holds base backups of other deployments (${[...others].join(", ")}) in the time the journal covers, and the journal does not record which one it follows. Using ${base.id} of ${chosen}, the newest suitable base at or before ${describeTime(to)}. Pass the source's identity (\`shield.sourceIdentity()\`, or --source-cluster on the CLI) to choose, and keep each deployment under its own storage prefix.`,
  ];
}

function notRecoverable(
  at: ClusterTime,
  bases: readonly BaseBackup[],
  ranges: readonly CoveredRange[],
  skipped: readonly SkippedBase[],
): MongoShieldError {
  const recoverable = recoverableRanges(bases, ranges);
  const listed =
    recoverable.length === 0
      ? "nothing (no base backup with a cluster time)"
      : recoverable.map((range) => `\n  ${describeRange(range)}`).join("");
  const reason =
    bases.length === 0
      ? skipped.length === 0
        ? "there is no base backup (a converge or snapshot backup)"
        : "no base backup suits this restore"
      : bases.every((base) => isAfter(base.clusterTime, at))
        ? skipped.length === 0
          ? "every base backup is newer than that"
          : "every suitable base backup is newer than that"
        : "the journal does not cover the time from the newest earlier base backup to that point";
  const passedOver = skipped
    .slice(0, 5)
    .map((base) => `\n  ${base.id}: ${base.reason}`)
    .join("");
  const skippedText =
    skipped.length === 0
      ? ""
      : `\nBase backups passed over:${passedOver}${skipped.length > 5 ? `\n  … and ${skipped.length - 5} more` : ""}`;
  return new MongoShieldError(
    "MS_CHANGE_HISTORY_LOST",
    `Cannot restore to ${describeTime(at)}: ${reason}. Recoverable: ${listed}${skippedText}`,
    {
      hint:
        skipped.length === 0
          ? "Pick a time inside a recoverable range. `mongoshield journal status` shows the covered ranges and gaps."
          : "Pick a time inside a recoverable range, or narrow the restore (include/exclude) to what a passed-over base covers. A base must hold every namespace the restore selects, without a query filter.",
      details: {
        recoverableRanges: recoverable,
        ...(skipped.length === 0 ? {} : { skippedBases: skipped }),
      },
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
