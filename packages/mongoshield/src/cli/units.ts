/**
 * Parsing human-friendly sizes and durations from flags, e.g.
 * `--part-size 256MiB`, `--max-bytes-per-second 50MB`, `--max-duration 14m`.
 *
 * Sizes: a number with an optional unit. `KiB`, `MiB`, `GiB`, `TiB` are powers of
 * 1024; `KB`, `MB`, `GB`, `TB` are powers of 1000 (as storage vendors count); a
 * plain number is bytes. Units are case-insensitive.
 *
 * Durations: one or more `<number><unit>` pieces, `ms`, `s`, `m` or `h`, e.g.
 * `90s`, `14m`, `1h30m`. A unit is required: a bare `15` could mean seconds or
 * minutes, and guessing wrong would make a 15-minute budget last 15 seconds.
 */

const SIZE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parses a size such as `256MiB` into whole bytes, or `undefined` if it is not one.
 */
export function parseByteSize(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
  if (match === null) return undefined;
  const [, amount = "", unit = ""] = match;
  const multiplier = unit === "" ? 1 : SIZE_UNITS[unit.toLowerCase()];
  if (multiplier === undefined) return undefined;
  const bytes = Math.round(Number(amount) * multiplier);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

/**
 * Parses a duration such as `14m` or `1h30m` into milliseconds, or `undefined` if
 * it is not one.
 */
export function parseDuration(text: string): number | undefined {
  const compact = text.trim().toLowerCase();
  if (!/^(\d+(?:\.\d+)?(ms|s|m|h))+$/.test(compact)) return undefined;
  let total = 0;
  for (const piece of compact.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    const [, amount = "", unit = ""] = piece;
    total += Number(amount) * (DURATION_UNITS[unit] ?? 0);
  }
  const milliseconds = Math.round(total);
  return milliseconds > 0 ? milliseconds : undefined;
}
