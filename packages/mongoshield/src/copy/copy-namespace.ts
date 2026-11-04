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
 * Checkpointed copies (`copy-checkpoint.ts`) read each part in `_id` order through the
 * `_id` index between index bounds, exactly like a backup's parts (`backup-parts.ts`
 * explains why bounds and not `$gte`/`$lt`), and write it in CHUNKS: after a chunk's
 * writes have all completed, its last `_id` is reported, and a resumed copy continues
 * from there. Insert workers write batches in parallel and out of order, so only a
 * whole chunk tells which documents are certainly written.
 *
 * Creating collections and building indexes reuse restore's helpers
 * (`restore-collections.ts`, `restore-indexes.ts`), so a copy recreates options,
 * validators, collations, time series and views exactly like a restore does. With a
 * mask, definitions that refer to masked fields (a validator's `$in` list, a partial
 * index filter, a view's `$match`) are copied as they are, values included; the copy
 * warns about each one before writing (`warnAboutMaskedDefinitions`).
 */

import {
  type Collection,
  type Db,
  type Document,
  type FindOptions,
  type MongoClient,
  MongoServerError,
  type ReadPreferenceMode,
  type WriteConcernSettings,
} from "mongodb";
import { ID_INDEX, type PartBound } from "../engine/backup-parts.ts";
import {
  createNamespace,
  createOptionsFrom,
  dropNamespace,
  withViewSource,
} from "../engine/restore-collections.ts";
import { type LoadResult, type WriteMode, writeDocuments } from "../engine/restore-documents.ts";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { deserializeInStoredOrder, valueInStoredOrder } from "../format/field-order.ts";
import type { Logger } from "../logger.ts";
import type { Mask } from "../mask/index.ts";
import type { CollectionSpec } from "../mongo/index.ts";
import type { RestorePlanEntry } from "../types.ts";

/**
 * How a selection is read. `ordered: false` is a plain query in natural order;
 * `ordered: true` reads in `_id` order, between the bounds when there are any.
 */
export interface SelectionReading {
  readonly ordered: boolean;
  /** Inclusive lower `_id` bound (a part's start, or where a resumed part continues). */
  readonly lower: PartBound;
  /** Exclusive upper `_id` bound. */
  readonly upper: PartBound;
}

/** Reads everything matching the filter, in natural order. */
export const UNORDERED_READING: SelectionReading = {
  ordered: false,
  lower: undefined,
  upper: undefined,
};

/**
 * Documents per checkpointed chunk, and bytes. Large enough that the short pause at
 * each chunk end (the workers finish their batches) costs little; small enough that
 * a resumed copy repeats little work.
 */
export const CHECKPOINT_CHUNK = { documents: 10_000, bytes: 64 * 1024 * 1024 } as const;

/** Everything `copySelection` needs. */
export interface CopySelectionOptions {
  readonly source: MongoClient;
  readonly spec: CollectionSpec;
  /** Which source documents to copy (`{}` for all). */
  readonly filter: Document;
  readonly reading: SelectionReading;
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
  /**
   * Called with the `_id` (exact BSON type) of the last document of every chunk once
   * the whole chunk is written. Given only for ordered readings; without it, the
   * selection is written in one go.
   */
  readonly onChunkWritten?: ((lastId: unknown) => void) | undefined;
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
    .find(options.filter, {
      raw: true,
      readPreference: options.readPreference,
      ...findOptionsFor(options.reading, options.filter),
    });
  try {
    const documents = rawDocuments(cursor, spec.ns);
    const onChunkWritten = options.onChunkWritten;
    if (onChunkWritten === undefined) return await writeAll(options, documents);
    return await writeInChunks(options, documents, onChunkWritten);
  } catch (error) {
    throw toCopyError(spec.ns, "Copying documents of", error);
  } finally {
    // Releases the server-side cursor when the copy stopped early; a no-op otherwise.
    await cursor.close().catch(() => undefined);
  }
}

/** Writes every document in one `writeDocuments` call. */
function writeAll(
  options: CopySelectionOptions,
  documents: AsyncIterable<Buffer>,
  onProgress: (documents: number, bytes: number) => void = options.onProgress,
): Promise<LoadResult> {
  return writeDocuments({
    documents,
    collection: options.target,
    mode: options.mode,
    workers: options.workers,
    bypassDocumentValidation: options.bypassDocumentValidation,
    writeConcern: options.writeConcern,
    signal: options.signal,
    transformBatch: options.transformBatch,
    onProgress,
  });
}

/**
 * Writes chunk after chunk of `CHECKPOINT_CHUNK` documents (see the file header), and
 * reports each chunk's last `_id` after all of its documents are written.
 */
async function writeInChunks(
  options: CopySelectionOptions,
  documents: AsyncIterable<Buffer>,
  onChunkWritten: (lastId: unknown) => void,
): Promise<LoadResult> {
  const iterator = documents[Symbol.asyncIterator]();
  const totals = { documents: 0, documentsRead: 0, duplicatesSkipped: 0, bytes: 0 };
  let exhausted = false;
  while (!exhausted) {
    let last: Buffer | undefined;
    let count = 0;
    let bytes = 0;
    // One chunk: the next documents of the shared cursor, until the chunk is full.
    // `next()` (not for-await) so ending a chunk does not close the cursor.
    const chunk = async function* (): AsyncGenerator<Buffer> {
      while (count < CHECKPOINT_CHUNK.documents && bytes < CHECKPOINT_CHUNK.bytes) {
        const next = await iterator.next();
        if (next.done === true) {
          exhausted = true;
          return;
        }
        count += 1;
        bytes += next.value.length;
        last = next.value;
        yield next.value;
      }
    };
    const before = { ...totals };
    const result = await writeAll(options, chunk(), (written, writtenBytes) =>
      options.onProgress(before.documents + written, before.bytes + writtenBytes),
    );
    totals.documents += result.documents;
    totals.documentsRead += result.documentsRead;
    totals.duplicatesSkipped += result.duplicatesSkipped;
    totals.bytes += result.bytes;
    if (last !== undefined) onChunkWritten(idOfRawDocument(last));
  }
  return totals;
}

/**
 * The `_id` of a raw BSON document, in its exact BSON type and stored field order (it
 * becomes the bound a resumed copy continues from; see backup-parts.ts).
 */
function idOfRawDocument(raw: Buffer): unknown {
  return deserializeInStoredOrder(raw)._id;
}

/** Everything `collectSelection` needs. */
export interface CollectSelectionOptions {
  readonly source: MongoClient;
  readonly spec: CollectionSpec;
  readonly filter: Document;
  readonly reading: SelectionReading;
  readonly readPreference: ReadPreferenceMode;
  readonly signal: AbortSignal;
  /** Documents per call of `onBatch`. */
  readonly batchSize: number;
  readonly onBatch: (documents: Document[]) => Promise<void>;
}

/**
 * Reads a selection WITHOUT writing it, handing parsed documents to `onBatch` in
 * batches. A resumed copy uses it to note the references of documents the
 * interrupted run already copied (the reference sets do not survive a failure).
 *
 * @throws MongoShieldError for a source read failure, `MS_ABORTED`.
 */
export async function collectSelection(options: CollectSelectionOptions): Promise<void> {
  const { spec } = options;
  const cursor = options.source
    .db(spec.db)
    .collection(spec.name)
    .find(options.filter, {
      // Raw, then parsed losslessly with the stored field order recorded, as the
      // copy's write path parses them: the noted references (embedded documents
      // among them) must be the stored values, to find the documents they name.
      raw: true,
      readPreference: options.readPreference,
      ...findOptionsFor(options.reading, options.filter),
    });
  try {
    let batch: Document[] = [];
    for await (const raw of rawDocuments(cursor, spec.ns)) {
      batch.push(deserializeInStoredOrder(raw));
      if (batch.length >= options.batchSize) {
        throwIfAborted(options.signal);
        await options.onBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await options.onBatch(batch);
  } catch (error) {
    throw toCopyError(spec.ns, "Reading the copied documents of", error);
  } finally {
    await cursor.close().catch(() => undefined);
  }
}

/**
 * The find options of a reading. Ordered readings sort by `_id`; bounds need the
 * `_id` index as a hint (`min`/`max` are index bounds). An ordered read of a whole
 * collection uses the hint too, so it walks the `_id` index instead of sorting.
 * A filtered read without bounds lets the planner choose: an index on the filtered
 * fields usually beats walking every `_id`.
 */
function findOptionsFor(reading: SelectionReading, filter: Document): FindOptions {
  if (!reading.ordered) return {};
  const bounded = reading.lower !== undefined || reading.upper !== undefined;
  const useIdIndex = bounded || Object.keys(filter).length === 0;
  return {
    sort: ID_INDEX,
    ...(useIdIndex ? { hint: ID_INDEX } : {}),
    // Sorting a filter's matches may need more than the in-memory sort limit.
    ...(useIdIndex ? {} : { allowDiskUse: true }),
    // In stored field order: an embedded-document bound with integer-like names is
    // another value in JavaScript order (see backup-parts.ts).
    ...(reading.lower === undefined
      ? {}
      : { min: { _id: valueInStoredOrder(reading.lower.value) } }),
    ...(reading.upper === undefined
      ? {}
      : { max: { _id: valueInStoredOrder(reading.upper.value) } }),
  };
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

// ---------------------------------------------------------------------------
// Masked copies: definitions that may hold unmasked values
// ---------------------------------------------------------------------------

/** Where a collection's definition can quote field values. */
export interface MaskedDefinitionWarning {
  /** The source namespace whose definition is copied. */
  readonly ns: string;
  /** `validator`, `index <name> (partialFilterExpression)` or `view pipeline`. */
  readonly where: string;
  /** The masked field paths it refers to. */
  readonly fields: readonly string[];
}

/**
 * The definitions a masked copy carries over that refer to masked fields.
 *
 * Masking rewrites documents, but a copy recreates each collection's definition as
 * the source has it: a validator (`{ email: { $in: ["ceo@acme.com", …] } }`), a
 * partial index's `partialFilterExpression`, or a view's pipeline (`$match` on a
 * customer's name) can quote the very values the mask hides, in clear text, in the
 * staging database. The definitions are still copied (dropping a validator or a view
 * changes behaviour); this lists them so the copy can warn. A view is checked against
 * the rules of its source collection as well as its own.
 */
export function maskedDefinitionWarnings(
  spec: CollectionSpec,
  masksOf: (ns: string) => readonly string[],
): MaskedDefinitionWarning[] {
  const ownPaths = masksOf(spec.ns);
  const warnings: MaskedDefinitionWarning[] = [];
  const check = (where: string, expression: unknown, paths: readonly string[]): void => {
    if (expression === undefined || paths.length === 0) return;
    const fields = maskedFieldsIn(expression, paths);
    if (fields.length > 0) warnings.push({ ns: spec.ns, where, fields });
  };

  check("validator", spec.options.validator, ownPaths);
  for (const index of spec.indexes) {
    const name = typeof index.name === "string" ? index.name : "?";
    check(`index ${name} (partialFilterExpression)`, index.partialFilterExpression, ownPaths);
  }
  if (spec.type === "view") {
    const viewOn = spec.options.viewOn;
    const sourcePaths = typeof viewOn === "string" ? masksOf(`${spec.db}.${viewOn}`) : [];
    check("view pipeline", spec.options.pipeline, [...new Set([...ownPaths, ...sourcePaths])]);
  }
  return warnings;
}

/**
 * Logs a warning for every copied definition that refers to a masked field (see
 * {@link maskedDefinitionWarnings}), before anything is written.
 */
export function warnAboutMaskedDefinitions(
  namespaces: readonly { readonly spec: CollectionSpec }[],
  mask: Mask,
  logger: Logger,
): void {
  const masksOf = (ns: string): readonly string[] => mask.forNamespace(ns)?.paths ?? [];
  for (const { spec } of namespaces) {
    for (const warning of maskedDefinitionWarnings(spec, masksOf)) {
      logger.warn(
        `The ${warning.where} of ${warning.ns} refers to masked ${warning.fields.length === 1 ? "field" : "fields"} ${warning.fields.join(", ")}: it is copied as defined, so any values it quotes reach the target unmasked. Review it on the target, or leave the namespace out.`,
        { ns: warning.ns, where: warning.where, fields: warning.fields },
      );
    }
  }
}

/** The masked paths (as written in the rules) that `expression` refers to. */
function maskedFieldsIn(expression: unknown, maskedPaths: readonly string[]): string[] {
  const references = new Set<string>();
  collectFieldReferences(expression, "", references);
  const found: string[] = [];
  for (const masked of maskedPaths) {
    const target = plainPath(masked);
    for (const reference of references) {
      const ref = plainPath(reference);
      // The same field, a part of it, or a document that contains it.
      if (ref === target || ref.startsWith(`${target}.`) || target.startsWith(`${ref}.`)) {
        found.push(masked);
        break;
      }
    }
  }
  return found;
}

/**
 * Every field a query, validator or pipeline names: dotted keys outside operators
 * (`{ "profile.email": … }`), `$jsonSchema` property names (`properties: { email }`),
 * and aggregation field paths (`"$email"`, not `"$$variables"`). A walk over plain
 * values, bounded by the definition's size.
 */
function collectFieldReferences(node: unknown, prefix: string, into: Set<string>): void {
  if (typeof node === "string") {
    if (node.startsWith("$") && !node.startsWith("$$") && node.length > 1) {
      into.add(node.slice(1));
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const element of node) collectFieldReferences(element, prefix, into);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      // $jsonSchema: each property is a field one level down.
      for (const [name, schema] of Object.entries(value)) {
        into.add(`${prefix}${name}`);
        collectFieldReferences(schema, `${prefix}${name}.`, into);
      }
    } else if (key.startsWith("$")) {
      collectFieldReferences(value, prefix, into);
    } else {
      into.add(`${prefix}${key}`);
      collectFieldReferences(value, `${prefix}${key}.`, into);
    }
  }
}

/** `addresses.*.street` / `addresses.0.street` → `addresses.street`: array steps dropped. */
function plainPath(path: string): string {
  return path
    .split(".")
    .filter((segment) => segment !== "*" && !/^\d+$/.test(segment))
    .join(".");
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
