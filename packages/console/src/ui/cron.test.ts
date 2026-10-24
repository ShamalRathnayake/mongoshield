/**
 * Tests for the schedule preview: parsing, plain-English descriptions and next runs,
 * including time zones.
 */

import { describe, expect, it } from "vitest";
import { describeCron, nextRuns, parseCron } from "./cron.ts";

describe("parseCron", () => {
  it("rejects expressions without five fields and out-of-range values", () => {
    expect(parseCron("0 2 * *").kind).toBe("invalid");
    expect(parseCron("61 2 * * *")).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("minute"),
    });
    expect(parseCron("0 2 * * FUNDAY").kind).toBe("invalid");
  });

  it("labels croner extensions as custom instead of guessing", () => {
    expect(parseCron("0 2 L * *").kind).toBe("custom");
    expect(parseCron("0 2 * * 5#3").kind).toBe("custom");
  });

  it("accepts names and macros", () => {
    expect(parseCron("0 9 * JAN MON-FRI").kind).toBe("ok");
    expect(parseCron("@daily").kind).toBe("ok");
  });
});

describe("describeCron", () => {
  it.each([
    ["0 2 * * *", "Every day at 02:00"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["15 * * * *", "Every hour at minute 15"],
    ["0 */6 * * *", "Every 6 hours at minute 0"],
    ["30 3 * * 1", "Every Monday at 03:30"],
    ["0 8 * * 1-5", "Every weekday at 08:00"],
    ["0 4 1 * *", "On day 1 of every month at 04:00"],
    ["@hourly", "Every hour at minute 0"],
    ["0 2 1 1,7 *", "Custom schedule"],
    ["nonsense", "Invalid schedule"],
  ])("describes %s as %s", (expression, description) => {
    expect(describeCron(expression)).toBe(description);
  });
});

describe("nextRuns", () => {
  const from = new Date("2026-10-21T10:17:30Z");

  it("lists the next daily runs in UTC", () => {
    const runs = nextRuns("0 2 * * *", "UTC", 3, from)?.map((date) => date.toISOString());
    expect(runs).toEqual([
      "2026-10-22T02:00:00.000Z",
      "2026-10-23T02:00:00.000Z",
      "2026-10-24T02:00:00.000Z",
    ]);
  });

  it("starts at the next whole minute", () => {
    const runs = nextRuns("*/15 * * * *", "UTC", 2, from)?.map((date) => date.toISOString());
    expect(runs).toEqual(["2026-10-21T10:30:00.000Z", "2026-10-21T10:45:00.000Z"]);
  });

  it("matches wall-clock time in the plan's time zone", () => {
    // Berlin is UTC+2 in October (before the switch on the 25th), so 02:00 there is 00:00Z.
    const runs = nextRuns("0 2 * * *", "Europe/Berlin", 1, from)?.map((date) => date.toISOString());
    expect(runs).toEqual(["2026-10-22T00:00:00.000Z"]);
  });

  it("combines restricted day-of-month and day-of-week with OR, like cron", () => {
    // The 1st of the month OR any Friday.
    const runs = nextRuns("0 0 1 * 5", "UTC", 3, from)?.map((date) =>
      date.toISOString().slice(0, 10),
    );
    expect(runs).toEqual(["2026-10-23", "2026-10-30", "2026-11-01"]);
  });

  it("returns undefined for custom expressions and unknown time zones", () => {
    expect(nextRuns("0 2 L * *", "UTC", 5, from)).toBeUndefined();
    expect(nextRuns("0 2 * * *", "Mars/Olympus", 5, from)).toBeUndefined();
  });
});
