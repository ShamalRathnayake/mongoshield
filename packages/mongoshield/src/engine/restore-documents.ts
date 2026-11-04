/**
 * Loading a collection's documents from its data files into the target.
 *
 *   data files (in order) → raw BSON documents → batches → N insert workers
 *
 * `writeDocuments` is the part after "raw BSON documents"; `copy` feeds it from a
 * source cursor instead of backup files, with a `transformBatch` that masks documents.
 *
 * - Batches are bounded by bytes AND count (`DEFAULT_BATCH_LIMITS`), so memory stays
 *   small whatever the document sizes, and each batch is one round trip.
 * - Workers pull batches from one shared iterator. The data files are only read as
 *   fast as workers take batches, so backpressure reaches all the way to storage.
 * - Documents are parsed with `LOSSLESS_DESERIALIZE_OPTIONS`, so every BSON type is
 *   written back exactly as it was backed up (Int32 stays Int32, -0.0 stays -0.0, …),
 *   and in stored field order: a document with integer-like field names ("0", "1"),
 *   which JavaScript objects would list first, is written as Maps in the order it was
 *   stored (src/format/field-order.ts). Other documents are written as parsed.
 * - Inserts are unordered (the server keeps going after a failed document, and can
 *   apply the batch in parallel) and bypass document validation when allowed: the
 *   documents were valid when they were written, even if the validator changed since.
 */

import {
  type AnyBulkWriteOperation,
  type Collection,
  type Document,
  MongoBulkWriteError,
  MongoServerError,
  type WriteConcernSettings,
  type WriteError,
} from "mongodb";
import { abortError, isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { documentId, inStoredOrder } from "../format/field-order.ts";
import type { StoredFile } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import { parseBackedUpDocument } from "./find-parse.ts";
import { mapWithConcurrency } from "./pool.ts";
import { openDocumentStream, type StoredBackupSource } from "./read-pipeline.ts";

/** Limits for one insert batch. */
export interface BatchLimits {
  /** Most documents per batch. */
  readonly maxDocuments: number;
  /** Most raw BSON bytes per batch (a single larger document still forms its own batch). */
  readonly maxBytes: number;
}

/**
 * 1000 documents keeps the per-batch JavaScript objects small (parsed documents take
 * several times their BSON size) while amortising round trips; it is also what
 * mongorestore uses. 8 MiB bounds batches of large documents, well under the
 * server's 48 MB message limit, so the driver never has to split a batch.
 */
export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  maxDocuments: 1000,
  maxBytes: 8 * 1024 * 1024,
};

/** Duplicate key error: a document with this `_id` (or unique key) already exists. */
const DUPLICATE_KEY_CODE = 11000;

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/**
 * The ordinary documents of a collection have unique `_id`s, but a collection may
 * have a default collation under which two different string `_id`s compare equal.
 * Upserts match on `_id` with the simple (binary) collation so a document only ever
 * replaces the document with exactly its own `_id`.
 */
const BINARY_COLLATION = { locale: "simple" } as const;

/** How documents are written. */
export type WriteMode =
  /** Into a new, empty collection: every failure is an error. */
  | "insert-new"
  /** Into an existing collection: documents whose `_id` exists are skipped. */
  | "insert-skip-duplicates"
  /** Into an existing collection: documents replace the one with the same `_id`. */
  | "upsert";

/**
 * Everything `writeDocuments` needs: raw BSON documents from any source (a backup's
 * data files for restore, a source cursor for copy) and where to write them.
 */
export interface WriteDocumentsOptions {
  /** Raw BSON documents, one Buffer each. Read only as fast as workers take batches. */
  readonly documents: AsyncIterable<Buffer>;
  readonly collection: Collection;
  readonly mode: WriteMode;
  /** Parallel insert workers for this collection. */
  readonly workers: number;
  readonly bypassDocumentValidation: boolean;
  readonly writeConcern?: WriteConcernSettings | undefined;
  readonly batchLimits?: BatchLimits | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Called after every written batch with the running totals. */
  readonly onProgress?: ((documents: number, bytes: number) => void) | undefined;
  /**
   * Changes each parsed batch before it is written (copy uses it to mask documents
   * and to note references for subsetting). May modify the documents in place.
   */
  readonly transformBatch?: ((documents: Document[]) => Promise<Document[]>) | undefined;
  /**
   * Where to warn when `insert-skip-duplicates` skipped documents on duplicate key
   * errors that name no index (MongoDB-compatible engines; see classifyDuplicateKey).
   */
  readonly logger?: Logger | undefined;
}

