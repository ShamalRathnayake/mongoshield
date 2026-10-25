/**
 * Cluster-time arithmetic for the change journal (docs/specs/JOURNAL.md).
 *
 * A cluster time is a BSON Timestamp `{ t, i }`: seconds since the epoch, then an
 * increment that orders the writes within that second (it starts at 1). The journal
 * compares, steps and converts them; the converge helpers (`compareClusterTimes`,
 * `formatClusterTime`, …) are reused from src/engine/converge-time.ts.
 */

import { compareClusterTimes } from "../engine/converge-time.ts";
import type { ClusterTime } from "../format/manifest.ts";

/** The largest increment a BSON Timestamp can hold (an unsigned 32-bit number). */
export const MAX_INCREMENT = 0xffff_ffff;

/**
 * The cluster time right after `time`. A change stream opened with
 * `startAtOperationTime: successor(T)` returns exactly the events after T, which is how
 * the writer resumes after the last committed segment.
 */
export function successor(time: ClusterTime): ClusterTime {
  if (time.i < MAX_INCREMENT) return { t: time.t, i: time.i + 1 };
  return { t: time.t + 1, i: 0 };
}

/**
 * The cluster time right before `time`, e.g. "just before the disaster" when the
 * disaster's own cluster time is known.
 */
export function predecessor(time: ClusterTime): ClusterTime {
  if (time.i > 0) return { t: time.t, i: time.i - 1 };
  return { t: Math.max(0, time.t - 1), i: MAX_INCREMENT };
}

/** The later of two cluster times. */
export function laterOf(a: ClusterTime, b: ClusterTime): ClusterTime {
  return compareClusterTimes(a, b) >= 0 ? a : b;
}

/** True when `a` is strictly after `b`. */
export function isAfter(a: ClusterTime, b: ClusterTime): boolean {
  return compareClusterTimes(a, b) > 0;
}

/**
 * The cluster time standing for a wall-clock instant: `{ t: <second of date>, i: 0 }`.
 *
 * Why increment 0: real writes start at increment 1, so "every event up to and
 * including `{ t, 0 }`" means "every event of the seconds before `t`". A `Date` is
 * thereby rounded DOWN to its second, and the writes of that second are left out:
 * when someone says "restore to 03:17:42" because that is when the bad `deleteMany`
 * ran, replaying 03:17:42 itself might replay the disaster. Pass a `ClusterTime` for
 * finer control.
 */
export function clusterTimeOfDate(date: Date): ClusterTime {
  return { t: Math.floor(date.getTime() / 1000), i: 0 };
}

/** The wall-clock second of a cluster time, as a `Date` (for display and RPO). */
export function dateOfClusterTime(time: ClusterTime): Date {
  return new Date(time.t * 1000);
}

/** A `Date` or a cluster time, as a cluster time (see {@link clusterTimeOfDate}). */
export function toJournalTime(at: Date | ClusterTime): ClusterTime {
  return at instanceof Date ? clusterTimeOfDate(at) : { t: at.t, i: at.i };
}
