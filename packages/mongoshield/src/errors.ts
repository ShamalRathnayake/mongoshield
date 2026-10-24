/**
 * Every failure MongoShield reports is a `MongoShieldError` with a stable `code`.
 * Codes are part of the public API: they are documented, mapped to CLI exit codes,
 * and never renamed within a major version.
 */

interface ErrorCodeInfo {
  /** Process exit code used by the CLI. */
  readonly exitCode: number;
  /** One-line description used in docs and as a fallback message. */
  readonly description: string;
}

export const ERROR_CODES = {
  MS_CONFIG_INVALID: { exitCode: 2, description: "The configuration is invalid." },
  MS_CONFIRMATION_REQUIRED: {
    exitCode: 3,
    description:
      "A destructive action needs confirmation, but the session is not interactive. Re-run with --yes.",
  },
  MS_CONNECTION_FAILED: { exitCode: 10, description: "Could not connect to MongoDB." },
  MS_AUTH_FAILED: { exitCode: 11, description: "MongoDB rejected the credentials." },
  MS_PERMISSION_DENIED: {
    exitCode: 12,
    description: "The MongoDB user lacks a privilege this operation needs.",
  },
  MS_UNSUPPORTED_TOPOLOGY: {
    exitCode: 13,
    description: "The deployment topology does not support this operation.",
  },
  MS_SNAPSHOT_TOO_OLD: {
    exitCode: 14,
    description:
      "A snapshot backup took longer than the server keeps snapshot history (5 minutes by default).",
  },
  MS_CHANGE_HISTORY_LOST: {
    exitCode: 15,
    description:
      "Changes needed for consistency or point-in-time recovery are no longer in the oplog (it rolled over).",
  },
  MS_STORAGE_NOT_FOUND: {
    exitCode: 20,
    description: "The storage location or object does not exist.",
  },
  MS_STORAGE_FORBIDDEN: { exitCode: 21, description: "Access to the storage location was denied." },
  MS_STORAGE_IO: { exitCode: 22, description: "A storage read or write failed." },
  MS_STORAGE_INSUFFICIENT_SPACE: {
    exitCode: 23,
    description: "There is not enough space at the storage location.",
  },
  MS_STORAGE_PRECONDITION_FAILED: {
    exitCode: 24,
    description: "A conditional storage write failed because the object already exists.",
  },
  MS_BACKUP_NOT_FOUND: { exitCode: 30, description: "No backup matches the given selector." },
  MS_MANIFEST_INVALID: { exitCode: 31, description: "A backup manifest is missing or malformed." },
  MS_FORMAT_UNSUPPORTED: {
    exitCode: 32,
    description: "The backup uses a format version this release cannot read.",
  },
  MS_INTEGRITY_FAILED: {
    exitCode: 33,
    description: "Backup data failed an integrity check (checksum, size or count).",
  },
  MS_GUARD_FAILED: {
    exitCode: 34,
    description:
      "The backup guard refused a backup that looks like data was lost since the previous one.",
  },
  MS_ENCRYPTION_FAILED: { exitCode: 40, description: "Encrypting backup data failed." },
  MS_DECRYPTION_FAILED: {
    exitCode: 41,
    description: "Backup data could not be decrypted or failed authentication.",
  },
  MS_NO_IDENTITY: {
    exitCode: 42,
    description: "The backup is encrypted and no matching identity or passphrase was given.",
  },
  MS_RESTORE_CONFLICT: {
    exitCode: 50,
    description: "The restore target already contains data that would be overwritten.",
  },
  MS_RESTORE_FAILED: { exitCode: 51, description: "Writing documents to the target failed." },
  MS_ABORTED: { exitCode: 60, description: "The operation was aborted." },
  MS_TIMEOUT: { exitCode: 61, description: "The operation timed out." },
  MS_NOT_IMPLEMENTED: { exitCode: 70, description: "This feature is not implemented yet." },
  MS_INTERNAL: { exitCode: 71, description: "An unexpected internal error occurred." },
} as const satisfies Record<string, ErrorCodeInfo>;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface MongoShieldErrorOptions {
  /** A short, actionable sentence telling the user how to fix the problem. */
  readonly hint?: string;
  /** The underlying error, if any. */
  readonly cause?: unknown;
  /** Structured context safe to log (never secrets). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Error pages on the docs site; each code has an anchor (`#ms_storage_forbidden`). */
const DOCS_BASE = "https://shamalrathnayake.github.io/mongoshield/reference/errors/";

export class MongoShieldError extends Error {
  override readonly name = "MongoShieldError";
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message?: string, options: MongoShieldErrorOptions = {}) {
    super(message ?? ERROR_CODES[code].description, { cause: options.cause });
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  get exitCode(): number {
    return ERROR_CODES[this.code].exitCode;
  }

  get docsUrl(): string {
    return `${DOCS_BASE}#${this.code.toLowerCase()}`;
  }
}

export function isMongoShieldError(error: unknown, code?: ErrorCode): error is MongoShieldError {
  return error instanceof MongoShieldError && (code === undefined || error.code === code);
}

/** Wraps an AbortSignal's reason in a typed error. */
export function abortError(signal: AbortSignal): MongoShieldError {
  const reason: unknown = signal.reason;
  if (reason instanceof MongoShieldError) return reason;
  const isTimeout = reason instanceof Error && reason.name === "TimeoutError";
  return new MongoShieldError(isTimeout ? "MS_TIMEOUT" : "MS_ABORTED", undefined, {
    cause: reason,
  });
}

/** Throws a typed abort error if the signal has been aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}
