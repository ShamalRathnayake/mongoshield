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
  /** Login methods the server accepts. */
  readonly authMethods: readonly ("password" | "oidc" | "proxy")[];
}

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
  readonly createdAt: string;
  readonly lastLoginAt?: string;
}

export interface UserInput {
  readonly username: string;
  readonly role: Role;
  /** Required when creating; optional when updating (omit to keep). */
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
  /** The backup the job created (backup) or worked on (restore, verify, drill). */
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
      readonly namespace?: string;
    }
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
}

/** `"GET /api/plans"` → `"GET"`. */
export type RouteMethod<Route extends keyof ApiRoutes> = Route extends `${infer Method} ${string}`
  ? Method
  : never;
