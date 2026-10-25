/**
 * The console's HTTP API contract, shared by the server (src/server) and the UI (src/ui).
 *
 * Every endpoint is listed in `ApiRoutes` below: method + path → request body →
 * response body. The server implements exactly these, and the UI's fetch client is
 * typed from them, so the two cannot drift apart without a type error.
 *
 * Conventions:
 * - JSON everywhere; dates are ISO 8601 strings.
 * - Secrets never appear in responses. Where a resource has a secret, the response
 *   says `configured: true` and shows a redacted preview at most.
 * - Errors use `ApiError` with the MongoShield error code where one applies.
 * - State-changing requests need the `x-csrf-token` header from `GET /api/session`.
 */

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

/** Every failed request returns this body with a 4xx/5xx status. */
export interface ApiError {
  readonly error: {
    /** A MongoShield error code (`MS_…`) or a console code (`CONSOLE_…`). */
    readonly code: string;
    readonly message: string;
    readonly hint?: string;
  };
}

/** Who can do what. Each role includes everything the roles before it can do. */
export type Role = "viewer" | "operator" | "admin";

export const ROLES: readonly Role[] = ["viewer", "operator", "admin"];

/**
 * Permissions granted per user on top of the role. They are separate from roles on
 * purpose: being an admin does not by itself allow changing live data.
 *
 * - `data:write`: insert, edit and delete documents of live databases in the data
 *   browser (and undo such edits), on connections where an admin turned on "Allow live
 *   edits". Only operators and admins can hold it.
 */
export type Permission = "data:write";

export const PERMISSIONS: readonly Permission[] = ["data:write"];

/** A secret the console stores encrypted. Only this summary ever leaves the server. */
export interface SecretSummary {
  readonly configured: boolean;
  /** e.g. `mongodb+srv://app:***@cluster0.example.net`; never the secret itself. */
  readonly preview?: string;
}

// ---------------------------------------------------------------------------
// Session, setup and users
// ---------------------------------------------------------------------------

export interface SessionInfo {
  /** `false` until the first admin has been created via /api/setup. */
  readonly setupComplete: boolean;
  readonly user?: UserView;
  /** Send back as the `x-csrf-token` header on every state-changing request. */
  readonly csrfToken?: string;
  /**
   * Login methods the server accepts. With `"oidc"`, the login page offers a
   * "Sign in with single sign-on" link to {@link OIDC_LOGIN_PATH}.
   */
  readonly authMethods: readonly ("password" | "oidc" | "proxy")[];
  /** While setup is not complete: whether the setup page needs the token from the log. */
  readonly setup?: SetupState;
  /**
   * Signed in only: whether the console runs in a container, where `localhost` is the
   * container itself. Pages then suggest `host.docker.internal` instead of `localhost`.
   */
  readonly inContainer?: boolean;
}

/**
 * How the first admin can be created. For a short time after the console starts
 * (MONGOSHIELD_SETUP_WINDOW_MINUTES, 15 by default) the setup page works without the
 * one-time token from the log; after that, or with the window turned off, it needs it.
 */
export interface SetupState {
  /** True once the window has closed (or when there is none): `token` is required. */
  readonly tokenRequired: boolean;
  /** When the window closes (ISO date), while it is open. */
  readonly windowEndsAt?: string;
}

/**
 * OIDC sign-in is a browser redirect flow, not a JSON API, so its two endpoints
 * are not in `ApiRoutes`:
 *
 *   GET /api/oidc/login      302 to the identity provider (authorization code + PKCE)
 *   GET /api/oidc/callback   the provider redirects back here; on success the session
 *                            cookie is set and the browser is sent to `/#/`, on failure
 *                            to `/#/?sso_error=<code>` (one of {@link OidcErrorCode}).
 */
export const OIDC_LOGIN_PATH = "/api/oidc/login";

/** Why a single sign-on attempt failed, as passed back to the UI in `sso_error`. */
export type OidcErrorCode =
  /** The provider reported an error (the user cancelled, consent denied, …). */
  | "CONSOLE_OIDC_PROVIDER_ERROR"
  /** The sign-in took too long, was started in another browser, or was replayed. */
  | "CONSOLE_OIDC_STATE"
  /** The provider's answer could not be verified (signature, issuer, audience, expiry, nonce). */
  | "CONSOLE_OIDC_INVALID_TOKEN"
  /** The provider could not be reached or answered with something unexpected. */
  | "CONSOLE_OIDC_UNAVAILABLE"
  /** The identity has no console role (no role mapping matched and there is no default role). */
  | "CONSOLE_OIDC_NO_ROLE"
  /** Auto-provisioning is off and no console account belongs to this identity. */
  | "CONSOLE_OIDC_NOT_PROVISIONED"
  /** A console account with the same username exists and belongs to someone else. */
  | "CONSOLE_OIDC_ACCOUNT_CONFLICT";

/** Every {@link OidcErrorCode}, for checking a code read from the URL. */
export const OIDC_ERROR_CODES: readonly OidcErrorCode[] = [
  "CONSOLE_OIDC_PROVIDER_ERROR",
  "CONSOLE_OIDC_STATE",
  "CONSOLE_OIDC_INVALID_TOKEN",
  "CONSOLE_OIDC_UNAVAILABLE",
  "CONSOLE_OIDC_NO_ROLE",
  "CONSOLE_OIDC_NOT_PROVISIONED",
  "CONSOLE_OIDC_ACCOUNT_CONFLICT",
];

export interface LoginRequest {
  readonly username: string;
  readonly password: string;
}

export interface SetupRequest {
  /**
   * The one-time token printed in the server log at first start. Optional while the
   * setup window is open (`SessionInfo.setup.tokenRequired` is false).
   */
  readonly token?: string;
  readonly username: string;
  readonly password: string;
}

export interface UserView {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  /**
   * How the account signs in: `"password"`, or `"sso"` for accounts without a
   * password that only single sign-on (OIDC or the trusted proxy) can use.
   */
  readonly signIn: "password" | "sso";
  readonly createdAt: string;
  readonly lastLoginAt?: string;
  /** Extra permissions on top of the role (see {@link Permission}). */
  readonly permissions: readonly Permission[];
}

export interface UserInput {
  readonly username: string;
  readonly role: Role;
  /**
   * Optional when updating (omit to keep). When creating it is required, unless
   * single sign-on is enabled: then omitting it creates an `"sso"` account that
   * signs in only through SSO (useful with OIDC auto-provisioning turned off).
   */
  readonly password?: string;
  /** Omit when updating to keep the user's permissions. `data:write` needs operator or admin. */
  readonly permissions?: readonly Permission[];
}

