/**
 * Backup chains: a full backup followed by incremental backups, each holding only the
 * changes since the one before it (docs/specs/FORMAT.md, "Incremental backups").
 *
 *   full (base) ──▶ inc 1 ──▶ inc 2 ──▶ inc 3
 *   consistency.to   from = base.to   from = inc1.to   from = inc2.to
 *                    to = T1          to = T2          to = T3
 *
 * Restoring `inc 3` means: restore the base, then replay inc 1, inc 2 and inc 3 in
 * order. That only works when every link holds: each parent exists and is complete,
 * the times line up exactly (a child starts where its parent ends, so no change is
 * missed or replayed twice), every member names the same base and comes from the same
 * deployment, and the positions count up by one.
 *
 * Everything here is pure (no I/O): it works on the catalog listing that every caller
 * already has, so restore, verify, prune, list and replicate all judge a chain the
 * same way, and every rule is unit-tested.
 */

import { compareClusterTimes, formatClusterTime } from "../engine/converge-time.ts";
import { MongoShieldError } from "../errors.ts";
import {
  type ClusterTime,
  type IncrementalManifest,
  isIncrementalManifest,
  type Manifest,
} from "../format/manifest.ts";
import type { CatalogEntry } from "./catalog.ts";

/** A chain resolved from its newest member back to its base full backup. */
export interface ResolvedChain {
  /** The full backup the chain starts from. */
  readonly base: Manifest;
  /** The incremental backups after the base, oldest first, up to the requested one. */
  readonly incrementals: readonly IncrementalManifest[];
}

/** Why a chain cannot be used: which member is affected, what is wrong, and how bad. */
export interface ChainProblem {
  /** The backup whose link is broken (the child whose parent is missing or wrong). */
  readonly backupId: string;
  readonly problem: string;
  /** `missing`: a member is gone or incomplete; `mismatch`: the links do not line up. */
  readonly kind: "missing" | "mismatch";
}

/** What {@link inspectChain} found: the chain as far as it could be followed, and its problems. */
export interface ChainInspection {
  /** Set when the whole chain could be resolved without a problem. */
  readonly chain: ResolvedChain | undefined;
  /** Every member reached, newest first (the requested backup first). */
  readonly members: readonly Manifest[];
  readonly problems: readonly ChainProblem[];
}

/** "full" or "incremental", for listings. Manifests without `kind` are full backups. */
export function backupKindOf(manifest: Manifest): "full" | "incremental" {
  return isIncrementalManifest(manifest) ? "incremental" : "full";
}

/** How many incrementals separate this backup from its base: 0 for a full backup. */
export function chainPositionOf(manifest: Manifest): number {
  return isIncrementalManifest(manifest) ? manifest.chain.length : 0;
}

/**
 * The cluster time a chain continuing from this backup starts after: the time the
 * backup's data is exact at. `converge` backups (and incrementals) are exact at the end
 * of their window (`consistency.to`), `snapshot` backups at their read time. Backups
 * taken with consistency `none` mix moments and cannot start a chain (`undefined`).
 */
export function chainEndTime(manifest: Manifest): ClusterTime | undefined {
  const { consistency } = manifest;
  if (consistency.mode === "converge") return consistency.to;
  if (consistency.mode === "snapshot") return consistency.to ?? consistency.from;
  return undefined;
}

/**
 * Follows `manifest` back to its base and reports every problem on the way, without
 * throwing (verify lists them all). A full backup is a chain of one.
 */
export function inspectChain(
  entries: readonly CatalogEntry[],
  manifest: Manifest,
): ChainInspection {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const members: Manifest[] = [manifest];
  const problems: ChainProblem[] = [];
  const visited = new Set<string>([manifest.id]);

  let current = manifest;
  while (isIncrementalManifest(current)) {
    const parentId = current.chain.parent;
    if (visited.has(parentId)) {
      // Only a hand-edited manifest can point back into its own chain.
      problems.push(mismatch(current, `its parent ${parentId} is already part of this chain`));
      break;
    }
    const parent = parentOf(byId.get(parentId), current, problems);
    if (parent === undefined) break;
    problems.push(...linkProblems(current, parent));
    visited.add(parent.id);
    members.push(parent);
    current = parent;
  }

  const [base, ...newerFirst] = [...members].reverse();
  const chain =
    problems.length === 0 && base !== undefined && !isIncrementalManifest(base)
      ? { base, incrementals: newerFirst.filter(isIncrementalManifest) }
      : undefined;
  return { chain, members, problems };
}

