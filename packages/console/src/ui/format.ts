/**
 * Formatting helpers for numbers, sizes, durations and times shown in the UI.
 *
 * Everything uses the browser's locale through `Intl`, so separators and month names
 * match what the user expects. Absolute times are always paired with a relative one
 * ("Oct 21, 02:00 · 3 h ago") because ops people think in both.
 */

const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** `1234567` → `1,234,567`. */
export function formatNumber(value: number | undefined): string {
  return value === undefined ? "–" : integerFormat.format(value);
}

/** `1234567` → `1.2M`, for dense tables. */
export function formatCompact(value: number | undefined): string {
  return value === undefined ? "–" : compactFormat.format(value);
}

/** Binary units, because storage providers bill and display that way. */
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** `1536` → `1.5 KiB`. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "–";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** `95_000` → `1 min 35 s`; `3_600_000` → `1 h 0 min`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "–";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${seconds} s`;
  return `${seconds} s`;
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateTimeWithSecondsFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** ISO string → `Oct 21, 2026, 02:00` in the browser's time zone. */
export function formatDateTime(iso: string | undefined, withSeconds = false): string {
  if (iso === undefined) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (withSeconds ? dateTimeWithSecondsFormat : dateTimeFormat).format(date);
}

/** Formats a date in a named IANA time zone, e.g. for schedule previews. */
export function formatDateTimeInZone(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

/** Units from largest to smallest, with their length in seconds. */
const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** ISO string → `3 hr. ago` / `in 5 min.` relative to `now`. */
export function formatRelative(iso: string | undefined, now: number = Date.now()): string {
  if (iso === undefined) return "–";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const diffSeconds = Math.round((time - now) / 1000);
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(diffSeconds) >= seconds || unit === "second") {
      return relativeFormat.format(Math.round(diffSeconds / seconds), unit);
    }
  }
  return iso;
}

/** `"verification.ok"` style keys and enum values → `Verification ok` for display. */
export function humanize(value: string): string {
  const spaced = value.replace(/[._-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Pluralises simple English nouns: `plural(1, "plan")` → `1 plan`, `plural(2, "plan")` → `2 plans`. */
export function plural(count: number, noun: string): string {
  return `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}
