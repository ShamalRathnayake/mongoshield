import type { Document, MongoClient, WriteConcernSettings } from "mongodb";
import type { ApplyErasuresResult } from "./extras/erasure.ts";
import type { ClusterTime, Compression, ConsistencyMode, Manifest } from "./format/manifest.ts";
import type { Logger } from "./logger.ts";
import type { MaskConfig, MaskReport } from "./mask/index.ts";
import type { StorageAdapter } from "./storage/types.ts";
import type { SubsetConfig, SubsetSelection } from "./subset/index.ts";

/**
 * Public option and result types for the high-level API. These are the contract
 * between the engines (`src/engine`), the `MongoShield` class and the CLI.
 */

/** Where to connect. Pass exactly one of `uri` or `client`. */
export type SourceOptions =
  | { readonly uri: string; readonly client?: never }
  /** An existing client. MongoShield never closes a client it did not create. */
  | { readonly client: MongoClient; readonly uri?: never };

/** A cloud KMS key, e.g. `{ provider: "aws", key: "arn:aws:kms:eu-west-1:…:key/…" }`. */
export interface KmsKeyRef {
  readonly provider: "aws" | "gcp" | "azure";
  /** AWS key ARN or alias, GCP key resource name, or Azure Key Vault key URL. */
  readonly key: string;
}

export interface EncryptionOptions {
  /** age recipients (`age1…`). The machine running backups only needs these public keys. */
  readonly recipients?: readonly string[];
  /** Passphrase-based encryption (scrypt). Prefer recipients for unattended backups. */
  readonly passphrase?: string;
  /**
   * Cloud KMS keys that wrap each backup's data key. Restoring needs only
   * permission to call the KMS decrypt API; no key material is ever handled.
   * Combine with an offline `recipients` key so backups survive losing the KMS key.
   */
  readonly kms?: readonly KmsKeyRef[];
}

export interface DecryptionOptions {
  /** age identities (`AGE-SECRET-KEY-1…`). */
  readonly identities?: readonly string[];
  readonly passphrase?: string;
}

export interface MongoShieldOptions {
  readonly source?: SourceOptions;
  readonly storage: StorageAdapter;
  /** Defaults to `"zstd"`. */
  readonly compression?: Compression;
  readonly encryption?: EncryptionOptions;
  readonly logger?: Logger;
  /**
   * OpenTelemetry spans and metrics (see docs/guides/observability.md). They are
   * recorded only when `@opentelemetry/api` is installed and the application
   * registered an SDK; otherwise this costs nothing.
   */
  readonly telemetry?: TelemetryOptions;
  /**
   * The GDPR erasure ledger (docs/guides/gdpr-erasure.md). `secret` keys the hashes
   * stored for erasure filters that contain personal data; it is needed to record
   * such erasures and to apply them after a restore.
   */
  readonly erasures?: { readonly secret?: string };
}

/**
 * Namespace patterns: `app.*`, `app.users`, `*.audit_*`, `*`.
 * In `exclude`, patterns are matched the same way.
 */
export type NamespacePattern = string;

export interface BackupOptions {
  /** Defaults to every non-system namespace in every non-internal database. */
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /** A filter per namespace, e.g. `{ "app.events": { createdAt: { $gte: … } } }`. */
  readonly query?: Readonly<Record<string, Document>>;
  /**
   * `"auto"` (default) picks `"converge"` when the deployment (replica set or sharded
   * cluster, MongoDB 6.0+) and the user's privileges allow it, otherwise `"none"` with
   * a `consistency.warning` in the manifest. See docs/specs/CONSISTENCY.md.
   */
  readonly consistency?: ConsistencyMode | "auto";
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * Collections (and parts of split collections) dumped at the same time. Defaults to 4.
   */
  readonly parallelism?: number;
  /**
   * Collections larger than this (raw BSON, estimated from collection statistics) are
   * split into parts by `_id` range, dumped in parallel and resumable one by one.
   * Defaults to 256 MiB. See docs/specs/PARTS-AND-RESUME.md.
   */
  readonly partSizeBytes?: number;
  /**
   * Time budget of this call. Once it is nearly used up, no new parts are started and
   * the run returns `{ status: "checkpointed" }` with a checkpoint to resume from,
   * instead of a manifest. Only consistency `"none"` (or `"auto"`, which then uses it)
   * can be combined with it.
   */
  readonly maxDurationMs?: number;
  /**
   * Continue a checkpointed backup: its id, `"latest"` (the newest checkpoint), or
   * `"auto"` (the newest checkpoint made with the same options, or a new backup when
   * there is none). The options must match the ones the backup was started with.
   */
  readonly resume?: string;
  /** Where data is read from. Defaults to `"secondaryPreferred"` (see the spec for snapshot/converge). */
  readonly readPreference?: ReadPreferenceModeName;
  /** Tag sets for `readPreference`, e.g. `[{ use: "backup" }, {}]`. */
  readonly readPreferenceTags?: readonly Readonly<Record<string, string>>[];
  /** Upper bound on documents read per second, over all collections together. */
  readonly maxDocumentsPerSecond?: number;
  /** Upper bound on raw BSON bytes read per second, over all collections together. */
  readonly maxBytesPerSecond?: number;
  /**
   * Make every file of the backup write-once for this many days (S3 Object Lock and
   * similar). Needs storage with `capabilities.objectLock`; recorded as the manifest's
   * `immutableUntil`.
   */
  readonly retainDays?: number;
  /**
   * Also back up the users and custom roles defined in the backed-up databases (every
   * database when `include` is not given), as `admin/system.users` and
   * `admin/system.roles` entries of the manifest. Off by default. The users' credentials
   * are SCRAM hashes, which can still be attacked offline: encrypt backups that hold
   * them (a warning is logged when they are not encrypted).
   */
  readonly includeUsersAndRoles?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
  /**
   * Called with the finished manifest right before it is committed; throwing refuses
   * the backup (its files are cleaned up like any failed run). Used by the backup guard.
   */
  readonly beforeCommit?: (
    manifest: Manifest,
    options: { readonly signal?: AbortSignal },
  ) => Promise<void>;
}

