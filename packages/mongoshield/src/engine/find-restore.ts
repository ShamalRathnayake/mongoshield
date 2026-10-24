/**
 * Single-document restore: put back only the documents of a backup that match a
 * filter ("restore the user someone deleted an hour ago"), leaving everything else
 * in the target untouched.
 *
 *   validate → open the backup namespace (find.ts) → inspect the target collection
 *   → (create it with the backed-up options and indexes, if allowed and missing)
 *   → stream matching documents in batches → insert or upsert each batch
 *
 * Modes, for a matching document whose `_id` already exists in the target:
 *
 *   insert (default)   keep the existing document; the backed-up one is skipped
 *   upsert             replace the existing document with the backed-up one
 *
 * Documents whose `_id` does not exist are inserted in both modes. A dry run reads
 * the backup and counts what WOULD happen (one `_id` lookup per batch), writing
 * nothing.
 *
 * Safety: the target must already exist (a typo in a namespace should not quietly
 * create a new collection) unless `createIfMissing` is set. Views and time series
 * collections are refused as targets: views store nothing, and time series have no
 * unique `_id` to merge on, so documents would be duplicated.
 */

import {
  type AnyBulkWriteOperation,
  type Collection,
  type Document,
  MongoBulkWriteError,
  type MongoClient,
  MongoServerError,
  type WriteConcernSettings,
  type WriteError,
} from "mongodb";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { splitNamespace } from "../mongo/index.ts";
import type { BackupSelector, DecryptionOptions, SourceOptions } from "../types.ts";
import type { RestoreContext } from "./context.ts";
import { compileFilter } from "./filter.ts";
import {
  type MatchedDocument,
  matchingDocuments,
  type OpenedNamespace,
  openNamespace,
} from "./find.ts";
import { readMetadataFile } from "./read-pipeline.ts";
import { createNamespace, createOptionsFrom } from "./restore-collections.ts";
import { type BatchLimits, DEFAULT_BATCH_LIMITS } from "./restore-documents.ts";
import { prepareIndexSpecs, restoreIndexes } from "./restore-indexes.ts";
import { assertValidTargetNamespace } from "./restore-rename.ts";

/** How matching documents are written when their `_id` already exists in the target. */
export type RestoreDocumentsMode = "insert" | "upsert";

/** Options for `restoreDocuments`. */
export interface RestoreDocumentsOptions {
  /** Which backup: an id, `"latest"`, or `{ before: date }`. */
  readonly backup: BackupSelector;
  /** The backed-up namespace to read, `<database>.<collection>`. */
  readonly namespace: string;
  /** Which documents to restore (a MongoDB query filter; see filter.ts for the subset). */
  readonly filter: Document;
  /** Where to write, `<database>.<collection>`. Defaults to `namespace`. */
  readonly targetNamespace?: string;
  /** `"insert"` (default) skips documents whose `_id` exists; `"upsert"` replaces them. */
  readonly mode?: RestoreDocumentsMode;
  /**
   * Create the target collection (with the backed-up options and indexes) when it does
   * not exist. Defaults to false: a missing target is refused.
   */
  readonly createIfMissing?: boolean;
  /** Count what would be written, without writing. */
  readonly dryRun?: boolean;
  readonly decryption?: DecryptionOptions;
  readonly writeConcern?: WriteConcernSettings;
  /** Batch sizes for writes. Mainly for tests. */
  readonly batchLimits?: BatchLimits;
  readonly signal?: AbortSignal;
}

/** Options of `shield.restoreDocuments()`: `RestoreDocumentsOptions` plus where to connect. */
export interface ShieldRestoreDocumentsOptions extends RestoreDocumentsOptions {
  /** The deployment to write to. Defaults to the instance's `source`. */
  readonly to?: SourceOptions;
}

