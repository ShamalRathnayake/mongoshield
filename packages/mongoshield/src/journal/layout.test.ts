import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { gapKey, isGapKey, parseSegmentKey, segmentKey } from "./layout.ts";
import { clusterTimeOfDate, MAX_INCREMENT, predecessor, successor, toJournalTime } from "./time.ts";

describe("segment keys", () => {
  it("name a segment by the day and time of its start, then its exact cluster time", () => {
    const key = segmentKey({
      from: { t: 1_763_090_100, i: 3 },
      compression: "zstd",
      encrypted: true,
    });
    expect(key).toBe("journal/segments/2025-11-14/031500_1763090100-0000000003.bson.zst.age");
  });

  it("round-trip through parseSegmentKey", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.integer({ min: 0, max: MAX_INCREMENT }),
        fc.constantFrom("zstd" as const, "gzip" as const, "none" as const),
        fc.boolean(),
        (t, i, compression, encrypted) => {
          const key = segmentKey({ from: { t, i }, compression, encrypted });
          expect(parseSegmentKey(key)).toEqual({ key, from: { t, i }, compression, encrypted });
        },
      ),
    );
  });

  it("sort in time order as plain strings", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            t: fc.integer({ min: 0, max: 0xffff_ffff }),
            i: fc.integer({ min: 0, max: MAX_INCREMENT }),
          }),
          {
            minLength: 2,
            maxLength: 20,
          },
        ),
        (times) => {
          const byTime = [...times].sort((a, b) => a.t - b.t || a.i - b.i);
          const keys = byTime.map((from) =>
            segmentKey({ from, compression: "none", encrypted: false }),
          );
          expect([...keys].sort()).toEqual(keys);
        },
      ),
    );
  });

  it("ignores objects that are not segments", () => {
    expect(parseSegmentKey("journal/segments/2025-11-14/notes.txt")).toBeUndefined();
    expect(parseSegmentKey("backups/x/031500_1763090100-0000000003.bson")).toBeUndefined();
  });
});

describe("gap keys", () => {
  it("are recognised", () => {
    const key = gapKey({ t: 1_763_090_100, i: 3 });
    expect(key).toBe("journal/gaps/1763090100-0000000003.json");
    expect(isGapKey(key)).toBe(true);
    expect(isGapKey("journal/gaps/readme.md")).toBe(false);
  });
});

describe("journal time", () => {
  it("steps to the next and previous cluster time, across seconds", () => {
    expect(successor({ t: 5, i: 1 })).toEqual({ t: 5, i: 2 });
    expect(successor({ t: 5, i: MAX_INCREMENT })).toEqual({ t: 6, i: 0 });
    expect(predecessor({ t: 5, i: 2 })).toEqual({ t: 5, i: 1 });
    expect(predecessor({ t: 5, i: 0 })).toEqual({ t: 4, i: MAX_INCREMENT });
  });

  it("rounds a Date down to its second, leaving that second's writes out", () => {
    expect(clusterTimeOfDate(new Date("2026-11-14T03:17:42.900Z"))).toEqual({
      t: Date.parse("2026-11-14T03:17:42Z") / 1000,
      i: 0,
    });
    expect(toJournalTime({ t: 7, i: 9 })).toEqual({ t: 7, i: 9 });
  });
});
