/**
 * Is a live connection an Atlas shared-tier cluster (Free, Flex, legacy M2/M5)?
 *
 * Those clusters run behind a proxy that throttles every client (Atlas Free allows about
 * 100 operations per second, Flex about 500) and refuses some commands, `$collStats`
 * among them. The data browser adapts: schema samples read fewer documents, samples and
 * exports run one at a time (pacing.ts), and the collection page explains missing sizes
 * instead of failing.
 *
 * Detection follows the library (packages/mongoshield/src/mongo/atlas.ts) using only its
 * public exports (`isAtlasHost`, `isAtlasRefusal`):
 *
 *   1. Atlas at all? Some host name of the connection (its SRV name, or a seed host)
 *      ends in `.mongodb.net` / `.mongodbgov.net`. Other deployments are never probed.
 *   2. Shared tier? One read-only probe, `getParameter` of `featureCompatibilityVersion`:
 *      shared tiers refuse it with code 8000 `AtlasError` (they only let users read two
 *      parameters); dedicated clusters answer it, or refuse it with `Unauthorized` (13)
 *      for users without `clusterMonitor`, which is not an Atlas refusal.
 *
 * An Atlas refusal of `$collStats` proves the same thing, so the collection route
 * records it with {@link markSharedTier} and the probe is never needed afterwards.
 *
 * The answer is cached per MongoClient in a WeakMap: the live client cache
 * (clients.ts) builds a new client when the connection's URI changes or it was idle, so
 * the cached answer goes away with the client it describes, and nothing leaks.
 */

import type { Document, MongoClient } from "mongodb";
import { isAtlasHost, isAtlasRefusal } from "mongoshield";

/**
 * The probe (see the file header). Every mongod since 3.4 knows the parameter; it is
 * only read, never set.
 */
export const SHARED_TIER_PROBE: Readonly<Document> = {
  getParameter: 1,
  featureCompatibilityVersion: 1,
};

/** The cached answer per client: a promise, so concurrent requests share one probe. */
const tiers = new WeakMap<MongoClient, Promise<boolean>>();

/**
 * True when the client talks to an Atlas shared-tier cluster. Probes at most once per
 * client, and only Atlas hosts; any unexpected outcome counts as "not shared" (the
 * normal limits apply), so detection can never break browsing.
 */
export function isSharedTier(client: MongoClient): Promise<boolean> {
  const cached = tiers.get(client);
  if (cached !== undefined) return cached;
  const answer = atlasHostsOf(client).length === 0 ? Promise.resolve(false) : probe(client);
  tiers.set(client, answer);
  return answer;
}

/** Records that the client's cluster is a shared tier (Atlas refused `$collStats`). */
export function markSharedTier(client: MongoClient): void {
  tiers.set(client, Promise.resolve(true));
}

/** Runs the probe: an Atlas refusal means shared tier; anything else does not. */
async function probe(client: MongoClient): Promise<boolean> {
  try {
    await client.db("admin").command({ ...SHARED_TIER_PROBE });
    return false;
  } catch (error) {
    return isAtlasRefusal(error);
  }
}

/**
 * The client's Atlas host names: the SRV name of a `mongodb+srv://` URI and the seed
 * hosts, as the driver parsed them (no command is sent to find them).
 */
export function atlasHostsOf(client: MongoClient): string[] {
  const { srvHost, hosts } = client.options;
  const names = [...(typeof srvHost === "string" ? [srvHost] : []), ...hosts.map(String)];
  return names.filter(isAtlasHost);
}
