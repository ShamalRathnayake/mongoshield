import { describe, expect, it } from "vitest";
import type { ClusterTime } from "../format/manifest.ts";
import { buildCoverage, type ListedSegment, rangeCovering, segmentsBetween } from "./coverage.ts";
import { parseSegmentKey, segmentKey } from "./layout.ts";
import { recoverableRanges } from "./plan.ts";
import type { GapRecord, JournalState } from "./records.ts";

function listed(t: number): ListedSegment {
  const info = parseSegmentKey(
    segmentKey({ from: { t, i: 1 }, compression: "zstd", encrypted: false }),
  );
  if (info === undefined) throw new Error("bad key");
  return { info, size: 100 };
}

function state(lastFrom: number, recoveryPoint: ClusterTime): JournalState {
  return {
    formatVersion: 1,
    recoveryPoint,
    lastSegment: {
      key: listed(lastFrom).info.key,
      from: { t: lastFrom, i: 1 },
      to: recoveryPoint,
      size: 100,
      sha256: "a".repeat(64),
      events: 1,
    },
    totals: { segments: 3, events: 3, bytes: 300 },
    updatedAt: "2026-11-14T03:00:00.000Z",
    writer: { host: "h", pid: 1 },
  };
}

function gap(from: ClusterTime, to: ClusterTime): GapRecord {
  return {
    formatVersion: 1,
    from,
    to,
    detectedAt: "2026-11-14T03:00:00.000Z",
    reason: "lost",
    action: "backup",
  };
}

describe("buildCoverage", () => {
  it("ends each segment where the next starts, and the newest at the recovery point", () => {
    const coverage = buildCoverage(
      state(300, { t: 400, i: 1 }),
      [listed(200), listed(100), listed(300)],
      [],
    );
    expect(coverage.segments.map((segment) => [segment.from.t, segment.to.t])).toEqual([
      [100, 200],
      [200, 300],
      [300, 400],
    ]);
    expect(coverage.ranges).toEqual([
      { from: { t: 100, i: 1 }, to: { t: 400, i: 1 }, segments: 3 },
    ]);
  });

  it("ignores segments after the last commit (interrupted uploads)", () => {
    const coverage = buildCoverage(
      state(200, { t: 300, i: 1 }),
      [listed(100), listed(200), listed(300)],
      [],
    );
    expect(coverage.segments).toHaveLength(2);
    expect(coverage.uncommitted.map((segment) => segment.from.t)).toEqual([300]);
  });

  it("treats every segment as uncommitted without a state", () => {
    const coverage = buildCoverage(undefined, [listed(100)], []);
    expect(coverage.segments).toEqual([]);
    expect(coverage.uncommitted).toHaveLength(1);
  });

  it("splits the covered ranges at a recorded gap", () => {
    const coverage = buildCoverage(
      state(500, { t: 600, i: 1 }),
      [listed(100), listed(200), listed(500)],
      [gap({ t: 250, i: 1 }, { t: 500, i: 1 })],
    );
    expect(coverage.segments.map((segment) => [segment.from.t, segment.to.t])).toEqual([
      [100, 200],
      [200, 250],
      [500, 600],
    ]);
    expect(coverage.ranges.map((range) => [range.from.t, range.to.t])).toEqual([
      [100, 250],
      [500, 600],
    ]);
    expect(rangeCovering(coverage.ranges, { t: 150, i: 0 }, { t: 240, i: 0 })).toBeDefined();
    expect(rangeCovering(coverage.ranges, { t: 150, i: 0 }, { t: 550, i: 0 })).toBeUndefined();
  });

  it("selects the segments holding events in a range", () => {
    const coverage = buildCoverage(
      state(300, { t: 400, i: 1 }),
      [listed(100), listed(200), listed(300)],
      [],
    );
    const keys = segmentsBetween(coverage.segments, { t: 200, i: 1 }, { t: 350, i: 0 }).map(
      (segment) => segment.from.t,
    );
    // The segment ending exactly at `from` holds nothing after it.
    expect(keys).toEqual([200, 300]);
  });
});

describe("recoverableRanges", () => {
  it("reaches from the oldest base backup inside each covered range to its end", () => {
    const coverage = buildCoverage(
      state(500, { t: 600, i: 1 }),
      [listed(100), listed(200), listed(500)],
      [gap({ t: 250, i: 1 }, { t: 500, i: 1 })],
    );
    const base = (id: string, t: number) => ({
      id,
      clusterTime: { t, i: 5 },
      completedAt: new Date(0),
      // The manifest is not looked at here.
      manifest: undefined as never,
    });
    const ranges = recoverableRanges(
      [base("c", 550), base("b", 150), base("a", 50)],
      coverage.ranges,
    );
    expect(ranges.map((range) => [range.from.t, range.to.t])).toEqual([
      [50, 50],
      [150, 250],
      [550, 600],
    ]);
  });
});