/** What `restoreDocuments` did (or, in a dry run, would do). */
export interface RestoreDocumentsResult {
  readonly backupId: string;
  /** The backed-up namespace that was searched. */
  readonly namespace: string;
  /** The namespace written to. */
  readonly targetNamespace: string;
  readonly mode: RestoreDocumentsMode;
  readonly dryRun: boolean;
  /** Documents in the backup that match the filter. */
  readonly matched: number;
  /** Matching documents written as new documents. */
  readonly inserted: number;
  /** Existing documents replaced by their backed-up version (upsert mode only). */
  readonly replaced: number;
  /** Matching documents not written because their `_id` exists (insert mode only). */
  readonly skipped: number;
  /** True when the target collection existed before the run. */
  readonly targetExisted: boolean;
  /** True when the target collection did not exist and was created (never in a dry run). */
  readonly createdCollection: boolean;
  readonly durationMs: number;
}

/** Duplicate key error: a document with this `_id` (or unique key) already exists. */
const DUPLICATE_KEY_CODE = 11000;

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/** Upserts and `_id` lookups match with the binary collation, whatever the collection's default. */
const BINARY_COLLATION = { locale: "simple" } as const;

/** What exists at the target namespace. */
export type TargetKind = "missing" | "collection" | "view" | "timeseries";

/** Running totals of one run (also kept per namespace by extras/tenant-restore.ts). */
export interface Counts {
  matched: number;
  inserted: number;
  replaced: number;
  skipped: number;
}

/**
 * Restores the documents of one backed-up namespace that match `filter`.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for a bad filter, mode or namespace, or
 *   a missing target without `createIfMissing`; `MS_RESTORE_CONFLICT` when the target
 *   is a view or a time series collection; `MS_PERMISSION_DENIED` / `MS_RESTORE_FAILED`
 *   for write failures; read-pipeline errors for damaged or locked backups; `MS_ABORTED`.
 */
export async function restoreDocuments(
  context: RestoreContext,
  options: RestoreDocumentsOptions,
): Promise<RestoreDocumentsResult> {
  const startedAt = performance.now();
  const mode = validateMode(options.mode);
  const matcher = compileFilter(options.filter);
  const targetNamespace = options.targetNamespace ?? options.namespace;
  assertValidTargetNamespace(targetNamespace);
  const dryRun = options.dryRun === true;

  // Everything that can be refused is checked before the first write.
  const opened = await openNamespace(context, options);
  const target = await inspectTarget(context.client, targetNamespace);
  assertUsableTarget(targetNamespace, target, options.createIfMissing === true);

  const { database, collection: collectionName } = splitNamespace(targetNamespace);
  const collection = context.client.db(database).collection(collectionName);
  const createdCollection = target === "missing" && !dryRun;
  if (createdCollection) await createTarget(context, opened, targetNamespace, options);

  const counts: Counts = { matched: 0, inserted: 0, replaced: 0, skipped: 0 };
  const writer: BatchWriter = {
    collection,
    mode,
    dryRun,
    targetExists: target !== "missing",
    options,
  };
  const limits = options.batchLimits ?? DEFAULT_BATCH_LIMITS;
  for await (const batch of batchMatches(
    matchingDocuments(opened, matcher, options.signal),
    limits,
  )) {
    throwIfAborted(options.signal);
    counts.matched += batch.length;
    await writeBatch(writer, batch, counts);
  }

  const result: RestoreDocumentsResult = {
    backupId: opened.manifest.id,
    namespace: options.namespace,
    targetNamespace,
    mode,
    dryRun,
    ...counts,
    targetExisted: target !== "missing",
    createdCollection,
    durationMs: Math.round(performance.now() - startedAt),
  };
  context.logger.info(dryRun ? "Dry run: nothing was written" : "Restored documents", {
    backupId: result.backupId,
    target: targetNamespace,
    matched: counts.matched,
    inserted: counts.inserted,
    replaced: counts.replaced,
    skipped: counts.skipped,
  });
  return result;
}

// ---------------------------------------------------------------------------
// The target
// ---------------------------------------------------------------------------