/** Everything `loadDocuments` needs. */
export interface LoadDocumentsOptions extends Omit<WriteDocumentsOptions, "documents"> {
  readonly source: StoredBackupSource;
  /** Data parts in order, from the manifest. */
  readonly files: readonly StoredFile[];
}

/** What `loadDocuments` wrote. */
export interface LoadResult {
  /** Documents now in the target from this backup (inserted, or upserted/replaced). */
  readonly documents: number;
  /** Documents read from the backup (including skipped duplicates). */
  readonly documentsRead: number;
  /**
   * Documents not written because a document with the same `_id` was already in the
   * target (`insert-skip-duplicates` only). Not part of `documents`.
   */
  readonly duplicatesSkipped: number;
  /** Raw BSON bytes read from the backup. */
  readonly bytes: number;
}

/**
 * Streams every document of the given data files into `collection`.
 *
 * @throws MongoShieldError `MS_RESTORE_FAILED` for write errors, `MS_PERMISSION_DENIED`
 *   when the server refuses the write, read-pipeline errors (`MS_INTEGRITY_FAILED`, …)
 *   for damaged files, `MS_ABORTED` on abort. Workers already running finish their
 *   current batch before the error is thrown, so nothing writes after the call returns.
 */
export async function loadDocuments(options: LoadDocumentsOptions): Promise<LoadResult> {
  const { source, files, ...rest } = options;
  return writeDocuments({ ...rest, documents: readAllParts(source, files, options.signal) });
}

/**
 * Writes raw documents into `collection`: batches → (transform) → N insert workers.
 * The shared core of `loadDocuments` (restore) and `copy`.
 *
 * @throws as `loadDocuments`.
 */
export async function writeDocuments(options: WriteDocumentsOptions): Promise<LoadResult> {
  const batches = batchDocuments(options.documents, options.batchLimits ?? DEFAULT_BATCH_LIMITS);
  let documents = 0;
  let documentsRead = 0;
  let duplicatesSkipped = 0;
  let duplicatesUnattributed = 0;
  let bytes = 0;

  /** One insert worker: takes the next batch until there are none left. */
  const worker = async (_lane: number, _index: number, signal: AbortSignal): Promise<void> => {
    for (;;) {
      if (signal.aborted) throw abortError(signal);
      const next = await batches.next();
      if (next.done === true) return;
      const batch = next.value;
      const parsed = parseBatch(batch.documents);
      const transformed = options.transformBatch ? await options.transformBatch(parsed) : parsed;
      const outcome = await writeBatch(options, transformed);
      documents += outcome.written;
      duplicatesSkipped += outcome.skipped;
      duplicatesUnattributed += outcome.unattributed;
      documentsRead += batch.documents.length;
      bytes += batch.bytes;
      options.onProgress?.(documents, bytes);
    }
  };

  const lanes = Array.from({ length: Math.max(1, options.workers) }, (_, lane) => lane);
  try {
    await mapWithConcurrency(lanes, worker, {
      concurrency: lanes.length,
      signal: options.signal,
    });
  } finally {
    // Closes the data file streams when a worker failed before reading everything.
    await batches.return(undefined);
    // Once per collection, also when the load failed later on.
    if (duplicatesUnattributed > 0) warnUnattributedDuplicates(options, duplicatesUnattributed);
  }
  return { documents, documentsRead, duplicatesSkipped, bytes };
}

// ---------------------------------------------------------------------------
// Reading and batching
// ---------------------------------------------------------------------------

/** A batch of raw documents and their total size. */
export interface RawBatch {
  readonly documents: Buffer[];
  readonly bytes: number;
}

