/**
 * TypeScript shapes of the three custom resources: MongoShieldBackupPlan,
 * MongoShieldBackup and MongoShieldRestore.
 *
 * These mirror the OpenAPI schemas in crds.ts (which is what the API server
 * validates against). Every field is documented there too; the docs here say how
 * the operator uses each one. Keep the two files in step: crds.test.ts checks that
 * the example objects in the tests satisfy both.
 */

import type {
  V1Affinity,
  V1EnvFromSource,
  V1EnvVar,
  V1ResourceRequirements,
  V1Toleration,
} from "@kubernetes/client-node";
import type { Condition, KubeObject } from "../kube/objects.ts";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** A key in a Secret in the same namespace as the object that references it. */
export interface SecretKeyRef {
  readonly name: string;
  /** Defaults depend on the field (e.g. MONGODB_URI for connection strings). */
  readonly key?: string;
}

/** A whole Secret in the same namespace, exposed to job pods as environment variables. */
export interface SecretRef {
  readonly name: string;
}

/** A reference to another object of a known kind in the same namespace. */
export interface LocalObjectRef {
  readonly name: string;
}

/** The `ready`/`complete` summary every MongoShield status carries. */
export interface CommonStatus {
  /** The `metadata.generation` this status describes; older means "not yet looked at". */
  observedGeneration?: number;
  /** Conditions per the Kubernetes API conventions; the authoritative state. */
  conditions?: Condition[];
}

/** How a backup is verified after it is taken. */
export type VerifyMode = "none" | "fast" | "deep" | "drill";

/** Settings for the pods of the Jobs a plan's runs and restores use. */
export interface JobTemplateSettings {
  /** The MongoShield image; defaults to the image the operator was installed with. */
  readonly image?: string;
  readonly imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  readonly imagePullSecrets?: readonly LocalObjectRef[];
  /** For cloud identity (IRSA, GKE / Azure Workload Identity). Defaults to `default`. */
  readonly serviceAccountName?: string;
  readonly resources?: V1ResourceRequirements;
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly tolerations?: readonly V1Toleration[];
  readonly affinity?: V1Affinity;
  readonly podLabels?: Readonly<Record<string, string>>;
  readonly podAnnotations?: Readonly<Record<string, string>>;
  /** Kill a run after this many seconds. Defaults to 6 hours. */
  readonly activeDeadlineSeconds?: number;
  /** Pod retries at the Kubernetes level. Defaults to 0 (MongoShield retries inside a run). */
  readonly backoffLimit?: number;
  /** Delete finished Jobs after this many seconds. Defaults to 1 day. */
  readonly ttlSecondsAfterFinished?: number;
  readonly env?: readonly V1EnvVar[];
  readonly envFrom?: readonly V1EnvFromSource[];
}

// ---------------------------------------------------------------------------
// MongoShieldBackupPlan
// ---------------------------------------------------------------------------