// ---------------------------------------------------------------------------
// Connections and storage
// ---------------------------------------------------------------------------

export interface ConnectionView {
  readonly id: string;
  readonly name: string;
  readonly uri: SecretSummary;
  /** Restores into a production connection require typing its name to confirm. */
  readonly production: boolean;
  readonly createdAt: string;
  /** Whether the live data browser may change documents here (off unless an admin turned it on). */
  readonly liveEdits: LiveEditSettingsView;
  /** What the last check found out about the deployment (Atlas tier, version), when known. */
  readonly deployment?: DeploymentSummary;
}

/** A connection's deployment as last seen by a check or test (shown as badges). */
export interface DeploymentSummary {
  readonly topology?: string;
  readonly serverVersion?: string;
  /** Atlas tier; absent when not on Atlas. */
  readonly atlas?: AtlasTierName;
  readonly checkedAt: string;
}

export interface ConnectionInput {
  readonly name: string;
  /** Omit when updating to keep the stored URI. */
  readonly uri?: string;
  readonly production: boolean;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly topology?: string;
  readonly serverVersion?: string;
  /** Privileges missing for backup and for restore, if any. */
  readonly missingBackupPrivileges: readonly string[];
  readonly missingRestorePrivileges: readonly string[];
  readonly error?: ApiError["error"];
  /** What went wrong, in plain words with a fix, when `ok` is false. */
  readonly problem?: ConnectionProblem;
  /** MongoDB Atlas: Free/Flex (`shared`) or dedicated (M10+). Absent when not on Atlas. */
  readonly atlas?: { readonly tier: AtlasTierName };
  /**
   * When the user may read only some databases (per-database roles, common on Atlas):
   * those databases. Backups then contain only them.
   */
  readonly readableDatabases?: readonly string[];
  /** Advice about missing privileges, in plain words (a warning, not a failure). */
  readonly privilegeAdvice?: ConnectionProblem;
  /**
   * Set when the console got through on another address than the one given. In a
   * container `localhost` is the container itself, so when it was refused the console
   * tried the machine the container runs on (`host.docker.internal`), and that worked.
   * The check page saves that address; a saved connection's test stores it right away.
   */
  readonly reachedThrough?: { readonly from: string; readonly to: string };
}

/** Atlas cluster tiers as the console shows them: Free/Flex share hardware; M10+ is dedicated. */
export type AtlasTierName = "shared" | "dedicated";

/** The kinds of connection failure the console explains (src/server/connection-problems.ts). */
export type ConnectionProblemKind =
  | "dns-not-found"
  | "network-blocked"
  | "paused-cluster"
  | "auth-failed"
  | "missing-privileges"
  | "tls"
  | "connection-refused"
  | "timeout"
  | "unknown";

/** A connection problem explained for people: what is wrong, how to fix it, where to go. */
export interface ConnectionProblem {
  readonly kind: ConnectionProblemKind;
  readonly title: string;
  readonly message: string;
  readonly fix: string;
  readonly links: readonly { readonly label: string; readonly url: string }[];
  /** The driver's own message (connection string removed), for the curious and for support. */
  readonly detail: string;
  /** True when knowing the console's public IP helps (an Atlas IP access list). */
  readonly offerPublicIp?: boolean;
}

/** Checks a connection string before it is saved (`POST /api/connections/check`, admin). */
export interface ConnectionCheckRequest {
  /** The pasted connection string (cleaned by the server like the onboarding page does). */
  readonly uri: string;
}

/** The check's answer: the test result plus the defaults the onboarding page proposes. */
export interface ConnectionCheckResult extends ConnectionTestResult {
  /** A short name from the host, replica set or Atlas cluster, unique among connections. */
  readonly suggestedName: string;
  /** Whether to mark it production by default, and why in plain words (always shown). */
  readonly production: { readonly suggested: boolean; readonly reason: string };
}

/** The console's public (egress) IP address, looked up on request (`POST /api/network/public-ip`). */
export interface PublicIpResult {
  /** The address as an external service saw it, e.g. for an Atlas IP access list. */
  readonly ip?: string;
  /** Why it could not be found (no internet access, the service did not answer, …). */
  readonly error?: string;
}

/** One database in the namespace tree used to choose what to back up. */
export interface DatabaseNode {
  readonly name: string;
  /** Size of the database on disk, when the server reports it (`listDatabases`). */
  readonly sizeBytes?: number;
  readonly collections: readonly {
    readonly name: string;
    readonly type: "collection" | "view" | "timeseries";
    readonly estimatedDocuments: number;
    readonly indexes: number;
    /** True for a capped collection (from `listCollections` options; costs no extra command). */
    readonly capped?: boolean;
    /** Uncompressed size of the documents, when known. Absent: unknown (never 0 by default). */
    readonly sizeBytes?: number;
  }[];
}

export interface StorageView {
  readonly id: string;
  readonly name: string;
  /** Storage URL with secrets removed, e.g. `s3://acme-backups/prod/`. */
  readonly url: string;
  readonly credentials: SecretSummary;
  readonly createdAt: string;
}

export interface StorageInput {
  readonly name: string;
  /** `s3://…`, `gs://…`, `az://…`, `sftp://…` or a local path inside the data volume. */
  readonly url: string;
  /** Provider credentials as environment-style pairs, stored encrypted. Omit to keep. */
  readonly credentials?: Readonly<Record<string, string>>;
}

export interface StorageTestResult {
  readonly ok: boolean;
  readonly capabilities?: {
    readonly conditionalWrites: boolean;
    readonly rangeReads: boolean;
    readonly objectLock: boolean;
  };
  readonly error?: ApiError["error"];
}

// ---------------------------------------------------------------------------
// Backup plans (connection + storage + what + how + when)
// ---------------------------------------------------------------------------

export interface PlanView {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string;
  readonly storageId: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly compression: "zstd" | "gzip" | "none";
  readonly encryption:
    | { readonly kind: "none" }
    | { readonly kind: "recipients"; readonly recipients: readonly string[] }
    | { readonly kind: "passphrase"; readonly passphrase: SecretSummary }
    | ManagedKeyView;
  readonly consistency: "auto" | "none" | "snapshot" | "converge";
  /** 5-field cron; absent = run manually only. */
  readonly schedule?: { readonly cron: string; readonly timezone: string };
  readonly retention?: {
    readonly last?: number;
    readonly daily?: number;
    readonly weekly?: number;
    readonly monthly?: number;
    readonly yearly?: number;
  };
  readonly verify: "none" | "fast" | "deep";
  readonly notify: readonly {
    readonly type: "webhook" | "slack" | "discord";
    readonly url: SecretSummary;
  }[];
  /** Incremental backups between full ones, a full one every `fullEveryDays` days. */
  readonly incremental?: { readonly fullEveryDays: number };
  readonly nextRunAt?: string;
  readonly lastRun?: JobSummary;
  /** `quick`: created by "Back up now" (one per connection); edit it like any other plan. */
  readonly origin?: "quick";
}