/** Yields the raw documents of every part, one part after the other. */
async function* readAllParts(
  source: StoredBackupSource,
  files: readonly StoredFile[],
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer> {
  for (const file of files) {
    for await (const document of openDocumentStream(source, file, { signal })) {
      yield document as Buffer;
    }
  }
}

/**
 * Groups documents into batches bounded by `limits`. A batch is closed before a
 * document that would push it over `maxBytes`, so a batch exceeds the byte limit
 * only when it holds a single document larger than the limit.
 */
export async function* batchDocuments(
  documents: AsyncIterable<Buffer>,
  limits: BatchLimits,
): AsyncGenerator<RawBatch, void, undefined> {
  let batch: Buffer[] = [];
  let bytes = 0;
  for await (const document of documents) {
    const wouldOverflow = batch.length > 0 && bytes + document.length > limits.maxBytes;
    if (wouldOverflow) {
      yield { documents: batch, bytes };
      batch = [];
      bytes = 0;
    }
    batch.push(document);
    bytes += document.length;
    if (batch.length >= limits.maxDocuments) {
      yield { documents: batch, bytes };
      batch = [];
      bytes = 0;
    }
  }
  if (batch.length > 0) yield { documents: batch, bytes };
}

/**
 * Parses raw documents losslessly, recording the stored field order of the rare
 * documents JavaScript would reorder. A document that does not parse means a
 * damaged file (`MS_INTEGRITY_FAILED`).
 */
function parseBatch(raw: readonly Buffer[]): Document[] {
  const parsed: Document[] = [];
  for (const bytes of raw) parsed.push(parseBackedUpDocument(bytes));
  return parsed;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** What one written batch did. */
interface BatchOutcome {
  /** Documents stored (inserted, or upserted/replaced). */
  readonly written: number;
  /** Documents skipped because their `_id` was already in the target. */
  readonly skipped: number;
  /** Of `skipped`: duplicate key errors that did not say which index (see classifyDuplicateKey). */
  readonly unattributed: number;
}

/** Writes one batch in the requested mode and returns what it stored and skipped. */
async function writeBatch(
  options: WriteDocumentsOptions,
  documents: Document[],
): Promise<BatchOutcome> {
  throwIfAborted(options.signal);
  // A transform may leave nothing to write; the driver rejects empty batches.
  if (documents.length === 0) return { written: 0, skipped: 0, unattributed: 0 };
  // After the transform (which reads and masks plain objects), so masked values are
  // written in stored order too.
  const ordered = documents.map((document) => inStoredOrder(document));
  try {
    if (options.mode === "upsert")
      return { written: await upsertBatch(options, ordered), skipped: 0, unattributed: 0 };
    return await insertBatch(options, ordered);
  } catch (error) {
    throw toWriteError(options.collection, error);
  }
}

/** Common write options: unordered, validation bypass, write concern. */
function writeOptions(options: WriteDocumentsOptions) {
  return {
    ordered: false,
    bypassDocumentValidation: options.bypassDocumentValidation,
    ...(options.writeConcern ? { writeConcern: options.writeConcern } : {}),
  };
}

/**
 * Unordered insertMany. `forceServerObjectId` stops the driver from adding an `_id`
 * to documents that have none, so documents are restored exactly as backed up.
 * In `insert-skip-duplicates` mode, duplicate `_id` errors are expected and the
 * documents skipped (and counted as such), and ONLY those: a duplicate on another
 * unique index, or any other write error, still fails the restore.
 */
async function insertBatch(
  options: WriteDocumentsOptions,
  documents: Document[],
): Promise<BatchOutcome> {
  try {
    const result = await options.collection.insertMany(documents, {
      ...writeOptions(options),
      forceServerObjectId: true,
    });
    return { written: result.insertedCount, skipped: 0, unattributed: 0 };
  } catch (error) {
    const duplicates =
      options.mode === "insert-skip-duplicates" ? duplicateIdErrorsOnly(error) : undefined;
    if (duplicates !== undefined && error instanceof MongoBulkWriteError) {
      const unattributed = duplicates.filter(
        (item) => classifyDuplicateKey(item) === "unattributed",
      ).length;
      return { written: error.insertedCount, skipped: duplicates.length, unattributed };
    }
    throw error;
  }
}

/**
 * Replaces each document by `_id`, inserting it when missing. Documents may be Maps
 * (see `inStoredOrder`), so the `_id` is read with `documentId`; it is then in stored
 * order itself, which the filter needs to match an embedded-document `_id`.
 */
async function upsertBatch(options: WriteDocumentsOptions, documents: Document[]): Promise<number> {
  const operations: AnyBulkWriteOperation[] = documents.map((document) => {
    const id = documentId(document);
    const filter: Document = { _id: id };
    return id === undefined
      ? { insertOne: { document } }
      : {
          replaceOne: {
            filter,
            replacement: document,
            upsert: true,
            collation: BINARY_COLLATION,
          },
        };
  });
  const result = await options.collection.bulkWrite(operations, writeOptions(options));
  // matched = replaced (even when identical), upserted = newly inserted.
  return result.matchedCount + result.upsertedCount + result.insertedCount;
}

/**
 * The write errors of a failed insert batch when every one of them is a duplicate
 * `_id` (see {@link isDuplicateIdError}) and the write concern was met; `undefined`
 * when anything else went wrong, which must fail the restore.
 */
export function duplicateIdErrorsOnly(error: unknown): readonly WriteError[] | undefined {
  if (!(error instanceof MongoBulkWriteError)) return undefined;
  if (error.result.getWriteConcernError() !== undefined) return undefined;
  const writeErrors = asArray(error.writeErrors);
  if (writeErrors.length === 0 || !writeErrors.every(isDuplicateIdError)) return undefined;
  return writeErrors;
}

/**
 * True for a duplicate key error (E11000) on the `_id` index, and only there, as far
 * as can be told: see {@link classifyDuplicateKey}. An error that does not say which
 * index it hit (`"unattributed"`) also counts, as it did before indexes were told apart.
 */
export function isDuplicateIdError(item: DuplicateKeyErrorShape): boolean {
  const kind = classifyDuplicateKey(item);
  return kind === "id" || kind === "unattributed";
}

/**
 * The parts of a write error that tell which index a duplicate key hit: the code and
 * message the driver keeps, and the server's `keyPattern` / `keyValue` where they
 * survive (on a MongoServerError, or on the raw `err` record of a WriteError).
 */
export interface DuplicateKeyErrorShape {
  readonly code: number;
  readonly errmsg?: string | undefined;
  /** The unique index's key, e.g. `{ _id: 1 }` (absent from the driver's WriteError). */
  readonly keyPattern?: unknown;
  /** The duplicate value by field, e.g. `{ _id: 7 }` (absent from the driver's WriteError). */
  readonly keyValue?: unknown;
}

/**
 * Which index a duplicate key error is about:
 * - `"id"`: the `_id` index (or a clustered collection's `_id`);
 * - `"other-index"`: any other unique index;
 * - `"unattributed"`: a duplicate key error that does not say;
 * - `undefined`: not a duplicate key error at all.
 *
 * "Skip documents whose `_id` exists" must not swallow a collision on any other unique
 * index (a `username` index the application created before the restore): that
 * document's `_id` is NOT in the target, so skipping it would lose it silently.
 *
 * Read in order of reliability:
 * 1. `keyPattern` (or else `keyValue`), the structured fields modern servers send:
 *    an `_id`-only key is the `_id` index. The driver drops them from bulk write
 *    errors, but keeps them on a MongoServerError and may pass them on one day.
 * 2. The index name in the message (`index: _id_` is always the `_id` index; no
 *    other index can take that name):
 *      E11000 duplicate key error collection: app.users index: _id_ dup key: { _id: 1 }
 *      E11000 duplicate key error collection: app.users index: username_1 dup key: { … }
 * 3. Without an index name, the duplicate key itself, as clustered collections (whose
 *    `_id` is the clustered key and has no index) report it:
 *      E11000 duplicate key error collection: app.events dup key: { _id: 1 } found value: …
 * 4. Nothing of that: MongoDB-compatible engines (Azure Cosmos DB, Amazon DocumentDB,
 *    FerretDB) word the error their own way, for example "E11000 duplicate key error
 *    collection: app.users Failed _id or unique index constraint". Such errors are
 *    `"unattributed"`: skip-duplicates treats them as duplicate `_id`s (as it always
 *    did) but counts them and warns once per collection (see writeDocuments).
 */
export function classifyDuplicateKey(
  item: DuplicateKeyErrorShape,
): "id" | "other-index" | "unattributed" | undefined {
  if (item.code !== DUPLICATE_KEY_CODE) return undefined;
  const structured = structuredKeyFields(item);
  if (structured !== undefined) return isIdOnly(structured) ? "id" : "other-index";

  const message = item.errmsg ?? "";
  const index = INDEX_NAME.exec(message)?.[1];
  if (index !== undefined) return index === ID_INDEX_NAME ? "id" : "other-index";

  const firstKeyField = DUP_KEY_FIRST_FIELD.exec(message)?.[1];
  if (firstKeyField !== undefined) return firstKeyField === "_id" ? "id" : "other-index";
  return "unattributed";
}

/** The name MongoDB always gives the `_id` index. */
const ID_INDEX_NAME = "_id_";

/** `index: <name>` in an E11000 message: the index the duplicate hit. */
const INDEX_NAME = /\bindex: ([^\s]+)/;

/** `dup key: { <field>:` in an E11000 message: the first field of the duplicate key. */
const DUP_KEY_FIRST_FIELD = /\bdup key: \{\s*"?([^\s:"]+)"?\s*:/;

/**
 * The field names of the error's `keyPattern` (preferred) or `keyValue`, looked for on
 * the error itself and on a WriteError's raw `err` record; `undefined` when neither is
 * a document.
 */
function structuredKeyFields(item: DuplicateKeyErrorShape): string[] | undefined {
  const raw: unknown = Reflect.get(item, "err");
  for (const field of ["keyPattern", "keyValue"]) {
    for (const source of [item, raw]) {
      if (typeof source !== "object" || source === null) continue;
      const value: unknown = Reflect.get(source, field);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return Object.keys(value);
      }
    }
  }
  return undefined;
}