/**
 * Resolves the chain of `manifest`: its base full backup and every incremental up to
 * it, oldest first. A full backup resolves to itself with no incrementals.
 *
 * @throws MongoShieldError `MS_BACKUP_NOT_FOUND` when a member is missing or
 *   incomplete, `MS_INTEGRITY_FAILED` when the links do not line up (see the file
 *   header), both naming the broken link.
 */
export function resolveChain(entries: readonly CatalogEntry[], manifest: Manifest): ResolvedChain {
  const inspection = inspectChain(entries, manifest);
  if (inspection.chain !== undefined) return inspection.chain;
  throw chainError(manifest, inspection.problems);
}

/**
 * The ids of every backup `id` depends on, nearest parent first (empty for a full
 * backup). Best effort: stops at the first missing or unreadable member, because
 * callers (prune, replicate) only need what exists.
 */
export function chainAncestorIds(entries: readonly CatalogEntry[], id: string): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const ancestors: string[] = [];
  const seen = new Set<string>([id]);
  let manifest = byId.get(id)?.manifest;
  while (manifest !== undefined && isIncrementalManifest(manifest)) {
    const parentId = manifest.chain.parent;
    if (seen.has(parentId)) break;
    seen.add(parentId);
    ancestors.push(parentId);
    manifest = byId.get(parentId)?.manifest;
  }
  return ancestors;
}

/**
 * Restricts a resolved chain to what a restore "as of `at`" needs: the base and the
 * incrementals up to the first one whose window reaches `at`.
 *
 * @throws MongoShieldError `MS_CHANGE_HISTORY_LOST` when `at` lies outside the chain
 *   (before the base is exact, or after its newest member), naming what is reachable.
 */
export function chainUntil(chain: ResolvedChain, at: ClusterTime): ResolvedChain {
  const start = chainEndTime(chain.base);
  const newest = chain.incrementals.at(-1);
  const end = newest === undefined ? start : newest.consistency.to;
  if (start === undefined || end === undefined) {
    throw new MongoShieldError(
      "MS_INTERNAL",
      `Backup ${chain.base.id} has no end time but starts a chain.`,
    );
  }
  if (compareClusterTimes(at, start) < 0 || compareClusterTimes(at, end) > 0) {
    throw new MongoShieldError(
      "MS_CHANGE_HISTORY_LOST",
      `The chain of ${newest?.id ?? chain.base.id} cannot restore to ${formatClusterTime(at)}: it covers ${formatClusterTime(start)} (base ${chain.base.id}) to ${formatClusterTime(end)}.`,
      {
        hint: "Pick a time inside that range, or restore a different backup.",
        details: { recoverableRanges: [{ from: start, to: end }] },
      },
    );
  }
  const needed: IncrementalManifest[] = [];
  for (const incremental of chain.incrementals) {
    // The incremental holds (from, to]: it is needed when `at` is after its start.
    if (compareClusterTimes(at, incremental.consistency.from ?? start) <= 0) break;
    needed.push(incremental);
  }
  return { base: chain.base, incrementals: needed };
}

/** A stretch of cluster time one chain can restore to (any time within it). */
export interface ChainRange {
  /** The newest incremental of the chain, the one to restore. */
  readonly backupId: string;
  readonly baseBackupId: string;
  readonly from: ClusterTime;
  readonly to: ClusterTime;
}

/**
 * The time range every intact chain covers, one per chain tip (an incremental that no
 * other incremental continues), oldest first. Broken chains are left out.
 */
export function chainRanges(entries: readonly CatalogEntry[]): ChainRange[] {
  const continued = new Set<string>();
  const incrementals: IncrementalManifest[] = [];
  for (const entry of entries) {
    const manifest = entry.manifest;
    if (entry.status !== "complete" || manifest === undefined) continue;
    if (!isIncrementalManifest(manifest)) continue;
    incrementals.push(manifest);
    continued.add(manifest.chain.parent);
  }
  const ranges: ChainRange[] = [];
  for (const tip of incrementals) {
    if (continued.has(tip.id)) continue;
    const inspection = inspectChain(entries, tip);
    const from = inspection.chain === undefined ? undefined : chainEndTime(inspection.chain.base);
    if (inspection.chain === undefined || from === undefined) continue;
    ranges.push({
      backupId: tip.id,
      baseBackupId: tip.chain.base,
      from,
      to: tip.consistency.to ?? from,
    });
  }
  return ranges.sort((a, b) => compareClusterTimes(a.from, b.from));
}

/**
 * The incremental to restore for "the data as of `at`" from an intact chain: the
 * oldest incremental whose window reaches `at` in a chain that starts at or before it.
 * `undefined` when no chain covers `at`.
 */
