/**
 * The shape of the console's own data: everything stored in `<data>/console.json`.
 *
 * These are the *stored* records. They differ from the API views in
 * src/shared/api.ts in one important way: secrets are kept here, encrypted
 * (see crypto.ts), and the server turns records into views that never contain
 * them (src/server/views.ts).
 *
 * The document is versioned so a later release can migrate it. Version 1 is the
 * first format; readers refuse versions they do not know rather than guessing.
 */

import type {
  ApiError,
  JobSummary,
  LiveEditOp,
  LiveEditStatus,
  Permission,
  Role,
} from "../shared/api.ts";

/** Version of the console.json layout. Bump it (and add a migration) on incompatible changes. */
export const STATE_FORMAT_VERSION = 1;

/**
 * A secret encrypted with AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>`, each part
 * base64url. Produced and opened only by crypto.ts.
 */
export type EncryptedSecret = string;

/** A console user. Passwords are stored only as scrypt hashes (passwords.ts). */
export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  /** `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>`; empty for users that may only sign in via SSO. */
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly lastLoginAt?: string;
  /**
   * The OIDC identity this account belongs to, set at its first OIDC sign-in.
   * Identities are matched by issuer + subject only (the `sub` claim is stable and
   * unique per issuer; usernames and emails are not). Added without a format bump:
   * older files simply have no linked identities.
   */
  readonly oidc?: { readonly issuer: string; readonly subject: string };
  /**
   * Extra permissions on top of the role (see `Permission` in src/shared/api.ts), e.g.
   * `data:write` for editing live documents. Added without a format bump: older files
   * have none, which means "no extra permissions".
   */
  readonly permissions?: readonly Permission[];
}

/** A signed-in browser session. Only the SHA-256 of the session id is stored. */
export interface SessionRecord {
  /** Hex SHA-256 of the cookie value, so a leaked state file cannot be replayed as a cookie. */
  readonly idHash: string;
  readonly userId: string;
  readonly createdAt: string;
  /** Updated (at most every few minutes) as the session is used; drives the idle timeout. */
  readonly lastSeenAt: string;
}

/** The single-use token that creates the first admin. Only its hash is stored. */
export interface SetupTokenRecord {
  readonly tokenHash: string;
  readonly expiresAt: string;
}

/** A MongoDB deployment the console can back up from or restore into. */
export interface ConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly uri: EncryptedSecret;
  /** The URI with its password removed, computed when the URI is saved. */
  readonly uriPreview: string;
  readonly production: boolean;
  readonly createdAt: string;
  /**
   * Live data editing for this connection (off when absent). Added without a format
   * bump: older files have no such settings, which means "read-only".
   */
  readonly liveEdits?: LiveEditSettingsRecord;
}

/**
 * Whether people with the `data:write` permission may change documents of a
 * connection from the console's live data browser, and with which safety rails.
 */
export interface LiveEditSettingsRecord {
  readonly enabled: boolean;
  /** The admin who last changed the setting, and when. */
  readonly changedBy: string;
  readonly changedAt: string;
  /** Why live edits were turned on; required for production connections. */
  readonly reason?: string;
  /**
   * True only when an admin turned edits on while the connection was marked production,
   * typing its name to confirm. Marking a connection production later turns edits off.
   */
  readonly productionConfirmed: boolean;
  /**
   * The storage location that keeps the edit journal (pre-images for undo). Absent:
   * the journal lives in the console's data directory (`<data>/live-journal`).
   */
  readonly journalStorageId?: string;
  /** Most documents one "update many" or "delete many" may touch. */
  readonly maxBulkDocuments: number;
}

/**
 * One entry of the live edit journal index. The pre-images (and post-images) of the
 * documents live in the journal objects (src/server/live/journal.ts), sealed with the
 * console's key; this record only says what happened, so the history page and the audit
 * log never need the document contents.
 */