function validateMode(mode: string | undefined): RestoreDocumentsMode {
  if (mode === undefined || mode === "insert" || mode === "upsert") return mode ?? "insert";
  throw new MongoShieldError("MS_CONFIG_INVALID", `Unknown mode "${mode}".`, {
    hint: 'Use "insert" (keep existing documents) or "upsert" (replace them).',
  });
}

/** What the target namespace is (one listCollections). */
export async function inspectTarget(client: MongoClient, namespace: string): Promise<TargetKind> {
  const { database, collection } = splitNamespace(namespace);
  const infos = await client
    .db(database)
    .listCollections({ name: collection }, { nameOnly: true, authorizedCollections: true })
    .toArray();
  const info = infos[0];
  if (info === undefined) return "missing";
  if (info.type === "view" || info.type === "timeseries") return info.type;
  return "collection";
}

/** Refuses targets documents cannot (or should not) be merged into. */
export function assertUsableTarget(
  namespace: string,
  target: TargetKind,
  createIfMissing: boolean,
): void {
  if (target === "missing" && !createIfMissing) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The target collection ${namespace} does not exist.`,
      {
        hint: "Check the namespace, or allow creating it (createIfMissing: true / --create) with the backed-up options and indexes.",
      },
    );
  }
  if (target === "view") {
    throw new MongoShieldError(
      "MS_RESTORE_CONFLICT",
      `The target ${namespace} is a view; documents cannot be written to it.`,
      { hint: "Restore into the collection the view reads from, or into another namespace." },
    );
  }
  if (target === "timeseries") {
    throw new MongoShieldError(
      "MS_RESTORE_CONFLICT",
      `The target ${namespace} is a time series collection, which has no unique _id to merge documents on.`,
      {
        hint: "Restore into a new namespace (with createIfMissing / --create), or restore the whole collection with `mongoshield restore`.",
      },
    );
  }
}

/**
 * Creates a missing target like a full restore would: with the backed-up collection
 * options (validator, collation, time series, …), then its indexes, before any
 * document is written (so unique indexes hold from the start).
 */
export async function createTarget(
  context: RestoreContext,
  opened: OpenedNamespace,
  targetNamespace: string,
  options: Pick<RestoreDocumentsOptions, "signal" | "writeConcern">,
): Promise<void> {
  const metadata = await readMetadataFile(opened.source, opened.entry.metadata, {
    signal: options.signal,
  });
  const { database, collection } = splitNamespace(targetNamespace);
  const db = context.client.db(database);
  const createOptions = createOptionsFrom(metadata.options);
  try {
    await createNamespace(db, collection, createOptions, options.writeConcern);
    await restoreIndexes(db, collection, prepareIndexSpecs(metadata.indexes, createOptions), {
      writeConcern: options.writeConcern,
      keepConflictingTargetIndexes: false,
      logger: context.logger,
    });
  } catch (error) {
    throw toWriteError(targetNamespace, error);
  }
  context.logger.info("Created the target collection", { ns: targetNamespace });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Everything `writeBatch` needs. */
export interface BatchWriter {
  readonly collection: Collection;
  readonly mode: RestoreDocumentsMode;
  readonly dryRun: boolean;
  readonly targetExists: boolean;
  readonly options: Pick<RestoreDocumentsOptions, "writeConcern">;
}

/** Groups matching documents into batches bounded by count and raw bytes. */
export async function* batchMatches(
  matches: AsyncIterable<MatchedDocument>,
  limits: BatchLimits,
): AsyncGenerator<Document[]> {
  let batch: Document[] = [];
  let bytes = 0;
  for await (const match of matches) {
    if (batch.length > 0 && bytes + match.bytes > limits.maxBytes) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(match.document);
    bytes += match.bytes;
    if (batch.length >= limits.maxDocuments) {
      yield batch;
      batch = [];
      bytes = 0;
    }
  }
  if (batch.length > 0) yield batch;
}

/** Writes (or, in a dry run, counts) one batch and adds the outcome to `counts`. */
export async function writeBatch(
  writer: BatchWriter,
  documents: Document[],
  counts: Counts,
): Promise<void> {
  const namespace = writer.collection.namespace;
  try {
    if (writer.dryRun) {
      const existing = writer.targetExists ? await countExisting(writer.collection, documents) : 0;
      if (writer.mode === "upsert") counts.replaced += existing;
      else counts.skipped += existing;
      counts.inserted += documents.length - existing;
    } else if (writer.mode === "upsert") {
      await upsertBatch(writer, documents, counts);
    } else {
      await insertBatch(writer, documents, counts);
    }
  } catch (error) {
    throw toWriteError(namespace, error);
  }
}

/** How many of the documents' `_id`s already exist in the target. */
async function countExisting(
  collection: Collection,
  documents: readonly Document[],
): Promise<number> {
  const ids = documents
    .filter((document) => document._id !== undefined)
    .map((document) => document._id);
  if (ids.length === 0) return 0;
  return collection.countDocuments({ _id: { $in: ids } }, { collation: BINARY_COLLATION });
}

/** Common write options: unordered (keeps going past duplicates), write concern. */
function writeOptions(writer: BatchWriter) {
  const writeConcern = writer.options.writeConcern;
  return { ordered: false, ...(writeConcern ? { writeConcern } : {}) };
}

/**
 * Unordered insert; documents whose `_id` exists fail with a duplicate key error,
 * which is expected here and counted as skipped. `forceServerObjectId` keeps the
 * driver from adding an `_id` to a document that was backed up without one.
 */
async function insertBatch(
  writer: BatchWriter,
  documents: Document[],
  counts: Counts,
): Promise<void> {
  try {
    const result = await writer.collection.insertMany(documents, {
      ...writeOptions(writer),
      forceServerObjectId: true,
    });
    counts.inserted += result.insertedCount;
  } catch (error) {
    if (error instanceof MongoBulkWriteError && onlyDuplicates(error)) {
      counts.inserted += error.insertedCount;
      counts.skipped += documents.length - error.insertedCount;
      return;
    }
    throw error;
  }
}

/** Replaces each document by `_id`, inserting it when missing. */
async function upsertBatch(
  writer: BatchWriter,
  documents: Document[],
  counts: Counts,
): Promise<void> {
  const operations: AnyBulkWriteOperation[] = documents.map((document) =>
    document._id === undefined
      ? { insertOne: { document } }
      : {
          replaceOne: {
            filter: { _id: document._id },
            replacement: document,
            upsert: true,
            collation: BINARY_COLLATION,
          },
        },
  );
  const result = await writer.collection.bulkWrite(operations, writeOptions(writer));
  counts.replaced += result.matchedCount;
  counts.inserted += result.upsertedCount + result.insertedCount;
}

/** True when every write error is a duplicate key and the write concern was met. */
function onlyDuplicates(error: MongoBulkWriteError): boolean {
  if (error.result.getWriteConcernError() !== undefined) return false;
  const writeErrors: readonly WriteError[] = Array.isArray(error.writeErrors)
    ? error.writeErrors
    : [error.writeErrors];
  return writeErrors.length > 0 && writeErrors.every((item) => item.code === DUPLICATE_KEY_CODE);
}

/** Turns driver errors into MongoShieldErrors that name the target. */
export function toWriteError(namespace: string, error: unknown): unknown {
  if (isMongoShieldError(error)) return error;
  if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) {
    return new MongoShieldError(
      "MS_PERMISSION_DENIED",
      `The MongoDB user may not write to ${namespace}: ${error.message}`,
      { cause: error, hint: "Grant the `readWrite` role on the target database." },
    );
  }
  return new MongoShieldError(
    "MS_RESTORE_FAILED",
    `Writing documents to ${namespace} failed: ${error instanceof Error ? error.message : String(error)}`,
    {
      cause: error,
      hint: "Batches written before the failure stay written; fix the cause and run again (documents already restored are skipped in insert mode).",
    },
  );
}
