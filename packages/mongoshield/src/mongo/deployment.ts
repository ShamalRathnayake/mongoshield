/**
 * Describing the deployment MongoShield is connected to.
 *
 * The backup engine uses this to choose a consistency mode (snapshot reads, change
 * streams, or none), and the manifest records it so a restore can tell where a backup
 * came from. Everything here comes from `hello` and `buildInfo`, which every user may
 * run (no privileges needed), so describing a deployment never fails for lack of roles.
 * On Atlas, one more read-only command tells a shared tier (Free, Flex) from a dedicated
 * cluster (see atlas.ts); its failure never fails the description either.
 *
 * Replica sets get a second identity, `instanceId`, from the set's own
 * `settings.replicaSetId` (an ObjectId the server generates when the set is initiated).
 * Reading it needs the `clusterMonitor` role (`replSetGetConfig`) or read access to
 * `local.system.replset`; users without either get no `instanceId`, and two sets with the
 * same name then look like one deployment, as they did before (see `sameDeployment`).
 */

import { createHash } from "node:crypto";
import { type Document, type MongoClient, MongoServerError, ObjectId } from "mongodb";
import { type AtlasInfo, detectAtlas } from "./atlas.ts";
import { type CompatibleEngine, detectCompatibleEngine } from "./engine.ts";

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
   *
   * Two replica sets with the same name (`rs0` is the default everywhere) share it; use
   * `sameDeployment`, which also compares `instanceId`, to tell deployments apart.
   */
  readonly clusterId: string;
  /**
   * A second, cluster-unique identifier: 32 hex characters derived with SHA-256 from the
   * replica set's `settings.replicaSetId`, which the server generates when the set is
   * initiated and which a set rebuilt under the same name does not share. Only replica
   * sets have one, and only when the user may read the set's configuration
   * (`replSetGetConfig`, part of the `clusterMonitor` role, or `local.system.replset`).
   * Absent otherwise, on Atlas (whose generated set names are unique already), and in
   * manifests written before MongoShield recorded it.
   */
  readonly instanceId?: string;
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
  /**
   * Set when the server is a MongoDB-compatible database rather than MongoDB itself
   * (Amazon DocumentDB, Azure Cosmos DB, FerretDB; see engine.ts). Absent for MongoDB.
   */
  readonly engine?: CompatibleEngine;
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
  // Not on Atlas: its replica set names are generated per cluster (`atlas-<id>-shard-0`),
  // so they are unique already, and Free/Flex clusters refuse replSetGetConfig anyway.
  const instanceId =
    topology === "replicaSet" && atlas === undefined ? await deriveInstanceId(client) : undefined;
  const engine = detectCompatibleEngine(client, buildInfo);

  return {
    topology,
    serverVersion,
    clusterId: await deriveClusterId(client, topology, hello),
    ...(instanceId === undefined ? {} : { instanceId }),
    supportsChangeStreams: hasOplog,
    supportsSnapshotReads: hasOplog && majorVersion(serverVersion) >= SNAPSHOT_READS_MIN_MAJOR,
    maxBsonObjectSize:
      typeof hello.maxBsonObjectSize === "number"
        ? hello.maxBsonObjectSize
        : DEFAULT_MAX_BSON_OBJECT_SIZE,
    ...(atlas === undefined ? {} : { atlas }),
    ...(engine === undefined ? {} : { engine }),
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

/**
 * Derives `instanceId` from the replica set's `settings.replicaSetId`, or `undefined`
 * when the user may not read the set's configuration. Two ways, cheapest first:
 *   1. `replSetGetConfig` (the `clusterMonitor` role has it; Atlas Free/Flex refuse it);
 *   2. the same document straight from `local.system.replset` (users who may read the
 *      `local` database, e.g. with the `backup` role on some versions).
 * Any failure means "unknown": describing a deployment never fails for lack of roles.
 */
async function deriveInstanceId(client: MongoClient): Promise<string | undefined> {
  const fromCommand = await readReplicaSetIdWith(async () => {
    const reply = await client.db("admin").command({ replSetGetConfig: 1 });
    return asDocument(reply.config);
  });
  const replicaSetId =
    fromCommand ??
    (await readReplicaSetIdWith(async () => {
      const config = await client
        .db("local")
        .collection("system.replset")
        .findOne({}, { projection: { "settings.replicaSetId": 1 } });
      return config ?? undefined;
    }));
  return replicaSetId === undefined ? undefined : hashId(`replicaSetId:${replicaSetId}`);
}

/**
 * Runs `read` (which returns a replica set configuration document) and returns its
 * `settings.replicaSetId` as 24 hex characters, or `undefined` on any failure.
 */
async function readReplicaSetIdWith(
  read: () => Promise<Document | undefined>,
): Promise<string | undefined> {
  try {
    const config = await read();
    const replicaSetId: unknown = asDocument(config?.settings)?.replicaSetId;
    if (replicaSetId instanceof ObjectId) return replicaSetId.toHexString();
    return undefined;
  } catch {
    // Not authorized, refused by Atlas, or an old server: the set name has to do.
    return undefined;
  }
}

function asDocument(value: unknown): Document | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

/**
 * True when two descriptions (a live deployment, a manifest's or a checkpoint's
 * `source`) name the same deployment: the same `clusterId`, and, when BOTH record an
 * `instanceId`, the same `instanceId`. A side without `instanceId` (an older manifest,
 * a user who may not read the replica set configuration) matches on `clusterId` alone,
 * as every release before `instanceId` did, so existing backups keep their chains.
 * Two missing `clusterId`s are not the same deployment.
 */
export function sameDeployment(
  a: { readonly clusterId?: string | undefined; readonly instanceId?: string | undefined },
  b: { readonly clusterId?: string | undefined; readonly instanceId?: string | undefined },
): boolean {
  if (a.clusterId === undefined || a.clusterId !== b.clusterId) return false;
  if (a.instanceId === undefined || b.instanceId === undefined) return true;
  return a.instanceId === b.instanceId;
}

/**
 * A warning for replica sets identified by their name alone (no `instanceId`), or
 * `undefined`. Atlas is left out: its replica set names are generated per cluster
 * (`atlas-<id>-shard-0`), so two Atlas clusters never share one.
 */
export function deploymentIdentityWarning(deployment: DeploymentInfo): string | undefined {
  if (deployment.topology !== "replicaSet" || deployment.instanceId !== undefined) return undefined;
  if (deployment.atlas !== undefined) return undefined;
  return "The replica set is identified by its name only: the MongoDB user may not read its configuration (replSetGetConfig), so another replica set with the same name writing to the same storage would look like the same deployment to incrementals, resume and the backup guard. Grant the clusterMonitor role to tell them apart, or keep each deployment's backups in their own storage location.";
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
