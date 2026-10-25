/**
 * Describing the deployment MongoShield is connected to.
 *
 * The backup engine uses this to choose a consistency mode (snapshot reads, change
 * streams, or none), and the manifest records it so a restore can tell where a backup
 * came from. Everything here comes from `hello` and `buildInfo`, which every user may
 * run (no privileges needed), so describing a deployment never fails for lack of roles.
 * On Atlas, one more read-only command tells a shared tier (Free, Flex) from a dedicated
 * cluster (see atlas.ts); its failure never fails the description either.
 */

import { createHash } from "node:crypto";
import { type Document, type MongoClient, MongoServerError } from "mongodb";
import { type AtlasInfo, detectAtlas } from "./atlas.ts";

/** The shape of the deployment, as seen from the connected server. */
export type Topology = "standalone" | "replicaSet" | "sharded" | "unknown";

/** Facts about the connected deployment that affect how backups are taken. */
export interface DeploymentInfo {
  readonly topology: Topology;
  /** The server version, e.g. `"7.0.12"`. */
  readonly serverVersion: string;
  /**
   * A stable, non-secret identifier for the deployment: 32 hex characters derived with
   * SHA-256 from the replica set name (or cluster id / host list). Used to group backups
   * by source without storing host names or credentials in manifests.
   */
  readonly clusterId: string;
  /** Change streams need the oplog, which only replica sets and sharded clusters have. */
  readonly supportsChangeStreams: boolean;
  /** `readConcern: "snapshot"` outside transactions needs MongoDB 5.0+ on a replica set or sharded cluster. */
  readonly supportsSnapshotReads: boolean;
  /** The largest document the server accepts, in bytes (16 MiB on every current version). */
  readonly maxBsonObjectSize: number;
  /**
   * Set when the deployment is on MongoDB Atlas: which tier kind, and why we think so.
   * The engines adapt to shared tiers (Free, Flex) with it. Absent elsewhere.
   */
  readonly atlas?: AtlasInfo;
}

/** MongoDB's documented maximum BSON document size, used if `hello` omits it. */
const DEFAULT_MAX_BSON_OBJECT_SIZE = 16 * 1024 * 1024;

/** Server error code for an unknown command (very old servers lack `hello`). */
const COMMAND_NOT_FOUND_CODE = 59;

/** First major version that supports `readConcern: "snapshot"` outside transactions. */
const SNAPSHOT_READS_MIN_MAJOR = 5;

/**
 * Inspects the connected deployment.
 *
 * @param client a connected client (see `openConnection`).
 */
export async function describeDeployment(client: MongoClient): Promise<DeploymentInfo> {
  const admin = client.db("admin");
  const hello = await runHello(client);
  const buildInfo = await admin.command({ buildInfo: 1 });

  const topology = topologyFromHello(hello);
  const serverVersion = typeof buildInfo.version === "string" ? buildInfo.version : "0.0.0";
  const hasOplog = topology === "replicaSet" || topology === "sharded";
  const atlas = await detectAtlas(client, hello);

  return {
    topology,
    serverVersion,
    clusterId: await deriveClusterId(client, topology, hello),
    supportsChangeStreams: hasOplog,
    supportsSnapshotReads: hasOplog && majorVersion(serverVersion) >= SNAPSHOT_READS_MIN_MAJOR,
    maxBsonObjectSize:
      typeof hello.maxBsonObjectSize === "number"
        ? hello.maxBsonObjectSize
        : DEFAULT_MAX_BSON_OBJECT_SIZE,
    ...(atlas === undefined ? {} : { atlas }),
  };
}

/**
 * Runs `hello`, falling back to the legacy `isMaster` on servers that predate it
 * (`hello` arrived in 4.4.2 and was backported to late 4.2 patch releases).
 */
async function runHello(client: MongoClient): Promise<Document> {
  const admin = client.db("admin");
  try {
    return await admin.command({ hello: 1 });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === COMMAND_NOT_FOUND_CODE) {
      return await admin.command({ isMaster: 1 });
    }
    throw error;
  }
}

/**
 * Classifies the deployment from the `hello` reply:
 * - a `mongos` router answers with `msg: "isdbgrid"`;
 * - a replica set member reports its `setName`;
 * - a node started with `--replSet` but never initiated reports `isreplicaset: true`
 *   and cannot serve reads yet, so it is "unknown";
 * - anything else that answers as a writable primary is a standalone server.
 */
export function topologyFromHello(hello: Document): Topology {
  if (hello.msg === "isdbgrid") return "sharded";
  if (typeof hello.setName === "string") return "replicaSet";
  if (hello.isreplicaset === true) return "unknown";
  if (hello.isWritablePrimary === true || hello.ismaster === true) return "standalone";
  return "unknown";
}

/**
 * Derives a stable id for the deployment.
 * - Replica set: the set name, which stays the same as members are added or replaced.
 * - Sharded: the `clusterId` stored in `config.version` when the user may read it,
 *   otherwise the list of mongos hosts in the connection string.
 * - Standalone / unknown: the host list, since a lone server has no other identity.
 * Hashing keeps host names out of manifests while staying deterministic.
 */
async function deriveClusterId(
  client: MongoClient,
  topology: Topology,
  hello: Document,
): Promise<string> {
  if (topology === "replicaSet" && typeof hello.setName === "string") {
    return hashId(`replicaSet:${hello.setName}`);
  }
  if (topology === "sharded") {
    const shardedClusterId = await readShardedClusterId(client);
    if (shardedClusterId !== undefined) return hashId(`sharded:${shardedClusterId}`);
  }
  return hashId(`${topology}:${seedHosts(client)}`);
}

/** Reads `config.version.clusterId`; returns undefined when the user lacks access. */
async function readShardedClusterId(client: MongoClient): Promise<string | undefined> {
  try {
    const versionDoc = await client.db("config").collection("version").findOne({});
    const clusterId: unknown = versionDoc?.clusterId;
    return clusterId === undefined || clusterId === null ? undefined : String(clusterId);
  } catch {
    // Reading config.version needs privileges many users do not have; fall back quietly.
    return undefined;
  }
}

/** The hosts from the connection string, sorted so their order does not change the id. */
function seedHosts(client: MongoClient): string {
  const hosts = client.options.hosts.map((host) => host.toString().toLowerCase());
  hosts.sort();
  return hosts.join(",");
}

function hashId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/** `"7.0.12"` → 7. Unparseable versions count as 0 so feature checks fail safe. */
function majorVersion(serverVersion: string): number {
  const major = Number.parseInt(serverVersion.split(".")[0] ?? "", 10);
  return Number.isNaN(major) ? 0 : major;
}