/** What to back up, where to, how, and when. */
export interface BackupPlanSpec {
  readonly source: {
    /** The connection string of the deployment to back up. */
    readonly uriSecretRef: SecretKeyRef;
  };
  readonly storage: {
    /** A storage URL (`s3://bucket/prefix`, `gs://…`, `azure://…`) or an absolute path. */
    readonly url: string;
    /** Cloud credentials as environment variables (AWS_ACCESS_KEY_ID, …), if not using workload identity. */
    readonly credentialsSecretRef?: SecretRef;
    /** A PersistentVolumeClaim to mount, for path storage. */
    readonly persistentVolumeClaim?: {
      readonly claimName: string;
      /** Defaults to /backups. */
      readonly mountPath?: string;
    };
  };
  readonly encryption?: {
    /** Public age keys (`age1…`) to encrypt for. Not secret. */
    readonly recipients?: readonly string[];
    /** Cloud KMS keys that wrap each backup's data key. */
    readonly kms?: readonly { readonly provider: "aws" | "gcp" | "azure"; readonly key: string }[];
    /** A passphrase instead of recipients (age scrypt). */
    readonly passphraseSecretRef?: SecretKeyRef;
    /** The age identity (secret key) for deep verification and restores. */
    readonly identitySecretRef?: SecretKeyRef;
  };
  /** When to run. Without it the plan has no CronJob: only manual backups. */
  readonly schedule?: {
    /** Standard 5-field cron expression. */
    readonly cron: string;
    /** IANA time zone for `cron`. Defaults to Etc/UTC. */
    readonly timeZone?: string;
    /** Pause scheduled runs without deleting the plan. */
    readonly suspend?: boolean;
    /** Still start a missed run up to this many seconds late. Defaults to 3600. */
    readonly startingDeadlineSeconds?: number;
  };
  readonly backup?: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    readonly consistency?: "auto" | "none" | "snapshot" | "converge";
    readonly compression?: "zstd" | "gzip" | "none";
    readonly parallelism?: number;
    readonly readPreference?:
      | "primary"
      | "primaryPreferred"
      | "secondary"
      | "secondaryPreferred"
      | "nearest";
    readonly labels?: Readonly<Record<string, string>>;
    readonly retainDays?: number;
    readonly usersAndRoles?: boolean;
  };
  /**
   * Incremental backups: each run stores only the changes since the previous backup
   * (recorded from a change stream), and a full backup starts a new chain when none
   * can be continued, the chain's full backup is `fullEveryDays` old, or the chain
   * holds `maxChainLength` incrementals. "Full weekly, incremental hourly" is an
   * hourly `schedule.cron` with `fullEveryDays: 7`. Needs a replica set or sharded
   * cluster (MongoDB 6.0+). Becomes `backup.incremental` in the config.
   */
  readonly incremental?: {
    /** Start a new chain once its full backup is this many days old. Defaults to 7. */
    readonly fullEveryDays?: number;
    /** Start a new chain once it holds this many incrementals. No limit by default. */
    readonly maxChainLength?: number;
  };
  /** Which backups to keep in storage; applied after each successful scheduled run. */
  readonly retention?: {
    readonly last?: number;
    readonly hourly?: number;
    readonly daily?: number;
    readonly weekly?: number;
    readonly monthly?: number;
    readonly yearly?: number;
    readonly minVerified?: number;
  };
  /**
   * How each new backup is checked. Defaults to `fast` (checksums, no key needed).
   * `drill` restores it into the scratch deployment of `spec.drill` and checks it,
   * which also measures the recovery time.
   */
  readonly verify?: VerifyMode;
  /**
   * The scratch deployment for `verify: drill` (and the defaults of drills). Its
   * connection string comes from a Secret, as MONGOSHIELD_DRILL_URI in the pod; it
   * is never written to the ConfigMap.
   */
  readonly drill?: {
    readonly targetUriSecretRef: SecretKeyRef;
    /** Documents per collection compared byte for byte. Defaults to 0. */
    readonly sample?: number;
    /** Prefix of the temporary database names. Defaults to msdrill_. */
    readonly prefix?: string;
  };
  /** Retries inside a run, with backoff, before it fails. Defaults to 2. */
  readonly retries?: number;
  /** The lock that keeps two runs from overlapping. Defaults to `storage`. */
  readonly lock?: "storage" | "mongo" | "none";
  /**
   * More mongoshield.config.json settings (notify, heartbeat, guard, replicate, …),
   * merged under the generated config. Stored in a ConfigMap: no secrets here.
   */
  readonly extraConfig?: Readonly<Record<string, unknown>>;
  /** How many finished MongoShieldBackup objects of scheduled runs to keep. */
  readonly history?: {
    /** Defaults to 10. */
    readonly successfulLimit?: number;
    /** Defaults to 5. */
    readonly failedLimit?: number;
  };
  readonly job?: JobTemplateSettings;
}

/** A short summary of one backup run, embedded in a plan's status. */
export interface BackupRunSummary {
  /** The MongoShieldBackup object. */
  name: string;
  /** The backup id in storage (for successful runs). */
  backupId?: string;
  phase: BackupPhase;
  completionTime?: string;
  bytesStored?: number;
}

