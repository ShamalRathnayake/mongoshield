/**
 * Namespace discovery: which collections exist, and everything needed to recreate each
 * one faithfully on restore (creation options + index definitions).
 *
 * `discoverNamespaces` walks `listDatabases` → `listCollections` → `listIndexes` (and
 * `$listSearchIndexes` for Atlas Search indexes, see search-indexes.ts) and returns one
 * `CollectionSpec` per namespace. `orderForRestore` sorts those specs so a
 * restore can create them one by one without referring to something not yet created.
 * Only catalog metadata is read here; documents are streamed by the backup engine.
 */

import { Binary, type Db, type Document, type MongoClient, MongoServerError } from "mongodb";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { SearchIndexDefinition } from "../format/metadata.ts";
import { type Logger, silentLogger } from "../logger.ts";
import {
  compileNamespaceRules,
  explicitlyNamedDatabases,
  matchesRules,
  mayIncludeDatabase,
  type NamespaceFilterOptions,
  type NamespaceRules,
} from "./namespace-filter.ts";
import { listSearchIndexDefinitions, type SearchIndexSupport } from "./search-indexes.ts";

export {
  compileNamespaceFilter,
  type NamespaceFilter,
  type NamespaceFilterOptions,
  splitNamespace,
} from "./namespace-filter.ts";

/** The kinds of namespace `listCollections` reports that MongoShield can back up. */
export type CollectionType = "collection" | "view" | "timeseries";

/** Everything needed to recreate one namespace. Stored in the backup manifest. */
export interface CollectionSpec {
  /** `db.collection`. */
  readonly ns: string;
  readonly db: string;
  readonly name: string;
  readonly type: CollectionType;
  /**
   * Exactly what `listCollections` reported as `options`, passed back to
   * `createCollection` on restore: `viewOn`/`pipeline`, `validator`/`validationLevel`/
   * `validationAction`, `collation`, `capped`/`size`/`max`, `clusteredIndex`,
   * `timeseries`, `expireAfterSeconds`, `changeStreamPreAndPostImages`, …
   */
  readonly options: Document;
  /**
   * The collection UUID as 32 lowercase hex characters. Views have none. For time series
   * this is the UUID of the backing `system.buckets.<name>` collection, because that is
   * where the server records writes (oplog entries, change events).
   */
  readonly uuid?: string;
  /** `listIndexes` output, unmodified. Always `[]` for views. */
  readonly indexes: readonly Document[];
  /**
   * Atlas Search and Vector Search index definitions. Only set when the collection has
   * some; servers without Atlas Search never do.
   */
  readonly searchIndexes?: readonly SearchIndexDefinition[];
  /** A fast estimate from collection metadata, for progress bars. 0 for views. */
  readonly estimatedDocuments: number;
}

/** Options for `discoverNamespaces`. */
export interface DiscoverNamespacesOptions extends NamespaceFilterOptions {
  readonly signal?: AbortSignal | undefined;
  /** Receives warnings, e.g. about collections dropped while discovery ran. */
  readonly logger?: Logger | undefined;
}

/**
 * Databases MongoDB uses for itself. `admin` holds users and roles, `config` holds
 * sessions and sharding metadata, `local` holds the oplog. None of them can be restored
 * with plain inserts, so they are only scanned when an include pattern names them.
 */
const INTERNAL_DATABASES = new Set(["admin", "config", "local"]);

/** Server error code when a namespace no longer exists. */
const NAMESPACE_NOT_FOUND_CODE = 26;

/**
 * Lists every namespace the connected user can see that matches the filter, with its
 * full creation spec, sorted by namespace.
 *
 * Skipped automatically:
 * - the `admin`, `config` and `local` databases unless an include pattern names them
 *   literally (`admin.*` does, `*.*` does not);
 * - `system.*` collections (users, roles, profiler data, view definitions, …), except
 *   `system.js`, which holds user-stored JavaScript and is ordinary data;
 * - `system.buckets.*`: a time series collection is backed by a hidden buckets collection
 *   in an internal, compressed format. MongoShield reads the time series namespace
 *   itself, which yields plain measurements, and recreating it with its `timeseries`
 *   options on restore rebuilds the buckets, so the format stays version-independent.
 *
 * A collection dropped between listing and reading is skipped with a warning.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for malformed patterns, `MS_ABORTED` when
 *   the signal fires.
 */
