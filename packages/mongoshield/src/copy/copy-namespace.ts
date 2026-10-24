/**
 * Copying the pieces of one namespace: preparing the target collection, streaming a
 * selection of source documents into it, and recreating views.
 *
 *   source find(filter, raw) → raw BSON → batches → (note references, mask) → N insert workers
 *
 * Documents are read with `raw: true`, exactly like a backup reads them, and written
 * with restore's batch writer (`writeDocuments`), so BSON types survive untouched and
 * memory stays bounded by one batch per worker. Documents are only parsed because the
 * writer needs objects; masking happens on that parsed form, in place.
 *
 * Creating collections and building indexes reuse restore's helpers
 * (`restore-collections.ts`, `restore-indexes.ts`), so a copy recreates options,
 * validators, collations, time series and views exactly like a restore does.
 */

import {
  type Collection,
  type Db,
  type Document,
  type MongoClient,
  MongoServerError,
  type ReadPreferenceMode,
  type WriteConcernSettings,
} from "mongodb";
import {
  createNamespace,
  createOptionsFrom,
  dropNamespace,
  withViewSource,
} from "../engine/restore-collections.ts";
import { type LoadResult, type WriteMode, writeDocuments } from "../engine/restore-documents.ts";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import type { CollectionSpec } from "../mongo/index.ts";
import type { RestorePlanEntry } from "../types.ts";

/** Everything `copySelection` needs. */
export interface CopySelectionOptions {
  readonly source: MongoClient;
  readonly spec: CollectionSpec;
  /** Which source documents to copy (`{}` for all). */
  readonly filter: Document;
  readonly readPreference: ReadPreferenceMode;
  readonly target: Collection;
  readonly mode: WriteMode;
  readonly workers: number;
  readonly bypassDocumentValidation: boolean;
  readonly writeConcern: WriteConcernSettings | undefined;
  readonly signal: AbortSignal;
  /** Masks and notes references, per parsed batch. */
  readonly transformBatch: ((documents: Document[]) => Promise<Document[]>) | undefined;
  readonly onProgress: (documents: number, bytes: number) => void;
}

/**
 * Streams the source documents matching `filter` into the target collection.
 *
 * @throws MongoShieldError from the writer (`MS_RESTORE_FAILED`, `MS_PERMISSION_DENIED`,
 *   `MS_ABORTED`) or for a source read failure.
 */
export async function copySelection(options: CopySelectionOptions): Promise<LoadResult> {
  const { spec } = options;
  const cursor = options.source
    .db(spec.db)
    .collection(spec.name)
    .find(options.filter, { raw: true, readPreference: options.readPreference });
  try {
    return await writeDocuments({
      documents: rawDocuments(cursor, spec.ns),
      collection: options.target,
      mode: options.mode,
      workers: options.workers,
      bypassDocumentValidation: options.bypassDocumentValidation,
      writeConcern: options.writeConcern,
      signal: options.signal,
      transformBatch: options.transformBatch,
      onProgress: options.onProgress,
    });
  } catch (error) {
    throw toCopyError(spec.ns, "Copying documents of", error);
  } finally {
    // Releases the server-side cursor when the copy stopped early; a no-op otherwise.
    await cursor.close().catch(() => undefined);
  }
}

/**
 * The cursor's raw documents as Buffers. With `raw: true` the driver yields the BSON
 * bytes the server sent; the typings still say "document", so the type is checked.
 */
async function* rawDocuments(cursor: AsyncIterable<unknown>, ns: string): AsyncGenerator<Buffer> {
  for await (const document of cursor) {
    if (!(document instanceof Uint8Array)) {
      throw new MongoShieldError("MS_INTERNAL", `The driver returned a parsed document for ${ns}.`);
    }
    yield Buffer.isBuffer(document)
      ? document
      : Buffer.from(document.buffer, document.byteOffset, document.byteLength);
  }
}

/**
 * Drops and/or creates the target as the plan says, and returns the options the
 * target collection now has (they decide how index collations are recreated).
 */
export async function prepareTarget(
  db: Db,
  collection: string,
  spec: CollectionSpec,
  action: RestorePlanEntry["action"],
  writeConcern: WriteConcernSettings | undefined,
): Promise<Document> {
  const ns = `${db.databaseName}.${collection}`;
  try {
    if (action === "drop-and-create") await dropNamespace(db, collection, writeConcern);
    if (action === "create" || action === "drop-and-create") {
      const options = createOptionsFrom(spec.options);
      await createNamespace(db, collection, options, writeConcern);
      return options;
    }
    // insert / upsert into an existing collection: its own options are kept.
    const [info] = await db.listCollections({ name: collection }, { nameOnly: false }).toArray();
    const options: unknown = info?.options;
    return typeof options === "object" && options !== null ? { ...options } : {};
  } catch (error) {
    throw toCopyError(ns, "Creating", error);
  }
}

/** Recreates a view, reading from `viewOn` (already adjusted for renames). */
export async function createView(
  db: Db,
  name: string,
  spec: CollectionSpec,
  options: {
    readonly drop: boolean;
    readonly viewOn: string | undefined;
    readonly writeConcern: WriteConcernSettings | undefined;
  },
): Promise<void> {
  try {
    if (options.drop) await dropNamespace(db, name, options.writeConcern);
    const createOptions = createOptionsFrom(spec.options);
    await createNamespace(
      db,
      name,
      options.viewOn === undefined ? createOptions : withViewSource(createOptions, options.viewOn),
      options.writeConcern,
    );
  } catch (error) {
    throw toCopyError(`${db.databaseName}.${name}`, "Creating the view", error);
  }
}

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/**
 * Turns raw driver errors into MongoShieldErrors naming the namespace and the step.
 * MongoShieldErrors (from the writer, masking, aborts) pass through unchanged.
 */
export function toCopyError(ns: string, step: string, error: unknown): MongoShieldError {
  if (isMongoShieldError(error)) return error;
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) {
    return new MongoShieldError("MS_PERMISSION_DENIED", `${step} ${ns} was refused: ${reason}`, {
      cause: error,
      hint: "The source user needs the `backup` role (or find on the copied collections); the target user the `restore` or `readWrite` role.",
    });
  }
  return new MongoShieldError("MS_RESTORE_FAILED", `${step} ${ns} failed: ${reason}`, {
    cause: error,
  });
}
