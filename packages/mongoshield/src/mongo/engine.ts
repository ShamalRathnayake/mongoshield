/**
 * Recognising MongoDB-compatible databases that are not MongoDB: Amazon DocumentDB,
 * Azure Cosmos DB for MongoDB and FerretDB. They speak the wire protocol and report a
 * MongoDB version, but implement only part of it, so a feature check by version number
 * alone (change streams with `showExpandedEvents`, say) can promise more than they do.
 * The backup engine uses this to make `consistency: "auto"` fall back to `none` instead
 * of failing when such a server refuses the change stream `converge` needs.
 *
 * Detection is the one mongosh uses: host names for the cloud services
 * (`*.docdb.amazonaws.com`, `*.docdb-elastic.amazonaws.com`, `*.cosmos.azure.com`), and
 * the `ferretdb` fields FerretDB adds to `buildInfo`. Nothing is sent to the server.
 */

import type { Document, MongoClient } from "mongodb";

/** A MongoDB-compatible database that is not MongoDB itself. */
export type CompatibleEngine = "documentdb" | "cosmosdb" | "ferretdb";

/** Product names, for messages. */
export const COMPATIBLE_ENGINE_NAMES: Readonly<Record<CompatibleEngine, string>> = {
  documentdb: "Amazon DocumentDB",
  cosmosdb: "Azure Cosmos DB for MongoDB",
  ferretdb: "FerretDB",
};

/** DocumentDB clusters (instance-based and elastic) live under these domains. */
const DOCUMENTDB_HOST_PATTERN = /\.docdb(?:-elastic)?\.amazonaws\.com$/i;

/** Cosmos DB for MongoDB, RU (`*.mongo.cosmos.azure.com`) and vCore (`*.mongocluster…`). */
const COSMOSDB_HOST_PATTERN = /\.cosmos\.azure\.com$/i;

/**
 * Which compatible engine the client is connected to, or `undefined` for MongoDB (and
 * for anything not recognised, which is then treated as MongoDB).
 *
 * @param client the connected client (its SRV name and seed hosts are read).
 * @param buildInfo the server's `buildInfo` reply.
 */
export function detectCompatibleEngine(
  client: MongoClient,
  buildInfo: Document,
): CompatibleEngine | undefined {
  // FerretDB reports itself in buildInfo (`ferretdb`, or `ferretdbVersion` in 1.x).
  if (Object.keys(buildInfo).some((key) => key.toLowerCase().startsWith("ferretdb"))) {
    return "ferretdb";
  }
  for (const host of hostNames(client)) {
    if (DOCUMENTDB_HOST_PATTERN.test(host)) return "documentdb";
    if (COSMOSDB_HOST_PATTERN.test(host)) return "cosmosdb";
  }
  return undefined;
}

/** The SRV name and the seed host names of the connection, without ports. */
function hostNames(client: MongoClient): string[] {
  const names: string[] = [];
  const { srvHost } = client.options;
  if (typeof srvHost === "string") names.push(srvHost);
  for (const host of client.options.hosts) {
    const address = host.toString();
    // `host:port`, or `[v6]:port` for IPv6 literals (never a compatible engine's name).
    const colon = address.lastIndexOf(":");
    names.push(colon > 0 && !address.endsWith("]") ? address.slice(0, colon) : address);
  }
  return names;
}
