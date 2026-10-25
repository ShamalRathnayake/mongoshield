/**
 * Recognising MongoDB Atlas, and in particular its shared tiers: Free (formerly M0),
 * Flex, and the legacy shared M2/M5 clusters (migrated to Flex in January 2026).
 *
 * Free and Flex clusters run on infrastructure shared between customers, behind a
 * proxy that refuses some commands and throttles the rest (docs/guides/atlas-free-tier.md
 * lists the limits, with links to the Atlas documentation). MongoShield adapts to them
 * automatically, so it first has to know it is talking to one:
 *
 *   1. Atlas at all? Every Atlas host name ends in `.mongodb.net` (or `.mongodbgov.net`
 *      for Atlas for Government): the SRV name of the connection string, the seed
 *      hosts, and the members `hello` lists. mongosh and Compass recognise Atlas the
 *      same way. Nothing is sent to deployments that are not on Atlas.
 *   2. Shared tier? The proxy answers commands it does not allow on the tier with
 *      error code 8000 (`AtlasError`), a code reserved for it (SERVER-28245) that
 *      mongod itself never returns. On Free and Flex, `getParameter` is limited to two
 *      parameters (`authSchemaVersion`, `authenticationMechanisms`), so asking for any
 *      other one is refused that way. On a dedicated cluster (M10+) the same command is
 *      answered, or refused with code 13 (`Unauthorized`) for users without the
 *      `clusterMonitor` role: either way not an Atlas refusal. One cheap, read-only
 *      probe therefore tells the two apart (see `probeSharedTier`).
 *
 * Detection is best effort and never fails a backup: an unexpected probe reply means
 * "dedicated", and the backup runs with the normal defaults. Users whose connection
 * hides the Atlas host name can name the tier with the `atlas-free` / `atlas-flex`
 * config presets (src/config/presets.ts) instead.
 *
 * Sources: https://www.mongodb.com/docs/atlas/unsupported-commands/ ("Limited
 * Commands": getParameter), https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/
 * and https://www.mongodb.com/docs/atlas/reference/flex-limitations/.
 */

import { type Document, type MongoClient, MongoServerError } from "mongodb";

/** Which kind of Atlas cluster the deployment is. */
export type AtlasTier =
  /** Free (formerly M0), Flex, or legacy shared M2/M5: restricted commands, throttled. */
  | "shared"
  /** M10 and up: a regular replica set or sharded cluster. */
  | "dedicated";

/** What MongoShield found out about an Atlas deployment. */
export interface AtlasInfo {
  readonly tier: AtlasTier;
  /**
   * Why MongoShield believes so, in words, for debug logs (e.g. `"host
   * cluster0.abcde.mongodb.net"`, `"getParameter refused with AtlasError"`).
   */
  readonly signals: readonly string[];
}

/**
 * Atlas host names: `*.mongodb.net` (plus the `-dev`, `-qa` and `-stage` variants
 * MongoDB's own tools also accept) and `*.mongodbgov.net` for Atlas for Government.
 */
const ATLAS_HOST_PATTERN = /\.mongodb(?:-dev|-qa|-stage)?\.net$|\.mongodbgov\.net$/i;

/**
 * The error code Atlas uses for everything its proxy refuses on a tier
 * (`codeName: "AtlasError"`). It is not a MongoDB server code: mongod never returns it.
 */
export const ATLAS_ERROR_CODE = 8000;

/**
 * Message fragments of such refusals, for replies whose code got lost (wrapped
 * errors). The Atlas documentation gives these two forms:
 *   `<command> is not allowed or the syntax is incorrect, see the Atlas documentation for more information`
 *   `command <command> is not allowed in this Atlas tier`
 */
const ATLAS_REFUSAL_PATTERN =
  /not allowed in this atlas tier|is not allowed or the syntax is incorrect, see the atlas documentation/i;

/**
 * The probe command: a read-only `getParameter` of a parameter that shared tiers do
 * not let users read (only `authSchemaVersion` and `authenticationMechanisms` are
 * allowed there). Every mongod since 3.4 knows `featureCompatibilityVersion`.
 */
const SHARED_TIER_PROBE: Document = { getParameter: 1, featureCompatibilityVersion: 1 };

