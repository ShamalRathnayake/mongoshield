import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import {
  hasAnyCount,
  isoWeekOf,
  periodOf,
  planRetention,
  type RetentionBackup,
  type RetentionPlan,
  type RetentionPolicy,
} from "./retention.ts";

const NOW = new Date("2026-10-20T12:00:00Z");
const HOUR = 60 * 60 * 1000;

/** A complete, unverified, unheld backup that completed at `iso`. Its id is the time. */
function backup(iso: string, extra: Partial<RetentionBackup> = {}): RetentionBackup {
  return {
    id: iso,
    completedAt: new Date(iso),
    status: "complete",
    verified: false,
    held: false,
    ...extra,
  };
}

function plan(backups: RetentionBackup[], policy: RetentionPolicy, now: Date = NOW): RetentionPlan {
  return planRetention({ backups, policy, now });
}

function keptIds(result: RetentionPlan): string[] {
  return result.keep.map((kept) => kept.id);
}

function removedIds(result: RetentionPlan): string[] {
  return result.remove.map((removed) => removed.id);
}

function reasonsOf(result: RetentionPlan, id: string): string[] {
  return result.keep.find((kept) => kept.id === id)?.reasons ?? [];
}

describe("periodOf", () => {
  it("labels hours, days, months and years in UTC", () => {
    const date = new Date("2026-10-20T23:30:00-05:00"); // 2026-10-21T04:30Z
    expect(periodOf("hourly", date)).toBe("2026-10-21T04");
    expect(periodOf("daily", date)).toBe("2026-10-21");
    expect(periodOf("monthly", date)).toBe("2026-10");
    expect(periodOf("yearly", date)).toBe("2026");
  });

  it("labels ISO weeks with the ISO week-year", () => {
    expect(periodOf("weekly", new Date("2026-10-20T12:00:00Z"))).toBe("2026-W43");
    expect(periodOf("weekly", new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
  });

  it("treats a leap day as its own day in February", () => {
    const leapDay = new Date("2024-02-29T12:00:00Z");
    expect(periodOf("daily", leapDay)).toBe("2024-02-29");
    expect(periodOf("monthly", leapDay)).toBe("2024-02");
  });
});

describe("isoWeekOf", () => {
  it.each([
    ["2026-10-20T12:00:00Z", 2026, 43],
    ["2025-12-29T00:00:00Z", 2026, 1], // Monday; the week's Thursday is 2026-01-01
    ["2026-01-01T00:00:00Z", 2026, 1],
    ["2027-01-01T00:00:00Z", 2026, 53], // Friday; 2026 has 53 ISO weeks
    ["2027-01-04T00:00:00Z", 2027, 1],
    ["2021-01-03T23:59:59Z", 2020, 53], // Sunday still belongs to the previous ISO year
    ["2024-12-29T23:59:59Z", 2024, 52],
    ["2024-12-30T00:00:00Z", 2025, 1],
  ])("puts %s in %i-W%i", (iso, year, week) => {
    expect(isoWeekOf(new Date(iso))).toEqual({ year, week });
  });

  it("starts weeks on Monday at UTC midnight", () => {
    const sunday = isoWeekOf(new Date("2026-10-18T23:59:59Z"));
    const monday = isoWeekOf(new Date("2026-10-19T00:00:00Z"));
    expect(sunday.week).toBe(42);
    expect(monday.week).toBe(43);
  });

  it("agrees with a day-by-day reference count over several years", () => {
    // Walk from a known week-1 Monday and count weeks by hand.
    let year = 2020;
    let week = 1;
    let day = Date.UTC(2019, 11, 30); // Monday of 2020-W01
    for (let i = 0; i < 365 * 8; i++) {
      const date = new Date(day);
      expect(isoWeekOf(date)).toEqual({ year, week });
      day += 24 * HOUR;
      const next = new Date(day);
      if (next.getUTCDay() === 1) {
        // A new ISO year starts on the Monday of the week containing 4 January.
        const thursday = new Date(day + 3 * 24 * HOUR);
        if (thursday.getUTCFullYear() !== year) {
          year = thursday.getUTCFullYear();
          week = 1;
        } else {
          week++;
        }
      }
    }
  });
});

describe("hasAnyCount", () => {
  it("is false for an empty policy and for explicit zeros", () => {
    expect(hasAnyCount({})).toBe(false);
    expect(hasAnyCount({ last: 0, daily: 0 })).toBe(false);
    expect(hasAnyCount({ minVerified: 3, incompleteGraceMs: 1 })).toBe(false);
  });

  it("is true when any count is positive", () => {
    expect(hasAnyCount({ yearly: 1 })).toBe(true);
  });
});

describe("planRetention: count rules", () => {
  it("keeps the N newest backups with `last`", () => {
    const backups = [
      backup("2026-10-17T03:00:00Z"),
      backup("2026-10-20T03:00:00Z"),
      backup("2026-10-18T03:00:00Z"),
      backup("2026-10-19T03:00:00Z"),
    ];
    const result = plan(backups, { last: 2 });
    expect(keptIds(result)).toEqual(["2026-10-20T03:00:00Z", "2026-10-19T03:00:00Z"]);
    expect(removedIds(result)).toEqual(["2026-10-18T03:00:00Z", "2026-10-17T03:00:00Z"]);
    expect(reasonsOf(result, "2026-10-19T03:00:00Z")).toEqual(["last 2"]);
    expect(result.remove[0]?.reason).toBe("not selected by any retention rule");
  });

  it("keeps the newest backup of each hour with `hourly`", () => {
    const backups = [
      backup("2026-10-20T10:05:00Z"),
      backup("2026-10-20T10:40:00Z"),
      backup("2026-10-20T11:10:00Z"),
      backup("2026-10-20T11:50:00Z"),
    ];
    const result = plan(backups, { hourly: 2 });
    expect(keptIds(result)).toEqual(["2026-10-20T11:50:00Z", "2026-10-20T10:40:00Z"]);
    expect(reasonsOf(result, "2026-10-20T10:40:00Z")).toEqual(["hourly 2026-10-20T10"]);
  });

  it("splits days at UTC midnight with `daily`", () => {
    const backups = [
      backup("2026-10-17T10:00:00Z"),
      backup("2026-10-18T23:59:59Z"),
      backup("2026-10-19T00:00:00Z"),
      backup("2026-10-19T06:00:00Z"),
    ];
    const result = plan(backups, { daily: 2 });
    expect(keptIds(result)).toEqual(["2026-10-19T06:00:00Z", "2026-10-18T23:59:59Z"]);
    expect(removedIds(result)).toEqual(["2026-10-19T00:00:00Z", "2026-10-17T10:00:00Z"]);
  });

  it("only counts periods that contain a backup (restic/borg semantics)", () => {
    const backups = [
      backup("2026-10-20T03:00:00Z"),
      backup("2026-10-15T03:00:00Z"),
      backup("2026-10-01T03:00:00Z"),
      backup("2026-09-01T03:00:00Z"),
    ];
    // Three distinct days with backups, even though they span weeks.
    const result = plan(backups, { daily: 3 });
    expect(keptIds(result)).toEqual([
      "2026-10-20T03:00:00Z",
      "2026-10-15T03:00:00Z",
      "2026-10-01T03:00:00Z",
    ]);
  });

  it("uses ISO weeks across a year boundary with `weekly`", () => {
    const backups = [
      backup("2024-12-29T12:00:00Z"), // Sunday, 2024-W52
      backup("2024-12-30T12:00:00Z"), // Monday, 2025-W01
      backup("2025-01-03T12:00:00Z"), // Friday, 2025-W01
    ];
    const result = plan(backups, { weekly: 2 }, new Date("2025-01-10T00:00:00Z"));
    expect(keptIds(result)).toEqual(["2025-01-03T12:00:00Z", "2024-12-29T12:00:00Z"]);
    expect(removedIds(result)).toEqual(["2024-12-30T12:00:00Z"]);
    expect(reasonsOf(result, "2024-12-29T12:00:00Z")).toEqual(["weekly 2024-W52"]);
  });

  it("splits months at the last second of the month with `monthly`", () => {
    const backups = [
      backup("2026-01-30T00:00:00Z"),
      backup("2026-01-31T23:59:59Z"),
      backup("2026-02-01T00:00:00Z"),
    ];
    const result = plan(backups, { monthly: 2 });
    expect(keptIds(result)).toEqual(["2026-02-01T00:00:00Z", "2026-01-31T23:59:59Z"]);
  });

  it("keeps the leap day as February's newest backup", () => {
    const backups = [
      backup("2024-02-28T12:00:00Z"),
      backup("2024-02-29T12:00:00Z"),
      backup("2024-03-01T12:00:00Z"),
    ];
    const result = plan(backups, { monthly: 2 });
    expect(keptIds(result)).toEqual(["2024-03-01T12:00:00Z", "2024-02-29T12:00:00Z"]);
    expect(reasonsOf(result, "2024-02-29T12:00:00Z")).toEqual(["monthly 2024-02"]);
  });

  it("splits years at UTC midnight on 1 January with `yearly`", () => {
    const backups = [
      backup("2024-06-01T00:00:00Z"),
      backup("2024-12-31T23:59:59Z"),
      backup("2025-01-01T00:00:00Z"),
      backup("2025-07-01T00:00:00Z"),
    ];
    const result = plan(backups, { yearly: 2 });
    expect(keptIds(result)).toEqual(["2025-07-01T00:00:00Z", "2024-12-31T23:59:59Z"]);
  });

  it("records every rule that keeps a backup", () => {
    const result = plan([backup("2026-10-20T03:00:00Z")], {
      last: 1,
      hourly: 1,
      daily: 1,
      weekly: 1,
      monthly: 1,
      yearly: 1,
    });
    expect(reasonsOf(result, "2026-10-20T03:00:00Z")).toEqual([
      "newest complete backup",
      "last 1",
      "hourly 2026-10-20T03",
      "daily 2026-10-20",
      "weekly 2026-W43",
      "monthly 2026-10",
      "yearly 2026",
    ]);
  });

  it("combines buckets over a year of daily backups", () => {
    const backups: RetentionBackup[] = [];
    for (let day = 0; day < 365; day++) {
      const time = Date.UTC(2026, 9, 20, 3) - day * 24 * HOUR;
      backups.push(backup(new Date(time).toISOString()));
    }
    const result = plan(backups, { daily: 7, weekly: 4, monthly: 12 });

    // 7 days (Oct 14–20) + weeks 41 and 40 (Oct 11, Oct 4; weeks 43 and 42 are
    // already covered by Oct 20 and Oct 18) + 11 month-ends (Nov 2025 – Sep 2026).
    expect(result.keep).toHaveLength(20);
    expect(keptIds(result)).toContain("2026-10-04T03:00:00.000Z");
    expect(keptIds(result)).toContain("2026-02-28T03:00:00.000Z");
    expect(keptIds(result)).toContain("2025-11-30T03:00:00.000Z");
    expect(keptIds(result)).not.toContain("2025-10-31T03:00:00.000Z");
    expect(result.remove).toHaveLength(345);
  });

  it("returns both lists newest first", () => {
    const backups = [
      backup("2026-10-10T00:00:00Z"),
      backup("2026-10-12T00:00:00Z"),
      backup("2026-10-11T00:00:00Z"),
      backup("2026-10-13T00:00:00Z"),
    ];
    const result = plan(backups, { last: 2 });
    expect(keptIds(result)).toEqual(["2026-10-13T00:00:00Z", "2026-10-12T00:00:00Z"]);
    expect(removedIds(result)).toEqual(["2026-10-11T00:00:00Z", "2026-10-10T00:00:00Z"]);
  });
});

describe("planRetention: safety rules", () => {
  it("keeps everything and warns when the policy sets no counts", () => {
    const backups = [
      backup("2026-10-01T00:00:00Z"),
      backup("2020-01-01T00:00:00Z"),
      backup("2020-01-02T00:00:00Z", { status: "incomplete" }),
    ];
    for (const policy of [{}, { last: 0, daily: 0 }, { minVerified: 2 }]) {
      const result = plan(backups, policy);
      expect(result.remove).toEqual([]);
      expect(result.keep).toHaveLength(3);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/sets no counts/);
    }
  });

  it("always keeps the newest complete backup", () => {
    const backups = [
      backup("2026-10-20T03:00:00Z"),
      backup("2026-10-21T03:00:00Z"), // future; must not hide the real newest
    ];
    const result = plan(backups, { yearly: 1 });
    expect(reasonsOf(result, "2026-10-20T03:00:00Z")).toContain("newest complete backup");
    expect(result.remove).toEqual([]);
  });

  it("never removes held backups", () => {
    const backups = [
      backup("2026-10-20T03:00:00Z"),
      backup("2020-01-01T00:00:00Z", { held: true }),
      backup("2020-01-02T00:00:00Z"),
    ];
    const result = plan(backups, { last: 1 });
    expect(reasonsOf(result, "2020-01-01T00:00:00Z")).toEqual(["held"]);
    expect(removedIds(result)).toEqual(["2020-01-02T00:00:00Z"]);
  });

  it("keeps immutable backups until immutableUntil, and lets them fill count slots", () => {
    const backups = [
      backup("2026-10-20T03:00:00Z"),
      backup("2026-10-19T03:00:00Z", { immutableUntil: new Date("2026-10-26T03:00:00Z") }),
      backup("2026-10-18T03:00:00Z", { immutableUntil: new Date("2026-10-25T03:00:00Z") }),
      backup("2026-10-17T03:00:00Z"),
    ];
    const result = plan(backups, { last: 2 });
    expect(reasonsOf(result, "2026-10-19T03:00:00Z")).toEqual([
      "immutable until 2026-10-26T03:00:00.000Z",
      "last 2",
    ]);
    expect(reasonsOf(result, "2026-10-18T03:00:00Z")).toEqual([
      "immutable until 2026-10-25T03:00:00.000Z",
    ]);
    expect(removedIds(result)).toEqual(["2026-10-17T03:00:00Z"]);
  });

  it("removes an immutable backup normally once its retention has passed", () => {
    const backups = [
      backup("2026-10-20T03:00:00Z"),
      backup("2026-09-01T03:00:00Z", { immutableUntil: new Date("2026-10-01T03:00:00Z") }),
      // Expiring exactly now counts as expired: the storage releases it at that instant.
      backup("2026-08-01T03:00:00Z", { immutableUntil: NOW }),
    ];
    expect(removedIds(plan(backups, { last: 1 }))).toEqual([
      "2026-09-01T03:00:00Z",
      "2026-08-01T03:00:00Z",
    ]);
  });

  it("keeps the newest verified backups until minVerified is met", () => {
    const backups = [
      backup("2026-10-20T00:00:00Z"),
      backup("2026-10-19T00:00:00Z", { verified: true }),
      backup("2026-10-18T00:00:00Z"),
      backup("2026-10-17T00:00:00Z", { verified: true }),
      backup("2026-10-16T00:00:00Z", { verified: true }),
    ];
    const result = plan(backups, { last: 1, minVerified: 2 });
    expect(keptIds(result)).toEqual([
      "2026-10-20T00:00:00Z",
      "2026-10-19T00:00:00Z",
      "2026-10-17T00:00:00Z",
    ]);
    expect(reasonsOf(result, "2026-10-17T00:00:00Z")).toEqual(["min verified 2"]);
    expect(result.warnings).toEqual([]);
  });

  it("counts verified backups that are kept for other reasons toward minVerified", () => {
    const backups = [
      backup("2026-10-20T00:00:00Z", { verified: true }),
      backup("2026-10-19T00:00:00Z", { verified: true }),
      backup("2026-10-18T00:00:00Z", { verified: true }),
    ];
    const result = plan(backups, { last: 2, minVerified: 2 });
    expect(removedIds(result)).toEqual(["2026-10-18T00:00:00Z"]);
  });

  it("warns when fewer than minVerified verified backups exist", () => {
    const backups = [backup("2026-10-20T00:00:00Z"), backup("2026-10-19T00:00:00Z")];
    const result = plan(backups, { last: 1, minVerified: 1 });
    expect(result.warnings.join("\n")).toMatch(/Only 0 verified backup/);
  });

  it("keeps incomplete runs within the grace period and removes older ones", () => {
    const backups = [
      backup("2026-10-20T00:00:00Z"),
      backup("2026-10-20T11:00:00Z", { status: "incomplete" }), // 1h old
      backup("2026-10-19T11:00:00Z", { status: "incomplete" }), // 25h old
    ];
    const result = plan(backups, { last: 1 });
    expect(reasonsOf(result, "2026-10-20T11:00:00Z")[0]).toMatch(/within the 24h grace period/);
    expect(result.remove).toEqual([
      {
        id: "2026-10-19T11:00:00Z",
        reason: "incomplete run idle for longer than the 24h grace period",
      },
    ]);
  });

  it("honours a custom incompleteGraceMs", () => {
    const backups = [
      backup("2026-10-20T00:00:00Z"),
      backup("2026-10-20T11:00:00Z", { status: "incomplete" }), // 1h old
    ];
    const result = plan(backups, { last: 1, incompleteGraceMs: 30 * 60 * 1000 });
    expect(removedIds(result)).toEqual(["2026-10-20T11:00:00Z"]);
  });

  it("does not let incomplete runs take a `last` slot", () => {
    const backups = [
      backup("2026-10-20T11:00:00Z", { status: "incomplete" }),
      backup("2026-10-20T00:00:00Z"),
      backup("2026-10-19T00:00:00Z"),
    ];
    const result = plan(backups, { last: 1 });
    expect(reasonsOf(result, "2026-10-20T00:00:00Z")).toContain("last 1");
    expect(removedIds(result)).toEqual(["2026-10-19T00:00:00Z"]);
  });

  it("never removes invalid backups and reports them", () => {
    const backups = [
      backup("2026-10-20T00:00:00Z"),
      backup("2020-01-01T00:00:00Z", { status: "invalid" }),
    ];
    const result = plan(backups, { last: 1 });
    expect(result.remove).toEqual([]);
    expect(reasonsOf(result, "2020-01-01T00:00:00Z")).toEqual([
      "invalid manifest (never removed automatically)",
    ]);
    expect(result.warnings.join("\n")).toMatch(/2020-01-01T00:00:00Z has an invalid manifest/);
  });

  it("keeps backups dated in the future without giving them a count slot", () => {
    const backups = [
      backup("2026-10-21T00:00:00Z"),
      backup("2026-10-20T00:00:00Z"),
      backup("2026-10-19T00:00:00Z"),
    ];
    const result = plan(backups, { last: 1 });
    expect(reasonsOf(result, "2026-10-21T00:00:00Z")).toEqual(["completed in the future"]);
    expect(reasonsOf(result, "2026-10-20T00:00:00Z")).toContain("last 1");
    expect(removedIds(result)).toEqual(["2026-10-19T00:00:00Z"]);
    expect(result.warnings.join("\n")).toMatch(/dated in the future/);
  });

  it("keeps backups whose completion time is not a valid date", () => {
    const backups = [
      backup("2026-10-20T00:00:00Z"),
      { ...backup("2026-10-19T00:00:00Z"), completedAt: new Date(Number.NaN) },
    ];
    const result = plan(backups, { last: 1 });
    expect(result.remove).toEqual([]);
    expect(reasonsOf(result, "2026-10-19T00:00:00Z")).toEqual(["unknown completion time"]);
  });

  it.each([
    [{ last: -1 }],
    [{ daily: 1.5 }],
    [{ weekly: Number.NaN }],
    [{ minVerified: -2 }],
    [{ incompleteGraceMs: Number.POSITIVE_INFINITY }],
  ])("rejects the invalid policy %o", (policy) => {
    expect(() => plan([], policy)).toThrow(expect.objectContaining({ code: "MS_CONFIG_INVALID" }));
  });

  it("rejects an invalid `now`", () => {
    expect(() => plan([], { last: 1 }, new Date(Number.NaN))).toThrow(/valid `now`/);
  });

  it("rejects duplicate ids", () => {
    const duplicate = backup("2026-10-20T00:00:00Z");
    let thrown: unknown;
    try {
      plan([duplicate, duplicate], { last: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(isMongoShieldError(thrown, "MS_INTERNAL")).toBe(true);
  });

  it("plans nothing for an empty catalog", () => {
    expect(plan([], { last: 3 })).toEqual({ keep: [], remove: [], warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

/** Up to ~3 years in the past, plus a little in the future to exercise clock skew. */
const minutesBeforeNow = fc.integer({ min: -600, max: 3 * 365 * 24 * 60 });

const backupFields = fc.record({
  minutesAgo: minutesBeforeNow,
  status: fc.constantFrom("complete", "complete", "complete", "incomplete", "invalid"),
  verified: fc.boolean(),
  held: fc.boolean(),
  /** Retention end relative to now, in minutes (negative = already expired), or none. */
  immutableMinutes: fc.option(fc.integer({ min: -60 * 24 * 30, max: 60 * 24 * 30 }), {
    nil: undefined,
  }),
});

/** Backups with unique ids (`b0`, `b1`, …). Times may collide, as they can in real life. */
const backupsArbitrary = fc.array(backupFields, { maxLength: 60 }).map((items) =>
  items.map(
    (item, index): RetentionBackup => ({
      id: `b${index}`,
      completedAt: new Date(NOW.getTime() - item.minutesAgo * 60_000),
      status: item.status,
      verified: item.verified,
      held: item.held,
      ...(item.immutableMinutes === undefined
        ? {}
        : { immutableUntil: new Date(NOW.getTime() + item.immutableMinutes * 60_000) }),
    }),
  ),
);

const count = fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined });

const policyArbitrary = fc
  .record({
    last: count,
    hourly: count,
    daily: count,
    weekly: count,
    monthly: count,
    yearly: count,
    minVerified: count,
    incompleteGraceMs: fc.option(fc.integer({ min: 0, max: 72 * 60 * 60 * 1000 }), {
      nil: undefined,
    }),
  })
  .map((fields): RetentionPolicy => {
    // Drop undefined fields: `exactOptionalPropertyTypes` forbids explicit undefined.
    const policy: Record<string, number> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) policy[key] = value;
    }
    return policy;
  });

describe("planRetention: invariants", () => {
  it("never removes the newest complete backup", () => {
    fc.assert(
      fc.property(backupsArbitrary, policyArbitrary, (backups, policy) => {
        const result = plan(backups, policy);
        const complete = backups
          .filter((item) => item.status === "complete")
          .sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
        const newest = complete[0];
        if (newest === undefined) return;
        // Several backups may share the newest time; at least one of them is kept,
        // and none of the tied ones may be removed if it is the planner's choice.
        const removed = new Set(removedIds(result));
        const tied = complete.filter(
          (item) => item.completedAt.getTime() === newest.completedAt.getTime(),
        );
        expect(tied.some((item) => !removed.has(item.id))).toBe(true);
      }),
    );
  });

  it("never removes the newest complete backup that is not in the future", () => {
    fc.assert(
      fc.property(backupsArbitrary, policyArbitrary, (backups, policy) => {
        const result = plan(backups, policy);
        const newestId = result.keep.find((kept) =>
          kept.reasons.includes("newest complete backup"),
        )?.id;
        const anyPastComplete = backups.some(
          (item) => item.status === "complete" && item.completedAt <= NOW,
        );
        if (hasAnyCount(policy) && anyPastComplete) expect(newestId).toBeDefined();
      }),
    );
  });

  it("never removes held, invalid, future-dated or still-immutable backups", () => {
    fc.assert(
      fc.property(backupsArbitrary, policyArbitrary, (backups, policy) => {
        const removed = new Set(removedIds(plan(backups, policy)));
        for (const item of backups) {
          const immutable = item.immutableUntil !== undefined && item.immutableUntil > NOW;
          if (item.held || item.status === "invalid" || item.completedAt > NOW || immutable) {
            expect(removed.has(item.id)).toBe(false);
          }
        }
      }),
    );
  });

  it("never removes an incomplete run inside the grace period", () => {
    fc.assert(
      fc.property(backupsArbitrary, policyArbitrary, (backups, policy) => {
        const grace = policy.incompleteGraceMs ?? 24 * HOUR;
        const removed = new Set(removedIds(plan(backups, policy)));
        for (const item of backups) {
          if (item.status === "incomplete" && NOW.getTime() - item.completedAt.getTime() < grace) {
            expect(removed.has(item.id)).toBe(false);
          }
        }
      }),
    );
  });

  it("partitions the input: keep and remove are disjoint and cover every backup", () => {
    fc.assert(
      fc.property(backupsArbitrary, policyArbitrary, (backups, policy) => {
        const result = plan(backups, policy);
        const kept = keptIds(result);
        const removed = removedIds(result);
        expect(kept.length + removed.length).toBe(backups.length);
        expect(new Set([...kept, ...removed])).toEqual(new Set(backups.map((item) => item.id)));
      }),
    );
  });

  it("is idempotent: planning again over the kept backups removes nothing", () => {
    fc.assert(
      fc.property(backupsArbitrary, policyArbitrary, (backups, policy) => {
        const kept = new Set(keptIds(plan(backups, policy)));
        const second = plan(
          backups.filter((item) => kept.has(item.id)),
          policy,
        );
        expect(second.remove).toEqual([]);
      }),
    );
  });

  it("with only `last: n`, keeps exactly min(n, complete count) complete backups", () => {
    const completeOnly = fc
      .array(fc.integer({ min: 0, max: 3 * 365 * 24 * 60 }), { maxLength: 40 })
      .map((minutes) =>
        minutes.map((minutesAgo, index) =>
          backup(new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), {
            id: `b${index}`,
          }),
        ),
      );
    fc.assert(
      fc.property(completeOnly, fc.integer({ min: 1, max: 50 }), (backups, last) => {
        const result = plan(backups, { last });
        expect(result.keep).toHaveLength(Math.min(last, backups.length));
      }),
    );
  });
});

describe("planRetention: incremental chains (rule 8)", () => {
  // Chain A on Monday: a full backup and two incrementals; chain B on Tuesday.
  const a = backup("2026-10-19T00:00:00Z");
  const a1 = backup("2026-10-19T06:00:00Z", { parent: a.id });
  const a2 = backup("2026-10-19T12:00:00Z", { parent: a1.id });
  const b = backup("2026-10-20T00:00:00Z");
  const b1 = backup("2026-10-20T06:00:00Z", { parent: b.id });
  const all = [a, a1, a2, b, b1];

  it("keeps the whole chain of a kept incremental, and drops the older chain whole", () => {
    const result = plan(all, { last: 1 });
    expect(keptIds(result)).toEqual([b1.id, b.id]);
    expect(reasonsOf(result, b.id)).toEqual([`chain of kept incremental ${b1.id}`]);
    expect(removedIds(result)).toEqual([a2.id, a1.id, a.id]);
  });

  it("keeps each day's newest backup with the chain it needs", () => {
    const result = plan(all, { daily: 2 });
    expect(removedIds(result)).toEqual([]);
    expect(reasonsOf(result, a1.id)).toContain(`chain of kept incremental ${a2.id}`);
  });

  it("cuts a chain only at its newest end: a held middle member keeps what is before it", () => {
    const result = plan(
      all.map((item) => (item.id === a1.id ? { ...item, held: true } : item)),
      { last: 1 },
    );
    expect(keptIds(result)).toEqual([b1.id, b.id, a1.id, a.id]);
    expect(removedIds(result)).toEqual([a2.id]);
  });

  it("keeps what a backup outside the plan depends on (neededBy)", () => {
    const result = plan([{ ...a, neededBy: "other-scope-incremental" }, b], { last: 1 });
    expect(reasonsOf(result, a.id)).toEqual([
      "needed by incremental other-scope-incremental (outside this scope)",
    ]);
  });

  it("never removes a backup that a kept backup depends on (property)", () => {
    const chains = fc
      .array(
        fc.record({
          minutesAgo: fc.integer({ min: 0, max: 30 * 24 * 60 }),
          parentOffset: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
          held: fc.boolean(),
        }),
        { maxLength: 30 },
      )
      .map((items) => {
        // Oldest first, so a parent (a few positions earlier) is always older.
        const sorted = [...items].sort((x, y) => y.minutesAgo - x.minutesAgo);
        return sorted.map((item, index) => {
          const parentIndex = item.parentOffset === undefined ? -1 : index - item.parentOffset;
          return backup(new Date(NOW.getTime() - item.minutesAgo * 60_000 - index).toISOString(), {
            id: `b${index}`,
            held: item.held,
            ...(parentIndex >= 0 ? { parent: `b${parentIndex}` } : {}),
          });
        });
      });
    fc.assert(
      fc.property(chains, policyArbitrary, (backups, policy) => {
        const kept = new Set(keptIds(plan(backups, policy)));
        for (const item of backups) {
          if (kept.has(item.id) && item.parent !== undefined)
            expect(kept.has(item.parent)).toBe(true);
        }
      }),
    );
  });
});
