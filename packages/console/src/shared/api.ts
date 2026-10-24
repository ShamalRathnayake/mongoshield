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
  /** The one-time token printed in the server log at first start. */
  readonly token: string;
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
}

/** One database in the namespace tree used to choose what to back up. */
export interface DatabaseNode {
  readonly name: string;
  readonly collections: readonly {
    readonly name: string;
    readonly type: "collection" | "view" | "timeseries";
    readonly estimatedDocuments: number;
    readonly indexes: number;
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
    | { readonly kind: "passphrase"; readonly passphrase: SecretSummary };
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
  readonly nextRunAt?: string;
  readonly lastRun?: JobSummary;
}

export type PlanInput = Omit<PlanView, "id" | "encryption" | "notify" | "nextRunAt" | "lastRun"> & {
  readonly encryption:
    | { readonly kind: "none" }
    | { readonly kind: "recipients"; readonly recipients: readonly string[] }
    /** Omit `passphrase` when updating to keep the stored one. */
    | { readonly kind: "passphrase"; readonly passphrase?: string };
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
  }[];
}

/** A page of documents from inside a backup, as relaxed Extended JSON strings. */
export interface DocumentPage {
  readonly documents: readonly string[];
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

export type JobKind = "backup" | "restore" | "verify" | "drill" | "prune";
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
  "GET /api/connections/:id/namespaces": { request: undefined; response: readonly DatabaseNode[] };

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
  /** Query: `ns` (required), `filter` (Extended JSON), `limit` (≤ 100), `after`. */
  "GET /api/storage/:id/backups/:backupId/documents": {
    request: undefined;
    response: DocumentPage;
  };

  "POST /api/restore/plan": { request: RestoreRequest; response: RestorePlanView };
  "POST /api/restore": { request: RestoreRequest; response: JobSummary };

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