/**
 * Tuning the backup engine applies on a shared tier when the caller sets none,
 * chosen to stay far below the tier's limits so the application keeps them:
 *
 * - `parallelism: 2`: Free clusters allow 100 operations per second (Flex 500), and
 *   every collection being dumped keeps a cursor fetching batches; two at a time
 *   keeps the backup's share small, and the at most 500 collections those tiers
 *   allow are still read in minutes.
 * - `maxBytesPerSecond: 4 MiB`: reads count against the Free tier's data transfer
 *   allowance (10 GB out per rolling 7 days), and a burst of reads at full speed
 *   triggers the tier's network throttling, which the application would feel. A full
 *   512 MB Free cluster takes about two minutes at this rate.
 */
export const ATLAS_SHARED_TIER_TUNING = {
  parallelism: 2,
  maxBytesPerSecond: 4 * 1024 * 1024,
} as const;

/** The hint of every "Atlas manages users itself" error. */
export const ATLAS_USERS_HINT =
  "Atlas manages database users and custom roles through its UI, Admin API and CLI (it rolls back changes made with database commands): list them with `atlas dbusers list --output json` and `atlas customDbRoles list --output json`, recreate them with the Atlas CLI or Terraform, and leave users and roles out of MongoShield backups and restores on Atlas.";

/** True when `host` (optionally with `:port`) is an Atlas host name. */
export function isAtlasHost(host: string): boolean {
  return ATLAS_HOST_PATTERN.test(stripPort(host));
}

/**
 * True for an error Atlas returns when its proxy refuses a command on this tier
 * (code 8000 `AtlasError`, or one of the refusal messages above).
 */
export function isAtlasRefusal(error: unknown): error is MongoServerError {
  if (!(error instanceof MongoServerError)) return false;
  if (error.code === ATLAS_ERROR_CODE || error.codeName === "AtlasError") return true;
  return ATLAS_REFUSAL_PATTERN.test(error.message);
}

/** True when the deployment was detected as an Atlas Free, Flex or shared M2/M5 cluster. */
export function isAtlasSharedTier(deployment: { readonly atlas?: AtlasInfo }): boolean {
  return deployment.atlas?.tier === "shared";
}

/**
 * Describes the Atlas side of a deployment, or returns `undefined` when it is not on
 * Atlas (no Atlas host name anywhere). Sends the one probe command only to Atlas.
 *
 * @param client the connected client (its SRV name and seed hosts are read).
 * @param hello the deployment's `hello` reply (its member list is read).
 * @param probe runs the probe command; a parameter so tests can fake every reply.
 */
export async function detectAtlas(
  client: MongoClient,
  hello: Document,
  probe: (command: Document) => Promise<unknown> = (command) => client.db("admin").command(command),
): Promise<AtlasInfo | undefined> {
  const atlasHost = connectionHosts(client, hello).find(isAtlasHost);
  if (atlasHost === undefined) return undefined;

  const hostSignal = `host ${stripPort(atlasHost)}`;
  const refusal = await probeSharedTier(probe);
  if (refusal !== undefined) {
    return { tier: "shared", signals: [hostSignal, refusal] };
  }
  return { tier: "dedicated", signals: [hostSignal] };
}

/**
 * Runs the probe; returns a description of the Atlas refusal when the tier refused it
 * (shared tier), `undefined` otherwise. Any other outcome, success or failure, means
 * the cluster is not a shared tier as far as MongoShield can tell.
 */
async function probeSharedTier(
  probe: (command: Document) => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await probe(SHARED_TIER_PROBE);
    return undefined;
  } catch (error) {
    return isAtlasRefusal(error) ? "getParameter refused with AtlasError" : undefined;
  }
}

/**
 * Every host name the connection knows: the SRV name (`cluster0.abcde.mongodb.net`)
 * when the URI used `mongodb+srv://`, the seed hosts, and the replica set members
 * `hello` reports (`hosts`, `passives`, `arbiters`, `me`, `primary`).
 */
function connectionHosts(client: MongoClient, hello: Document): string[] {
  const hosts: string[] = [];
  const { srvHost } = client.options;
  if (typeof srvHost === "string") hosts.push(srvHost);
  for (const host of client.options.hosts) hosts.push(host.toString());
  for (const field of ["hosts", "passives", "arbiters"]) {
    const members: unknown = hello[field];
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      if (typeof member === "string") hosts.push(member);
    }
  }
  for (const field of ["me", "primary"]) {
    const member: unknown = hello[field];
    if (typeof member === "string") hosts.push(member);
  }
  return hosts;
}

/** `"host:27017"` → `"host"`; IPv6 literals (`[::1]:27017`) lose the port too. */
function stripPort(host: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  const colon = host.lastIndexOf(":");
  // More than one colon without brackets is a bare IPv6 address, which has no port.
  if (colon === -1 || host.indexOf(":") !== colon) return host;
  return host.slice(0, colon);
}
