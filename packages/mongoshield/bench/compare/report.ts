/**
 * Turning raw runs into the results file and the Markdown table: medians, units,
 * and the shape of bench/results/<scale>.json.
 */

import type { DatasetSummary } from "./dataset.ts";
import type { Measurement } from "./measure.ts";

const MIB = 1024 * 1024;

/** One backup + restore of one variant. */
export interface RunResult {
  readonly run: number;
  readonly backup: Measurement;
  readonly restore: Measurement | null;
  readonly outputBytes: number;
}

/** All runs of one variant and their medians. */
export interface VariantResult {
  readonly id: string;
  readonly label: string;
  readonly runs: readonly RunResult[];
  readonly median: {
    readonly backupWallMs: number;
    readonly backupPeakRssBytes: number;
    readonly backupCpuMs: number | null;
    readonly outputBytes: number;
    readonly restoreWallMs: number | null;
    readonly restorePeakRssBytes: number | null;
    readonly restoreCpuMs: number | null;
  };
}

/** The whole results file. */
export interface BenchmarkResults {
  readonly schema: 1;
  readonly scale: string;
  readonly startedAt: string;
  readonly durationSeconds: number;
  readonly runsPerVariant: number;
  readonly machine: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly dataset: DatasetSummary;
  readonly variants: readonly VariantResult[];
  /** Variants that could not run here (e.g. mongodump not installed) and why. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

/** The median of a non-empty list (the mean of the middle two for even lengths). */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** The median of the values that are not null, or null when all are. */
function medianOrNull(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : median(present);
}

/** Collects one variant's runs and computes its medians. */
export function summarizeVariant(
  id: string,
  label: string,
  runs: readonly RunResult[],
): VariantResult {
  return {
    id,
    label,
    runs,
    median: {
      backupWallMs: median(runs.map((run) => run.backup.wallMs)),
      backupPeakRssBytes: median(runs.map((run) => run.backup.peakRssBytes)),
      backupCpuMs: medianOrNull(runs.map((run) => run.backup.cpuMs)),
      outputBytes: median(runs.map((run) => run.outputBytes)),
      restoreWallMs: medianOrNull(runs.map((run) => run.restore?.wallMs ?? null)),
      restorePeakRssBytes: medianOrNull(runs.map((run) => run.restore?.peakRssBytes ?? null)),
      restoreCpuMs: medianOrNull(runs.map((run) => run.restore?.cpuMs ?? null)),
    },
  };
}

/** "12.3 s" */
function seconds(milliseconds: number | null): string {
  return milliseconds === null ? "n/a" : `${(milliseconds / 1000).toFixed(1)} s`;
}

/** "123 MiB", or "12.3 MiB" below 100 MiB (one decimal where it matters). */
function mebibytes(bytes: number | null): string {
  if (bytes === null) return "n/a";
  const value = bytes / MIB;
  return value >= 100 ? `${Math.round(value)} MiB` : `${value.toFixed(1)} MiB`;
}

/**
 * "12.3 s (11.9–14.0)": the median wall time with the fastest and slowest run, so a
 * noisy measurement is visible in the table instead of hidden behind its median.
 */
function secondsWithRange(median: number | null, runs: readonly (number | null)[]): string {
  const present = runs.filter((value): value is number => value !== null);
  if (median === null || present.length < 2) return seconds(median);
  const fastest = (Math.min(...present) / 1000).toFixed(1);
  const slowest = (Math.max(...present) / 1000).toFixed(1);
  return `${seconds(median)} (${fastest}–${slowest})`;
}

/**
 * The results as a Markdown table: one row per variant, medians (times also show the
 * range over all runs). "Size vs raw" is the backup's size relative to the
 * uncompressed BSON size of the data.
 */
export function markdownTable(results: BenchmarkResults): string {
  const raw = results.dataset.totalDataBytes;
  const lines = [
    "| Variant | Backup time | Backup CPU | Backup peak RSS | Backup size | Size vs raw | Restore time | Restore CPU | Restore peak RSS |",
    "|---|--:|--:|--:|--:|--:|--:|--:|--:|",
  ];
  for (const variant of results.variants) {
    const { median: values } = variant;
    const backupTimes = variant.runs.map((run) => run.backup.wallMs);
    const restoreTimes = variant.runs.map((run) => run.restore?.wallMs ?? null);
    const ratio = raw > 0 ? `${((values.outputBytes / raw) * 100).toFixed(0)}%` : "n/a";
    lines.push(
      `| ${variant.label} | ` +
        `${secondsWithRange(values.backupWallMs, backupTimes)} | ${seconds(values.backupCpuMs)} | ` +
        `${mebibytes(values.backupPeakRssBytes)} | ${mebibytes(values.outputBytes)} | ${ratio} | ` +
        `${secondsWithRange(values.restoreWallMs, restoreTimes)} | ${seconds(values.restoreCpuMs)} | ` +
        `${mebibytes(values.restorePeakRssBytes)} |`,
    );
  }
  return lines.join("\n");
}
