/**
 * Recreating a collection's indexes from its backed-up `listIndexes` output.
 *
 * Indexes are built after the documents are loaded: one bulk build over the
 * finished collection is much faster than maintaining every index during inserts.
 *
 * What is changed in each index definition, and why:
 *
 * - `_id_` is skipped: the server creates it with the collection.
 * - Clustered indexes (`clustered: true`) are skipped: they are the collection's
 *   storage order, created by the `clusteredIndex` create option.
 * - `v` (index format version) is removed so the server picks its current format;
 *   restoring `v: 1` from an old backup would pin an outdated format.
 * - `ns` (pre-4.4 servers) and `background` (ignored since 4.2) are removed: newer
 *   servers reject or ignore them.
 * - When the collection has a default collation, an index listed WITHOUT a collation
 *   uses the simple (binary) collation. Recreated as-is it would inherit the
 *   collection's collation instead, changing its behaviour (text indexes even fail
 *   to build). So `collation: { locale: "simple" }` is added, as mongorestore does.
 *
 * Everything else (unique, sparse, partialFilterExpression, expireAfterSeconds,
 * weights, wildcardProjection, hidden, 2dsphereIndexVersion, …) is kept unchanged.
 */

import { BSON, type Db, type Document, MongoServerError, type WriteConcernSettings } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { commandWriteConcern } from "./restore-collections.ts";

/** Fields removed from every index definition (see the header comment). */
const STRIPPED_INDEX_FIELDS = ["v", "ns", "background"] as const;

/** Name of the index the server creates on `_id` for every regular collection. */
const ID_INDEX_NAME = "_id_";

/**
 * Server error codes meaning "an index like this already exists in another form":
 * 85 IndexOptionsConflict (same key, different name or options),
 * 86 IndexKeySpecsConflict (same name, different key),
 * 68 IndexAlreadyExists.
 */
const INDEX_CONFLICT_CODES = new Set([85, 86, 68]);

/**
 * Turns backed-up index definitions into `createIndexes` specs for a collection
 * with the given create options (see the header comment for every rule).
 */
export function prepareIndexSpecs(
  indexes: readonly Document[],
  collectionOptions: Document,
): Document[] {
  const collectionHasCollation = collectionOptions.collation !== undefined;
  const specs: Document[] = [];
  for (const index of indexes) {
    if (index.name === ID_INDEX_NAME || index.clustered === true) continue;
    const spec = withoutFields(index, STRIPPED_INDEX_FIELDS);
    if (collectionHasCollation && spec.collation === undefined) {
      spec.collation = { locale: "simple" };
    }
    specs.push(spec);
  }
  return specs;
}

/**
 * Leaves out specs that an existing index already satisfies: same name and same key.
 * This covers indexes the server creates by itself, such as the `{ meta: 1, time: 1 }`
 * index of a time series with a metaField, and indexes that survived in merge modes.
 */
export function withoutExistingIndexes(
  specs: readonly Document[],
  existing: readonly Document[],
): Document[] {
  return specs.filter(
    (spec) => !existing.some((index) => index.name === spec.name && sameKey(index.key, spec.key)),
  );
}

/** Options for `createIndexes`. */
export interface CreateIndexesOptions {
  readonly writeConcern?: WriteConcernSettings | undefined;
  /**
   * Restoring into a collection that already existed (insert / upsert modes): an index
   * that conflicts with one the target already has is skipped with a warning, because
   * the user chose to keep the target. For new collections a conflict is an error.
   */
  readonly keepConflictingTargetIndexes: boolean;
  readonly logger: Logger;
}

/**
 * Builds the backed-up indexes of `collection` that it does not have yet.
 * All indexes are sent in one `createIndexes` command so the server builds them in a
 * single collection scan. On a conflict in a merge mode, they are retried one by one
 * so that only the conflicting ones are skipped.
 *
 * @returns how many index specs were sent to the server.
 * @throws MongoShieldError `MS_RESTORE_FAILED` when an index cannot be built.
 */
export async function restoreIndexes(
  db: Db,
  collection: string,
  specs: readonly Document[],
  options: CreateIndexesOptions,
): Promise<number> {
  const existing = await db.collection(collection).listIndexes().toArray();
  const missing = withoutExistingIndexes(specs, existing);
  if (missing.length === 0) return 0;

  try {
    await runCreateIndexes(db, collection, missing, options.writeConcern);
    return missing.length;
  } catch (error) {
    if (!(options.keepConflictingTargetIndexes && isIndexConflict(error))) {
      throw indexError(db.databaseName, collection, error);
    }
  }

  // Merge mode with a conflict: build the others, skip the conflicting ones.
  let created = 0;
  for (const spec of missing) {
    try {
      await runCreateIndexes(db, collection, [spec], options.writeConcern);
      created += 1;
    } catch (error) {
      if (!isIndexConflict(error)) throw indexError(db.databaseName, collection, error);
      options.logger.warn("Kept the target's index instead of a conflicting one from the backup", {
        ns: `${db.databaseName}.${collection}`,
        index: String(spec.name),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return created;
}

async function runCreateIndexes(
  db: Db,
  collection: string,
  specs: readonly Document[],
  writeConcern: WriteConcernSettings | undefined,
): Promise<void> {
  await db.command({
    createIndexes: collection,
    indexes: specs,
    ...commandWriteConcern(writeConcern),
  });
}

function isIndexConflict(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    typeof error.code === "number" &&
    INDEX_CONFLICT_CODES.has(error.code)
  );
}

function indexError(database: string, collection: string, cause: unknown): MongoShieldError {
  if (cause instanceof MongoShieldError) return cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new MongoShieldError(
    "MS_RESTORE_FAILED",
    `Building the indexes of ${database}.${collection} failed: ${reason}`,
    {
      cause,
      hint: "The documents were restored; fix the cause and recreate the index, or restore again with --drop.",
    },
  );
}

/**
 * Compares two index keys, field order included (it matters for compound indexes).
 * Relaxed Extended JSON makes `1`, `Int32(1)` and `Double(1)` compare equal, since the
 * server treats them the same in a key pattern.
 */
function sameKey(left: unknown, right: unknown): boolean {
  return (
    BSON.EJSON.stringify(left, { relaxed: true }) === BSON.EJSON.stringify(right, { relaxed: true })
  );
}

/** A shallow copy of `document` without the given fields. */
function withoutFields(document: Document, fields: readonly string[]): Document {
  const copy: Document = {};
  for (const [name, value] of Object.entries(document)) {
    if (!fields.includes(name)) copy[name] = value;
  }
  return copy;
}
