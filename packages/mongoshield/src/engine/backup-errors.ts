/**
 * Turns whatever a backup step threw into a `MongoShieldError` with a useful code,
 * message and hint. Errors that are already typed (storage, crypto, compression,
 * our own checks) pass through unchanged; this mostly translates driver errors
 * raised while reading collections.
 */

import { MongoNetworkError, MongoServerError, MongoServerSelectionError } from "mongodb";
import { MongoShieldError } from "../errors.ts";

/**
 * Server error codes the backup engine recognises
 * (https://www.mongodb.com/docs/manual/reference/error-codes/).
 */
const SERVER_ERROR_CODES = {
  /** The user lacks a privilege for the command. */
  Unauthorized: 13,
  /** A snapshot read asked for a point in time older than the server still keeps. */
  SnapshotTooOld: 239,
  /** A snapshot read asked for a point in time the server cannot serve yet / anymore. */
  SnapshotUnavailable: 246,
} as const;

/** What the failing step was doing, for the message. */
export interface BackupErrorContext {
  /** The namespace being read, if any. */
  readonly ns?: string | undefined;
}

/**
 * Converts any error thrown during a backup into a `MongoShieldError`.
 * Already-typed errors are returned as they are.
 */
export function toBackupError(error: unknown, context: BackupErrorContext = {}): MongoShieldError {
  if (error instanceof MongoShieldError) return error;
  const where = context.ns === undefined ? "" : ` while reading ${context.ns}`;

  if (isSnapshotExpired(error)) return snapshotExpiredError(error, where);

  if (error instanceof MongoServerError && error.code === SERVER_ERROR_CODES.Unauthorized) {
    return new MongoShieldError(
      "MS_PERMISSION_DENIED",
      `MongoDB refused a read${where}: ${error.message}`,
      {
        cause: error,
        hint: 'Grant the built-in `backup` role (db: "admin"), or `read` on the databases being backed up.',
      },
    );
  }

  if (error instanceof MongoNetworkError || error instanceof MongoServerSelectionError) {
    return new MongoShieldError(
      "MS_CONNECTION_FAILED",
      `Lost the connection to MongoDB${where}: ${error.message}`,
      { cause: error, hint: "Check that the deployment is reachable, then run the backup again." },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new MongoShieldError("MS_INTERNAL", `The backup failed${where}: ${message}`, {
    cause: error,
  });
}

/** True for the server errors that mean "your snapshot is no longer available". */
export function isSnapshotExpired(error: unknown): error is MongoServerError {
  return (
    error instanceof MongoServerError &&
    (error.code === SERVER_ERROR_CODES.SnapshotTooOld ||
      error.code === SERVER_ERROR_CODES.SnapshotUnavailable)
  );
}

/**
 * The snapshot window (`minSnapshotHistoryWindowInSeconds`, 5 minutes by default)
 * bounds how long a snapshot backup may run. When it is exceeded the server
 * discards the history the backup still needs.
 */
function snapshotExpiredError(error: MongoServerError, where: string): MongoShieldError {
  return new MongoShieldError(
    "MS_SNAPSHOT_TOO_OLD",
    `The snapshot this backup reads from is no longer available${where}: the backup took longer than the server's snapshot window.`,
    {
      cause: error,
      hint: 'Use consistency "none", back up fewer namespaces per run, or raise the server parameter minSnapshotHistoryWindowInSeconds.',
      details: { serverCode: error.code },
    },
  );
}