/** MongoDB read preference modes accepted by `BackupOptions.readPreference`. */
export type ReadPreferenceModeName =
  | "primary"
  | "primaryPreferred"
  | "secondary"
  | "secondaryPreferred"
  | "nearest";

/**
 * Backup options that can never stop early: without `maxDurationMs` and `resume`
 * a backup either completes or throws, so its result always has a manifest.
 */
export type CompletingBackupOptions = BackupOptions & {
  readonly maxDurationMs?: undefined;
  readonly resume?: undefined;
};

/** A committed backup. */
export interface CompletedBackupResult {
  readonly status: "complete";
  readonly id: string;
  readonly manifest: Manifest;
  readonly durationMs: number;
}

/**
 * A backup that ran out of its `maxDurationMs` budget. Nothing is committed yet;
 * call `backup({ resume: id })` (with the same options) to continue it.
 */
export interface CheckpointedBackupResult {
  readonly status: "checkpointed";
  readonly id: string;
  readonly durationMs: number;
  /** Where the checkpoint lives and how far the backup got. */
  readonly checkpoint: {
    /** Storage key of the checkpoint, `_state/checkpoints/<id>.json`. */
    readonly key: string;
    readonly partsDone: number;
    readonly partsTotal: number;
    /** Documents and raw bytes in the finished parts, over all invocations. */
    readonly documents: number;
    readonly bytesRaw: number;
  };
}

/** What `backup()` returns: check `status` before reading `manifest`. */
export type BackupResult = CompletedBackupResult | CheckpointedBackupResult;

export type BackupSelector = "latest" | string | { readonly before: Date | string };

export type RestoreMode = "fail-if-exists" | "drop" | "insert" | "upsert";

export interface RestoreOptions {
  readonly backup: BackupSelector;
  /**
   * Point-in-time recovery: restore the newest base backup taken before this moment,
   * then replay the change journal up to it (see docs/guides/point-in-time-recovery.md).
   * A `Date` is rounded down to its second; a cluster time `{ t, i }` is exact.
   * Use with `backup: "latest"`; the base backup is chosen automatically.
   */
  readonly at?: Date | ClusterTime;
  /** Defaults to the instance's `source`. */
  readonly target?: SourceOptions;
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /** `{ "app.*": "app_restored.*", "app.users": "app.users_old" }`. */
  readonly rename?: Readonly<Record<string, string>>;
  /** Defaults to `"fail-if-exists"`. */
  readonly mode?: RestoreMode;
  readonly dryRun?: boolean;
  readonly decryption?: DecryptionOptions;
  /** Collections restored at the same time. Defaults to 4. */
  readonly parallelism?: number;
  /** Insert workers per collection. Defaults to 2. */
  readonly insertWorkers?: number;
  readonly writeConcern?: WriteConcernSettings;
  /** Skip index creation (useful for very fast restores into throwaway targets). */
  readonly skipIndexes?: boolean;
  /**
   * Do not recreate Atlas Search / Vector Search indexes. Without it they are created
   * after the regular indexes on targets that support them (Atlas), and skipped with a
   * warning elsewhere.
   */
  readonly skipSearchIndexes?: boolean;
  /**
   * What to do with the users and roles of a backup taken with `includeUsersAndRoles`.
   * Defaults to `"skip"`. Only users and roles of databases the include/exclude
   * patterns select (`<db>.system.users` / `<db>.system.roles` must match) are
   * restored, into the database the rename rules give.
   */
  readonly usersAndRoles?: UsersAndRolesMode;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
  /**
   * Don't re-apply the erasure ledger afterwards. Only for restores into
   * throwaway targets: erased personal data comes back otherwise.
   */
  readonly skipErasures?: boolean;
}