export async function discoverNamespaces(
  client: MongoClient,
  options: DiscoverNamespacesOptions = {},
): Promise<CollectionSpec[]> {
  const rules = compileNamespaceRules(options);
  const logger = options.logger ?? silentLogger;
  const explicitDatabases = explicitlyNamedDatabases(rules);

  const scan: DatabaseScan = {
    rules,
    logger,
    signal: options.signal,
    search: { supported: undefined },
  };

  const specs: CollectionSpec[] = [];
  for (const database of await listDatabaseNames(client)) {
    throwIfAborted(options.signal);
    if (INTERNAL_DATABASES.has(database) && !explicitDatabases.has(database)) continue;
    if (!mayIncludeDatabase(rules, database)) continue;
    const found = await describeDatabase(client.db(database), scan);
    specs.push(...found);
  }
  specs.sort((left, right) => compareNamespaces(left.ns, right.ns));
  return specs;
}

/**
 * `authorizedDatabases: true` makes the server return the databases this user has
 * privileges on instead of failing when the user lacks the `listDatabases` action.
 */
async function listDatabaseNames(client: MongoClient): Promise<string[]> {
  const result = await client
    .db("admin")
    .admin()
    .listDatabases({ nameOnly: true, authorizedDatabases: true });
  return result.databases.map((database) => database.name);
}

/** Settings and shared state of one discovery run. */
interface DatabaseScan {
  readonly rules: NamespaceRules;
  readonly logger: Logger;
  readonly signal: AbortSignal | undefined;
  /** Learned from the first collection: a server without Atlas Search is asked once. */
  readonly search: SearchIndexSupport;
}

