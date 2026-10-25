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
 * Only "not authorized", or an Atlas Free/Flex proxy refusing the stream (code 8000,
 * `AtlasError`), makes `auto` fall back to `none`; any other probe failure (network,
 * server down) is a real problem and fails the backup.
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
  if (await mayOpenChangeStream(client)) return { mode, warning: undefined };
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
    throw toBackupError(error);
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
    throw toBackupError(error);
  }
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
