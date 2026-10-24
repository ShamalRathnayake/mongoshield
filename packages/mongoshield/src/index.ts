// biome-ignore-all assist/source/organizeImports: exports are grouped by topic so the public API reads like a table of contents.

/**
 * MongoShield: backup, restore and copy MongoDB from Node.js.
 *
 * Public entry point. Everything exported here is covered by semver.
 * Storage adapters and cloud KMS support live in their own entry points, so
 * their dependencies load only when used:
 *   mongoshield/storage/file   mongoshield/storage/s3     mongoshield/storage/gcs
 *   mongoshield/storage/azure  mongoshield/storage/sftp   mongoshield/storage/memory
 *   mongoshield/kms            mongoshield/testing
 */

// The main class.
export { MongoShield, type ShieldPruneOptions } from "./shield.ts";

// Options and results of the high-level API.
export type {
  BackupOptions,
  BackupResult,
  BackupSelector,
  CheckpointedBackupResult,
  CompletedBackupResult,
  CompletingBackupOptions,
  DecryptionOptions,
  EncryptionOptions,
  KmsKeyRef,
  PointInTimeResult,
  MongoShieldOptions,
  NamespacePattern,
  ProgressEvent,
  ReadPreferenceModeName,
  RestoreMode,
  RestoreOptions,
  RestorePlan,
  RestorePlanEntry,
  RestoreResult,
  SearchIndexRef,
  SearchIndexReport,
  SourceOptions,
  UsersAndRolesMode,
  UsersAndRolesReport,
  VerifyMode,
  VerifyOptions,
  VerifyProblem,
  VerifyReport,
} from "./types.ts";

// Restore drills (shield.drill) and OpenTelemetry settings.
export type {
  DrillAssertion,
  DrillAssertionInfo,
  DrillAssertions,
  DrillDatabase,
  DrillNamespaceReport,
  DrillOptions,
  DrillProblem,
  DrillReport,
  ShieldDrillOptions,
} from "./engine/drill.ts";
export { type DrillRecord, readDrills } from "./catalog/annotations.ts";
export type { TelemetryOptions } from "./types.ts";

// The backup catalog and retention.
export type { HoldRecord, VerificationRecord } from "./catalog/annotations.ts";
export { type CatalogEntry, type CatalogStatus, listBackups } from "./catalog/catalog.ts";
export { selectBackup } from "./catalog/select.ts";
export type { OutOfScopeBackup, OutOfScopeReason, PruneResult } from "./catalog/prune.ts";
export { type PruneScope, PLAN_LABEL } from "./catalog/scope.ts";
export {
  type KeptBackup,
  planRetention,
  type RemovedBackup,
  type RetentionPlan,
  type RetentionPolicy,
} from "./catalog/retention.ts";

// Running backups unattended: scheduled jobs, the cron scheduler and job locks.
export {
  BackupScheduler,
  mongoLock,
  noLock,
  type RunReport,
  type RunStatus,
  runScheduledJob,
  type ScheduledJobOptions,
  type ScheduledVerifyMode,
  type SchedulerOptions,
  storageLock,
  summarizeReport,
} from "./schedule/index.ts";

// Point-in-time recovery: the change journal.
export * from "./journal/index.ts";

// Notifications (webhooks, Slack, Discord, heartbeats).
export { type NotifyTarget, notifyRun, pingHeartbeat, sendWebhook } from "./notify/index.ts";

// The backup guard: refuse backups that look like data was lost.
export {
  type BackupGuardPolicy,
  type BeforeCommitHook,
  backupShapeLabel,
  checkBackupSanity,
  GUARD_SHAPE_LABEL,
  type GuardFinding,
  type GuardResult,
} from "./engine/backup-guard.ts";

// Finding documents inside a backup, and restoring just those.
export type { FindInBackupOptions } from "./engine/find.ts";
export type {
  RestoreDocumentsMode,
  RestoreDocumentsOptions,
  RestoreDocumentsResult,
  ShieldRestoreDocumentsOptions,
} from "./engine/find-restore.ts";