/**
 * Restoring users and roles:
 * - `skip`: leave them out (the default).
 * - `create`: create the ones the target lacks; existing users and roles are kept.
 * - `replace`: also overwrite existing ones with the backed-up definition (roles with
 *   `updateRole`, users are dropped and recreated). Users and roles that are not in the
 *   backup are never touched.
 */
export type UsersAndRolesMode = "skip" | "create" | "replace";

/** One Atlas Search / Vector Search index of a restored collection. */
export interface SearchIndexRef {
  /** Target namespace. */
  readonly ns: string;
  readonly name: string;
}

/** What a restore did with Atlas Search / Vector Search indexes. */
export interface SearchIndexReport {
  /** Sent to Atlas; they finish building in the background after the restore. */
  readonly created: readonly SearchIndexRef[];
  /** Not created because the target does not support search indexes. */
  readonly notCreated: readonly SearchIndexRef[];
}

/** What a restore did with users and roles. Names are `db.name` (target database). */
export interface UsersAndRolesReport {
  readonly mode: Exclude<UsersAndRolesMode, "skip">;
  readonly rolesCreated: readonly string[];
  /** Existing roles overwritten (`replace`). */
  readonly rolesReplaced: readonly string[];
  /** Existing roles left as they were (`create`). */
  readonly rolesKept: readonly string[];
  readonly usersCreated: readonly string[];
  /** Existing users dropped and recreated from the backup (`replace`). */
  readonly usersReplaced: readonly string[];
  /** Existing users left as they were (`create`). */
  readonly usersKept: readonly string[];
  /**
   * How users were written: `merge` restores them with their password hashes, as
   * mongorestore does (`_mergeAuthzCollections`); `createUser` is the fallback when the
   * target refuses that (e.g. Atlas), and then passwords cannot be restored.
   */
  readonly method: "merge" | "createUser";
  /**
   * Users created without their original password (`createUser` method): they got a
   * random password nobody knows and need a password reset before they can log in.
   */
  readonly passwordResetRequired: readonly string[];
}

export interface RestorePlanEntry {
  readonly from: string;
  readonly to: string;
  readonly type: "collection" | "view" | "timeseries";
  readonly documents: number;
  /**
   * What the restore will do with this namespace. `conflict` means the target
   * already holds data the chosen mode must not touch; `reason` says why.
   * A plan with any conflict is refused by `restore()`.
   */
  readonly action: "create" | "drop-and-create" | "insert" | "upsert" | "skip" | "conflict";
  /** Why the namespace cannot be restored in this mode. Only set for `conflict`. */
  readonly reason?: string;
  /**
   * Documents already in the target namespace (0 if it does not exist), or
   * `undefined` when they could not be counted (the user lacks the `find` privilege).
   */
  readonly existingDocuments: number | undefined;
}

export interface RestorePlan {
  readonly backupId: string;
  readonly mode: RestoreMode;
  readonly entries: readonly RestorePlanEntry[];
}

/** What a point-in-time restore replayed on top of its base backup. */
export interface PointInTimeResult {
  readonly baseBackupId: string;
  /** The exact cluster time the target now reflects. */
  readonly restoredTo: ClusterTime;
  /** Journal events read in the range (base backup time, restoredTo]. */
  readonly events: number;
  readonly warnings: readonly string[];
}

export interface RestoreResult {
  readonly plan: RestorePlan;
  readonly dryRun: boolean;
  readonly documentsRestored: number;
  readonly durationMs: number;
  /** Present for point-in-time restores (`at`). */
  readonly pointInTime?: PointInTimeResult;
  /** Present when restored collections had Atlas Search indexes (and they were not skipped). */
  readonly searchIndexes?: SearchIndexReport;
  /** Present when users and roles were restored (`usersAndRoles` other than `skip`). */
  readonly usersAndRoles?: UsersAndRolesReport;
  /** Documents deleted afterwards because the erasure ledger lists them. */
  readonly erasures?: ApplyErasuresResult;
}

/**
 * How thoroughly to check a backup.
 * - `fast`: every file exists with the recorded size and SHA-256. No key needed.
 * - `deep`: also decrypts, decompresses and parses every document, and compares
 *   document counts with the manifest. Needs the decryption key if encrypted.
 */
export type VerifyMode = "fast" | "deep";