export interface LiveEditRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly ns: string;
  readonly op: LiveEditOp;
  /** Username of whoever made the change. */
  readonly by: string;
  readonly at: string;
  readonly status: LiveEditStatus;
  /** Documents whose pre-image was journaled. */
  readonly documents: number;
  /** Documents actually changed, and documents skipped because they had changed meanwhile. */
  readonly applied: number;
  readonly conflicts: number;
  /** Relaxed Extended JSON of the `_id`, for single-document entries. */
  readonly documentId?: string;
  /** SHA-256 of the document before and after (single-document entries). */
  readonly beforeHash?: string;
  readonly afterHash?: string;
  /** The entry this one undid, and the entry that undid this one. */
  readonly undoOf?: string;
  readonly undoneBy?: string;
  /** The job of a bulk operation or a bulk undo. */
  readonly jobId?: string;
  /** Where the journal objects are: a storage location, or the console's data directory. */
  readonly journal:
    | { readonly kind: "storage"; readonly storageId: string }
    | { readonly kind: "console" };
  /** Number of journal objects (parts of at most 100 documents each). */
  readonly parts: number;
  readonly error?: ApiError["error"];
}

/** Live edit journal entries kept in console.json; older ones drop out of the index. */
export const MAX_LIVE_EDIT_HISTORY = 1000;

/** A storage location for backups. */
export interface StorageRecord {
  readonly id: string;
  readonly name: string;
  /** The storage URL (never contains credentials; those are refused on input). */
  readonly url: string;
  /** JSON of the environment-style credential pairs, encrypted. */
  readonly credentials?: EncryptedSecret;
  /** The credential names (not values), shown as the redacted preview. */
  readonly credentialNames?: readonly string[];
  readonly createdAt: string;
  /** Changes whenever the record changes, so cached storage adapters are rebuilt. */
  readonly updatedAt: string;
}

/** A notification target of a plan; its URL often embeds a token, so it is encrypted. */
export interface NotifyRecord {
  readonly type: "webhook" | "slack" | "discord";
  readonly url: EncryptedSecret;
  /** `https://hooks.slack.com/***`: origin only. */
  readonly urlPreview: string;
}

/** Encryption settings of a plan, with the passphrase (if any) encrypted. */
export type PlanEncryptionRecord =
  | { readonly kind: "none" }
  | { readonly kind: "recipients"; readonly recipients: readonly string[] }
  | { readonly kind: "passphrase"; readonly passphrase: EncryptedSecret };

/** A backup plan: connection + storage + what + how + when. */
export interface PlanRecord {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string;
  readonly storageId: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly compression: "zstd" | "gzip" | "none";
  readonly encryption: PlanEncryptionRecord;
  readonly consistency: "auto" | "none" | "snapshot" | "converge";
  readonly schedule?: { readonly cron: string; readonly timezone: string };
  readonly retention?: {
    readonly last?: number;
    readonly daily?: number;
    readonly weekly?: number;
    readonly monthly?: number;
    readonly yearly?: number;
  };
  readonly verify: "none" | "fast" | "deep";
  readonly notify: readonly NotifyRecord[];
  readonly createdAt: string;
  /**
   * Incremental backups between full ones: each run stores only the changes since the
   * previous backup, and a full backup starts a new chain every `fullEveryDays` (the
   * library's `backup.incremental`). Absent: every run is a full backup.
   */
  readonly incremental?: { readonly fullEveryDays: number };
}

/** The whole console.json document. */
export interface ConsoleState {
  readonly version: typeof STATE_FORMAT_VERSION;
  /** Base64 HKDF salt for the encryption key. Random per data directory. */
  readonly keySalt: string;
  /**
   * A known value encrypted with the derived key. If it does not decrypt, the
   * console was started with a different MONGOSHIELD_SECRET and must refuse to run
   * (otherwise it would silently fail to read every stored secret).
   */
  readonly keyCheck: EncryptedSecret;
  readonly setupToken?: SetupTokenRecord;
  readonly users: readonly UserRecord[];
  readonly sessions: readonly SessionRecord[];
  readonly connections: readonly ConnectionRecord[];
  readonly storage: readonly StorageRecord[];
  readonly plans: readonly PlanRecord[];
  /** Job history, newest first, at most {@link MAX_JOB_HISTORY} entries. */
  readonly jobs: readonly JobSummary[];
  /**
   * The live edit journal index, newest first, at most {@link MAX_LIVE_EDIT_HISTORY}
   * entries. Optional so files written before live editing existed still open.
   */
  readonly liveEdits?: readonly LiveEditRecord[];
}

/** Job history kept in console.json. Older jobs are dropped. */
export const MAX_JOB_HISTORY = 500;

/** A mutable copy of the state, handed to `StateStore.update` callbacks. */
export type MutableState = { -readonly [Key in keyof ConsoleState]: ConsoleState[Key] };
