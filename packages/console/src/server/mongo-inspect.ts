/**
 * Looking at a MongoDB deployment for the connection pages: "does this
 * connection work, and is the user allowed to back up and restore?" and the
 * database/collection tree used to pick what a plan backs up.
 *
 * Only catalog metadata is read (hello, buildInfo, connectionStatus,
 * listDatabases, listCollections, listIndexes, collection counts). The console
 * never reads documents from a live database here.
 *
 * The library has richer versions of these checks (`describeDeployment`,
 * `checkPrivileges`, `discoverNamespaces`), but they are not exported from the
 * public `mongoshield` entry point, so the console uses the driver directly
 * and keeps the privilege check deliberately coarse (see `missingPrivileges`).
 */

import { type Document, MongoClient } from "mongodb";
import type { ConnectionTestResult, DatabaseNode } from "../shared/api.ts";
import { scrubText } from "../state/redact.ts";

/** How long to wait for a server before calling the connection broken. */
const SERVER_SELECTION_TIMEOUT_MS = 10_000;

/** Databases MongoDB uses for itself; never offered for backup. */
const INTERNAL_DATABASES = new Set(["admin", "config", "local"]);

/** Collections inspected at the same time while building the tree. */
const INSPECT_CONCURRENCY = 8;

/** Actions a full backup needs on every database, plus `listDatabases` on the cluster. */
const BACKUP_ACTIONS = ["find", "listCollections", "listIndexes"];
/** Actions a restore needs on every database it writes to (the built-in `restore` role). */
const RESTORE_ACTIONS = [
  "insert",
  "createCollection",
  "createIndex",
  "dropCollection",
  "listCollections",
];