/** "Back up now" (`POST /api/quick-backup`, admin): one click, sensible defaults. */
export interface QuickBackupRequest {
  readonly connectionId: string;
  /**
   * Namespace patterns to back up (`db.*`, `db.collection`). Omit or leave empty for
   * everything except MongoDB's own databases (admin, local, config). Saved on the
   * connection's quick plan, so later clicks (and its schedule) back up the same.
   */
  readonly include?: readonly string[];
}

/** What "Back up now" did: the plan it used (created on the first click) and the job. */
export interface QuickBackupResult {
  readonly plan: PlanView;
  readonly job: JobSummary;
  /** True when this click created the plan (and its encryption key). */
  readonly created: boolean;
}

/** A plan's recovery key, for safekeeping outside the console (admin, audited). */
export interface RecoveryKeyView {
  readonly planId: string;
  readonly planName: string;
  /** The age private key, `AGE-SECRET-KEY-1…`. Restores these backups without the console. */
  readonly identity: string;
  /** Its public key, `age1…`. */
  readonly recipient: string;
  /** A suggested file name for the download. */
  readonly filename: string;
  /** The text to save: the key with comments saying what it is and how to use it. */
  readonly fileContent: string;
}

/**
 * Encryption with a key the console generates and keeps (an age X25519 key pair). Backups
 * are encrypted to its public key (`recipient`); the private key (the "recovery key") is
 * stored sealed like every other secret, so restores, verifies and drills need no typing.
 * Download it once (`POST /api/plans/:id/recovery-key`) and keep it somewhere else: it is
 * what restores these backups when the console itself is gone.
 */
export interface ManagedKeyView {
  readonly kind: "managed";
  /** The age public key (age1…). */
  readonly recipient: string;
  /** True once someone downloaded the recovery key; the UI keeps reminding until then. */
  readonly recoveryKeySaved: boolean;
}

export type PlanInput = Omit<
  PlanView,
  "id" | "encryption" | "notify" | "nextRunAt" | "lastRun" | "origin"
> & {
  readonly encryption:
    | { readonly kind: "none" }
    | { readonly kind: "recipients"; readonly recipients: readonly string[] }
    /** Omit `passphrase` when updating to keep the stored one. */
    | { readonly kind: "passphrase"; readonly passphrase?: string }
    /** Keeps the plan's managed key, or generates one when the plan had none. */
    | { readonly kind: "managed" };
  readonly notify: readonly {
    readonly type: "webhook" | "slack" | "discord";
    readonly url?: string;
  }[];
};

// ---------------------------------------------------------------------------
// Backups (read from storage through the mongoshield catalog)
// ---------------------------------------------------------------------------

export interface BackupSummary {
  readonly id: string;
  readonly status: "complete" | "incomplete" | "invalid";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly namespaces?: number;
  readonly documents?: number;
  readonly bytesStored?: number;
  readonly encrypted?: boolean;
  readonly consistency?: string;
  /**
   * Incremental backups (only the changes since their parent): `"incremental"` and
   * their position after the chain's full backup. Absent for full backups.
   */
  readonly kind?: "incremental";
  readonly chainLength?: number;
  readonly verification?: {
    readonly mode: string;
    readonly ok: boolean;
    readonly verifiedAt: string;
  };
  readonly hold?: { readonly reason: string; readonly heldAt: string };
  readonly immutableUntil?: string;
}

export interface BackupDetail extends BackupSummary {
  /** The full manifest, exactly as stored (it never contains secrets). */
  readonly manifest?: unknown;
  readonly drills: readonly {
    readonly drilledAt: string;
    readonly ok: boolean;
    readonly rtoMs: number;
    /**
     * Upgrade rehearsals only: the MongoDB version the backup was restored into and
     * proved on (e.g. `8.0.13`). Absent for ordinary drills.
     */
    readonly targetVersion?: string;
  }[];
}

