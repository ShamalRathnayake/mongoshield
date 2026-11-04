/**
 * Consistency modes for backups: which point in time the documents come from.
 *
 * - `none`: every collection is read with plain reads, so collections (and even
 *   documents within one collection) may reflect different moments if the
 *   database is written to during the backup. Works everywhere.
 * - `snapshot`: every read runs in ONE snapshot session, so all collections are
 *   read as of the same cluster time. Needs a replica set or sharded cluster on
 *   MongoDB 5.0+, and the backup must finish within the server's snapshot window.
 * - `converge`: every collection is read with plain reads while a change stream
 *   records the changes made meanwhile; restore replays them, so the result is the
 *   database as of the end of the backup. Needs a replica set or sharded cluster on
 *   MongoDB 6.0+. The capture itself lives in converge-capture.ts.
 *
 * `auto` (the default) picks `converge` when the deployment and the user's privileges
 * allow it, and `none` otherwise, recording why in the manifest's
 * `consistency.warning`. It never picks `snapshot`: snapshot backups fail outright
 * when they outlast the snapshot window, which is too surprising for a default.
 * `converge` became the default after its randomized test harness passed repeatedly
 * (see docs/specs/CONSISTENCY.md).
 */

import {
  type ClientSession,
  type Document,
  type MongoClient,
  MongoServerError,
  Timestamp,
} from "mongodb";
import { MongoShieldError } from "../errors.ts";
import type { ClusterTime, ConsistencyMode } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import {
  COMPATIBLE_ENGINE_NAMES,
  type CollectionSpec,
  type DeploymentInfo,
  isAtlasRefusal,
  isAtlasSharedTier,
} from "../mongo/index.ts";
import type { BackupOptions } from "../types.ts";
import { toBackupError } from "./backup-errors.ts";

/** The mode a backup runs in, and why it is weaker than asked for (if it is). */
export interface ConsistencyChoice {
  readonly mode: ConsistencyMode;
  /** Set when `auto` fell back to `none`; recorded as `consistency.warning`. */
  readonly warning: string | undefined;
}

/** How the backup reads documents, once set up. */
export interface ReadConsistency {
  readonly mode: ConsistencyMode;
  /** The session every read must use, or `undefined` for plain reads. */
  readonly session: ClientSession | undefined;
  /** The cluster time all reads observe (snapshot mode only). */
  readonly clusterTime: ClusterTime | undefined;
  /** Ends the session, if any. Safe to call more than once; never throws. */
  close(): Promise<void>;
}

/**
 * Turns the requested consistency into the mode this run will use, from the
 * deployment's facts alone, failing early for explicit modes the deployment cannot
 * provide. `auto` becomes `converge` where the deployment could support it and `none`
 * elsewhere; `chooseConsistency` then also checks the user's privileges.
 *
 * @throws MS_UNSUPPORTED_TOPOLOGY for `snapshot` without snapshot read support, and
 *   for `converge` without change streams (standalone servers, MongoDB before 6.0).
 * @throws MS_CONFIG_INVALID for unknown values (JavaScript callers).
 */
export function resolveConsistencyMode(
  requested: BackupOptions["consistency"],
  deployment: DeploymentInfo,
): ConsistencyMode {
  switch (requested ?? "auto") {
    case "auto":
      return convergeUnsupportedReason(deployment) === undefined ? "converge" : "none";
    case "none":
      return "none";
    case "snapshot":
      assertSnapshotSupported(deployment);
      return "snapshot";
    case "converge":
      assertConvergeSupported(deployment);
      return "converge";
    default:
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `Unknown consistency mode "${String(requested)}".`,
        { hint: 'Use "auto", "none", "snapshot" or "converge".' },
      );
  }
}

function assertSnapshotSupported(deployment: DeploymentInfo): void {
  if (deployment.supportsSnapshotReads) return;
  const isReplicated = deployment.topology === "replicaSet" || deployment.topology === "sharded";
  const reason = isReplicated
    ? `MongoDB ${deployment.serverVersion} does not support snapshot reads (they need 5.0 or later)`
    : `a ${deployment.topology} deployment does not support snapshot reads (they need a replica set or sharded cluster)`;
  throw new MongoShieldError(
    "MS_UNSUPPORTED_TOPOLOGY",
    `Consistency mode "snapshot" cannot be used: ${reason}.`,
    { hint: 'Use consistency "none", or back up from a replica set running MongoDB 5.0+.' },
  );
}

/** `showExpandedEvents` (DDL events in change streams) arrived in MongoDB 6.0. */
const CONVERGE_MIN_MAJOR = 6;

/** Why `converge` cannot run on this deployment, or `undefined` when it can. */
function convergeUnsupportedReason(deployment: DeploymentInfo): string | undefined {
  if (!deployment.supportsChangeStreams) {
    return `a ${deployment.topology} deployment has no change streams (they need a replica set or sharded cluster)`;
  }
  const major = Number.parseInt(deployment.serverVersion.split(".")[0] ?? "0", 10);
  if (major < CONVERGE_MIN_MAJOR) {
    return `MongoDB ${deployment.serverVersion} lacks the change stream events it needs (6.0 or later)`;
  }
  return undefined;
}