export interface VerifyOptions {
  readonly backup: BackupSelector;
  /** Defaults to `"fast"`. */
  readonly mode?: VerifyMode;
  readonly decryption?: DecryptionOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
}

export interface VerifyProblem {
  /** Storage key (relative to the backup directory) or namespace the problem concerns. */
  readonly subject: string;
  readonly problem: string;
}

export interface VerifyReport {
  readonly backupId: string;
  readonly mode: VerifyMode;
  /** True when no problems were found. */
  readonly ok: boolean;
  readonly filesChecked: number;
  readonly bytesChecked: number;
  /** Documents parsed (deep mode only). */
  readonly documentsChecked: number;
  readonly problems: readonly VerifyProblem[];
  readonly durationMs: number;
}

export type ProgressEvent =
  | { readonly type: "namespace:start"; readonly ns: string; readonly estimatedDocuments: number }
  | {
      readonly type: "namespace:progress";
      readonly ns: string;
      readonly documents: number;
      readonly bytes: number;
    }
  | { readonly type: "namespace:done"; readonly ns: string; readonly documents: number }
  | {
      readonly type: "overall";
      readonly documents: number;
      readonly estimatedDocuments: number;
      readonly bytes: number;
      readonly elapsedMs: number;
      /** `undefined` until there is enough data to estimate. */
      readonly etaMs: number | undefined;
    };

/** Settings for OpenTelemetry tracing and metrics. */
export interface TelemetryOptions {
  /** Set to `false` to never load `@opentelemetry/api`, even when it is installed. Defaults to `true`. */
  readonly enabled?: boolean;
  /**
   * Report namespace names (`app.users`) as span attributes. Off by default:
   * collection names can reveal customers or products to whoever reads the traces.
   */
  readonly includeNamespaces?: boolean;
}

// ---------------------------------------------------------------------------
// Copying between deployments: `shield.copy()`, `mongoshield copy`, `mongoshield pull`
// ---------------------------------------------------------------------------

/**
 * Options for copying namespaces straight from one deployment into another, with
 * optional masking and subsetting. Nothing is stored in between.
 */
export interface CopyOptions {
  /** Where to read from. Defaults to the instance's `source` (`shield.copy()` only). */
  readonly from?: SourceOptions;
  /** Where to write to. */
  readonly to: SourceOptions;
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /** `{ "app.*": "staging.*", "app.users": "staging.people" }`, as for restore. */
  readonly rename?: Readonly<Record<string, string>>;
  /** What to do with targets that exist, as for restore. Defaults to `"fail-if-exists"`. */
  readonly mode?: RestoreMode;
  /** Masking rules applied to every document on its way (see `defineMask`). */
  readonly mask?: MaskConfig;
  /** Filters and reference-following that pick a consistent slice (see `defineSubset`). */
  readonly subset?: SubsetConfig;
  /** Collections copied at the same time. Defaults to 4. */
  readonly parallelism?: number;
  /** Insert workers per collection. Defaults to 2. */
  readonly insertWorkers?: number;
  /**
   * Where source documents are read. Defaults to `"secondaryPreferred"`, which keeps
   * the copy's load off the primary of a replica set when it can.
   */
  readonly readPreference?: ReadPreferenceModeName;
  readonly writeConcern?: WriteConcernSettings;
  /** Skip index creation (faster, for throwaway targets). */
  readonly skipIndexes?: boolean;
  /** Plan and check everything (namespaces, conflicts, privileges, mask, subset), write nothing. */
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
  /**
   * Don't re-apply the erasure ledger afterwards. Only for restores into
   * throwaway targets: erased personal data comes back otherwise.
   */
  readonly skipErasures?: boolean;
}

/** One namespace of a copy plan: the restore plan entry plus how it is selected and masked. */
export interface CopyPlanEntry extends RestorePlanEntry {
  /** Estimated documents in the SOURCE namespace (the subset may copy fewer). */
  readonly documents: number;
  /** How documents are selected: all, by filter, by reference, or both. */
  readonly subset: SubsetSelection;
  /** Mask rules that apply, as `path: operation`; empty when nothing is masked. */
  readonly masked: readonly string[];
}

/** What a copy will do (or did). A plan with a `conflict` entry is refused. */
export interface CopyPlan {
  readonly mode: RestoreMode;
  readonly entries: readonly CopyPlanEntry[];
}

/** What a copy did (or, for a dry run, would do). */
export interface CopyResult {
  readonly plan: CopyPlan;
  readonly dryRun: boolean;
  /** Documents written to the target. */
  readonly documentsCopied: number;
  readonly durationMs: number;
  /** What each mask rule did. Absent when no mask was given. */
  readonly mask?: MaskReport;
  /** Documents deleted afterwards because the erasure ledger lists them. */
  readonly erasures?: ApplyErasuresResult;
}
