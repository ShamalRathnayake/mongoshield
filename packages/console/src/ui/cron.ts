/**
 * Cron previews for the plan editor: a plain-English description ("Every day at 02:00")
 * and the next few run times, computed in the browser while the user types.
 *
 * The server (croner, via the library's BackupScheduler) stays the authority on what a
 * schedule means. This parser covers the standard 5-field syntax — numbers, names,
 * `*`, ranges, steps and lists, plus `@daily`-style macros — which is what almost every
 * plan uses. Anything beyond that (`L`, `W`, `#`, `?`) is labelled "custom" and gets no
 * preview rather than a possibly wrong one.
 *
 * Time zones: matching happens on wall-clock time in the plan's zone (as cron does),
 * and each match is then converted to an instant with `Intl`. Around DST changes a
 * preview may be off by an hour; the server's schedule is still correct.
 */

/** Fields in cron order. */
const FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"] as const;

/** Allowed range per field. Day of week accepts 0–7, where 7 is Sunday like 0. */
const FIELD_RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Macros croner understands, expanded to their 5-field form. */
const MACROS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** A parsed expression: the allowed values of each field. */
export interface ParsedCron {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 = Sunday … 6 = Saturday (7 is folded into 0). */
  readonly daysOfWeek: ReadonlySet<number>;
  /** Whether day-of-month / day-of-week were `*` (affects how they combine). */
  readonly anyDayOfMonth: boolean;
  readonly anyDayOfWeek: boolean;
  /** The 5 raw fields, after macro expansion. */
  readonly fields: readonly string[];
}

/** Outcome of parsing: a schedule we can preview, one only the server understands, or an error. */
export type CronParse =
  | { readonly kind: "ok"; readonly cron: ParsedCron }
  | { readonly kind: "custom" }
  | { readonly kind: "invalid"; readonly message: string };

