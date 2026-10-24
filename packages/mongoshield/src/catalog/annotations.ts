/**
 * Annotations: facts about a backup learned after it was written.
 *
 * A backup's manifest is immutable (it may even sit under object lock), so
 * anything we learn later is stored as separate small JSON objects:
 *
 *   annotations/<backup id>/verifications/<time>-<mode>.json   one per verify run
 *   annotations/<backup id>/drills/<time>.json                 one per restore drill
 *   annotations/<backup id>/hold.json                          present while the backup is on hold
 *   annotations/<backup id>/rekey/<time>.json                  one per rekey (see rekey-records.ts)
 *
 * They live outside `backups/<id>/` on purpose: a backup directory then stays a
 * pure mongodump-layout directory that `mongorestore` can read directly.
 *
 * Retention uses them: a verified backup counts towards `minVerified`, and a
 * held backup is never pruned.
 *
 * Drill records are written by the drill engine (src/engine/drill-record.ts, which
 * knows the drill report); their schema and readers live here so the catalog can
 * show them without depending on the engine.
 */

import { z } from "zod";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { VerifyReport } from "../types.ts";
import { readStreamToBuffer } from "../util/streams.ts";
import { version } from "../version.ts";
import { type RekeyRecord, RekeyRecordSchema } from "./rekey-records.ts";

/** Every annotation lives under this prefix. */
export const ANNOTATIONS_PREFIX = "annotations/";

/** Annotations are tiny; refuse anything big enough to be a mistake. */
const MAX_ANNOTATION_BYTES = 1024 * 1024;

export const VerificationRecordSchema = z.object({
  backupId: z.string(),
  verifiedAt: z.iso.datetime({ offset: true }),
  mode: z.enum(["fast", "deep"]),
  ok: z.boolean(),
  filesChecked: z.number().int().nonnegative(),
  documentsChecked: z.number().int().nonnegative(),
  problemCount: z.number().int().nonnegative(),
  tool: z.string(),
});

export const HoldRecordSchema = z.object({
  backupId: z.string(),
  heldAt: z.iso.datetime({ offset: true }),
  /** Why the backup must be kept, e.g. "legal hold: case 4471". */
  reason: z.string().min(1),
  /** Who placed the hold, if known. */
  by: z.string().optional(),
});

/** The stored summary of one restore drill. */
export const DrillRecordSchema = z.object({
  backupId: z.string(),
  drilledAt: z.iso.datetime({ offset: true }),
  ok: z.boolean(),
  /** Whether the restore itself completed. */
  restored: z.boolean(),
  /** The measured recovery time (RTO): how long the restore took. */
  restoreDurationMs: z.number().int().nonnegative(),
  /** The whole drill, checks and cleanup included. */
  durationMs: z.number().int().nonnegative(),
  namespaces: z.number().int().nonnegative(),
  documentsRestored: z.number().int().nonnegative(),
  problemCount: z.number().int().nonnegative(),
  tool: z.string(),
  /**
   * Upgrade rehearsals only (`mongoshield rehearse-upgrade`): the MongoDB version the
   * backup was restored into, as the server reported it (e.g. `8.0.13`). Absent for
   * ordinary drills, so older readers and records stay compatible.
   */
  targetVersion: z.string().optional(),
  /** Upgrade rehearsals only: the source version recorded in the manifest. */
  sourceVersion: z.string().optional(),
  /** Upgrade rehearsals only: the static compatibility findings, counted by severity. */
  compatibility: z
    .object({
      problems: z.number().int().nonnegative(),
      warnings: z.number().int().nonnegative(),
    })
    .optional(),
});

/** The result of one verification run, as stored. */
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;
/** The stored summary of one restore drill. */
export type DrillRecord = z.infer<typeof DrillRecordSchema>;
/** A hold that protects a backup from pruning. */
export type HoldRecord = z.infer<typeof HoldRecordSchema>;

/** Everything annotated about one backup. */
export interface BackupAnnotations {
  /** Every verification run, oldest first. */
  readonly verifications: readonly VerificationRecord[];
  /** The newest verification run, if any. */
  readonly lastVerification: VerificationRecord | undefined;
  /** Every restore drill, newest first. */
  readonly drills: readonly DrillRecord[];
  /** The newest restore drill, if any. */
  readonly lastDrill: DrillRecord | undefined;
  /** Present while the backup is on hold. */
  readonly hold: HoldRecord | undefined;
  /** Rekeys of the backup's encryption (pending and complete), oldest first. */
  readonly rekeys: readonly RekeyRecord[];
}

/** Directory of one backup's annotations. */
function annotationsDir(backupId: string): string {
  return `${ANNOTATIONS_PREFIX}${backupId}/`;
}

function holdKey(backupId: string): string {
  return `${annotationsDir(backupId)}hold.json`;
}

/** Where one backup's drill records live. */
export function drillRecordsPrefix(backupId: string): string {
  return `${annotationsDir(backupId)}drills/`;
}

/**
 * Stores the outcome of a verification run. File names start with the time,
 * so listing them returns runs in chronological order.
 */