export interface BackupPlanStatus extends CommonStatus {
  /** The CronJob that runs the schedule (absent without `spec.schedule`). */
  cronJobName?: string;
  /** The ConfigMap holding the generated mongoshield.config.json. */
  configMapName?: string;
  /** When the CronJob last started a run. */
  lastScheduleTime?: string;
  /** When the next scheduled run is due (computed from the cron expression). */
  nextScheduleTime?: string;
  /** The newest finished run. */
  lastBackup?: BackupRunSummary;
  /** The newest successful run. */
  lastSuccessfulBackup?: BackupRunSummary;
  /** Runs in progress. */
  activeBackups?: number;
}

export interface BackupPlan extends KubeObject {
  spec: BackupPlanSpec;
  status?: BackupPlanStatus;
}

// ---------------------------------------------------------------------------
// MongoShieldBackup
// ---------------------------------------------------------------------------

/**
 * Where a backup run is. A convenience for `kubectl get`; the conditions are the
 * authoritative state.
 *
 * - `Pending`: waiting for its plan, or for the Job to be created.
 * - `Running`: the Job is running.
 * - `Succeeded`: a backup was committed (and verified, when enabled).
 * - `Checkpointed`: the run used up `maxDurationMs`; the next run resumes it.
 * - `Skipped`: another run held the lock; nothing was done (not an error).
 * - `Failed`: the run failed; `status.error` says why.
 */
export type BackupPhase =
  | "Pending"
  | "Running"
  | "Succeeded"
  | "Checkpointed"
  | "Skipped"
  | "Failed";

/** Phases after which a run never changes again. */
export const TERMINAL_BACKUP_PHASES: readonly BackupPhase[] = [
  "Succeeded",
  "Checkpointed",
  "Skipped",
  "Failed",
];

export interface BackupSpec {
  /** The plan whose source, storage and settings this run uses. */
  readonly planRef: LocalObjectRef;
  /** Overrides the plan's `verify` for this run (`drill` needs the plan's `spec.drill`). */
  readonly verify?: VerifyMode;
  /** Apply the plan's retention after this run. Defaults to false for manual runs. */
  readonly prune?: boolean;
  /**
   * What deleting this object does to the backup in storage. `Retain` (default): the
   * backup stays; only the record goes. `Delete`: the operator runs
   * `mongoshield delete <backupId>` first (under a finalizer), which refuses held,
   * write-once and depended-on backups; the object stays until the data is gone.
   * May be changed after the run.
   */
  readonly deletionPolicy?: "Retain" | "Delete";
}

/** An error reported by a run, without secrets (MongoShield scrubs them). */
export interface RunError {
  /** MongoShield error code, e.g. MS_CONNECT_FAILED (see docs/errors.md). */
  code: string;
  message: string;
  hint?: string;
  /** The step that failed: setup, lock, backup, verify, replicate or prune. */
  step?: string;
  /** The container's exit code. */
  exitCode?: number;
}

export interface BackupStatus extends CommonStatus {
  phase?: BackupPhase;
  /** The Job running (or that ran) this backup. */
  jobName?: string;
  startTime?: string;
  completionTime?: string;
  /** The backup id in storage, e.g. 2026-10-20T03-00-04Z_7f3a9c. Use it to restore. */
  backupId?: string;
  /** The run id from MongoShield's run report, for matching logs and notifications. */
  runId?: string;
  /** Where the backup was stored (without secrets). */
  storage?: string;
  /** How long the backup itself took, in milliseconds. */
  durationMs?: number;
  namespaces?: number;
  documents?: number;
  /** Uncompressed BSON bytes. */
  bytesRaw?: number;
  /** `full` or `incremental` (plans with `spec.incremental`). */
  kind?: "full" | "incremental";
  /** Incremental backups: the backup this one continues. */
  parentBackupId?: string;
  /** Incremental backups: the change events recorded. */
  changes?: number;
  /** Set when a plan takes incrementals but this run took a full backup: why. */
  fullBackupReason?: string;
  /** Bytes written to storage after compression and encryption. */
  bytesStored?: number;
  verification?: {
    mode: string;
    ok: boolean;
    /** How many problems were found (the first few are in `problems`). */
    problemCount: number;
    problems?: string[];
    /** Drills (`verify: drill`): the measured restore time in milliseconds (the RTO). */
    rtoMs?: number;
  };
  prune?: { deletedBackups: number; kept: number };
  error?: RunError;
}

export interface Backup extends KubeObject {
  spec: BackupSpec;
  status?: BackupStatus;
}