/** Opens a short-lived client for an inspection and always closes it. */
async function withClient<T>(uri: string, task: (client: MongoClient) => Promise<T>): Promise<T> {
  // Options passed here override the URI's, so only add our timeout when the URI sets none.
  const ownTimeout = /[?&]serverSelectionTimeoutMS=/i.test(uri);
  const client = new MongoClient(uri, {
    ...(ownTimeout ? {} : { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS }),
    appName: "mongoshield-console",
  });
  try {
    await client.connect();
    return await task(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Connects, describes the deployment and reports missing privileges. Never throws. */
export async function testConnection(uri: string): Promise<ConnectionTestResult> {
  try {
    return await withClient(uri, async (client) => {
      const admin = client.db("admin");
      const hello = await admin.command({ hello: 1 });
      const buildInfo = await admin.command({ buildInfo: 1 });
      const status = await admin.command({ connectionStatus: 1, showPrivileges: true });
      const privileges = readPrivileges(status);
      return {
        ok: true,
        topology: topologyOf(hello),
        serverVersion: typeof buildInfo.version === "string" ? buildInfo.version : "unknown",
        missingBackupPrivileges: missingPrivileges(privileges, BACKUP_ACTIONS, ["listDatabases"]),
        missingRestorePrivileges: missingPrivileges(privileges, RESTORE_ACTIONS, []),
      };
    });
  } catch (error) {
    return {
      ok: false,
      missingBackupPrivileges: [],
      missingRestorePrivileges: [],
      error: {
        code: "MS_CONNECTION_FAILED",
        // Driver messages can contain the URI; scrub it (and the URI itself) before returning.
        message: scrubText(error instanceof Error ? error.message : String(error), [uri]),
        hint: "Check the host, port, credentials and network access (firewall, IP allow list).",
      },
    };
  }
}

/** The database/collection tree with counts and index numbers. */
export async function namespaceTree(uri: string): Promise<DatabaseNode[]> {
  return withClient(uri, async (client) => {
    const { databases } = await client
      .db("admin")
      .admin()
      .listDatabases({ nameOnly: true, authorizedDatabases: true });
    const names = databases
      .map((database) => database.name)
      .filter((name) => !INTERNAL_DATABASES.has(name))
      .sort();
    const tree: DatabaseNode[] = [];
    for (const name of names) {
      tree.push({ name, collections: await describeCollections(client, name) });
    }
    return tree;
  });
}

type CollectionNode = DatabaseNode["collections"][number];

/** Every non-system collection of a database, sorted by name. */
async function describeCollections(client: MongoClient, dbName: string): Promise<CollectionNode[]> {
  const db = client.db(dbName);
  const infos = await db
    .listCollections({}, { nameOnly: false, authorizedCollections: true })
    .toArray();
  const wanted = infos
    .filter((info) => !info.name.startsWith("system."))
    .map((info) => ({ name: info.name, type: collectionType(info.type) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const nodes: CollectionNode[] = [];
  for (let start = 0; start < wanted.length; start += INSPECT_CONCURRENCY) {
    const batch = wanted.slice(start, start + INSPECT_CONCURRENCY);
    nodes.push(
      ...(await Promise.all(
        batch.map(async ({ name, type }): Promise<CollectionNode> => {
          if (type === "view") return { name, type, estimatedDocuments: 0, indexes: 0 };
          const collection = db.collection(name);
          // Metadata-only calls; a failure (privileges, a collection dropped meanwhile) shows as 0.
          const estimatedDocuments = await collection.estimatedDocumentCount().catch(() => 0);
          const indexes = await collection
            .listIndexes()
            .toArray()
            .then((list) => list.length)
            .catch(() => 0);
          return { name, type, estimatedDocuments, indexes };
        }),
      )),
    );
  }
  return nodes;
}

function collectionType(type: string | undefined): CollectionNode["type"] {
  if (type === "view") return "view";
  if (type === "timeseries") return "timeseries";
  return "collection";
}

/** `replicaSet`, `sharded` or `standalone`, from the `hello` reply. */
function topologyOf(hello: Document): string {
  if (typeof hello.setName === "string") return "replicaSet";
  if (hello.msg === "isdbgrid") return "sharded";
  return "standalone";
}

/** A privilege from connectionStatus: a resource and the actions allowed on it. */
interface Privilege {
  readonly resource: Document;
  readonly actions: readonly string[];
}

/**
 * The authenticated user's privileges, or `undefined` when nobody is
 * authenticated (the server runs without access control: everything is allowed).
 */
function readPrivileges(status: Document): Privilege[] | undefined {
  const authInfo: unknown = status.authInfo;
  if (typeof authInfo !== "object" || authInfo === null) return undefined;
  const users: unknown = Reflect.get(authInfo, "authenticatedUsers");
  if (!Array.isArray(users) || users.length === 0) return undefined;
  const raw: unknown = Reflect.get(authInfo, "authenticatedUserPrivileges");
  if (!Array.isArray(raw)) return [];
  const privileges: Privilege[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const resource: unknown = Reflect.get(entry, "resource");
    const actions: unknown = Reflect.get(entry, "actions");
    if (typeof resource === "object" && resource !== null && Array.isArray(actions)) {
      privileges.push({
        resource: { ...resource },
        actions: actions.filter((action): action is string => typeof action === "string"),
      });
    }
  }
  return privileges;
}

/**
 * Which actions the user lacks on *every* database (and on the cluster).
 * Coarse on purpose: a user whose roles grant access to single databases is
 * reported as missing privileges here, even though backups limited to those
 * databases would work. The backup itself does the precise per-namespace check.
 */
function missingPrivileges(
  privileges: readonly Privilege[] | undefined,
  databaseActions: readonly string[],
  clusterActions: readonly string[],
): string[] {
  if (privileges === undefined) return [];
  const grants = (action: string, scope: "cluster" | "everyDatabase"): boolean =>
    privileges.some((privilege) => {
      if (!privilege.actions.includes(action)) return false;
      const resource = privilege.resource;
      if (resource.anyResource === true) return true;
      if (scope === "cluster") return resource.cluster === true;
      return resource.db === "" && resource.collection === "";
    });
  return [
    ...clusterActions
      .filter((action) => !grants(action, "cluster"))
      .map((action) => `${action} on the cluster`),
    ...databaseActions
      .filter((action) => !grants(action, "everyDatabase"))
      .map((action) => `${action} on all databases`),
  ];
}
