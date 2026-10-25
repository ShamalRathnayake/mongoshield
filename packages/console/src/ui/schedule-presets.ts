/**
 * Schedule presets for the plan editor: the "Repeat" choices people pick from instead
 * of writing cron by hand, and the time zone list for the zone select.
 *
 * A plan's schedule is still stored as a cron expression (the server's format). This
 * module converts both ways:
 *
 *   preset → cron   `presetToCron({ repeat: "weekly", weekday: 1, hour: 3, minute: 30 })`
 *                   gives "30 3 * * 1"
 *   cron → preset   `presetFromCron("30 3 * * 1")` gives that preset back, or undefined
 *                   when the expression is not one of the presets (then the editor
 *                   shows the cron field, "Custom").
 *
 * Matching compares what the expression MEANS (the parsed sets of minutes, hours and
 * days from cron.ts), not its text, so "@daily", "0 0 * * *" and "0 0 1-31 * *" all
 * read as "Every day at 00:00".
 */

import { parseCron } from "./cron.ts";

/** The "Repeat" choices, in the order the select lists them. */
export const REPEAT_KINDS = [
  "hourly",
  "every6h",
  "every12h",
  "daily",
  "weekly",
  "monthly",
  "custom",
] as const;

/** One "Repeat" choice. `custom` means "type a cron expression". */
export type RepeatKind = (typeof REPEAT_KINDS)[number];

/** A repeat choice that has its own controls (everything except `custom`). */
export type PresetKind = Exclude<RepeatKind, "custom">;

/** What each repeat choice is called in the select. */
export const REPEAT_LABELS: Readonly<Record<RepeatKind, string>> = {
  hourly: "Every hour",
  every6h: "Every 6 hours",
  every12h: "Every 12 hours",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  custom: "Custom (cron expression)",
};

/**
 * A schedule built from the preset controls. Every field is always present so that
 * switching between repeat kinds keeps the time, weekday and day the user chose; each
 * kind simply ignores the fields it does not use (hourly kinds ignore `hour`, and so on).
 */
export interface SchedulePreset {
  readonly repeat: PresetKind;
  /** 0–59: the minute of the hour it runs at. */
  readonly minute: number;
  /** 0–23: the hour of the day (daily, weekly and monthly). */
  readonly hour: number;
  /** 0 = Sunday … 6 = Saturday (weekly). */
  readonly weekday: number;
  /** 1–28 (monthly). 29–31 are left out because not every month has them. */
  readonly dayOfMonth: number;
}

/** The starting point for a schedule: every day at 02:00, Monday, the 1st. */
export const DEFAULT_PRESET: SchedulePreset = {
  repeat: "daily",
  minute: 0,
  hour: 2,
  weekday: 1,
  dayOfMonth: 1,
};

/** The highest day of the month the monthly preset offers (every month has a 28th). */
export const LAST_PRESET_DAY = 28;

/** Hours each "every N hours" kind repeats at: every 6 hours runs at 0, 6, 12 and 18. */
const HOUR_STEPS: Readonly<Partial<Record<PresetKind, number>>> = {
  hourly: 1,
  every6h: 6,
  every12h: 12,
};

/** True for the kinds that repeat during the day (they only use `minute`). */
export function isHourlyKind(repeat: RepeatKind): boolean {
  return HOUR_STEPS[repeat as PresetKind] !== undefined;
}

