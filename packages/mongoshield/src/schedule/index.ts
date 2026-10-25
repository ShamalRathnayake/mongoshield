/**
 * Running backups unattended: the scheduled job, the cron scheduler, job locks
 * and retries. See docs/guides/scheduling.md.
 *
 *   runScheduledJob   one run: lock → backup (+ guard) → verify → prune → notify → unlock
 *   BackupScheduler   runs a job on a cron schedule, with jitter and graceful shutdown
 *   storageLock / mongoLock / noLock   lease locks that keep runners from overlapping
 */

export {
  type AcquireResult,
  createLockOwner,
  DEFAULT_LEASE_MS,
  type JobLock,
  type KeepAliveOptions,
  keepLeaseAlive,
  type Lease,
  type LeaseInfo,
  type LeaseKeeper,
  type LockKind,
  type LockOwner,
  noLock,
} from "./lock.ts";
export {
  MONGO_LOCK_COLLECTION,
  MONGO_LOCK_DATABASE,
  type MongoLockOptions,
  mongoLock,
} from "./lock-mongo.ts";
export { type StorageLockOptions, storageLock } from "./lock-storage.ts";
export {
  RUN_REPORT_VERSION,
  type RunReport,
  type RunStatus,
  type RunStep,
  type ScheduledVerifyMode,
  summarizeReport,
  verifyLabel,
} from "./report.ts";
export {
  backoffDelay,
  DEFAULT_RETRY_POLICY,
  isTransientError,
  type RetryPolicy,
  TRANSIENT_ERROR_CODES,
  withRetries,
} from "./retry.ts";
export { runScheduledJob, type ScheduledJobOptions, type ScheduledShield } from "./runner.ts";
export {
  BackupScheduler,
  DEFAULT_GRACE_MS,
  parseCron,
  type SchedulerOptions,
  type StopOptions,
} from "./scheduler.ts";