// ---------------------------------------------------------------------------
// MongoShieldDrill
// ---------------------------------------------------------------------------

/** One restore drill: restore a backup into a scratch deployment, check it, clean up. */
export interface DrillSpec {
  /** The plan whose storage (and decryption key) holds the backup. */
  readonly planRef: LocalObjectRef;
  /** Which backup: a MongoShieldBackup object, or a backup id / "latest" (default). */
  readonly backup?: { readonly name?: string; readonly id?: string };
  /**
   * The scratch deployment to restore into (temporary databases, dropped afterwards).
   * Never the backup's own source: MongoShield refuses that.
   */
  readonly target: { readonly uriSecretRef: SecretKeyRef };
  /** Documents per collection compared byte for byte with the backup. */
  readonly sample?: number;
  /** Prefix of the temporary database names. Defaults to msdrill_. */
  readonly prefix?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

/** Where a drill is. `Failed` covers both a drill that found problems and one that could not run. */
export type DrillPhase = "Pending" | "Running" | "Succeeded" | "Failed";

export interface DrillStatus extends CommonStatus {
  phase?: DrillPhase;
  jobName?: string;
  backupId?: string;
  startTime?: string;
  completionTime?: string;
  /** True when the backup restored and every check passed. */
  ok?: boolean;
  /** The measured recovery time: how long the restore took, in milliseconds. */
  rtoMs?: number;
  /** The whole drill, checks and cleanup included. */
  durationMs?: number;
  documentsRestored?: number;
  namespaces?: number;
  problemCount?: number;
  /** The first few problems. */
  problems?: string[];
  error?: RunError;
}

export interface Drill extends KubeObject {
  spec: DrillSpec;
  status?: DrillStatus;
}

// ---------------------------------------------------------------------------
// MongoShieldRestore
// ---------------------------------------------------------------------------

/** What happens to target collections that already exist (`mongoshield restore --mode`). */
export type RestoreMode = "fail-if-exists" | "drop" | "insert" | "upsert";

/** Modes that can change or delete existing documents, and so need `spec.confirm`. */
export const OVERWRITE_MODES: readonly RestoreMode[] = ["drop", "insert", "upsert"];

export interface RestoreSpec {
  /** The plan whose storage (and decryption key) holds the backup. */
  readonly planRef: LocalObjectRef;
  /** Which backup: a MongoShieldBackup object, or a backup id / "latest". Defaults to latest. */
  readonly backup?: {
    readonly name?: string;
    readonly id?: string;
  };
  /** Where to restore to. Required on purpose: there is no default target. */
  readonly target: {
    readonly uriSecretRef: SecretKeyRef;
  };
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Restore under other names, e.g. `{ from: "app.*", to: "app_restored.*" }`. */
  readonly rename?: readonly { readonly from: string; readonly to: string }[];
  /** Defaults to `fail-if-exists`: nothing is overwritten. */
  readonly mode?: RestoreMode;
  /** Plan only: report what would happen, write nothing. */
  readonly dryRun?: boolean;
  /**
   * For `drop`, `insert` and `upsert`: must equal `target.uriSecretRef.name`. Typing
   * the target's name is the "are you sure?" of a declarative API.
   */
  readonly confirm?: string;
  /** Point-in-time recovery: an ISO date or a cluster time (needs the change journal). */
  readonly at?: string;
  readonly skipIndexes?: boolean;
  readonly usersAndRoles?: "skip" | "create" | "replace";
}

/** Where a restore is. See BackupPhase for why this exists next to the conditions. */
export type RestorePhase = "Pending" | "Running" | "Succeeded" | "Failed";

export interface RestoreStatus extends CommonStatus {
  phase?: RestorePhase;
  jobName?: string;
  /** The backup id actually restored (resolved from `latest` or a MongoShieldBackup). */
  backupId?: string;
  startTime?: string;
  completionTime?: string;
  durationMs?: number;
  dryRun?: boolean;
  documentsRestored?: number;
  /** Namespaces in the restore plan. */
  namespaces?: number;
  error?: RunError;
}

export interface Restore extends KubeObject {
  spec: RestoreSpec;
  status?: RestoreStatus;
}