/** The cron expression for a preset, e.g. "30 3 * * 1" for Mondays at 03:30. */
export function presetToCron(preset: SchedulePreset): string {
  const { minute, hour, weekday, dayOfMonth } = preset;
  switch (preset.repeat) {
    case "hourly":
      return `${minute} * * * *`;
    case "every6h":
      return `${minute} */6 * * *`;
    case "every12h":
      return `${minute} */12 * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
  }
}

/** The single value of a set, or undefined when it has none or several. */
function onlyValue(values: ReadonlySet<number>): number | undefined {
  return values.size === 1 ? [...values][0] : undefined;
}

/** True when `values` is exactly 0, step, 2·step, … below 24 (the hours of "every N hours"). */
function isHourStep(values: ReadonlySet<number>, step: number): boolean {
  const expected = 24 / step;
  if (values.size !== expected) return false;
  for (let hour = 0; hour < 24; hour += step) if (!values.has(hour)) return false;
  return true;
}

/**
 * The preset an expression means, or undefined when it is not one of them (it then
 * stays "Custom"). Fields the expression does not decide (the weekday of a daily
 * schedule, say) take their value from `fallback`, so switching kinds afterwards starts
 * from sensible choices.
 */
export function presetFromCron(
  expression: string,
  fallback: SchedulePreset = DEFAULT_PRESET,
): SchedulePreset | undefined {
  const parsed = parseCron(expression);
  if (parsed.kind !== "ok") return undefined;
  const { cron } = parsed;

  // Every preset runs at one minute of the hour, in every month.
  const minute = onlyValue(cron.minutes);
  if (minute === undefined || cron.months.size !== 12) return undefined;

  // "Every day" in cron terms: both day fields allow every value.
  const everyDay = cron.daysOfMonth.size === 31 && cron.daysOfWeek.size === 7;

  // The kinds that repeat during the day: the hours are 0, N, 2N, … every day.
  if (everyDay) {
    for (const repeat of ["hourly", "every6h", "every12h"] as const) {
      const step = HOUR_STEPS[repeat] ?? 1;
      if (isHourStep(cron.hours, step)) return { ...fallback, repeat, minute };
    }
  }

  // The rest run once on the days they match, at one hour.
  const hour = onlyValue(cron.hours);
  if (hour === undefined) return undefined;
  if (everyDay) return { ...fallback, repeat: "daily", minute, hour };

  // Weekly: one weekday, with day-of-month left as "*". (When both day fields are
  // restricted, cron runs on either, which no preset describes.)
  const weekday = onlyValue(cron.daysOfWeek);
  if (cron.anyDayOfMonth && weekday !== undefined) {
    return { ...fallback, repeat: "weekly", minute, hour, weekday };
  }

  // Monthly: one day of the month that every month has, with day-of-week left as "*".
  const dayOfMonth = onlyValue(cron.daysOfMonth);
  if (cron.anyDayOfWeek && dayOfMonth !== undefined && dayOfMonth <= LAST_PRESET_DAY) {
    return { ...fallback, repeat: "monthly", minute, hour, dayOfMonth };
  }
  return undefined;
}

/** The "Repeat" choice for an expression: its preset kind, or "custom". */
export function repeatKindOf(expression: string): RepeatKind {
  return presetFromCron(expression)?.repeat ?? "custom";
}

/**
 * The preset to show when the user picks `repeat` in the select: the current schedule's
 * time, weekday and day carried over (when the current expression is a preset), else the
 * defaults.
 */
export function switchPreset(currentCron: string, repeat: PresetKind): SchedulePreset {
  const current = presetFromCron(currentCron) ?? DEFAULT_PRESET;
  return { ...current, repeat };
}

// ---------------------------------------------------------------------------
// Options for the selects
// ---------------------------------------------------------------------------

/** Two digits: 5 → "05". */
export function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** "HH:MM" for an hour and minute, the value of a time option. */
export function timeValue(hour: number, minute: number): string {
  return `${twoDigits(hour)}:${twoDigits(minute)}`;
}

/** Splits a "HH:MM" option value back into hour and minute. */
export function parseTimeValue(value: string): { hour: number; minute: number } {
  const [hour = "0", minute = "0"] = value.split(":");
  return { hour: Number(hour), minute: Number(minute) };
}

/**
 * Times of day for the time select: every half hour (00:00, 00:30 … 23:30), plus the
 * current time when it is between those (an existing plan at 02:15 keeps 02:15).
 */
export function timeOptions(hour: number, minute: number): string[] {
  const times: string[] = [];
  for (let at = 0; at < 24 * 60; at += 30) times.push(timeValue(Math.floor(at / 60), at % 60));
  const current = timeValue(hour, minute);
  if (!times.includes(current)) {
    times.push(current);
    // "HH:MM" strings sort in time order.
    times.sort();
  }
  return times;
}

/**
 * Minutes past the hour for the minute select: every 5 minutes (00, 05 … 55), plus the
 * current minute when it is between those (an existing plan at :17 keeps :17).
 */
export function minuteOptions(minute: number): number[] {
  const minutes: number[] = [];
  for (let at = 0; at < 60; at += 5) minutes.push(at);
  if (!minutes.includes(minute)) {
    minutes.push(minute);
    minutes.sort((a, b) => a - b);
  }
  return minutes;
}

/** Weekday names, indexed like cron (0 = Sunday), listed Monday first in the select. */
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Weekday numbers in the order the select lists them: Monday … Sunday. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** "1st", "2nd", "3rd", "4th" … "21st", "22nd", "28th". */
export function ordinal(day: number): string {
  const lastTwo = day % 100;
  // 11th, 12th and 13th are the exceptions to the last-digit rule.
  if (lastTwo >= 11 && lastTwo <= 13) return `${day}th`;
  const suffix = ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${day}${suffix}`;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/** One time zone option: the IANA name and how it is shown. */
export interface TimeZoneOption {
  readonly value: string;
  readonly label: string;
}

/** A group of time zone options (one `<optgroup>`). */
export interface TimeZoneGroup {
  readonly label: string;
  readonly zones: readonly TimeZoneOption[];
}

/** The zones this browser knows, or just UTC when it cannot list them. */
function supportedTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

/**
 * The zone's current offset from UTC, like "UTC+02:00" (or "UTC" for zero). Empty when
 * the browser cannot tell, so the label simply has no offset.
 */
export function utcOffsetLabel(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((candidate) => candidate.type === "timeZoneName");
    if (part === undefined) return "";
    // Browsers write "GMT+02:00", and zero as "GMT" or "GMT+00:00"; "UTC" is the
    // clearer word for people reading it.
    const offset = part.value.replace("GMT", "UTC");
    return offset === "UTC+00:00" ? "UTC" : offset;
  } catch {
    return "";
  }
}

/**
 * Offsets already worked out, by zone: the select lists about 400 zones and building an
 * `Intl.DateTimeFormat` for each is the slow part, so it is done once per page load.
 */
const offsetCache = new Map<string, string>();

/** "America/Argentina/Buenos_Aires" → "America/Argentina/Buenos Aires (UTC-03:00)". */
function zoneOption(zone: string, suffix = ""): TimeZoneOption {
  let offset = offsetCache.get(zone);
  if (offset === undefined) {
    offset = utcOffsetLabel(zone);
    offsetCache.set(zone, offset);
  }
  // The full name is kept (not just the city) so the closed select still says the region.
  const name = `${zone.replaceAll("_", " ")}${suffix}`;
  return { value: zone, label: offset === "" ? name : `${name} (${offset})` };
}

/**
 * The time zone select's options: a "Suggested" group first (this browser's zone and
 * UTC), then every zone the browser knows, grouped by region ("Europe", "America" …)
 * and sorted by name. `current` is always offered: a zone the browser does not list
 * (an old alias, or a typo in an imported plan) joins "Suggested", so an existing
 * plan's value is never silently replaced.
 */
export function timeZoneGroups(current: string, browserZone: string): TimeZoneGroup[] {
  const supported = supportedTimeZones();
  const suggested = [browserZone, "UTC"];
  if (current !== "" && !suggested.includes(current) && !supported.includes(current)) {
    suggested.push(current);
  }
  const groups: TimeZoneGroup[] = [
    {
      label: "Suggested",
      zones: [...new Set(suggested)].map((zone) =>
        zoneOption(zone, zone === browserZone ? " — this browser" : ""),
      ),
    },
  ];

  // Region → zones. Zones already suggested are not repeated below.
  const byRegion = new Map<string, TimeZoneOption[]>();
  for (const zone of supported) {
    if (suggested.includes(zone)) continue;
    const slash = zone.indexOf("/");
    // Names without a region ("EST", "GMT") go to "Other".
    const region = slash === -1 ? "Other" : zone.slice(0, slash);
    const zones = byRegion.get(region) ?? [];
    zones.push(zoneOption(zone));
    byRegion.set(region, zones);
  }
  const regions = [...byRegion.keys()].sort((a, b) => a.localeCompare(b));
  for (const region of regions) {
    const zones = byRegion.get(region) ?? [];
    zones.sort((a, b) => a.value.localeCompare(b.value));
    groups.push({ label: region, zones });
  }
  return groups;
}