/** Parses a 5-field cron expression or macro. */
export function parseCron(expression: string): CronParse {
  const trimmed = expression.trim();
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    return {
      kind: "invalid",
      message: `A schedule has 5 fields (minute hour day-of-month month day-of-week); this has ${fields.length}.`,
    };
  }
  // Extensions we deliberately do not evaluate: leave them to the server.
  if (fields.some((field) => /[LW#?]/i.test(field.replace(/[A-Z]{3}/gi, "")))) {
    return { kind: "custom" };
  }

  const sets: Set<number>[] = [];
  for (let index = 0; index < 5; index += 1) {
    const field = fields[index] ?? "";
    const range = FIELD_RANGES[index] ?? [0, 0];
    const names = index === 3 ? MONTH_NAMES : index === 4 ? DAY_NAMES : undefined;
    const result = parseField(field, range, names, index === 3 ? 1 : 0);
    if (typeof result === "string") {
      return { kind: "invalid", message: `The ${FIELD_NAMES[index]} field ${result}.` };
    }
    sets.push(result);
  }

  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = sets;
  if (!minutes || !hours || !daysOfMonth || !months || !rawDaysOfWeek) {
    return { kind: "invalid", message: "The schedule could not be read." };
  }
  // 7 and 0 both mean Sunday.
  const daysOfWeek = new Set([...rawDaysOfWeek].map((day) => day % 7));
  return {
    kind: "ok",
    cron: {
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      anyDayOfMonth: fields[2] === "*",
      anyDayOfWeek: fields[4] === "*",
      fields,
    },
  };
}

/**
 * Parses one field (`*`, `5`, `1-5`, `*\/15`, `MON-FRI`, `1,15`) into its allowed values.
 * Returns a message (completing "The … field …") when it is invalid.
 */
function parseField(
  field: string,
  [min, max]: readonly [number, number],
  names: readonly string[] | undefined,
  nameOffset: number,
): Set<number> | string {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangeText = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return `has an invalid step "${stepText ?? ""}"`;

    let start: number;
    let end: number;
    if (rangeText === "*") {
      start = min;
      end = max;
    } else {
      const [startText = "", endText] = rangeText.split("-");
      const parsedStart = parseValue(startText, names, nameOffset);
      // `5/15` means "from 5 to the end, every 15".
      const parsedEnd =
        endText === undefined
          ? stepText === undefined
            ? parsedStart
            : max
          : parseValue(endText, names, nameOffset);
      if (parsedStart === undefined || parsedEnd === undefined) {
        return `has "${part}", which is not a number${names ? " or name" : ""}`;
      }
      start = parsedStart;
      end = parsedEnd;
    }
    if (start < min || end > max || start > end) {
      return `has "${part}", outside ${min}–${max}`;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/** `"5"` → 5; `"MON"` → 1; `"JAN"` → 1 (names are offset to the field's numbering). */
function parseValue(
  text: string,
  names: readonly string[] | undefined,
  nameOffset: number,
): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  const nameIndex = names?.indexOf(text.toUpperCase()) ?? -1;
  return nameIndex === -1 ? undefined : nameIndex + nameOffset;
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The single value of a set, or undefined when it has zero or several. */
function only(values: ReadonlySet<number>): number | undefined {
  return values.size === 1 ? [...values][0] : undefined;
}

/**
 * A plain-English description of common schedules, or `"Custom schedule"` when the
 * pattern is not one we can describe in a few words.
 */
export function describeCron(expression: string): string {
  const parsed = parseCron(expression);
  if (parsed.kind === "invalid") return "Invalid schedule";
  if (parsed.kind === "custom") return "Custom schedule";
  const { cron } = parsed;
  const [minuteField = "", hourField = "", dayField = "", monthField = "", weekdayField = ""] =
    cron.fields;
  const minute = only(cron.minutes);
  const hour = only(cron.hours);
  const everyDay = dayField === "*" && monthField === "*" && weekdayField === "*";

  // "*/15 * * * *"
  const minuteStep = /^\*\/(\d+)$/.exec(minuteField);
  if (minuteStep && hourField === "*" && everyDay) return `Every ${minuteStep[1]} minutes`;
  if (minuteField === "*" && hourField === "*" && everyDay) return "Every minute";

  // "15 * * * *" and "0 */6 * * *"
  const hourStep = /^\*\/(\d+)$/.exec(hourField);
  if (minute !== undefined && hourField === "*" && everyDay) {
    return `Every hour at minute ${minute}`;
  }
  if (minute !== undefined && hourStep && everyDay) {
    return `Every ${hourStep[1]} hours at minute ${minute}`;
  }

  if (minute === undefined || hour === undefined) return "Custom schedule";
  const time = `${pad(hour)}:${pad(minute)}`;

  if (everyDay) return `Every day at ${time}`;
  if (dayField === "*" && monthField === "*") {
    if (weekdayField === "1-5" || weekdayField.toUpperCase() === "MON-FRI") {
      return `Every weekday at ${time}`;
    }
    const days = [...cron.daysOfWeek].sort((a, b) => a - b).map((day) => DAY_LABELS[day]);
    return `Every ${days.join(", ")} at ${time}`;
  }
  const dayOfMonth = only(cron.daysOfMonth);
  if (dayOfMonth !== undefined && monthField === "*" && weekdayField === "*") {
    return `On day ${dayOfMonth} of every month at ${time}`;
  }
  return "Custom schedule";
}

// ---------------------------------------------------------------------------
// Next runs
// ---------------------------------------------------------------------------

/** Wall-clock fields of `instant` in `timeZone`, packed into a Date whose UTC fields hold them. */
function wallClock(instant: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")),
  );
}

/** Converts a wall-clock time in `timeZone` (packed as UTC fields) to the real instant. */
function fromWallClock(wall: Date, timeZone: string): Date {
  // offset = how far the zone's clock is ahead of UTC at that moment. Computing it at the
  // first guess and correcting once handles every zone except the skipped DST hour.
  const guess = wall.getTime();
  const offset = wallClock(new Date(guess), timeZone).getTime() - guess;
  const corrected = guess - offset;
  const correctedOffset = wallClock(new Date(corrected), timeZone).getTime() - corrected;
  return new Date(guess - correctedOffset);
}

/** Day matching follows cron: when both day fields are restricted, either may match. */
function dayMatches(cron: ParsedCron, wall: Date): boolean {
  const dayOfMonthOk = cron.daysOfMonth.has(wall.getUTCDate());
  const dayOfWeekOk = cron.daysOfWeek.has(wall.getUTCDay());
  if (cron.anyDayOfMonth && cron.anyDayOfWeek) return true;
  if (cron.anyDayOfMonth) return dayOfWeekOk;
  if (cron.anyDayOfWeek) return dayOfMonthOk;
  return dayOfMonthOk || dayOfWeekOk;
}

/**
 * The next `count` run times after `from`, or undefined when the expression is custom
 * or invalid (or the time zone is unknown to this browser).
 */
export function nextRuns(
  expression: string,
  timeZone: string,
  count: number,
  from: Date = new Date(),
): Date[] | undefined {
  const parsed = parseCron(expression);
  if (parsed.kind !== "ok") return undefined;
  const { cron } = parsed;

  let wall: Date;
  try {
    wall = wallClock(from, timeZone);
  } catch {
    return undefined;
  }
  // Start at the next whole minute.
  wall.setUTCSeconds(0, 0);
  wall.setUTCMinutes(wall.getUTCMinutes() + 1);

  const runs: Date[] = [];
  // Each iteration skips at least a minute and usually a whole hour, day or month, so
  // this bound covers several years of search for even the sparsest schedules.
  for (let guard = 0; guard < 200_000 && runs.length < count; guard += 1) {
    if (!cron.months.has(wall.getUTCMonth() + 1)) {
      wall = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1));
      continue;
    }
    if (!dayMatches(cron, wall)) {
      wall = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1));
      continue;
    }
    if (!cron.hours.has(wall.getUTCHours())) {
      wall.setUTCHours(wall.getUTCHours() + 1, 0);
      continue;
    }
    if (!cron.minutes.has(wall.getUTCMinutes())) {
      wall.setUTCMinutes(wall.getUTCMinutes() + 1);
      continue;
    }
    runs.push(fromWallClock(wall, timeZone));
    wall.setUTCMinutes(wall.getUTCMinutes() + 1);
  }
  return runs;
}
