/**
 * Making `snapshot.restore()` fast: only the namespaces a test actually changed are
 * put back, and the cheapest way that is exact.
 *
 * A "fingerprint" of each snapshotted namespace is taken right after the snapshot
 * (and after every reset): its type, options and indexes, plus a hash of its
 * documents from the server's `dbHash` command (one command per database). At reset
 * time a fresh fingerprint is compared with that reference:
 *
 *   what changed since the reference          action
 *   nothing                                   keep      (no work at all)
 *   only documents                            reload    deleteMany({}) + insert the
 *                                                       backed-up documents
 *   options, indexes, type, or it is gone     recreate  drop + create + documents +
 *                                                       indexes (the restore engine)
 *
 * Why not always recreate: dropping and recreating a collection rebuilds its
 * indexes, which costs a round trip and a commit per index on replica sets; a test
 * that inserted one document should not pay that for every collection.
 *
 * When a hash is not available (no `dbHash` privilege, time series collections) the
 * data counts as changed, and capped collections are always recreated (documents
 * cannot be removed from them on every server version), so results stay exact.
 */

import { BSON, type Document, type MongoClient } from "mongodb";
import { mapWithConcurrency } from "../engine/pool.ts";
import type { StoredBackupSource } from "../engine/read-pipeline.ts";
import { loadDocuments } from "../engine/restore-documents.ts";
import type { NamespaceEntry } from "../format/manifest.ts";
import { splitNamespace } from "../mongo/index.ts";

/** A cheaply comparable description of one namespace's state. */
export interface NamespaceFingerprint {
  /** `collection`, `view` or `timeseries`, as listCollections reports it. */
  readonly type: string;
  /** Type, options and indexes, serialized (canonical Extended JSON). */
  readonly structure: string;
  /** The server's hash of the documents, or undefined when it is not available. */
  readonly dataHash: string | undefined;
  /** True when documents may be replaced in place (a plain, non-capped collection). */
  readonly reloadable: boolean;
}

/** Fingerprints by namespace. Namespaces that do not exist are absent. */
export type Fingerprints = Map<string, NamespaceFingerprint>;

/** What a reset does with one namespace (see the table in the header comment). */
export type ResetAction = "keep" | "reload" | "recreate";

/**
 * Fingerprints the given namespaces: one listCollections and one dbHash per
 * database, one listIndexes per collection.
 */
export async function fingerprintNamespaces(
  client: MongoClient,
  namespaces: readonly string[],
): Promise<Fingerprints> {
  const fingerprints: Fingerprints = new Map();
  for (const [database, names] of groupByDatabase(namespaces)) {
    const db = client.db(database);
    const infos = await db.listCollections({ name: { $in: names } }).toArray();
    const collections = infos.filter((info) => info.type === "collection").map((info) => info.name);
    const hashes = await collectionHashes(client, database, collections);
    for (const info of infos) {
      const options: Document = "options" in info ? (info.options ?? {}) : {};
      const indexes =
        info.type === "view" ? [] : await db.collection(info.name).listIndexes().toArray();
      fingerprints.set(`${database}.${info.name}`, {
        type: info.type ?? "collection",
        structure: BSON.EJSON.stringify({ type: info.type, options, indexes }, { relaxed: false }),
        dataHash: hashes.get(info.name),
        reloadable: info.type === "collection" && options.capped !== true,
      });
    }
  }
  return fingerprints;
}

/** Decides the action for every snapshotted namespace. Pure, so it is unit-tested. */
export function planReset(
  namespaces: readonly string[],
  reference: Fingerprints,
  current: Fingerprints,
): Map<string, ResetAction> {
  const plan = new Map<string, ResetAction>();
  for (const ns of namespaces) {
    plan.set(ns, decideAction(reference.get(ns), current.get(ns)));
  }
  return plan;
}

function decideAction(
  reference: NamespaceFingerprint | undefined,
  current: NamespaceFingerprint | undefined,
): ResetAction {
  if (reference === undefined || current === undefined) return "recreate";
  if (current.structure !== reference.structure) return "recreate";
  if (current.dataHash !== undefined && current.dataHash === reference.dataHash) return "keep";
  // Views have no data (and so no hash): an unchanged structure means unchanged.
  if (current.type === "view") return "keep";
  return current.reloadable ? "reload" : "recreate";
}

/** Everything `reloadDocuments` needs. */
export interface ReloadOptions {
  readonly client: MongoClient;
  readonly source: StoredBackupSource;
  readonly entries: readonly NamespaceEntry[];
  readonly parallelism: number;
}

/**
 * Replaces the documents of unchanged-structure collections with the backed-up
 * ones: delete everything, then insert. The options (and so the validator) are the
 * snapshot's, so the documents pass validation without bypassing it.
 */
export async function reloadDocuments(options: ReloadOptions): Promise<void> {
  await mapWithConcurrency(
    options.entries,
    async (entry, _index, signal) => {
      const collection = options.client.db(entry.db).collection(entry.collection);
      await collection.deleteMany({});
      await loadDocuments({
        source: options.source,
        files: entry.files,
        collection,
        mode: "insert-new",
        workers: 2,
        bypassDocumentValidation: false,
        signal,
      });
    },
    { concurrency: options.parallelism },
  );
}

/**
 * Collection name → hash of its documents, from `dbHash`. An empty map when the
 * command is refused (missing privilege, or a deployment that lacks it): then every
 * collection counts as changed, which is slower but still exact.
 */
async function collectionHashes(
  client: MongoClient,
  database: string,
  collections: readonly string[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  if (collections.length === 0) return hashes;
  try {
    const reply = await client.db(database).command({ dbHash: 1, collections: [...collections] });
    const perCollection: unknown = reply.collections;
    if (typeof perCollection === "object" && perCollection !== null) {
      for (const [name, hash] of Object.entries(perCollection)) {
        if (typeof hash === "string") hashes.set(name, hash);
      }
    }
  } catch {
    // Falls back to "changed" for every collection of this database.
  }
  return hashes;
}

function groupByDatabase(namespaces: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const ns of namespaces) {
    const { database, collection } = splitNamespace(ns);
    const group = groups.get(database) ?? [];
    group.push(collection);
    groups.set(database, group);
  }
  return groups;
}