/** Lists one database's collections and builds a spec for each selected one. */
async function describeDatabase(db: Db, scan: DatabaseScan): Promise<CollectionSpec[]> {
  const { rules, logger, signal } = scan;
  // `authorizedCollections` lets users with collection-level privileges list just what
  // they may read. These are small catalog entries, so collecting them is fine.
  const infos = await db
    .listCollections({}, { nameOnly: false, authorizedCollections: true })
    .toArray();
  const bucketUuids = timeSeriesBucketUuids(infos);

  const specs: CollectionSpec[] = [];
  for (const info of infos) {
    throwIfAborted(signal);
    const name = typeof info.name === "string" ? info.name : "";
    if (name === "" || isSkippedSystemCollection(name)) continue;
    if (!matchesRules(rules, `${db.databaseName}.${name}`)) continue;

    const type = collectionType(info.type);
    if (type === undefined) {
      logger.warn("Skipping a namespace of an unsupported type", {
        ns: `${db.databaseName}.${name}`,
        type: String(info.type),
      });
      continue;
    }
    const uuid = type === "timeseries" ? bucketUuids.get(name) : uuidHex(info.info?.uuid);
    const spec = await describeCollection(db, { name, type, info, uuid }, scan);
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

/** What `describeDatabase` already knows about a collection from `listCollections`. */
interface ListedCollection {
  readonly name: string;
  readonly type: CollectionType;
  readonly info: Document;
  readonly uuid: string | undefined;
}

/**
 * Reads indexes, search indexes and the document estimate; returns undefined if the
 * collection vanished.
 */
async function describeCollection(
  db: Db,
  listed: ListedCollection,
  scan: DatabaseScan,
): Promise<CollectionSpec | undefined> {
  const { logger } = scan;
  const ns = `${db.databaseName}.${listed.name}`;
  const base = {
    ns,
    db: db.databaseName,
    name: listed.name,
    type: listed.type,
    options: isDocument(listed.info.options) ? listed.info.options : {},
    ...(listed.uuid === undefined ? {} : { uuid: listed.uuid }),
  };
  // Views store no data and have no indexes of their own; their pipeline is the spec.
  if (listed.type === "view") return { ...base, indexes: [], estimatedDocuments: 0 };

  const collection = db.collection(listed.name);
  try {
    // For time series, listIndexes on the user-facing namespace returns indexes in
    // measurement terms (e.g. `{ meta: 1, time: 1 }`), which is what createIndex accepts.
    const indexes = await collection.listIndexes().toArray();
    // `count` reads collection metadata, so this is O(1) for collections. On a time
    // series it counts measurements by unpacking buckets, which is slower but accurate.
    const estimatedDocuments = await collection.estimatedDocumentCount();
    // Atlas Search indexes exist on regular collections only. This never throws:
    // servers without Atlas Search simply report none.
    const searchIndexes =
      listed.type === "collection"
        ? await listSearchIndexDefinitions(collection, { ns, support: scan.search, logger })
        : [];
    return {
      ...base,
      indexes,
      estimatedDocuments,
      ...(searchIndexes.length === 0 ? {} : { searchIndexes }),
    };
  } catch (error) {
    if (isNamespaceNotFound(error)) {
      logger.warn("Skipping a collection that was dropped during discovery", { ns });
      return undefined;
    }
    throw error;
  }
}

/** `system.js` is user data; every other `system.*` collection is server-managed. */
function isSkippedSystemCollection(name: string): boolean {
  return name.startsWith("system.") && name !== "system.js";
}

/**
 * Time series report no UUID of their own (the namespace is view-like); the UUID lives on
 * the backing `system.buckets.<name>` collection. Maps time series name → bucket UUID.
 */
function timeSeriesBucketUuids(infos: readonly Document[]): Map<string, string> {
  const prefix = "system.buckets.";
  const uuids = new Map<string, string>();
  for (const info of infos) {
    if (typeof info.name !== "string" || !info.name.startsWith(prefix)) continue;
    const uuid = uuidHex(info.info?.uuid);
    if (uuid !== undefined) uuids.set(info.name.slice(prefix.length), uuid);
  }
  return uuids;
}

function collectionType(type: unknown): CollectionType | undefined {
  // Servers before 3.4 omitted `type`; anything without it is an ordinary collection.
  if (type === undefined || type === "collection") return "collection";
  if (type === "view" || type === "timeseries") return type;
  return undefined;
}

/** A BSON UUID (binary subtype 4) as 32 lowercase hex characters. */
function uuidHex(value: unknown): string | undefined {
  return value instanceof Binary ? value.toString("hex").toLowerCase() : undefined;
}

function isNamespaceNotFound(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === NAMESPACE_NOT_FOUND_CODE;
}

function isDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain code-unit comparison: deterministic across locales, unlike `localeCompare`. */
function compareNamespaces(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Orders specs so each can be created after everything it depends on:
 * collections and time series first (they depend on nothing), then views, with a view
 * placed after any view its `viewOn` points to (`viewOn` always names a collection or
 * view in the same database). The relative order of the input is otherwise kept.
 *
 * @throws MongoShieldError `MS_MANIFEST_INVALID` if views form a cycle, which a real
 *   server never allows, so the specs must have been altered.
 */
export function orderForRestore(specs: readonly CollectionSpec[]): CollectionSpec[] {
  const storage = specs.filter((spec) => spec.type !== "view");
  const views = specs.filter((spec) => spec.type === "view");
  return [...storage, ...orderViews(views)];
}

/** Depth-first topological sort of views along their `viewOn` edges. */
function orderViews(views: readonly CollectionSpec[]): CollectionSpec[] {
  const viewsByNs = new Map(views.map((view) => [view.ns, view]));
  const ordered: CollectionSpec[] = [];
  const done = new Set<string>();
  // The current chain of views being visited; seeing one again means a cycle.
  const visiting: string[] = [];

  const visit = (view: CollectionSpec): void => {
    if (done.has(view.ns)) return;
    if (visiting.includes(view.ns)) {
      const cycle = [...visiting.slice(visiting.indexOf(view.ns)), view.ns];
      throw new MongoShieldError(
        "MS_MANIFEST_INVALID",
        `Views depend on each other in a cycle: ${cycle.join(" → ")}.`,
        { hint: "MongoDB never allows view cycles; check whether the backup manifest was edited." },
      );
    }
    visiting.push(view.ns);
    const source = viewSource(view);
    const sourceView = source === undefined ? undefined : viewsByNs.get(source);
    if (sourceView !== undefined) visit(sourceView);
    visiting.pop();
    done.add(view.ns);
    ordered.push(view);
  };

  for (const view of views) visit(view);
  return ordered;
}

/** The namespace a view reads from (`viewOn` is a bare collection name in the same db). */
function viewSource(view: CollectionSpec): string | undefined {
  const viewOn: unknown = view.options.viewOn;
  return typeof viewOn === "string" ? `${view.db}.${viewOn}` : undefined;
}
