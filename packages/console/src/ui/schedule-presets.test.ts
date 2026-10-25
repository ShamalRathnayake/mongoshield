/**
 * Tests for the plan editor's schedule presets: preset ↔ cron in both directions,
 * which expressions count as a preset, the select options, and the time zone groups.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRESET,
  isHourlyKind,
  minuteOptions,
  ordinal,
  parseTimeValue,
  presetFromCron,
  presetToCron,
  repeatKindOf,
  type SchedulePreset,
  switchPreset,
  timeOptions,
  timeZoneGroups,
  utcOffsetLabel,
} from "./schedule-presets.ts";

afterEach(() => vi.restoreAllMocks());

/** A preset with the defaults, changed where a test says. */
const preset = (changes: Partial<SchedulePreset>): SchedulePreset => ({
  ...DEFAULT_PRESET,
  ...changes,
});

describe("presetToCron", () => {
  it.each([
    [preset({ repeat: "hourly", minute: 15 }), "15 * * * *"],
    [preset({ repeat: "every6h", minute: 0 }), "0 */6 * * *"],
    [preset({ repeat: "every12h", minute: 30 }), "30 */12 * * *"],
    [preset({ repeat: "daily", hour: 2, minute: 0 }), "0 2 * * *"],
    [preset({ repeat: "weekly", weekday: 5, hour: 23, minute: 30 }), "30 23 * * 5"],
    [preset({ repeat: "monthly", dayOfMonth: 15, hour: 4, minute: 0 }), "0 4 15 * *"],
  ])("writes %o as %j", (input, cron) => {
    expect(presetToCron(input)).toBe(cron);
  });
});

describe("presetFromCron", () => {
  it.each(["15 * * * *", "0 */6 * * *", "30 */12 * * *", "0 2 * * *", "30 23 * * 5", "0 4 15 * *"])(
    "round-trips %j through the preset controls",
    (cron) => {
      const found = presetFromCron(cron);
      expect(found).toBeDefined();
      expect(presetToCron(found ?? DEFAULT_PRESET)).toBe(cron);
    },
  );

  it("reads expressions by what they mean, not how they are written", () => {
    expect(presetFromCron("@daily")).toMatchObject({ repeat: "daily", hour: 0, minute: 0 });
    expect(presetFromCron("@hourly")).toMatchObject({ repeat: "hourly", minute: 0 });
    expect(presetFromCron("5 0,12 * * *")).toMatchObject({ repeat: "every12h", minute: 5 });
    expect(presetFromCron("0 3 * * SUN")).toMatchObject({ repeat: "weekly", weekday: 0 });
    // 7 is Sunday too.
    expect(presetFromCron("0 3 * * 7")).toMatchObject({ repeat: "weekly", weekday: 0 });
    expect(presetFromCron("0 3 1-31 * *")).toMatchObject({ repeat: "daily", hour: 3 });
  });

  it("keeps the fallback's fields that the expression does not decide", () => {
    const fallback = preset({ weekday: 4, dayOfMonth: 9, hour: 6 });
    expect(presetFromCron("10 * * * *", fallback)).toEqual({
      ...fallback,
      repeat: "hourly",
      minute: 10,
    });
  });

  it.each([
    ["every 15 minutes", "*/15 * * * *"],
    ["two minutes", "0,30 2 * * *"],
    ["weekdays", "0 2 * * 1-5"],
    ["two hours", "0 2,14 * * 1"],
    ["a day not every month has", "0 2 31 * *"],
    ["one month only", "0 2 1 1 *"],
    ["both day fields", "0 2 1 * 1"],
    ["every 4 hours", "0 */4 * * *"],
    ["an extension", "0 2 L * *"],
    ["something invalid", "not cron"],
  ])("leaves %s (%j) as custom", (_name, cron) => {
    expect(presetFromCron(cron)).toBeUndefined();
    expect(repeatKindOf(cron)).toBe("custom");
  });

  it("names the repeat kind of preset expressions", () => {
    expect(repeatKindOf("0 */6 * * *")).toBe("every6h");
    expect(repeatKindOf("0 2 * * *")).toBe("daily");
  });
});

