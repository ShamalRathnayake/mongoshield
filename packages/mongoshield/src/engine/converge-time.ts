/**
 * Cluster-time helpers for consistency mode `converge` (docs/specs/CONSISTENCY.md).
 *
 * A cluster time is a BSON Timestamp: (seconds since the epoch, increment within that
 * second). The manifest stores it as `{ t, i }` (`ClusterTime`); the driver hands it
 * over as a `Timestamp`. Change events are ordered by it, which is what lets the
 * capture know when it has seen every change up to the end of the backup window.
 */

import { type ClientSession, type Document, type MongoClient, Timestamp } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import type { ClusterTime } from "../format/manifest.ts";

/** The `{ t, i }` form of a driver `Timestamp`. */
export function toClusterTime(timestamp: Timestamp): ClusterTime {
  return { t: timestamp.t, i: timestamp.i };
}

/** The driver `Timestamp` for a `{ t, i }` cluster time, e.g. for `startAtOperationTime`. */
export function toTimestamp(clusterTime: ClusterTime): Timestamp {
  return new Timestamp({ t: clusterTime.t, i: clusterTime.i });
}

/** Negative when `a` is earlier than `b`, 0 when equal, positive when later. */
export function compareClusterTimes(a: ClusterTime, b: ClusterTime): number {
  if (a.t !== b.t) return a.t - b.t;
  return a.i - b.i;
}

/** `t:i`, as MongoDB's own tools print cluster times. For logs and messages. */
export function formatClusterTime(clusterTime: ClusterTime): string {
  return `${clusterTime.t}:${clusterTime.i}`;
}

/**
 * Reads "now" as a cluster time, with a `ping`, erring EARLY: the reply's
 * `operationTime`, which can lag behind writes the node has already applied (seen on
 * MongoDB 8.0 under load). Use it where an early time is safe: the start of a window
 * (T0) or a journal's starting point, where it only means a few extra events that
 * replay harmlessly. For the end of a window use {@link readLatestClusterTime}.
 *
 * A mongos may omit `operationTime` for commands that reach no shard; then the
 * gossiped `$clusterTime` is used instead.
 *
 * @throws MS_UNSUPPORTED_TOPOLOGY when the reply carries no cluster time at all
 *   (a standalone server).
 */
export async function readClusterTime(
  client: MongoClient,
  session?: ClientSession,
): Promise<ClusterTime> {
  const reply = await pingForTime(client, session);
  return requireClusterTime(clusterTimeOfReply(reply));
}

/**
 * Reads "now" as a cluster time, erring LATE: the later of the reply's `$clusterTime`
 * (the logical clock, which is never behind any write the node has applied or the
 * client has seen) and its `operationTime`.
 *
 * This is what the END of a converge window (T1) needs. Every document the dump read
 * must be at or before T1; if T1 came out early, the dump could hold changes from after
 * T1 that the replay (which stops at T1) never reconciles, and the restore would mix
 * moments. A late T1 only means the drain waits for, and replays, a few more events.
 */
export async function readLatestClusterTime(client: MongoClient): Promise<ClusterTime> {
  const reply = await pingForTime(client);
  return requireClusterTime(latestClusterTimeOfReply(reply));
}

async function pingForTime(client: MongoClient, session?: ClientSession): Promise<Document> {
  return client.db("admin").command({ ping: 1 }, session === undefined ? {} : { session });
}

function requireClusterTime(clusterTime: ClusterTime | undefined): ClusterTime {
  if (clusterTime === undefined) {
    throw new MongoShieldError(
      "MS_UNSUPPORTED_TOPOLOGY",
      "The server did not report a cluster time, which consistency mode converge needs.",
      { hint: 'Use consistency "none", or back up from a replica set or sharded cluster.' },
    );
  }
  return clusterTime;
}

/** The later of a reply's `$clusterTime.clusterTime` and `operationTime`. */
export function latestClusterTimeOfReply(reply: Document): ClusterTime | undefined {
  const operation =
    reply.operationTime instanceof Timestamp ? toClusterTime(reply.operationTime) : undefined;
  const gossiped = gossipedClusterTime(reply);
  if (operation === undefined) return gossiped;
  if (gossiped === undefined) return operation;
  return compareClusterTimes(gossiped, operation) >= 0 ? gossiped : operation;
}

/** `$clusterTime.clusterTime` of a reply, if present. */
function gossipedClusterTime(reply: Document): ClusterTime | undefined {
  const gossiped: unknown = reply.$clusterTime;
  const clusterTime: unknown =
    typeof gossiped === "object" && gossiped !== null
      ? Reflect.get(gossiped, "clusterTime")
      : undefined;
  return clusterTime instanceof Timestamp ? toClusterTime(clusterTime) : undefined;
}

/** `operationTime` of a command reply, falling back to `$clusterTime.clusterTime`. */
export function clusterTimeOfReply(reply: Document): ClusterTime | undefined {
  if (reply.operationTime instanceof Timestamp) return toClusterTime(reply.operationTime);
  return gossipedClusterTime(reply);
}

/**
 * The cluster time encoded at the start of a change stream resume token.
 *
 * Resume tokens are `{ _data: "<hex>" }`, a KeyString whose first value is the event's
 * cluster time: type byte `0x82` (Timestamp), then the timestamp as a big-endian
 * unsigned 64-bit number (seconds in the high 32 bits, increment in the low 32).
 * This has been the layout of every token version since MongoDB 4.2. The token's
 * meaning is "every event before this point has been returned", so its cluster time
 * tells the capture how far the stream has read even when no event matched.
 *
 * Returns `undefined` for anything that does not look like that, so callers can
 * fall back to slower signals instead of failing.
 */
export function clusterTimeOfResumeToken(token: unknown): ClusterTime | undefined {
  if (typeof token !== "object" || token === null) return undefined;
  const data: unknown = Reflect.get(token, "_data");
  // 2 hex digits for the type byte + 16 for the 8-byte timestamp.
  if (typeof data !== "string" || data.length < 18 || !/^[0-9a-fA-F]+$/.test(data)) {
    return undefined;
  }
  if (data.slice(0, 2).toLowerCase() !== "82") return undefined;
  const seconds = Number.parseInt(data.slice(2, 10), 16);
  const increment = Number.parseInt(data.slice(10, 18), 16);
  return { t: seconds, i: increment };
}
