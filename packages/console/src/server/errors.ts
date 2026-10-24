/**
 * Errors of the console and how every error becomes an `ApiError` response.
 *
 * - `ConsoleError` is thrown by console code with a `CONSOLE_…` code and an
 *   HTTP status (validation, authorization, not found, …).
 * - `MongoShieldError`s from the library keep their `MS_…` code and get a
 *   status from {@link MS_STATUS}.
 * - Anything else is an unexpected bug: the client gets a generic
 *   `CONSOLE_INTERNAL` message and the details go to the server log only, so
 *   stack traces, driver internals or secrets never reach a browser.
 *
 * Messages of known errors still pass through `scrubText`, which removes
 * credentials from any MongoDB URI that might appear in a driver message.
 */

import { type ErrorCode, isMongoShieldError } from "mongoshield";
import type { ApiError } from "../shared/api.ts";
import { scrubText } from "../state/redact.ts";

/** HTTP statuses the console uses for errors. */
export type ErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 415
  | 422
  | 429
  | 500
  | 501
  | 502
  | 503
  | 504
  | 507;

/** An error raised by console code, with its HTTP status. */
export class ConsoleError extends Error {
  override readonly name = "ConsoleError";
  readonly code: string;
  readonly status: ErrorStatus;
  readonly hint: string | undefined;

  constructor(status: ErrorStatus, code: string, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/** `404 CONSOLE_NOT_FOUND` for a resource id that does not exist. */
export function notFound(what: string): ConsoleError {
  return new ConsoleError(404, "CONSOLE_NOT_FOUND", `${what} was not found.`);
}

/** `400 CONSOLE_VALIDATION` for a request body or query that is not acceptable. */
export function invalid(message: string, hint?: string): ConsoleError {
  return new ConsoleError(400, "CONSOLE_VALIDATION", message, hint);
}

/** `403 CONSOLE_FORBIDDEN`: signed in, but the role does not allow this. */
export function forbidden(message = "Your role does not allow this action."): ConsoleError {
  return new ConsoleError(403, "CONSOLE_FORBIDDEN", message);
}

/**
 * HTTP status per library error code. Problems with the user's input are 4xx;
 * problems reaching MongoDB or storage are 502 (the console is a gateway to them).
 */
const MS_STATUS: Readonly<Record<ErrorCode, ErrorStatus>> = {
  MS_CONFIG_INVALID: 400,
  MS_CONFIRMATION_REQUIRED: 400,
  MS_CONNECTION_FAILED: 502,
  MS_AUTH_FAILED: 502,
  MS_PERMISSION_DENIED: 502,
  MS_UNSUPPORTED_TOPOLOGY: 422,
  MS_SNAPSHOT_TOO_OLD: 422,
  MS_CHANGE_HISTORY_LOST: 422,
  MS_STORAGE_NOT_FOUND: 404,
  MS_STORAGE_FORBIDDEN: 502,
  MS_STORAGE_IO: 502,
  MS_STORAGE_INSUFFICIENT_SPACE: 507,
  MS_STORAGE_PRECONDITION_FAILED: 409,
  MS_BACKUP_NOT_FOUND: 404,
  // On hold, write-once, or needed by an incremental: the state forbids it, so 409.
  MS_BACKUP_PROTECTED: 409,
  MS_MANIFEST_INVALID: 422,
  MS_FORMAT_UNSUPPORTED: 422,
  MS_INTEGRITY_FAILED: 422,
  MS_GUARD_FAILED: 422,
  MS_ENCRYPTION_FAILED: 500,
  MS_DECRYPTION_FAILED: 422,
  MS_NO_IDENTITY: 422,
  MS_RESTORE_CONFLICT: 409,
  MS_RESTORE_FAILED: 502,
  MS_ABORTED: 409,
  MS_TIMEOUT: 504,
  MS_NOT_IMPLEMENTED: 501,
  MS_INTERNAL: 500,
};

/** The generic body sent for unexpected errors. */
const INTERNAL_ERROR: ApiError["error"] = {
  code: "CONSOLE_INTERNAL",
  message: "An unexpected error occurred. The server log has the details.",
};

/** True when `error` is one the console knows how to describe to a client. */
export function isKnownError(error: unknown): boolean {
  return error instanceof ConsoleError || isMongoShieldError(error);
}

/**
 * The client-safe description of an error. `secrets` are extra strings to
 * scrub from the message (e.g. the URI of the connection being used).
 */
export function describeError(error: unknown, secrets: readonly string[] = []): ApiError["error"] {
  if (error instanceof ConsoleError || isMongoShieldError(error)) {
    const hint = error.hint;
    return {
      code: error.code,
      message: scrubText(error.message, secrets),
      ...(hint === undefined ? {} : { hint: scrubText(hint, secrets) }),
    };
  }
  return INTERNAL_ERROR;
}

/** The HTTP status for an error (500 for unexpected ones). */
export function statusOf(error: unknown): ErrorStatus {
  if (error instanceof ConsoleError) return error.status;
  if (isMongoShieldError(error)) return MS_STATUS[error.code];
  return 500;
}
