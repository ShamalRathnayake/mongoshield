/**
 * Recording restore drills next to the backup they drilled.
 *
 * Drills are annotations, like verification runs (src/catalog/annotations.ts),
 * and follow the same conventions: one small JSON object per run, outside the
 * immutable backup directory, named by time so a listing is chronological:
 *
 *   annotations/<backup id>/drills/<time>.json
 *
 * Pruning a backup deletes everything under `annotations/<backup id>/`, so drill
 * records disappear with their backup. The record's schema and its readers live
 * in the catalog (which shows the last drill in listings); only the writer is
 * here, because it is the one part that needs to know the drill report.
 */

import {
  type DrillRecord,
  DrillRecordSchema,
  drillRecordsPrefix,
  readDrills,
} from "../catalog/annotations.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { version } from "../version.ts";
import type { DrillReport } from "./drill.ts";

// Re-exported so existing imports of the drill record keep working.
export { type DrillRecord, DrillRecordSchema, drillRecordsPrefix, readDrills };

/**
 * Stores a summary of a drill. Problem details are not stored (only their count),
 * as for verifications: the report itself carries them, and annotations stay small.
 */
export async function recordDrill(
  storage: StorageAdapter,
  report: DrillReport,
  drilledAt: Date = new Date(),
): Promise<DrillRecord> {
  return storeDrillRecord(storage, drillRecordOf(report, drilledAt));
}

/** The stored summary of a drill report (upgrade rehearsals add their fields to it). */
export function drillRecordOf(report: DrillReport, drilledAt: Date): DrillRecord {
  return {
    backupId: report.backupId,
    drilledAt: drilledAt.toISOString(),
    ok: report.ok,
    restored: report.restored,
    restoreDurationMs: Math.max(0, Math.round(report.restoreDurationMs)),
    durationMs: Math.max(0, Math.round(report.durationMs)),
    namespaces: report.namespaces.length,
    documentsRestored: report.documentsRestored,
    problemCount: report.problems.length,
    tool: `mongoshield@${version}`,
  };
}

/** Writes a drill record under `annotations/<backup id>/drills/<time>.json`. */
export async function storeDrillRecord(
  storage: StorageAdapter,
  record: DrillRecord,
): Promise<DrillRecord> {
  // "2026-11-14T03:00:04.123Z" → "2026-11-14T03-00-04-123Z": safe in keys, still sortable.
  const stamp = record.drilledAt.replaceAll(":", "-").replace(".", "-");
  const body = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  await storage.put(`${drillRecordsPrefix(record.backupId)}${stamp}.json`, body, {
    contentType: "application/json",
    sizeHint: body.length,
  });
  return record;
}
