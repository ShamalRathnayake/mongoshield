/**
 * What the journal covers, worked out from a storage listing, `state.json` and the gap
 * records, without opening any segment (so it needs no key and is cheap).
 *
 *   committed segments   the segments up to the one `state.json` names; a segment
 *                        written after it is an interrupted upload and is ignored
 *   segment ends         each segment ends where the next one starts, or where a gap
 *                        starts; the newest ends at the recovery point
 *   covered ranges       runs of segments with no gap between them
 *
 * Names cannot prove that no segment is missing or altered; the segment chain does,
 * and every reader checks it (reader.ts). `buildCoverage` is pure and unit-tested.
 */

import { compareClusterTimes } from "../engine/converge-time.ts";
import type { ClusterTime } from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";
import {
  GAPS_PREFIX,
  isGapKey,
  parseSegmentKey,
  SEGMENTS_PREFIX,
  type SegmentKeyInfo,
} from "./layout.ts";
import { type GapRecord, type JournalState, readGapRecords, readJournalState } from "./records.ts";
import { isAfter } from "./time.ts";

/** A committed segment with its range. */
export interface JournalSegment extends SegmentKeyInfo {
  /** The segment holds the journaled events in `(from, to]`. */
  readonly to: ClusterTime;
  /** Size of the stored object in bytes. */
  readonly size: number;
}

/** A stretch of time the journal covers without a gap. */
export interface CoveredRange {
  /** Changes after this cluster time … */
  readonly from: ClusterTime;
  /** … up to and including this one are journaled. */
  readonly to: ClusterTime;
  readonly segments: number;
}

/** Everything known about the journal from names and small records. */
export interface JournalCoverage {
  /** `undefined` before the first segment is committed. */
  readonly state: JournalState | undefined;
  /** Committed segments, oldest first. */
  readonly segments: readonly JournalSegment[];
  /** Segments written after the last commit (interrupted uploads); ignored by readers. */
  readonly uncommitted: readonly SegmentKeyInfo[];
  readonly gaps: readonly GapRecord[];
  /** Runs of segments without a gap, oldest first. */
  readonly ranges: readonly CoveredRange[];
}

/** A listed segment object: its decoded key plus its size. */
export interface ListedSegment {
  readonly info: SegmentKeyInfo;
  readonly size: number;
}

/**
 * Lists the journal and works out its coverage.
 *
 * @throws MongoShieldError from storage, or `MS_MANIFEST_INVALID` for a malformed
 *   `state.json` or gap record.
 */
export async function loadJournalCoverage(
  storage: StorageAdapter,
  signal?: AbortSignal,
): Promise<JournalCoverage> {
  const listOptions = signal === undefined ? {} : { signal };
  const listed: ListedSegment[] = [];
  for await (const object of storage.list(SEGMENTS_PREFIX, listOptions)) {
    const info = parseSegmentKey(object.key);
    if (info !== undefined) listed.push({ info, size: object.size });
  }
  const gapKeys: string[] = [];
  for await (const object of storage.list(GAPS_PREFIX, listOptions)) {
    if (isGapKey(object.key)) gapKeys.push(object.key);
  }
  const state = await readJournalState(storage, signal);
  const gaps = await readGapRecords(storage, gapKeys, signal);
  return buildCoverage(state, listed, gaps);
}

/** The pure part of {@link loadJournalCoverage}. */
export function buildCoverage(
  state: JournalState | undefined,
  listed: readonly ListedSegment[],
  gaps: readonly GapRecord[],
): JournalCoverage {
  const sorted = [...listed].sort((a, b) => compareClusterTimes(a.info.from, b.info.from));
  const sortedGaps = [...gaps].sort((a, b) => compareClusterTimes(a.from, b.from));

  // Without a state nothing is committed yet; otherwise everything up to the segment
  // the state names. (Key order is time order, so "up to" compares start times.)
  const lastFrom = state?.lastSegment.from;
  const committedListing = sorted.filter(
    (segment) => lastFrom !== undefined && !isAfter(segment.info.from, lastFrom),
  );
  const uncommitted = sorted
    .filter((segment) => lastFrom === undefined || isAfter(segment.info.from, lastFrom))
    .map((segment) => segment.info);

  const segments: JournalSegment[] = committedListing.map((segment, index) => {
    const next = committedListing[index + 1];
    const end = next === undefined ? state?.recoveryPoint : next.info.from;
    const to =
      end === undefined ? segment.info.from : endBeforeGap(segment.info.from, end, sortedGaps);
    return { ...segment.info, to, size: segment.size };
  });

  return { state, segments, uncommitted, gaps: sortedGaps, ranges: coveredRanges(segments) };
}

/**
 * Where a segment that starts at `from` ends, given that the next one starts at
 * `nextFrom`: at the first gap that starts in between, otherwise at `nextFrom`.
 */
function endBeforeGap(
  from: ClusterTime,
  nextFrom: ClusterTime,
  gaps: readonly GapRecord[],
): ClusterTime {
  for (const gap of gaps) {
    if (isAfter(gap.from, from) && isAfter(nextFrom, gap.from)) {
      return gap.from;
    }
  }
  return nextFrom;
}

/** Groups consecutive segments (each ending where the next starts) into ranges. */
export function coveredRanges(segments: readonly JournalSegment[]): CoveredRange[] {
  const ranges: CoveredRange[] = [];
  let current: { from: ClusterTime; to: ClusterTime; segments: number } | undefined;
  for (const segment of segments) {
    if (current !== undefined && compareClusterTimes(current.to, segment.from) === 0) {
      current.to = segment.to;
      current.segments += 1;
      continue;
    }
    if (current !== undefined) ranges.push(current);
    current = { from: segment.from, to: segment.to, segments: 1 };
  }
  if (current !== undefined) ranges.push(current);
  return ranges;
}

/** The covered range that holds every change in `(from, to]`, if there is one. */
export function rangeCovering(
  ranges: readonly CoveredRange[],
  from: ClusterTime,
  to: ClusterTime,
): CoveredRange | undefined {
  return ranges.find((range) => !isAfter(range.from, from) && !isAfter(to, range.to));
}

/** The committed segments holding events in `(from, to]`, oldest first. */
export function segmentsBetween(
  segments: readonly JournalSegment[],
  from: ClusterTime,
  to: ClusterTime,
): JournalSegment[] {
  return segments.filter((segment) => isAfter(segment.to, from) && isAfter(to, segment.from));
}