export function findChainCovering(
  entries: readonly CatalogEntry[],
  at: ClusterTime,
): IncrementalManifest | undefined {
  let best: IncrementalManifest | undefined;
  for (const entry of entries) {
    const manifest = entry.manifest;
    if (entry.status !== "complete" || manifest === undefined) continue;
    if (!isIncrementalManifest(manifest)) continue;
    const { from, to } = manifest.consistency;
    // The window is (from, to]; the chain also covers its base's end time itself.
    if (to === undefined || from === undefined || compareClusterTimes(at, to) > 0) continue;
    if (best !== undefined && compareClusterTimes(to, best.consistency.to ?? to) >= 0) continue;
    const chain = inspectChain(entries, manifest).chain;
    const start = chain === undefined ? undefined : chainEndTime(chain.base);
    if (start === undefined || compareClusterTimes(start, at) > 0) continue;
    best = manifest;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** The parent's manifest, or `undefined` with the reason recorded. */
function parentOf(
  entry: CatalogEntry | undefined,
  child: IncrementalManifest,
  problems: ChainProblem[],
): Manifest | undefined {
  const parentId = child.chain.parent;
  if (entry === undefined) {
    problems.push(
      missing(child, `its parent ${parentId} does not exist (deleted or never copied)`),
    );
    return undefined;
  }
  if (entry.status === "incomplete" || entry.manifest === undefined) {
    const why =
      entry.status === "invalid"
        ? `has an unusable manifest: ${entry.error ?? "unknown reason"}`
        : "is incomplete (it has no manifest)";
    problems.push(missing(child, `its parent ${parentId} ${why}`));
    return undefined;
  }
  return entry.manifest;
}

/** Everything that must agree between a child and its parent (see the file header). */
function linkProblems(child: IncrementalManifest, parent: Manifest): ChainProblem[] {
  const problems: ChainProblem[] = [];
  const parentEnd = chainEndTime(parent);
  const childStart = child.consistency.from;
  if (parentEnd === undefined) {
    problems.push(
      mismatch(
        child,
        `its parent ${parent.id} has no exact end time (consistency "${parent.consistency.mode}")`,
      ),
    );
  } else if (childStart === undefined || compareClusterTimes(childStart, parentEnd) !== 0) {
    problems.push(
      mismatch(
        child,
        `it starts at ${childStart === undefined ? "an unknown time" : formatClusterTime(childStart)}, but its parent ${parent.id} ends at ${formatClusterTime(parentEnd)}`,
      ),
    );
  }

  const expectedBase = isIncrementalManifest(parent) ? parent.chain.base : parent.id;
  if (child.chain.base !== expectedBase) {
    problems.push(
      mismatch(
        child,
        `it names base ${child.chain.base}, but its parent's base is ${expectedBase}`,
      ),
    );
  }
  const expectedLength = isIncrementalManifest(parent) ? parent.chain.length + 1 : 1;
  if (child.chain.length !== expectedLength) {
    problems.push(
      mismatch(
        child,
        `it is recorded as incremental #${child.chain.length}, but follows #${expectedLength - 1}`,
      ),
    );
  }
  const childCluster = child.source.clusterId;
  const parentCluster = parent.source.clusterId;
  if (childCluster === undefined || parentCluster === undefined || childCluster !== parentCluster) {
    problems.push(
      mismatch(child, `its parent ${parent.id} was taken from a different (or unknown) deployment`),
    );
  }
  return problems;
}

function missing(child: Manifest, problem: string): ChainProblem {
  return { backupId: child.id, problem, kind: "missing" };
}

function mismatch(child: Manifest, problem: string): ChainProblem {
  return { backupId: child.id, problem, kind: "mismatch" };
}

/** The error for an unusable chain: the first problem, with all of them in `details`. */
function chainError(manifest: Manifest, problems: readonly ChainProblem[]): MongoShieldError {
  const first = problems[0];
  const description =
    first === undefined
      ? "it does not lead back to a full backup"
      : `${first.backupId}: ${first.problem}`;
  return new MongoShieldError(
    first?.kind === "missing" ? "MS_BACKUP_NOT_FOUND" : "MS_INTEGRITY_FAILED",
    `The chain of incremental backup ${manifest.id} is broken (${description}).`,
    {
      hint: "An incremental backup can only be restored together with every backup before it. Restore an earlier backup of the chain (or its base), copy the missing backup back, or take a new full backup.",
      details: { chainProblems: problems },
    },
  );
}