// Recovery recipes: one tenant, a document's history, diffs, text exports.
export type {
  RestoreTenantOptions,
  RestoreTenantResult,
  ShieldRestoreTenantOptions,
  TenantRestoreMode,
} from "./extras/tenant-restore.ts";
export type { DocumentHistory, DocumentHistoryOptions, HistoryVersion } from "./extras/history.ts";
export type { DiffOptions, DiffResult, NamespaceDiff } from "./extras/diff.ts";
export type {
  ExportDocumentsOptions,
  ExportDocumentsResult,
  TextExportFormat,
} from "./extras/export-text.ts";

// Before/after migrations, GDPR erasure, off-site copies and key rotation.
export {
  rollback,
  type RollbackOptions,
  type RollbackResult,
  snapshot,
  type SnapshotOptions,
} from "./extras/snapshot.ts";
export {
  type ApplyErasuresResult,
  applyErasures,
  type ErasureRecord,
  eraseLiveDocuments,
  listErasures,
  recordErasure,
  type RecordErasureOptions,
} from "./extras/erasure.ts";
export {
  type ReplicateOptions,
  type ReplicateResult,
  replicateBackups,
  replicateToTargets,
} from "./extras/replicate.ts";
export {
  type RekeyBackupResult,
  rekeyBackups,
  type RekeyOptions,
  type RekeyResult,
} from "./extras/rekey.ts";
export type { BackupSelection } from "./extras/stored-files.ts";
export type { RekeyRecord } from "./catalog/rekey-records.ts";

// Copying between deployments, with masking and subsetting (staging and local data).
export type {
  CopyOptions,
  CopyPlan,
  CopyPlanEntry,
  CopyResult,
  CopyResumeState,
} from "./types.ts";
export {
  defineMask,
  type FakeKind,
  type MaskConfig,
  type MaskFunction,
  type MaskFunctionContext,
  type MaskReport,
  type MaskRule,
} from "./mask/index.ts";
export { defineSubset, type FollowRule, type SubsetConfig } from "./subset/index.ts";

// Moving data in and out of mongodump's formats.
export {
  type ExportSummary,
  exportBackup,
  type ImportResult,
  importMongodump,
} from "./interop/index.ts";

// Config files.
export { defineConfig } from "./config/define.ts";
export { validateConfig } from "./config/load.ts";
export {
  ConfigSchema,
  type MongoShieldConfig,
  type MongoShieldConfigInput,
} from "./config/schema.ts";

// Encryption keys (age format).
export {
  type GeneratedIdentity,
  generateIdentity,
  identityToRecipient,
  parseIdentityFile,
} from "./crypto/keys.ts";

// Errors.
export {
  ERROR_CODES,
  type ErrorCode,
  isMongoShieldError,
  MongoShieldError,
  type MongoShieldErrorOptions,
} from "./errors.ts";

// The on-disk format.
export {
  type Compression,
  type ConsistencyMode,
  MANIFEST_FORMAT_VERSION,
  type Manifest,
  ManifestSchema,
  type NamespaceEntry,
  type StoredFile,
} from "./format/manifest.ts";

// Logging.
export { fromPino, type LogFields, type Logger, type PinoLike, silentLogger } from "./logger.ts";

// Opening storage from a URL (`s3://…`, `gs://…`, `az://…`, `sftp://…`, paths).
export { resolveStorage, SUPPORTED_STORAGE_SCHEMES } from "./storage/resolve.ts";

// Keeping secrets out of logs and messages.
export { redactMongoUri, redactSecrets } from "./redact.ts";

// Writing your own storage adapter.
export type {
  GetOptions,
  ObjectInfo,
  PutOptions,
  RetentionMode,
  RetentionOptions,
  StorageAdapter,
  StorageCapabilities,
} from "./storage/types.ts";

export { version } from "./version.ts";
