import type { Readable } from "node:stream";

/**
 * A storage adapter is a dumb, stateless blob store. The engine owns the backup
 * layout; adapters only move bytes. Adapters must never keep per-run state, so a
 * single adapter instance can serve many concurrent and successive runs.
 *
 * Keys are relative POSIX paths such as `backups/<id>/app/users.bson.zst`.
 * They never start with `/`, never contain `..`, `\`, or empty segments.
 * Use `assertValidKey()` from `./keys.ts`.
 *
 * Errors must be thrown as `MongoShieldError` with one of the `MS_STORAGE_*` codes.
 */
export interface StorageAdapter {
  /** Short adapter id, e.g. `"file"`, `"s3"`, `"memory"`. */
  readonly kind: string;
  /** Human-readable location with any secrets removed, e.g. `s3://bucket/prefix/`. */
  readonly location: string;
  readonly capabilities: StorageCapabilities;

  /**
   * Writes an object from a stream or buffer. The write must be atomic from a
   * reader's point of view: either the full object is visible or nothing is.
   * With `ifNoneMatch: "*"` the write fails with `MS_STORAGE_PRECONDITION_FAILED`
   * if the key already exists (requires `capabilities.conditionalWrites`).
   */
  put(key: string, body: Readable | Uint8Array, options?: PutOptions): Promise<ObjectInfo>;

  /** Opens an object for reading. Throws `MS_STORAGE_NOT_FOUND` if missing. */
  get(key: string, options?: GetOptions): Promise<Readable>;

  /** Returns object info, or `undefined` if the object does not exist. */
  head(key: string, options?: SignalOptions): Promise<ObjectInfo | undefined>;

  /** Lists every object whose key starts with `prefix`, recursively, in lexicographic key order. */
  list(prefix: string, options?: SignalOptions): AsyncIterable<ObjectInfo>;

  /**
   * Lists the immediate "sub-directories" under `prefix` (which must be empty or end in `/`).
   * Each returned value ends in `/`, e.g. `backups/2026-11-14T03-00-04Z_7f3a9c/`.
   */
  listPrefixes(prefix: string, options?: SignalOptions): AsyncIterable<string>;

  /** Deletes objects. Missing keys are ignored. */
  delete(keys: readonly string[], options?: SignalOptions): Promise<void>;

  /** Releases resources (connections, file handles). Safe to call more than once. */
  close?(): Promise<void>;
}

export interface StorageCapabilities {
  /** `put(..., { ifNoneMatch: "*" })` is supported. Needed for storage-based locks. */
  readonly conditionalWrites: boolean;
  /** `get(..., { range })` is supported. */
  readonly rangeReads: boolean;
  /**
   * Write-once retention (S3 Object Lock, GCS object retention, Azure blob
   * immutability policies) can be applied with `PutOptions.retainUntil`.
   * When `false`, a put with `retainUntil` fails with `MS_CONFIG_INVALID`.
   * `true` means the adapter *can* ask for retention; whether the bucket or
   * container is set up for it is only known at the first retained put.
   */
  readonly objectLock: boolean;
}

/**
 * How strictly write-once retention is enforced, chosen per adapter (not per put),
 * because it is a property of the storage account's security policy, not of a backup.
 *
 * - `"compliance"`: nobody, not even the account root or an administrator, can
 *   shorten the retention or delete the object before it expires. This is what
 *   protects backups from ransomware and stolen admin credentials, and what
 *   regulations such as SEC 17a-4 ask for. It also means a mistake (retaining
 *   for 10 years instead of 10 days) cannot be undone and is billed until expiry.
 * - `"governance"`: the same protection against ordinary users and buggy scripts,
 *   but principals with a special permission (S3 `s3:BypassGovernanceRetention`,
 *   an unlocked GCS/Azure policy) can lift it. Good for trying the feature out.
 *
 * Maps to S3 `COMPLIANCE`/`GOVERNANCE`, GCS `Locked`/`Unlocked` and Azure
 * `Locked`/`Unlocked`. Adapters that support retention default to `"compliance"`,
 * the mode that actually holds against an attacker.
 */
export type RetentionMode = "compliance" | "governance";

/** Adapter option shared by every adapter that supports `retainUntil`. */
export interface RetentionOptions {
  /** See {@link RetentionMode}. Defaults to `"compliance"`. */
  readonly mode: RetentionMode;
}

export interface SignalOptions {
  readonly signal?: AbortSignal;
}

export interface PutOptions extends SignalOptions {
  readonly contentType?: string;
  readonly ifNoneMatch?: "*";
  /** Expected size in bytes if known; lets adapters pick multipart sizes. */
  readonly sizeHint?: number;
  /**
   * Write-once retention: the object cannot be deleted or overwritten before this
   * time (S3 Object Lock, GCS object retention, Azure immutability policy, in the
   * adapter's {@link RetentionMode}). Requires `capabilities.objectLock`; otherwise
   * the put fails with `MS_CONFIG_INVALID` before any of `body` is read, so a backup
   * that asked for immutability never silently produces mutable files.
   * Must be in the future. Deleting or overwriting a retained object fails with
   * `MS_STORAGE_FORBIDDEN` whose `details.objectLocked` is `true` (S3 is the
   * exception: there a delete only hides the locked version behind a delete marker).
   * Adapters that support retention take a `retention: { mode }` option, see
   * {@link RetentionMode}.
   */
  readonly retainUntil?: Date;
}

export interface GetOptions extends SignalOptions {
  /** Inclusive byte range. `end` defaults to the last byte. */
  readonly range?: { readonly start: number; readonly end?: number };
}

export interface ObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
  readonly etag?: string;
}
