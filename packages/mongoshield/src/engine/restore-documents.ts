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
      const written = await writeBatch(options, transformed);
      documents += written;
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
  }
  return { documents, documentsRead, bytes };
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

/** Writes one batch in the requested mode and returns how many documents it stored. */
async function writeBatch(options: WriteDocumentsOptions, documents: Document[]): Promise<number> {
  throwIfAborted(options.signal);
  // A transform may leave nothing to write; the driver rejects empty batches.
  if (documents.length === 0) return 0;
  // After the transform (which reads and masks plain objects), so masked values are
  // written in stored order too.
  const ordered = documents.map((document) => inStoredOrder(document));
  try {
    if (options.mode === "upsert") return await upsertBatch(options, ordered);
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
 * In `insert-skip-duplicates` mode, duplicate key errors (11000) are expected and
 * ignored, and ONLY those: any other write error still fails the restore.
 */
async function insertBatch(options: WriteDocumentsOptions, documents: Document[]): Promise<number> {
  try {
    const result = await options.collection.insertMany(documents, {
      ...writeOptions(options),
      forceServerObjectId: true,
    });
    return result.insertedCount;
  } catch (error) {
    const ignoreDuplicates = options.mode === "insert-skip-duplicates";
    if (ignoreDuplicates && error instanceof MongoBulkWriteError && onlyDuplicates(error)) {
      return error.insertedCount;
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

/** True when every write error is a duplicate key and the write concern was met. */
function onlyDuplicates(error: MongoBulkWriteError): boolean {
  if (error.result.getWriteConcernError() !== undefined) return false;
  const writeErrors = asArray(error.writeErrors);
  return writeErrors.length > 0 && writeErrors.every((item) => item.code === DUPLICATE_KEY_CODE);
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
    const first = asArray(error.writeErrors).find((item) => item.code !== DUPLICATE_KEY_CODE);
    if (first !== undefined) return `${first.errmsg ?? "write error"} (code ${first.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}