describe("switchPreset", () => {
  it("carries the time over to the new kind", () => {
    expect(switchPreset("30 23 * * 5", "monthly")).toMatchObject({
      repeat: "monthly",
      hour: 23,
      minute: 30,
      weekday: 5,
      dayOfMonth: 1,
    });
  });

  it("starts from the defaults when the current schedule is custom", () => {
    expect(switchPreset("0 2 * * 1-5", "weekly")).toEqual({ ...DEFAULT_PRESET, repeat: "weekly" });
  });
});

describe("select options", () => {
  it("offers every half hour, plus a time in between when a plan has one", () => {
    const times = timeOptions(2, 0);
    expect(times).toHaveLength(48);
    expect(times[0]).toBe("00:00");
    expect(times.at(-1)).toBe("23:30");
    const withOdd = timeOptions(2, 15);
    expect(withOdd).toHaveLength(49);
    // Sorted into place, between 02:00 and 02:30.
    expect(withOdd.slice(4, 7)).toEqual(["02:00", "02:15", "02:30"]);
  });

  it("offers every 5 minutes, plus an odd minute when a plan has one", () => {
    expect(minuteOptions(0)).toHaveLength(12);
    expect(minuteOptions(17)).toEqual([0, 5, 10, 15, 17, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it("splits a time value", () => {
    expect(parseTimeValue("07:30")).toEqual({ hour: 7, minute: 30 });
  });

  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [22, "22nd"],
    [23, "23rd"],
    [28, "28th"],
  ])("writes day %i as %j", (day, text) => {
    expect(ordinal(day)).toBe(text);
  });

  it("knows which kinds repeat during the day", () => {
    expect(isHourlyKind("hourly")).toBe(true);
    expect(isHourlyKind("every12h")).toBe(true);
    expect(isHourlyKind("daily")).toBe(false);
    expect(isHourlyKind("custom")).toBe(false);
  });
});

describe("time zones", () => {
  it("suggests this browser's zone and UTC first, then groups the rest by region", () => {
    const groups = timeZoneGroups("Europe/Berlin", "America/New_York");
    const [suggested, ...regions] = groups;
    expect(suggested?.label).toBe("Suggested");
    expect(suggested?.zones.map((zone) => zone.value)).toEqual(["America/New_York", "UTC"]);
    expect(suggested?.zones[0]?.label).toMatch(/^America\/New York — this browser \(UTC/);
    // UTC's offset is zero, written as plain "UTC".
    expect(suggested?.zones[1]?.label).toBe("UTC (UTC)");

    const europe = regions.find((group) => group.label === "Europe");
    expect(europe?.zones.some((zone) => zone.value === "Europe/Berlin")).toBe(true);
    // Suggested zones are not listed twice.
    const all = groups.flatMap((group) => group.zones.map((zone) => zone.value));
    expect(all.filter((zone) => zone === "America/New_York")).toHaveLength(1);
    // Regions are sorted.
    const labels = regions.map((group) => group.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("keeps a zone the browser does not know, so a plan's value is never lost", () => {
    const [suggested] = timeZoneGroups("Mars/Olympus", "UTC");
    expect(suggested?.zones.map((zone) => zone.value)).toEqual(["UTC", "Mars/Olympus"]);
    // No offset can be worked out for it, so its label is just the name.
    expect(suggested?.zones[1]?.label).toBe("Mars/Olympus");
    expect(utcOffsetLabel("Mars/Olympus")).toBe("");
  });

  it("falls back to UTC when the browser cannot list its zones", () => {
    vi.spyOn(Intl, "supportedValuesOf").mockImplementation(() => {
      throw new RangeError("not supported");
    });
    const groups = timeZoneGroups("UTC", "UTC");
    expect(groups.map((group) => group.label)).toEqual(["Suggested"]);
    expect(groups[0]?.zones.map((zone) => zone.value)).toEqual(["UTC"]);
  });

  it("puts zones without a region under Other", () => {
    vi.spyOn(Intl, "supportedValuesOf").mockReturnValue(["EST", "Europe/Paris"]);
    const groups = timeZoneGroups("UTC", "UTC");
    expect(groups.map((group) => group.label)).toEqual(["Suggested", "Europe", "Other"]);
  });
});
