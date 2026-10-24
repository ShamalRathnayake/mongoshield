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

  if (isCatalogChangedUnderSnapshot(error)) return catalogChangedError(error, where);
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

  if (isReplicaSetStateChange(error)) {
    return new MongoShieldError(
      "MS_CONNECTION_FAILED",
      `A replica set member changed state (an election or step-down)${where}: ${error.message}`,
      {
        cause: error,
        hint: "This is transient: run the backup again once the replica set has a primary (scheduled runs retry it automatically).",
        details: { serverCode: error.code },
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

/**
 * Server error codes a read gets when the member it runs on steps down, shuts down or
 * is not (or no longer) in a state to serve it: the codes the driver treats as
 * retryable for reads. The driver retries a failed `find` once by itself, but a
 * `getMore` is never retried (the cursor lived on the old member), and an election
 * can outlast that single retry. These errors are transient: the same backup succeeds
 * once the replica set has settled, so they become `MS_CONNECTION_FAILED`, which the
 * scheduler retries (see schedule/retry.ts).
 */
const REPLICA_SET_STATE_CHANGE_CODES: ReadonlySet<number> = new Set([
  91, // ShutdownInProgress
  189, // PrimarySteppedDown
  10107, // NotWritablePrimary
  10058, // LegacyNotPrimary
  11600, // InterruptedAtShutdown
  11602, // InterruptedDueToReplStateChange
  13435, // NotPrimaryNoSecondaryOk
  13436, // NotPrimaryOrSecondary
]);

/** True for a server error caused by an election, step-down or shutdown (see above). */
function isReplicaSetStateChange(error: unknown): error is MongoServerError {
  return (
    error instanceof MongoServerError &&
    typeof error.code === "number" &&
    REPLICA_SET_STATE_CHANGE_CODES.has(error.code)
  );
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
 * SnapshotUnavailable has a second meaning: the collection's catalog entry changed at
 * or after the requested time (a rename, a drop, the rename `$out` ends with), so the
 * server cannot read it as of then. Replica sets answer such reads from their
 * point-in-time catalog; a shard refuses them, and the rename `$out` performs there
 * commits its catalog change after the change event's cluster time, so the converge
 * capture's read of a renamed collection "as of the rename" fails on sharded
 * clusters. That is about timing and topology, not about the snapshot window.
 */
export function isCatalogChangedUnderSnapshot(error: unknown): error is MongoServerError {
  return (
    error instanceof MongoServerError &&
    error.code === SERVER_ERROR_CODES.SnapshotUnavailable &&
    /catalog change/i.test(error.message)
  );
}

function catalogChangedError(error: MongoServerError, where: string): MongoShieldError {
  return new MongoShieldError(
    "MS_UNSUPPORTED_TOPOLOGY",
    `A collection was renamed or replaced (e.g. by $out) at a moment the backup had to read it as of, and the server cannot read it at that time${where}: ${error.message}`,
    {
      cause: error,
      hint: 'This depends on timing: run the backup again. On sharded clusters, avoid $out and renameCollection into backed-up collections during converge backups, or use consistency "none".',
      details: { serverCode: error.code },
    },
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
