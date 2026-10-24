/**
 * `journalStatus`: what the journal covers and how far behind it is, from names and
 * small records only (no key needed, no segment opened). Backs `mongoshield journal
 * status` and RPO monitoring.
 */

import type { ClusterTime } from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { type CoveredRange, loadJournalCoverage } from "./coverage.ts";
import type { GapRecord } from "./records.ts";
import { dateOfClusterTime } from "./time.ts";

/** The state of the journal in a storage location. */
export interface JournalStatus {
  /** Every change up to and including this cluster time is journaled; `undefined` when empty. */
  readonly recoveryPoint: ClusterTime | undefined;
  /** The recovery point's wall-clock second. */
  readonly recoveryPointDate: Date | undefined;
  /** How far the recovery point is behind `now`, in milliseconds. */
  readonly rpoMs: number | undefined;
  /** Runs of segments without a gap, oldest first. */
  readonly coveredRanges: readonly CoveredRange[];
  /** Recorded gaps (lost history), oldest first. */
  readonly gaps: readonly GapRecord[];
  /** Committed segments in storage. */
  readonly segments: number;
  /** Their stored size. */
  readonly bytes: number;
  /** When the writer last committed, and from where. */
  readonly lastCommit: { readonly at: Date; readonly host: string } | undefined;
  /** Segment uploads that were interrupted (ignored; the writer cleans them up). */
  readonly uncommittedSegments: number;
}

/**
 * Reads the journal's status.
 *
 * @throws MongoShieldError from storage, or `MS_MANIFEST_INVALID` for malformed records.
 */
export async function journalStatus(
  storage: StorageAdapter,
  options: { readonly now?: Date | undefined; readonly signal?: AbortSignal | undefined } = {},
): Promise<JournalStatus> {
  const coverage = await loadJournalCoverage(storage, options.signal);
  const now = options.now ?? new Date();
  const state = coverage.state;
  const recoveryPoint = state?.recoveryPoint;
  const recoveryPointDate =
    recoveryPoint === undefined ? undefined : dateOfClusterTime(recoveryPoint);
  return {
    recoveryPoint,
    recoveryPointDate,
    rpoMs:
      recoveryPointDate === undefined
        ? undefined
        : Math.max(0, now.getTime() - recoveryPointDate.getTime()),
    coveredRanges: coverage.ranges,
    gaps: coverage.gaps,
    segments: coverage.segments.length,
    bytes: coverage.segments.reduce((total, segment) => total + segment.size, 0),
    lastCommit:
      state === undefined ? undefined : { at: new Date(state.updatedAt), host: state.writer.host },
    uncommittedSegments: coverage.uncommitted.length,
  };
}