function assertConvergeSupported(deployment: DeploymentInfo): void {
  const reason = convergeUnsupportedReason(deployment);
  if (reason === undefined) return;
  throw new MongoShieldError(
    "MS_UNSUPPORTED_TOPOLOGY",
    `Consistency mode "converge" cannot be used: ${reason}.`,
    {
      hint: 'Use consistency "none" (or "snapshot" on a replica set), or back up from a replica set running MongoDB 6.0+.',
    },
  );
}

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/**
 * `resolveConsistencyMode`, plus, for `auto`, a check that the user may open the
 * deployment-wide change stream converge needs. Explicit modes are not probed: an
 * explicit `converge` fails hard (with `MS_PERMISSION_DENIED`) when the capture starts.
 *
 * Why a probe instead of reading privileges from `connectionStatus`: whether a user
 * may open a cluster-wide change stream depends on built-in and custom roles,
 * inheritance and resource patterns (`{ db: "", collection: "" }`, `anyResource`,
 * `cluster`), and getting that subtly wrong would make `auto` either fail backups or
 * skip converge needlessly. Asking the server is exact and costs two round trips: an
 * `aggregate` with `batchSize: 0` (it returns at once, reading nothing) and a
 * `killCursors`.
 *
 * "Not authorized", or an Atlas Free/Flex proxy refusing the stream (code 8000,
 * `AtlasError`), makes `auto` fall back to `none`. So does a server that refuses the
 * stream as unsupported (an unknown stage, option or command; see
 * `UNSUPPORTED_PROBE_CODES`), and ANY probe error from a MongoDB-compatible database
 * (DocumentDB, Cosmos DB, FerretDB: their version numbers promise change streams they
 * may not have). Any other probe failure on MongoDB itself (network, server down) is a
 * real problem and fails the backup. Every fall back is logged by the backup and
 * recorded as the manifest's `consistency.warning`.
 */
export async function chooseConsistency(
  client: MongoClient,
  requested: BackupOptions["consistency"],
  deployment: DeploymentInfo,
  // The probe is a parameter so tests can exercise the fallback: the test server runs
  // without access control, where every user may open change streams.
  mayOpenChangeStream: (client: MongoClient) => Promise<boolean> = mayOpenClusterChangeStream,
): Promise<ConsistencyChoice> {
  const mode = resolveConsistencyMode(requested, deployment);
  if ((requested ?? "auto") !== "auto") return { mode, warning: undefined };

  if (mode === "none") {
    return {
      mode,
      warning: `Consistency "auto" used "none" (collections may reflect different moments): ${convergeUnsupportedReason(deployment) ?? "converge is not available"}.`,
    };
  }
  let allowed: boolean;
  try {
    allowed = await mayOpenChangeStream(client);
  } catch (error) {
    const reason = unsupportedProbeReason(error, deployment);
    if (reason === undefined) throw toBackupError(error);
    return {
      mode: "none",
      warning: `Consistency "auto" used "none" (collections may reflect different moments): ${reason}`,
    };
  }
  if (allowed) return { mode, warning: undefined };
  if (isAtlasSharedTier(deployment)) {
    return {
      mode: "none",
      warning:
        'Consistency "auto" used "none" (collections may reflect different moments): this Atlas Free/Flex cluster did not let the user open a change stream on the whole deployment, which "converge" needs. Give the database user the readAnyDatabase role (Atlas: "Only read any database"), or back up while the application is idle.',
    };
  }
  return {
    mode: "none",
    warning:
      'Consistency "auto" used "none" (collections may reflect different moments): the MongoDB user cannot open a change stream on the whole deployment, which "converge" needs. The built-in backup role does not allow it; grant changeStream and find on all databases (e.g. the readAnyDatabase role).',
  };
}

/**
 * Server error codes that mean "this server does not support that", not "something is
 * wrong right now": a probe refused with one of them makes `auto` fall back to `none`.
 *   2 BadValue, 9 FailedToParse, 20 IllegalOperation, 59 CommandNotFound,
 *   72 InvalidOptions, 115 CommandNotSupported, 238 NotImplemented,
 *   40324 unrecognised pipeline stage, 40415 unknown field (e.g. `showExpandedEvents`
 *   before 6.0), 40573 `$changeStream` outside a replica set.
 */
const UNSUPPORTED_PROBE_CODES: ReadonlySet<number> = new Set([
  2, 9, 20, 59, 72, 115, 238, 40324, 40415, 40573,
]);

/**
 * Why a failed probe means "converge is not available here" (the end of the `auto`
 * warning), or `undefined` when the failure is a real problem that fails the backup.
 */
function unsupportedProbeReason(error: unknown, deployment: DeploymentInfo): string | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  if (deployment.engine !== undefined) {
    return `${COMPATIBLE_ENGINE_NAMES[deployment.engine]} did not open the change stream on the whole deployment that "converge" needs (${detail}).`;
  }
  if (
    error instanceof MongoServerError &&
    typeof error.code === "number" &&
    UNSUPPORTED_PROBE_CODES.has(error.code)
  ) {
    return `the server refused the change stream on the whole deployment that "converge" needs as unsupported (${detail}). MongoDB-compatible databases often lack it; on MongoDB itself, check the server version (6.0+).`;
  }
  return undefined;
}

