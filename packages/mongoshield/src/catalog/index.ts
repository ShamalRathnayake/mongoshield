/**
 * The backup catalog: listing backups, selecting one, planning retention and pruning.
 *
 *   listBackups    what is in storage (complete / incomplete / invalid), newest first
 *   selectBackup   resolve "latest", an id, or { before } to one complete backup
 *   planRetention  pure keep/remove decision for a retention policy
 *   pruneBackups   list + plan + delete
 */

export {
  ANNOTATIONS_PREFIX,
  type BackupAnnotations,
  type DrillRecord,
  deleteAnnotations,
  type HoldRecord,
  placeHold,
  readAnnotations,
  readDrills,
  recordVerification,
  releaseHold,
  type VerificationRecord,
} from "./annotations.ts";
export type { CatalogEntry, CatalogStatus, ListBackupsOptions } from "./catalog.ts";
export { completedAtOf, immutableUntilOf, listBackups } from "./catalog.ts";
export type { PruneOptions, PruneResult } from "./prune.ts";
export { pruneBackups } from "./prune.ts";
export type {
  KeptBackup,
  RemovedBackup,
  RetentionBackup,
  RetentionBucket,
  RetentionInput,
  RetentionPlan,
  RetentionPolicy,
} from "./retention.ts";
export {
  DEFAULT_INCOMPLETE_GRACE_MS,
  hasAnyCount,
  isoWeekOf,
  periodOf,
  planRetention,
  selectByPeriod,
} from "./retention.ts";
export { selectBackup } from "./select.ts";