export async function recordVerification(
  storage: StorageAdapter,
  report: VerifyReport,
  verifiedAt: Date = new Date(),
): Promise<VerificationRecord> {
  const record: VerificationRecord = {
    backupId: report.backupId,
    verifiedAt: verifiedAt.toISOString(),
    mode: report.mode,
    ok: report.ok,
    filesChecked: report.filesChecked,
    documentsChecked: report.documentsChecked,
    problemCount: report.problems.length,
    tool: `mongoshield@${version}`,
  };
  // "2026-11-14T03:00:04.123Z" → "2026-11-14T03-00-04-123Z": safe in keys, still sortable.
  const stamp = record.verifiedAt.replaceAll(":", "-").replace(".", "-");
  const key = `${annotationsDir(report.backupId)}verifications/${stamp}-${report.mode}.json`;
  await putJson(storage, key, record);
  return record;
}

/** Places a hold on a backup so retention never deletes it. Replaces an existing hold. */
export async function placeHold(
  storage: StorageAdapter,
  backupId: string,
  details: { readonly reason: string; readonly by?: string },
): Promise<HoldRecord> {
  if (details.reason.trim() === "") {
    throw new MongoShieldError("MS_CONFIG_INVALID", "A hold needs a reason.", {
      hint: 'Say why the backup must be kept, e.g. --reason "audit 2026".',
    });
  }
  const record: HoldRecord = {
    backupId,
    heldAt: new Date().toISOString(),
    reason: details.reason,
    ...(details.by ? { by: details.by } : {}),
  };
  await putJson(storage, holdKey(backupId), record);
  return record;
}

/** Removes a backup's hold. Does nothing if there is none. */
export async function releaseHold(storage: StorageAdapter, backupId: string): Promise<void> {
  await storage.delete([holdKey(backupId)]);
}

/**
 * Reads every annotation of a backup. Unreadable annotation files are skipped
 * rather than failing: a broken verification record must never block a restore
 * or a listing. (A broken hold file still counts as a hold, to stay safe.)
 */
export async function readAnnotations(
  storage: StorageAdapter,
  backupId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<BackupAnnotations> {
  const verifications: VerificationRecord[] = [];
  const drills: DrillRecord[] = [];
  let hold: HoldRecord | undefined;
  const rekeys: RekeyRecord[] = [];

  for await (const object of storage.list(annotationsDir(backupId), options)) {
    if (object.key === holdKey(backupId)) {
      hold = (await readJson(storage, object.key, HoldRecordSchema)) ?? {
        // The file exists but is unreadable: keep protecting the backup.
        backupId,
        heldAt: object.lastModified.toISOString(),
        reason: "hold file is unreadable; treated as held",
      };
    } else if (object.key.includes("/verifications/")) {
      const record = await readJson(storage, object.key, VerificationRecordSchema);
      if (record) verifications.push(record);
    } else if (object.key.startsWith(drillRecordsPrefix(backupId))) {
      const record = await readJson(storage, object.key, DrillRecordSchema);
      if (record) drills.push(record);
    } else if (object.key.includes("/rekey/")) {
      const record = await readJson(storage, object.key, RekeyRecordSchema);
      if (record) rekeys.push(record);
    }
  }

  verifications.sort((a, b) => Date.parse(a.verifiedAt) - Date.parse(b.verifiedAt));
  drills.sort(newestDrillFirst);
  rekeys.sort((a, b) => Date.parse(a.rekeyedAt) - Date.parse(b.rekeyedAt));
  return {
    verifications,
    lastVerification: verifications.at(-1),
    drills,
    lastDrill: drills[0],
    hold,
    rekeys,
  };
}

/**
 * Reads every drill record of a backup, oldest first (as `readAnnotations` orders
 * verifications; its `drills` are newest first). Unreadable records are skipped:
 * a broken annotation must never break a listing.
 */
export async function readDrills(
  storage: StorageAdapter,
  backupId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<DrillRecord[]> {
  const records: DrillRecord[] = [];
  for await (const object of storage.list(drillRecordsPrefix(backupId), options)) {
    const record = await readJson(storage, object.key, DrillRecordSchema);
    if (record !== undefined) records.push(record);
  }
  return records.sort(newestDrillFirst).reverse();
}

/** Sort order for drill records: the most recent drill first. */
function newestDrillFirst(a: DrillRecord, b: DrillRecord): number {
  return Date.parse(b.drilledAt) - Date.parse(a.drilledAt);
}

/** Deletes every annotation of a backup (used when the backup itself is pruned). */
export async function deleteAnnotations(storage: StorageAdapter, backupId: string): Promise<void> {
  const keys: string[] = [];
  for await (const object of storage.list(annotationsDir(backupId))) keys.push(object.key);
  if (keys.length > 0) await storage.delete(keys);
}

async function putJson(storage: StorageAdapter, key: string, value: unknown): Promise<void> {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await storage.put(key, body, { contentType: "application/json", sizeHint: body.length });
}

/** Reads and validates a JSON annotation; `undefined` if it is missing or malformed. */
async function readJson<T>(
  storage: StorageAdapter,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    const bytes = await readStreamToBuffer(await storage.get(key), {
      maxBytes: MAX_ANNOTATION_BYTES,
    });
    const parsed = schema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")) {
      return undefined;
    }
    throw error;
  }
}
