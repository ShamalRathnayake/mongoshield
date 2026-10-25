/**
 * The backup catalog: listing backups, selecting one, planning retention and pruning.
 *
 *   listBackups    what is in storage (complete / incomplete / invalid), newest first
 *   selectBackup   resolve "latest", an id, or { before } to one complete backup
 *   planRetention  pure keep/remove decision for a retention policy
 *   pruneBackups   list + plan + delete (optionally within one scope, see scope.ts)
 *   resolveChain   an incremental backup's chain back to its full base (chain.ts)
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
export {
  backupKindOf,
  type ChainInspection,
  type ChainProblem,
  chainAncestorIds,
  chainEndTime,
  chainPositionOf,
  chainUntil,
  inspectChain,
  type ResolvedChain,
  resolveChain,
} from "./chain.ts";
export {
  type DeleteBackupOptions,
  type DeleteBackupResult,
  deleteBackupById,
  dependentsOf,
} from "./delete.ts";
export type { OutOfScopeBackup, OutOfScopeReason, PruneOptions, PruneResult } from "./prune.ts";
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
export {
  type BackupOrigin,
  describeScope,
  isInScope,
  PLAN_LABEL,
  type PruneScope,
  validateScope,
} from "./scope.ts";
export { selectBackup } from "./select.ts";