/** Opens and immediately closes a cluster-wide change stream; false if not authorized. */
async function mayOpenClusterChangeStream(client: MongoClient): Promise<boolean> {
  // killCursors must run in the session that opened the cursor.
  const session = client.startSession({ causalConsistency: false });
  try {
    const admin = client.db("admin");
    const reply = await admin.command(
      {
        aggregate: 1,
        pipeline: [{ $changeStream: { allChangesForCluster: true, showExpandedEvents: true } }],
        cursor: { batchSize: 0 },
      },
      { session, promoteLongs: false },
    );
    const cursorId: unknown = reply.cursor?.id;
    if (cursorId !== undefined && cursorId !== 0) {
      await admin
        .command({ killCursors: "$cmd.aggregate", cursors: [cursorId] }, { session })
        .catch(() => {});
    }
    return true;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) return false;
    if (isAtlasRefusal(error)) return false;
    // Untranslated: chooseConsistency decides whether it means "unsupported".
    throw error;
  } finally {
    await session.endSession().catch(() => {});
  }
}

/**
 * Prepares reads for the chosen mode. For `snapshot` it starts a snapshot session
 * and pins its point in time before any collection is dumped (see `pinSnapshot`).
 * `converge` reads like `none`; its change capture is started by the backup itself.
 */
export async function openReadConsistency(
  client: MongoClient,
  mode: ConsistencyMode,
  specs: readonly CollectionSpec[],
  logger: Logger,
): Promise<ReadConsistency> {
  if (mode !== "snapshot") {
    return { mode, session: undefined, clusterTime: undefined, close: async () => {} };
  }

  const session = client.startSession({ snapshot: true });
  const close = async (): Promise<void> => {
    try {
      await session.endSession();
    } catch (error) {
      logger.debug("Ending the snapshot session failed", { error: String(error) });
    }
  };

  try {
    const clusterTime = await pinSnapshot(client, session, specs);
    logger.debug("Reading from a snapshot", { clusterTime });
    return { mode, session, clusterTime, close };
  } catch (error) {
    await close();
    if (isAtlasRefusal(error)) throw snapshotRefusedByAtlas(error);
    throw toBackupError(error);
  }
}

/**
 * The pinning read is the first snapshot read of a run, made before any collection is
 * read: when an Atlas tier refuses snapshot reads, this is where the run finds out, so
 * nothing has been written yet. Whether Free and Flex clusters allow them is not
 * documented either way (docs/guides/atlas-free-tier.md); this turns a refusal into a
 * clear answer instead of the generic Atlas one.
 */
function snapshotRefusedByAtlas(error: MongoServerError): MongoShieldError {
  return new MongoShieldError(
    "MS_UNSUPPORTED_TOPOLOGY",
    `This Atlas cluster tier refused a snapshot read (readConcern "snapshot"), which consistency "snapshot" and the time series copies of incremental backups need: ${error.message}`,
    {
      cause: error,
      hint: 'Use consistency "auto" (converge) instead of "snapshot" on Atlas Free and Flex clusters. Incremental jobs that hold time series collections then take full backups (fallbackToFull).',
      details: { serverCode: error.code },
    },
  );
}

/**
 * A snapshot session picks its point in time from the FIRST read made in it, and
 * every later read reuses it. The collections are dumped in parallel, so without
 * this step several first reads could race and each pick a different time. We
 * therefore make one tiny read up front (at most one `_id`), which fixes the time
 * for the whole session, and take that time from the reply's `cursor.atClusterTime`.
 *
 * The read targets the first collection (views are fine too, but a real collection
 * is the cheapest). With no namespaces at all nothing needs pinning.
 */
async function pinSnapshot(
  client: MongoClient,
  session: ClientSession,
  specs: readonly CollectionSpec[],
): Promise<ClusterTime | undefined> {
  const target = specs.find((spec) => spec.type === "collection") ?? specs[0];
  if (target === undefined) return undefined;

  const reply = await client.db(target.db).command(
    {
      find: target.name,
      filter: {},
      projection: { _id: 1 },
      limit: 1,
      // Close the server cursor in the same round trip.
      singleBatch: true,
    },
    { session },
  );
  return readAtClusterTime(reply);
}

/** Extracts `cursor.atClusterTime` from a find reply as `{ t, i }`. */
function readAtClusterTime(reply: Document): ClusterTime {
  const cursor: unknown = reply.cursor;
  const atClusterTime: unknown =
    typeof cursor === "object" && cursor !== null
      ? Reflect.get(cursor, "atClusterTime")
      : undefined;
  if (!(atClusterTime instanceof Timestamp)) {
    throw new MongoShieldError(
      "MS_INTERNAL",
      "The server did not report the cluster time of the snapshot read.",
      { hint: 'Use consistency "none" and report this as a bug.' },
    );
  }
  // A BSON Timestamp is (seconds since the epoch, increment within that second).
  return { t: atClusterTime.t, i: atClusterTime.i };
}