/** True for the key fields of the `_id` index: exactly `["_id"]`. */
function isIdOnly(fields: readonly string[]): boolean {
  return fields.length === 1 && fields[0] === "_id";
}

/** Warns, once per collection, about duplicates skipped without knowing their index. */
function warnUnattributedDuplicates(options: WriteDocumentsOptions, count: number): void {
  options.logger?.warn(
    "Skipped documents on duplicate key errors that do not name the index; they were taken as duplicate _ids. On a MongoDB-compatible engine, check that no other unique index caused them",
    { ns: options.collection.namespace, documents: count },
  );
}

/** The driver reports one write error as an object and several as an array. */
function asArray(errors: WriteError | readonly WriteError[]): readonly WriteError[] {
  return isWriteErrorList(errors) ? errors : [errors];
}

function isWriteErrorList(
  errors: WriteError | readonly WriteError[],
): errors is readonly WriteError[] {
  return Array.isArray(errors);
}

/** Turns driver errors into MongoShieldErrors that say which namespace failed. */
function toWriteError(collection: Collection, error: unknown): unknown {
  if (isMongoShieldError(error)) return error;
  const ns = collection.namespace;
  if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) {
    return new MongoShieldError(
      "MS_PERMISSION_DENIED",
      `The MongoDB user may not write to ${ns}: ${error.message}`,
      {
        cause: error,
        hint: "Grant the built-in `restore` role (or `readWrite` on the target for insert/upsert modes).",
      },
    );
  }
  return new MongoShieldError(
    "MS_RESTORE_FAILED",
    `Writing documents to ${ns} failed: ${describeWriteFailure(error)}`,
    {
      cause: error,
      hint: "The namespace may be partially restored. Fix the cause and restore it again with --drop.",
    },
  );
}

/** The first real write error of a bulk failure, or the error message. */
function describeWriteFailure(error: unknown): string {
  if (error instanceof MongoBulkWriteError) {
    // Duplicate `_id`s are expected in some modes; the first OTHER error explains more
    // (a duplicate on another unique index names that index).
    const first = asArray(error.writeErrors).find((item) => !isDuplicateIdError(item));
    if (first !== undefined) return `${first.errmsg ?? "write error"} (code ${first.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}