/** A page of documents from inside a backup, as relaxed Extended JSON strings. */
export interface DocumentPage {
  readonly documents: readonly string[];
  /**
   * The same documents as canonical Extended JSON (every BSON type explicit, e.g.
   * `{"$numberInt": "1"}`), in the same order. Only sent when the request asked for it
   * with `ejson=canonical` (the document viewer's JSON view).
   */
  readonly canonical?: readonly string[];
  /** Pass back as `after` to get the next page; absent on the last page. */
  readonly next?: string;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreRequest {
  readonly storageId: string;
  readonly backupId: string;
  readonly targetConnectionId: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly rename?: Readonly<Record<string, string>>;
  readonly mode: "fail-if-exists" | "drop" | "insert" | "upsert";
  /** Required (must equal the connection's name) when the target is marked production. */
  readonly confirmName?: string;
  /** Needed for encrypted backups unless the console already stores a matching key. */
  readonly passphrase?: string;
  readonly identities?: readonly string[];
  /**
   * Restore only the documents matching this MongoDB filter (Extended JSON, relaxed or
   * canonical), e.g. `{"_id": {"$in": [3, 7]}}`. The same filter applies to every
   * selected namespace (`include`/`exclude`, any number of them); existing documents
   * outside the filter are never touched. It runs through the library's per-document
   * restore (`shield.restoreTenant`), so `mode` maps onto its document-level modes:
   *
   *   fail-if-exists, insert  → insert: add matching documents whose `_id` is missing;
   *                             existing ones are kept (reported, not overwritten)
   *   upsert                  → upsert: also replace existing ones with the backed-up version
   *   drop                    → replace-tenant: delete the target's current matching
   *                             documents, then insert the backed-up ones
   *
   * With a filter, the plan's `documents` is the number of MATCHING backed-up documents,
   * and `existingDocuments` the number of those that already exist in the target (for
   * `drop`: the current matching documents that will be deleted). Views and time series
   * collections cannot be restored per document and show as `action: "skip"`. An empty
   * filter (`{}`) is refused: leave `filter` out to restore everything.
   */
  readonly filter?: string;
}

export interface RestorePlanView {
  readonly backupId: string;
  readonly mode: string;
  readonly entries: readonly {
    readonly from: string;
    readonly to: string;
    readonly documents: number;
    readonly existingDocuments?: number;
    readonly action: string;
    readonly reason?: string;
  }[];
}

// ---------------------------------------------------------------------------
// Restore preview ("what would this restore change in the target?")
// ---------------------------------------------------------------------------

/**
 * A restore preview compares the chosen backup namespaces with the namespaces they
 * would be restored into (after `rename`), using the library's `diff` against the live
 * target. It only reads the target. `POST /api/restore/preview` takes the same body as
 * the dry-run plan (without `filter` and `confirmName`) and starts a `preview` job;
 * `GET /api/restore/preview/:id` (the job id) returns this view, with `namespaces` once
 * the job has succeeded. Results are kept in memory for a while (see `expiresAt`).
 */
export interface RestorePreviewView {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly storageId: string;
  readonly backupId: string;
  readonly targetConnectionId: string;
  readonly mode: RestoreRequest["mode"];
  /** Per selected backup namespace, sorted by name; present once the job has succeeded. */
  readonly namespaces?: readonly PreviewNamespaceView[];
  readonly error?: ApiError["error"];
  /**
   * Whether the caller may list changed documents and open their field-level diff
   * (the document browser's role). Counts are shown to everyone who may plan the restore.
   */
  readonly documentsVisible: boolean;
  /** The bounds this preview ran with, so the UI can explain estimates and short lists. */
  readonly limits: PreviewLimits;
  /** When the server forgets this preview (ISO date); run it again after that. */
  readonly expiresAt: string;
}

/** The bounds of a restore preview (server defaults, see `src/jobs/preview.ts`). */
export interface PreviewLimits {
  /** Namespaces with more documents than this (either side) are compared by a sample. */
  readonly sampleAbove: number;
  /** Backed-up documents compared per sampled namespace. */
  readonly sampleSize: number;
  /** Document ids kept per namespace and category for the drill-down list. */
  readonly listedPerCategory: number;
  /** The preview job is stopped after this long. */
  readonly timeoutMs: number;
}

/** Document categories of a preview (backup vs. the live target). */
export type PreviewCategory = "backup-only" | "live-only" | "changed";

/** What a restore would do to one target namespace. */
export interface PreviewNamespaceView {
  /** The namespace in the backup. */
  readonly from: string;
  /** Where it would be restored (after rename rules). */
  readonly to: string;
  /** False when the target namespace does not exist yet (the restore creates it). */
  readonly targetExists: boolean;
  /** The restore plan's action for it (create, drop-and-create, insert, upsert, skip, conflict). */
  readonly action: string;
  readonly reason?: string;
  /**
   * `exact`: every document was compared. `sampled`: the first `sample.documents` of
   * `sample.of` backed-up documents were looked up in the target by `_id`, and the
   * counts are estimates extrapolated from them.
   */
  readonly accuracy: "exact" | "sampled";
  readonly sample?: { readonly documents: number; readonly of: number };
  /** Documents by where they are, matched by `_id`. */
  readonly documents: {
    readonly backup: number;
    readonly live: number;
    /** In the backup only: the restore would add them. */
    readonly backupOnly: number;
    /** In the target only. */
    readonly liveOnly: number;
    /** In both, but different. */
    readonly changed: number;
    readonly identical: number;
  };
  /**
   * What the restore in the chosen mode would do with the target's documents, or
   * absent when it would not run for this namespace (`conflict`, `skip`):
   * `inserted` new documents, `replaced` changed ones, `deleted` target-only ones,
   * and `kept` target documents that stay as they are.
   */
  readonly effect?: {
    readonly inserted: number;
    readonly replaced: number;
    readonly deleted: number;
    readonly kept: number;
  };
  /** Index names that differ: only in the backup, only in the target, or defined differently. */
  readonly indexes: {
    readonly backupOnly: readonly string[];
    readonly liveOnly: readonly string[];
    readonly different: readonly string[];
  };
  /** Collection options (validator, collation, …) that differ. */
  readonly options: readonly string[];
  /** Document ids kept per category for the drill-down (at most `limits.listedPerCategory`). */
  readonly listed: Readonly<Record<PreviewCategory, number>>;
  readonly identical: boolean;
}

/** A page of document ids of one preview category (`GET …/preview/:id/documents`). */
export interface PreviewDocumentPage {
  readonly documents: readonly {
    /** The `_id` as canonical Extended JSON: pass it back to open the document's diff. */
    readonly id: string;
    /** The `_id` as relaxed Extended JSON, for display. */
    readonly label: string;
  }[];
  /** How many ids the preview kept for this category (the total may be larger). */
  readonly listed: number;
  /** Pass back as `after` for the next page; absent on the last page. */
  readonly next?: string;
}

/** Opens one document of a preview (`POST …/preview/:id/document`). */
export interface PreviewDocumentRequest {
  /** The namespace in the backup (`PreviewNamespaceView.from`). */
  readonly ns: string;
  /** The `_id` as canonical Extended JSON, as listed in a `PreviewDocumentPage`. */
  readonly id: string;
  /** Keys for an encrypted backup, as for the restore itself (never stored). */
  readonly passphrase?: string;
  readonly identities?: readonly string[];
}

/** One document in the backup and in the target, with the fields that differ. */
export interface PreviewDocumentDiff {
  readonly ns: string;
  readonly to: string;
  /** The `_id` as relaxed Extended JSON. */
  readonly label: string;
  /** The backed-up version (what the restore writes), relaxed Extended JSON; absent if none. */
  readonly backup?: string;
  /** The target's current version, relaxed Extended JSON; absent if none. */
  readonly live?: string;
  /** True when a version is larger than 1 MiB as JSON: it is left out, the field list is not. */
  readonly documentsOmitted?: boolean;
  /**
   * Fields that differ, by dotted path (array elements by index), named from the
   * target's side: `added` only in the backed-up version, `removed` only in the target's,
   * `changed` in both with different values (BSON types count). Values are relaxed
   * Extended JSON. Values of fields that look like secrets (password, token, apiKey, …)
   * are replaced by `"***"` here and in `backup`/`live`, and marked `redacted`.
   */
  readonly fields: readonly {
    readonly path: string;
    readonly change: "added" | "removed" | "changed";
    readonly backup?: string;
    readonly live?: string;
    readonly redacted?: boolean;
  }[];
  /** True when there were more differing fields than are listed. */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Pruning (applying a plan's retention policy)
// ---------------------------------------------------------------------------

/**
 * The dry run of applying a plan's retention policy to its storage location.
 * Retention applies to EVERY backup in that location, including backups written
 * by other plans or by the CLI; `warnings` says so when another plan writes there.
 */
export interface PrunePlanView {
  readonly planId: string;
  readonly storageId: string;
  readonly policy: NonNullable<PlanView["retention"]>;
  /** Backups that stay, each with why (e.g. "last 7", "daily", "held", "immutable"). */
  readonly keep: readonly { readonly id: string; readonly reasons: readonly string[] }[];
  /** Backups the prune would delete, each with why. */
  readonly remove: readonly { readonly id: string; readonly reason: string }[];
  readonly warnings: readonly string[];
  /**
   * Backups in the same storage that are not this plan's (other plans, other
   * sources, or runs nothing attributes to a plan). The plan's retention never
   * touches them; they are neither in `keep` nor in `remove`.
   */
  readonly outOfScope: number;
}

/** Confirms a prune. */
export interface PruneRequest {
  /**
   * The ids the dry run listed under `remove`. The job plans again when it runs and
   * refuses to delete any backup that is not in this list (the catalog may have
   * changed since the dry run), so a confirmation can never delete more than was shown.
   */
  readonly remove: readonly string[];
}

// ---------------------------------------------------------------------------
// Config import
// ---------------------------------------------------------------------------

/**
 * Imports a `mongoshield.config.ts` as JSON: the object passed to `defineConfig`,
 * or several of them keyed by plan name (`{ "nightly prod": {...}, ... }`), which
 * is what evaluating the console's own export and `JSON.stringify`-ing its named
 * exports produces.
 *
 * Secrets never travel inside `document`. A connection string with a password,
 * `encryption.passphrase` or a notification URL in the document is refused; give
 * them in `secrets` instead. Leaving them out of the document (as the export does
 * with unset `process.env` references: `source: {}`, `encryption: {}`, notify
 * targets without `url`) means "take it from `secrets`, or keep what the console
 * already stores for this plan".
 *
 * Send `dryRun: true` first to see the changes, then the same body with
 * `dryRun: false` to apply them (all or nothing).
 */
export interface ConfigImportRequest {
  readonly document: unknown;
  /** The plan's name when `document` is a single config. Defaults to "Imported plan". */
  readonly planName?: string;
  /** Secrets per plan name. */
  readonly secrets?: Readonly<Record<string, ConfigImportSecrets>>;
  readonly dryRun: boolean;
}

/** The secrets of one imported plan, given explicitly. */
export interface ConfigImportSecrets {
  /** The source connection string (may contain credentials). Overrides `source.uri`. */
  readonly uri?: string;
  /** The backup passphrase, for passphrase encryption (`encryption: {}` in the document). */
  readonly passphrase?: string;
  /** Notification URLs, by position in the document's `notify` list. */
  readonly notifyUrls?: readonly string[];
  /** Credentials for a NEW storage location (environment-style pairs). */
  readonly storageCredentials?: Readonly<Record<string, string>>;
}

/** One resource the import creates, changes or leaves as it is. */
export interface ConfigImportChange {
  readonly kind: "connection" | "storage" | "plan";
  readonly name: string;
  readonly action: "create" | "update" | "unchanged";
  /** For updates: each changed field with its old and new value (secrets never shown). */
  readonly fields: readonly {
    readonly field: string;
    readonly from?: string;
    readonly to?: string;
  }[];
}

/** What an import did (or, for a dry run, would do). */
export interface ConfigImportResult {
  readonly dryRun: boolean;
  readonly changes: readonly ConfigImportChange[];
  /** Settings in the document the console does not manage and therefore ignores. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobKind =
  | "backup"
  | "restore"
  | "verify"
  | "drill"
  | "prune"
  | "preview"
  /** "Update many" / "delete many" in the live data browser, or undoing one. */
  | "live-edit";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobSummary {
  readonly id: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly planId?: string;
  /** The storage location the job reads from or writes to, when there is one. */
  readonly storageId?: string;
  /** The backup the job created (backup) or worked on (restore, verify, drill); absent for prune. */
  readonly backupId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Who started it: a username, or "schedule". */
  readonly startedBy: string;
  /** e.g. the new backup id, or "restored 1.2M documents". */
  readonly summary?: string;
  readonly error?: ApiError["error"];
}

/** Server-Sent Events on /api/jobs/:id/events. `data` is JSON of this shape. */
export type JobEvent =
  | { readonly type: "status"; readonly job: JobSummary }
  | {
      readonly type: "progress";
      readonly documents: number;
      readonly estimatedDocuments: number;
      readonly bytes: number;
      readonly etaMs?: number;
      /** The namespace being worked on most recently, and its documents so far. */
      readonly namespace?: string;
      readonly namespaceDocuments?: number;
    }
  /**
   * A namespace has finished, with its final document count. Sent unthrottled, once per
   * namespace: progress events are throttled, so a small collection can start and end
   * between two of them, and several collections may be in progress at once.
   */
  | { readonly type: "namespace"; readonly ns: string; readonly documents: number }
  | { readonly type: "log"; readonly level: "info" | "warn" | "error"; readonly message: string };

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEntry {
  readonly at: string;
  /** Username, "schedule", or "anonymous" for failed logins. */
  readonly actor: string;
  /** e.g. "connection.create", "restore.start", "session.login_failed". */
  readonly action: string;
  readonly target?: string;
  readonly outcome: "success" | "failure";
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

// ---------------------------------------------------------------------------
// Live data: browsing and (opt-in) editing the databases of a connection
// ---------------------------------------------------------------------------

/**
 * The live data browser reads documents straight from a connection's databases
 * (operator role, like the backup document browser). Changing them is off by default
 * and needs three things at once:
 *
 * 1. an admin turned on "Allow live edits" for the connection (for a connection marked
 *    production: with its name typed again and a reason, both recorded);
 * 2. the user holds the `data:write` permission (granted per user by an admin);
 * 3. every write is conditional: the document must still be exactly the version the
 *    user loaded (`version`), or the write is refused with `409 CONSOLE_LIVE_CONFLICT`.
 *
 * Before any write the console stores the document's pre-image in the live edit
 * journal (sealed with the console's key, in the connection's journal storage), so
 * every edit can be undone from the Edit history page. Undo is itself a conditional
 * write and is journaled too (undoing an undo redoes the edit).
 */

/** Most documents a bulk edit may touch, whatever a connection's setting says. */
export const LIVE_BULK_HARD_LIMIT = 10_000;
/** Default "max documents per bulk edit" for a connection. */
export const LIVE_BULK_DEFAULT_LIMIT = 1_000;

/** A connection's live edit settings. */
export interface LiveEditSettingsView {
  readonly enabled: boolean;
  /** For connections marked production: an admin confirmed with the name and a reason. */
  readonly productionConfirmed: boolean;
  /** Who last changed the settings, when, and why. */
  readonly changedBy?: string;
  readonly changedAt?: string;
  readonly reason?: string;
  /**
   * The storage location that keeps the edit journal (the pre-images used for undo).
   * Absent: the journal is kept in the console's data directory.
   */
  readonly journalStorageId?: string;
  /** Most documents one "update many" / "delete many" may touch (≤ {@link LIVE_BULK_HARD_LIMIT}). */
  readonly maxBulkDocuments: number;
}

/** Changes a connection's live edit settings (admin, `PUT /api/connections/:id/live-edits`). */
export interface LiveEditSettingsInput {
  readonly enabled: boolean;
  /** A storage location id for the journal; omit to keep the journal in the data directory. */
  readonly journalStorageId?: string;
  readonly maxBulkDocuments?: number;
  /** Turning edits on for a production connection: its name, typed again. */
  readonly confirmName?: string;
  /** Why edits are turned on. Required for production connections; recorded in the audit log. */
  readonly reason?: string;
}

/** One live document as the browser shows it. */
export interface LiveDocument {
  /** The document as relaxed Extended JSON (what the editor shows). */
  readonly json: string;
  /** The `_id` as canonical Extended JSON; absent when the projection left it out. */
  readonly id?: string;
  /**
   * SHA-256 of the document as read (its BSON). Send it back with an edit or delete: the
   * write only happens while the stored document still has this version. Absent for
   * documents read with a projection, which are partial and cannot be edited.
   */
  readonly version?: string;
  /**
   * The document as canonical Extended JSON (every BSON type explicit). Only sent when
   * the request asked for it with `ejson=canonical` (the document viewer's JSON view).
   */
  readonly canonical?: string;
}

/** How many documents match a live query. */
export interface LiveCount {
  readonly value: number;
  /**
   * `estimated`: the collection's metadata count (no filter); `exact`: counted;
   * `at-least`: counting stopped at `value` (there are more).
   */
  readonly kind: "estimated" | "exact" | "at-least";
}

/**
 * A page of live documents (`GET /api/live/:id/documents`).
 * Query: `ns` (required), `filter`, `projection`, `sort` (Extended JSON objects),
 * `skip` (≤ 100 000), `limit` (≤ 100).
 */
export interface LiveDocumentPage {
  readonly documents: readonly LiveDocument[];
  readonly skip: number;
  readonly limit: number;
  readonly count: LiveCount;
  /** True when more documents follow this page. */
  readonly hasMore: boolean;
  /** True when a projection was applied (the documents are partial and read-only). */
  readonly projected: boolean;
}

/** One index of a live collection. */
export interface LiveIndexView {
  readonly name: string;
  /** The key pattern as relaxed Extended JSON, e.g. `{"email":1}`. */
  readonly key: string;
  readonly unique: boolean;
  readonly sparse: boolean;
  readonly hidden: boolean;
  readonly expireAfterSeconds?: number;
  /** The partial filter expression, as relaxed Extended JSON. */
  readonly partialFilter?: string;
  readonly sizeBytes?: number;
}

/** Statistics and indexes of a live collection (`GET /api/live/:id/collection?ns=`). */
export interface LiveCollectionInfo {
  readonly ns: string;
  readonly type: "collection" | "view" | "timeseries";
  readonly estimatedDocuments: number;
  /** Uncompressed size of the documents, storage size on disk, and the indexes' size. */
  readonly sizeBytes?: number;
  readonly storageSizeBytes?: number;
  readonly averageDocumentBytes?: number;
  readonly totalIndexBytes?: number;
  readonly capped: boolean;
  readonly indexes: readonly LiveIndexView[];
  /** Whether the caller may change documents here right now. */
  readonly writable: boolean;
  /** Why not, in words, when `writable` is false. */
  readonly readOnlyReason?: string;
  /**
   * Why the sizes above are missing, in words, when MongoDB refused `$collStats` (missing
   * privileges, or an Atlas Free/Flex cluster, which limits it). The UI shows "—" with
   * this as the tooltip instead of an error: the collection is still browsable.
   */
  readonly statsUnavailable?: string;
  /**
   * True when the connection is an Atlas shared-tier cluster (Free, Flex, legacy M2/M5).
   * Those are throttled (about 100 operations per second), so the UI paces the queries
   * it runs on its own (schema samples, field suggestions) and samples fewer documents.
   */
  readonly sharedTier?: boolean;
}

/** Documents a schema sample reads when the request does not say (`LiveSampleRequest.size`). */
export const LIVE_SAMPLE_DEFAULT_SIZE = 200;
/** Most documents one schema sample may read. */
export const LIVE_SAMPLE_MAX_SIZE = 1_000;
/** Most documents one schema sample may read on an Atlas shared-tier cluster. */
export const LIVE_SAMPLE_SHARED_TIER_MAX_SIZE = 200;

/**
 * A sample of documents for the schema and chart views and the filter's field
 * suggestions (`GET /api/live/:id/sample?ns=&filter=&size=`, operator, audited as
 * `live.browse`), or of a namespace inside a backup
 * (`GET /api/storage/:id/backups/:backupId/sample?ns=&filter=&size=`).
 */
export interface DocumentSample {
  /** The sampled documents as relaxed Extended JSON. */
  readonly documents: readonly string[];
  /** How many were asked for, after the server's cap (so the UI can say "a sample of 200"). */
  readonly size: number;
  /**
   * `random`: MongoDB's `$sample` (live collections); `first`: the first documents in
   * storage order (backups are read as a stream, so there is no random access).
   */
  readonly method: "random" | "first";
}

/** File formats of an export. */
export type ExportFormat = "json" | "jsonl" | "csv";
/** Documents an export contains when the request does not say. */
export const EXPORT_DEFAULT_LIMIT = 1_000;
/** Most documents one export may contain. */
export const EXPORT_MAX_LIMIT = 10_000;
/** Most bytes of content one export may contain; it stops early (and says so) beyond this. */
export const EXPORT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The current result of the document viewer as a file:
 * `GET /api/live/:id/export?ns=&filter=&projection=&sort=&format=&limit=&ejson=` and
 * `GET /api/storage/:id/backups/:backupId/export?ns=&filter=&format=&limit=&ejson=`
 * (operator, audited as `live.export` / `backup.export` with counts, never contents).
 *
 * - `json`: one array of documents; `jsonl`: one document per line (both relaxed
 *   Extended JSON, or canonical with `ejson=canonical`);
 * - `csv`: one column per field path (nested fields flattened as `address.city`, arrays
 *   as JSON text), RFC 4180 quoting, and cells that a spreadsheet would run as a formula
 *   (starting with `=`, `+`, `-`, `@`) prefixed with `'`.
 */
export interface ExportResult {
  /** A suggested file name, e.g. `shop.orders.csv`. */
  readonly filename: string;
  /** e.g. `text/csv;charset=utf-8`. */
  readonly contentType: string;
  /** The file's text. */
  readonly content: string;
  /** How many documents it contains. */
  readonly documents: number;
  /** True when it stopped at `limit` or at {@link EXPORT_MAX_BYTES} with more documents left. */
  readonly truncated: boolean;
}

/** Inserts one document (`POST /api/live/:id/documents`). */
export interface LiveInsertRequest {
  readonly ns: string;
  /** Extended JSON (relaxed or canonical). Without `_id`, the console adds an ObjectId. */
  readonly document: string;
}

/** Replaces one document with an edited version (`PUT /api/live/:id/documents`). */
export interface LiveReplaceRequest {
  readonly ns: string;
  /** The `_id` as canonical Extended JSON (`LiveDocument.id`); the edit may not change it. */
  readonly id: string;
  /** The version the edit was made from (`LiveDocument.version`). */
  readonly version: string;
  /**
   * The edited document as Extended JSON. Fields whose value is unchanged keep their exact
   * BSON type (a double stays a double even if it reads `1`); changed fields take the type
   * their new value has (use `{"$numberLong": "…"}` and friends to choose one).
   */
  readonly document: string;
}

/** Deletes one document (`POST /api/live/:id/documents/delete`). */
export interface LiveDeleteRequest {
  readonly ns: string;
  readonly id: string;
  readonly version: string;
}

/** What a single-document write did. */
export interface LiveWriteResult {
  readonly entry: LiveEditEntryView;
  /** The document as stored now (absent after a delete). */
  readonly document?: LiveDocument;
  /** Dotted paths of the fields that changed (edits only). */
  readonly changedFields?: readonly string[];
}

/** "Update many" / "delete many": what to change. */
export interface LiveBulkRequest {
  readonly ns: string;
  readonly op: "update" | "delete";
  /** The filter, as Extended JSON. An empty filter (all documents) is allowed but must be typed. */
  readonly filter: string;
  /**
   * For `update`: update operators as Extended JSON, e.g. `{"$set": {"status": "archived"}}`.
   * Only operators are allowed (no replacement documents, no pipelines).
   */
  readonly update?: string;
}

/** The mandatory preview of a bulk edit (`POST /api/live/:id/bulk/preview`). */
export interface LiveBulkPreview {
  readonly ns: string;
  readonly op: "update" | "delete";
  /** Documents the filter matches now. */
  readonly matched: number;
  /** The connection's cap (`maxBulkDocuments`). */
  readonly max: number;
  /** False when `matched` is over the cap (narrow the filter or raise the cap). */
  readonly allowed: boolean;
  /** What the user has to type to confirm, e.g. `delete 42 documents in app.users`. */
  readonly confirmText: string;
}

/** Starts a bulk edit as a job (`POST /api/live/:id/bulk`). */
export interface LiveBulkConfirm extends LiveBulkRequest {
  /** `LiveBulkPreview.matched`: the job refuses to run if the count has changed since. */
  readonly expectedCount: number;
  /** Exactly `LiveBulkPreview.confirmText`. */
  readonly confirm: string;
}

/** What a live edit journal entry records. */
export type LiveEditOp = "insert" | "update" | "delete" | "bulk-update" | "bulk-delete" | "undo";

/**
 * `pending`: the pre-image is journaled, the write has not been confirmed (still running,
 * or the console stopped); `applied`: done; `partial`: a bulk edit or undo skipped
 * documents that had changed; `conflict`: nothing was written because the document had
 * changed; `failed`: an error stopped it.
 */
export type LiveEditStatus = "pending" | "applied" | "partial" | "conflict" | "failed";

/** One entry of the Edit history page (`GET /api/live-edits`). */
export interface LiveEditEntryView {
  readonly id: string;
  readonly connectionId: string;
  /** The connection's name (absent if the connection was deleted since). */
  readonly connectionName?: string;
  readonly ns: string;
  readonly op: LiveEditOp;
  readonly by: string;
  readonly at: string;
  readonly status: LiveEditStatus;
  /** Documents whose pre-image was journaled, then changed, then skipped as changed meanwhile. */
  readonly documents: number;
  readonly applied: number;
  readonly conflicts: number;
  /** The `_id` (relaxed Extended JSON) of a single-document entry. */
  readonly documentId?: string;
  readonly beforeHash?: string;
  readonly afterHash?: string;
  /** The entry this one undid, and the entry that undid this one. */
  readonly undoOf?: string;
  readonly undoneBy?: string;
  readonly jobId?: string;
  /** Where the journal objects are kept. */
  readonly journal: { readonly kind: "storage" | "console"; readonly storageId?: string };
  /** True when undo can be attempted (it is still checked document by document). */
  readonly undoable: boolean;
  readonly error?: ApiError["error"];
}

/** An entry with its journaled documents (`GET /api/live-edits/:id`, audited). */
export interface LiveEditEntryDetail extends LiveEditEntryView {
  /** The first journaled documents, relaxed Extended JSON; `before` absent for inserts, `after` for deletes. */
  readonly records: readonly {
    readonly id: string;
    readonly before?: string;
    readonly after?: string;
  }[];
  /** True when the entry has more documents than `records` lists. */
  readonly truncated: boolean;
}

/** Undoing an entry: single documents are undone at once, bulk entries by a job. */
export type LiveUndoResult =
  | { readonly kind: "applied"; readonly entry: LiveEditEntryView }
  | { readonly kind: "job"; readonly job: JobSummary };

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

/**
 * Every endpoint: `"METHOD /path"` → { request; response }.
 * `:id`-style segments are path parameters. Query parameters are noted in comments.
 */
export interface ApiRoutes {
  "GET /api/session": { request: undefined; response: SessionInfo };
  "POST /api/session": { request: LoginRequest; response: SessionInfo };
  "DELETE /api/session": { request: undefined; response: { ok: true } };
  "POST /api/setup": { request: SetupRequest; response: SessionInfo };

  "GET /api/users": { request: undefined; response: readonly UserView[] };
  "POST /api/users": { request: UserInput; response: UserView };
  "PUT /api/users/:id": { request: UserInput; response: UserView };
  "DELETE /api/users/:id": { request: undefined; response: { ok: true } };

  "GET /api/connections": { request: undefined; response: readonly ConnectionView[] };
  "POST /api/connections": { request: ConnectionInput; response: ConnectionView };
  "PUT /api/connections/:id": { request: ConnectionInput; response: ConnectionView };
  "DELETE /api/connections/:id": { request: undefined; response: { ok: true } };
  "POST /api/connections/:id/test": { request: undefined; response: ConnectionTestResult };
  /** Tests a connection string before saving it, with the defaults to propose (admin). */
  "POST /api/connections/check": {
    request: ConnectionCheckRequest;
    response: ConnectionCheckResult;
  };
  /** Asks an external service for the console's public IP (admin; only when clicked). */
  "POST /api/network/public-ip": { request: undefined; response: PublicIpResult };
  "GET /api/connections/:id/namespaces": { request: undefined; response: readonly DatabaseNode[] };
  /** Live edit settings (admin; production connections need `confirmName` and `reason`). */
  "PUT /api/connections/:id/live-edits": {
    request: LiveEditSettingsInput;
    response: ConnectionView;
  };

  "GET /api/storage": { request: undefined; response: readonly StorageView[] };
  "POST /api/storage": { request: StorageInput; response: StorageView };
  "PUT /api/storage/:id": { request: StorageInput; response: StorageView };
  "DELETE /api/storage/:id": { request: undefined; response: { ok: true } };
  "POST /api/storage/:id/test": { request: undefined; response: StorageTestResult };

  "GET /api/plans": { request: undefined; response: readonly PlanView[] };
  "POST /api/plans": { request: PlanInput; response: PlanView };
  "PUT /api/plans/:id": { request: PlanInput; response: PlanView };
  "DELETE /api/plans/:id": { request: undefined; response: { ok: true } };
  "POST /api/plans/:id/run": { request: undefined; response: JobSummary };
  /** The recovery key of a plan with a managed key (admin; audited; marks it saved). */
  "POST /api/plans/:id/recovery-key": { request: undefined; response: RecoveryKeyView };
  /** "Back up now": creates or reuses the connection's quick plan and runs it (admin). */
  "POST /api/quick-backup": { request: QuickBackupRequest; response: QuickBackupResult };
  /** Dry run of the plan's retention policy (admin). */
  "POST /api/plans/:id/prune/plan": { request: undefined; response: PrunePlanView };
  /** Applies it as a `prune` job (admin). */
  "POST /api/plans/:id/prune": { request: PruneRequest; response: JobSummary };

  "GET /api/storage/:id/backups": { request: undefined; response: readonly BackupSummary[] };
  "GET /api/storage/:id/backups/:backupId": { request: undefined; response: BackupDetail };
  "POST /api/storage/:id/backups/:backupId/verify": {
    request: { mode: "fast" | "deep" };
    response: JobSummary;
  };
  "POST /api/storage/:id/backups/:backupId/drill": {
    request: { targetConnectionId: string; sample?: number };
    response: JobSummary;
  };
  "POST /api/storage/:id/backups/:backupId/hold": {
    request: { reason: string };
    response: { ok: true };
  };
  "DELETE /api/storage/:id/backups/:backupId/hold": { request: undefined; response: { ok: true } };
  /** Query: `ns` (required), `filter` (Extended JSON), `limit` (≤ 100), `after`, `ejson`. */
  "GET /api/storage/:id/backups/:backupId/documents": {
    request: undefined;
    response: DocumentPage;
  };
  /** Query: `ns` (required), `filter`, `size`. The first documents (operator, audited). */
  "GET /api/storage/:id/backups/:backupId/sample": {
    request: undefined;
    response: DocumentSample;
  };
  /** Query: `ns` (required), `filter`, `format`, `limit`, `ejson` (operator, audited). */
  "GET /api/storage/:id/backups/:backupId/export": {
    request: undefined;
    response: ExportResult;
  };

  "POST /api/restore/plan": { request: RestoreRequest; response: RestorePlanView };
  "POST /api/restore": { request: RestoreRequest; response: JobSummary };
  /** Starts a restore preview job (same rules as the dry-run plan; no `filter`). */
  "POST /api/restore/preview": { request: RestoreRequest; response: JobSummary };
  "GET /api/restore/preview/:id": { request: undefined; response: RestorePreviewView };
  /** Query: `ns` (backup namespace), `category`, `limit` (≤ 100), `after`. */
  "GET /api/restore/preview/:id/documents": { request: undefined; response: PreviewDocumentPage };
  "POST /api/restore/preview/:id/document": {
    request: PreviewDocumentRequest;
    response: PreviewDocumentDiff;
  };

  /** Query: `ns` (required). Operator. */
  "GET /api/live/:id/collection": { request: undefined; response: LiveCollectionInfo };
  /** Query: `ns` (required), `filter`, `projection`, `sort`, `skip`, `limit`, `ejson`. Operator. */
  "GET /api/live/:id/documents": { request: undefined; response: LiveDocumentPage };
  /** Query: `ns` (required), `filter`, `size`. A random sample for the schema view. Operator. */
  "GET /api/live/:id/sample": { request: undefined; response: DocumentSample };
  /** Query: `ns` (required), `filter`, `projection`, `sort`, `format`, `limit`, `ejson`. Operator. */
  "GET /api/live/:id/export": { request: undefined; response: ExportResult };
  /** The write routes need `data:write` and live edits turned on for the connection. */
  "POST /api/live/:id/documents": { request: LiveInsertRequest; response: LiveWriteResult };
  "PUT /api/live/:id/documents": { request: LiveReplaceRequest; response: LiveWriteResult };
  "POST /api/live/:id/documents/delete": { request: LiveDeleteRequest; response: LiveWriteResult };
  "POST /api/live/:id/bulk/preview": { request: LiveBulkRequest; response: LiveBulkPreview };
  "POST /api/live/:id/bulk": { request: LiveBulkConfirm; response: JobSummary };
  /** Query: `connectionId`, `limit` (≤ 200), `before` (an entry id, for older pages). Operator. */
  "GET /api/live-edits": { request: undefined; response: readonly LiveEditEntryView[] };
  "GET /api/live-edits/:id": { request: undefined; response: LiveEditEntryDetail };
  "POST /api/live-edits/:id/undo": { request: undefined; response: LiveUndoResult };

  "GET /api/jobs": { request: undefined; response: readonly JobSummary[] };
  "GET /api/jobs/:id": { request: undefined; response: JobSummary };
  "POST /api/jobs/:id/cancel": { request: undefined; response: JobSummary };

  /** Query: `limit`, `before` (ISO date) for paging backwards. */
  "GET /api/audit": { request: undefined; response: readonly AuditEntry[] };

  "GET /api/config/export": { request: undefined; response: { filename: string; content: string } };
  /** Dry run or apply (admin). */
  "POST /api/config/import": { request: ConfigImportRequest; response: ConfigImportResult };
}

/** `"GET /api/plans"` → `"GET"`. */
export type RouteMethod<Route extends keyof ApiRoutes> = Route extends `${infer Method} ${string}`
  ? Method
  : never;
