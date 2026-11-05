/**
 * Warnings a storage adapter can report about itself, for the engine to log and add
 * to `BackupResult.warnings`.
 *
 * The StorageAdapter contract has no warnings method, so this is an optional extra
 * an adapter may provide: `warnings(): readonly string[]` (e.g. a sign-in about to
 * expire). Adapters without it report nothing.
 */

import type { StorageAdapter } from "./types.ts";

/** The adapter's current warnings, or none when it does not report any. */
export function storageWarnings(storage: StorageAdapter): readonly string[] {
  const report: unknown = (storage as { warnings?: unknown }).warnings;
  if (typeof report !== "function") return [];
  const warnings: unknown = report.call(storage);
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning): warning is string => typeof warning === "string");
}
