/**
 * Creating and dropping restore targets with the raw `create` / `drop` commands.
 *
 * The backed-up `listCollections` options are passed back to `create` almost
 * unchanged, which recreates every kind of namespace faithfully:
 *
 *   capped, size, max                                   capped collections
 *   validator, validationLevel, validationAction        schema validation
 *   collation                                           default collation
 *   clusteredIndex (+ expireAfterSeconds)               clustered collections
 *   timeseries (+ expireAfterSeconds)                   time series
 *   viewOn, pipeline (+ collation)                      views
 *   changeStreamPreAndPostImages, storageEngine,
 *   indexOptionDefaults, …                              everything else
 *
 * The raw command is used instead of `db.createCollection()` so the driver adds
 * nothing of its own (it would, for example, create extra collections for
 * `encryptedFields`). A few options are removed because `create` rejects them
 * on current servers; see `REJECTED_CREATE_OPTIONS`.
 */

import { type Db, type Document, MongoServerError, type WriteConcernSettings } from "mongodb";

/**
 * Options `listCollections` may report that `create` refuses, so they are removed:
 *
 * - `autoIndexId`: removed in MongoDB 4.0 (every collection has an `_id` index).
 * - `flags`: MMAPv1 storage flags from servers before 4.2.
 * - `recordPreImages`: replaced by `changeStreamPreAndPostImages` in 6.0.
 * - `timeseriesBucketsMayHaveMixedSchemaData`: server-maintained state of the
 *   buckets collection, not a creation option.
 * - `temp`: marks internal temporary collections.
 */
export const REJECTED_CREATE_OPTIONS = [
  "autoIndexId",
  "flags",
  "recordPreImages",
  "timeseriesBucketsMayHaveMixedSchemaData",
  "temp",
] as const;

/** Server error code when a namespace does not exist. */
const NAMESPACE_NOT_FOUND_CODE = 26;

/** Returns the backed-up options without the ones `create` rejects. */
export function createOptionsFrom(options: Document): Document {
  const cleaned: Document = {};
  for (const [name, value] of Object.entries(options)) {
    if (!(REJECTED_CREATE_OPTIONS as readonly string[]).includes(name)) cleaned[name] = value;
  }
  return cleaned;
}

/**
 * Points a view at the collection it reads from, after renames. `viewOn` is a
 * collection name in the view's own database; `pipeline` is kept as is.
 */
export function withViewSource(options: Document, viewOn: string): Document {
  return { ...options, viewOn };
}

/** Creates a collection, time series or view with the given (cleaned) options. */
export async function createNamespace(
  db: Db,
  name: string,
  options: Document,
  writeConcern: WriteConcernSettings | undefined,
): Promise<void> {
  await db.command({ create: name, ...options, ...commandWriteConcern(writeConcern) });
}

/**
 * The `writeConcern` field of a raw command. The driver's settings use option names
 * (`journal`, `wtimeoutMS`) that differ from the server's wire names (`j`, `wtimeout`),
 * and the server rejects unknown fields, so they are translated here. The legacy
 * driver names `j`, `wtimeout` and `fsync` (a synonym of `j`) are accepted too.
 */
export function commandWriteConcern(settings: WriteConcernSettings | undefined): Document {
  if (settings === undefined) return {};
  const writeConcern: Document = {};
  if (settings.w !== undefined) writeConcern.w = settings.w;
  const journal = settings.journal ?? settings.j ?? settings.fsync;
  if (journal !== undefined) writeConcern.j = journal === true || journal === 1;
  const timeout = settings.wtimeoutMS ?? settings.wtimeout;
  if (timeout !== undefined) writeConcern.wtimeout = timeout;
  return Object.keys(writeConcern).length > 0 ? { writeConcern } : {};
}

/** Drops a namespace of any type. A namespace that is already gone is fine. */
export async function dropNamespace(
  db: Db,
  name: string,
  writeConcern: WriteConcernSettings | undefined,
): Promise<void> {
  try {
    await db.command({ drop: name, ...commandWriteConcern(writeConcern) });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === NAMESPACE_NOT_FOUND_CODE) return;
    throw error;
  }
}
