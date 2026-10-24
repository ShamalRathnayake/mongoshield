/**
 * Human-friendly formatting of sizes, counts, durations and dates for CLI output.
 *
 * All functions are pure and locale-independent (fixed English formats), so
 * output is the same on every machine and easy to assert in tests.
 */

/** Binary units: storage tools (and disks) report in powers of 1024. */
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** `1536` → `"1.5 KiB"`, `0` → `"0 B"`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // Whole bytes never need decimals; larger units get one, which is enough to compare.
  const digits = unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

const integerFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** `1234567` → `"1,234,567"`. */
export function formatCount(count: number): string {
  return integerFormat.format(count);
}

/** `"1 namespace"` / `"3 namespaces"`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

/** `850` → `"850ms"`, `12_300` → `"12.3s"`, `245_000` → `"4m 05s"`, hours as `"1h 02m"`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

  const seconds = Math.floor(totalSeconds % 60);
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${pad2(seconds)}s`;

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${pad2(minutes)}m`;
}

/** `"2026-10-20 14:03"` in the machine's local time zone. */
export function formatLocalDate(date: Date): string {
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Steps for relative times: below the limit, express the gap in this unit. */
const RELATIVE_STEPS = [
  { limitMs: 60_000, unitMs: 1000, suffix: "s" },
  { limitMs: 3_600_000, unitMs: 60_000, suffix: "m" },
  { limitMs: 86_400_000, unitMs: 3_600_000, suffix: "h" },
  { limitMs: 60 * 86_400_000, unitMs: 86_400_000, suffix: "d" },
  { limitMs: 730 * 86_400_000, unitMs: 30 * 86_400_000, suffix: "mo" },
] as const;

/** `"just now"`, `"5m ago"`, `"3d ago"`, `"in 2h"` (for clocks that disagree). */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const gap = now.getTime() - date.getTime();
  const distance = Math.abs(gap);
  if (distance < 10_000) return "just now";

  let amount = `${Math.floor(distance / (365 * 86_400_000))}y`;
  for (const step of RELATIVE_STEPS) {
    if (distance < step.limitMs) {
      amount = `${Math.floor(distance / step.unitMs)}${step.suffix}`;
      break;
    }
  }
  return gap >= 0 ? `${amount} ago` : `in ${amount}`;
}

/** `"2026-10-20 14:03 (3h ago)"`. */
export function formatDateWithRelative(date: Date, now: Date = new Date()): string {
  return `${formatLocalDate(date)} (${formatRelative(date, now)})`;
}

/** `raw / stored` as `"4.2×"`, or `"–"` when nothing was stored. */
export function formatRatio(raw: number, stored: number): string {
  if (stored <= 0) return "–";
  return `${(raw / stored).toFixed(1)}×`;
}

/** A rate such as `"4.1k docs/s"`. */
export function formatRate(count: number, elapsedMs: number, unit: string): string {
  if (elapsedMs <= 0) return `– ${unit}/s`;
  const perSecond = count / (elapsedMs / 1000);
  return `${compactNumber(perSecond)} ${unit}/s`;
}

/** `"12"`, `"4.1k"`, `"2.3M"`: short numbers for progress lines. */
export function compactNumber(value: number): string {
  if (value < 1000) return value.toFixed(0);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
