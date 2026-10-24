/**
 * The checks a restore drill runs on each restored namespace, after the restore
 * itself succeeded (see drill.ts for the whole drill):
 *
 *   count     the restored collection holds as many documents as the manifest says
 *   indexes   every index in the backed-up metadata exists on the restored collection
 *   views     a backed-up view exists as a view
 *   sample    N documents picked at random from the backup are found in the restored
 *             collection by `_id`, byte for byte identical (optional). Time series
 *             measurements are looked up by `_id` and time and compared field by
 *             field, ignoring field order: the server rebuilds them from buckets
 *
 * The sample check catches what counts and checksums cannot: a backup whose files
 * are intact and whose counts add up, but whose documents do not survive a restore
 * unchanged (documents without `_id`, fields the server reorders, a restore bug).
 *
 * Converge backups replay the changes of the backup window after loading the
 * documents, so their restored contents legitimately differ from the documents as
 * read: for those, count differences are noted rather than reported as problems, and
 * no sample is compared.
 */

import { randomInt } from "node:crypto";
import { BSON, type Collection, type Document, type MongoClient } from "mongodb";
import { isMongoShieldError } from "../errors.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "../format/bson-stream.ts";
import { deserializeInStoredOrder, valueInStoredOrder } from "../format/field-order.ts";
import type { NamespaceEntry } from "../format/manifest.ts";
import type { CollectionMetadata } from "../format/metadata.ts";
import { splitNamespace } from "../mongo/index.ts";
import type { RestorePlanEntry } from "../types.ts";
import { openDocumentStream, readMetadataFile, type StoredBackupSource } from "./read-pipeline.ts";

/** What a drill found for one namespace. */
export interface DrillNamespaceReport {
  /** The namespace in the backup, e.g. `app.users`. */
  readonly ns: string;
  /** Where it was restored, e.g. `msdrill_1a2b3c4d_app.users`. */
  readonly target: string;
  readonly type: RestorePlanEntry["type"];
  /** Documents the manifest lists (0 for views). */
  readonly expectedDocuments: number;
  /** Documents in the restored collection (0 for views, which are not counted). */
  readonly restoredDocuments: number;
  /** Indexes in the backed-up metadata. */
  readonly indexesExpected: number;
  /** How many of those exist on the restored collection. */
  readonly indexesFound: number;
  /** Documents compared with the backup byte for byte (0 when sampling is off or skipped). */
  readonly sampled: number;
  /** True when no problems were found. */
  readonly ok: boolean;
  /** What is wrong, one sentence each. */
  readonly problems: readonly string[];
  /** Facts worth knowing that are not problems (e.g. why a check was relaxed). */
  readonly notes: readonly string[];
}

/** Everything the checks of one namespace need. */
export interface NamespaceCheckInput {
  readonly client: MongoClient;
  /** The opened backup (keys unlocked), to read metadata and sample documents. */
  readonly source: StoredBackupSource;
  /** The plan entry of the restore (source → target namespace). */
  readonly planned: RestorePlanEntry;
  /** The namespace's manifest entry (files, metadata, counts). */
  readonly entry: NamespaceEntry;
  /** Documents to compare with the backup; 0 turns the sample check off. */
  readonly sampleSize: number;
  /** True for converge backups with change events: counts and contents may differ. */
  readonly replayedChanges: boolean;
  readonly signal: AbortSignal | undefined;
}

/**
 * Sample problems listed per namespace. A systematic difference (say, every
 * document) would otherwise flood the report with identical lines.
 */
const MAX_SAMPLE_PROBLEMS = 5;

/**
 * Error codes that mean "the backup cannot be read back as written". During a
 * drill they are findings about the backup, reported as problems; every other
 * error (connection, permissions, abort, missing keys) is about the drill's setup
 * and is thrown.
 */
const BACKUP_DEFECT_CODES = new Set([
  "MS_INTEGRITY_FAILED",
  "MS_DECRYPTION_FAILED",
  "MS_FORMAT_UNSUPPORTED",
  "MS_MANIFEST_INVALID",
  "MS_RESTORE_FAILED",
  "MS_STORAGE_NOT_FOUND",
]);

/** True for errors that are findings about the backup itself (see `BACKUP_DEFECT_CODES`). */
export function isBackupDefect(error: unknown): boolean {
  return isMongoShieldError(error) && BACKUP_DEFECT_CODES.has(error.code);
}

/**
 * Runs every check on one restored namespace. Backup defects found while reading
 * the backup (a damaged metadata or data file) become problems; anything else throws.
 */
export async function checkRestoredNamespace(
  input: NamespaceCheckInput,
): Promise<DrillNamespaceReport> {
  const { planned } = input;
  const problems: string[] = [];
  const notes: string[] = [];
  const target = splitNamespace(planned.to);
  const db = input.client.db(target.database);

  if (planned.type === "view") {
    await checkView(input, problems);
    return report(
      input,
      { restoredDocuments: 0, indexesExpected: 0, indexesFound: 0 },
      problems,
      notes,
      0,
    );
  }

  const collection = db.collection(target.collection);
  const restoredDocuments = await countDocuments(collection);
  checkCount(input, restoredDocuments, problems, notes);

  let indexes = { expected: 0, found: 0 };
  let sampled = 0;
  try {
    const metadata = await readMetadataFile(input.source, input.entry.metadata, {
      signal: input.signal,
    });
    indexes = await checkIndexes(
      metadata,
      collection,
      problems,
      input.replayedChanges ? notes : undefined,
    );
    sampled = await compareSample(input, metadata, collection, problems, notes);
  } catch (error) {
    if (!isBackupDefect(error)) throw error;
    problems.push(`reading the backup failed: ${messageOf(error)}`);
  }
  return report(
    input,
    { restoredDocuments, indexesExpected: indexes.expected, indexesFound: indexes.found },
    problems,
    notes,
    sampled,
  );
}

function report(
  input: NamespaceCheckInput,
  counts: { restoredDocuments: number; indexesExpected: number; indexesFound: number },
  problems: string[],
  notes: string[],
  sampled: number,
): DrillNamespaceReport {
  return {
    ns: input.planned.from,
    target: input.planned.to,
    type: input.planned.type,
    expectedDocuments: input.planned.type === "view" ? 0 : input.entry.documents,
    ...counts,
    sampled,
    ok: problems.length === 0,
    problems,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Count, views and indexes
// ---------------------------------------------------------------------------

/**
 * Counts with `countDocuments` (an exact scan), not `estimatedDocumentCount`:
 * the estimate comes from collection metadata, which is exactly what a drill must
 * not take on trust, and it is not supported on time-series collections.
 */
async function countDocuments(collection: Collection): Promise<number> {
  return collection.countDocuments({});
}

function checkCount(
  input: NamespaceCheckInput,
  restored: number,
  problems: string[],
  notes: string[],
): void {
  const expected = input.entry.documents;
  if (restored === expected) return;
  const difference = `${restored} documents restored, the manifest lists ${expected}`;
  if (input.replayedChanges) {
    notes.push(`${difference} (expected: changes of the backup window were replayed)`);
  } else {
    problems.push(difference);
  }
}

/** A backed-up view must exist as a view (restore recreates it from its definition). */
async function checkView(input: NamespaceCheckInput, problems: string[]): Promise<void> {
  const target = splitNamespace(input.planned.to);
  const found = await input.client
    .db(target.database)
    .listCollections({ name: target.collection }, { nameOnly: false })
    .next();
  if (found === null) problems.push("the view was not restored");
  else if (found.type !== "view") problems.push(`restored as a ${String(found.type)}, not a view`);
}

/**
 * Every index named in the backed-up metadata must exist on the restored
 * collection. Indexes are compared by name: restore keeps names, and the server
 * may legitimately normalise an index's other fields (version, collation).
 */
/**
 * Every index the metadata lists must exist on the restored collection. With replayed
 * changes (`notes` given), a missing index is only a note: the changes may have dropped
 * it (or the whole collection) after the dump, as an incremental chain often does.
 */
async function checkIndexes(
  metadata: CollectionMetadata,
  collection: Collection,
  problems: string[],
  notes?: string[],
): Promise<{ expected: number; found: number }> {
  const expectedNames: string[] = [];
  for (const index of metadata.indexes) {
    if (typeof index.name === "string") expectedNames.push(index.name);
  }

  // listIndexes returns one small document per index (never data), so reading it
  // whole is fine.
  const existing = new Set<string>();
  for (const index of await collection.listIndexes().toArray()) {
    if (typeof index.name === "string") existing.add(index.name);
  }

  let found = 0;
  for (const name of expectedNames) {
    if (existing.has(name)) found += 1;
    else if (notes !== undefined) {
      notes.push(`index "${name}" is missing (the replayed changes may have dropped it)`);
    } else problems.push(`index "${name}" is missing`);
  }
  return { expected: expectedNames.length, found };
}

// ---------------------------------------------------------------------------
// Sample comparison
// ---------------------------------------------------------------------------

/**
 * Compares up to `sampleSize` random backup documents with their restored copies.
 * Returns how many documents were compared.
 */
async function compareSample(
  input: NamespaceCheckInput,
  metadata: CollectionMetadata,
  collection: Collection,
  problems: string[],
  notes: string[],
): Promise<number> {
  if (input.sampleSize === 0) return 0;
  if (input.replayedChanges) {
    notes.push("converge backup: documents were not sampled (the change replay modifies them)");
    return 0;
  }
  const timeSeries = input.planned.type === "timeseries" ? timeSeriesFieldsOf(metadata) : undefined;
  if (input.planned.type === "timeseries" && timeSeries === undefined) {
    notes.push("time-series collection without a timeField in its metadata: not sampled");
    return 0;
  }

  const sample = await sampleBackupDocuments(input);
  const sampleProblems: string[] = [];
  for (const document of sample) {
    const problem =
      timeSeries === undefined
        ? await compareDocument(collection, document)
        : await compareMeasurement(collection, document, timeSeries);
    if (problem !== undefined) sampleProblems.push(problem);
  }
  problems.push(...sampleProblems.slice(0, MAX_SAMPLE_PROBLEMS));
  if (sampleProblems.length > MAX_SAMPLE_PROBLEMS) {
    problems.push(`… and ${sampleProblems.length - MAX_SAMPLE_PROBLEMS} more sampled documents`);
  }
  return sample.length;
}

/**
 * Picks `sampleSize` documents uniformly at random from every data part of the
 * namespace, in one streaming pass, holding at most `sampleSize` documents in
 * memory (reservoir sampling, "algorithm R": document number k replaces a random
 * slot with probability size/k).
 */
async function sampleBackupDocuments(input: NamespaceCheckInput): Promise<Buffer[]> {
  const reservoir: Buffer[] = [];
  let seen = 0;
  for (const file of input.entry.files) {
    for await (const document of openDocumentStream(input.source, file, { signal: input.signal })) {
      seen += 1;
      // Copy: the splitter may hand out views into a large decompressed chunk, which
      // would otherwise stay in memory for as long as the sample does.
      const copy = Buffer.from(document as Buffer);
      if (reservoir.length < input.sampleSize) {
        reservoir.push(copy);
        continue;
      }
      const slot = randomInt(seen);
      if (slot < input.sampleSize) reservoir[slot] = copy;
    }
  }
  return reservoir;
}

/**
 * Looks one backup document up by `_id` in the restored collection and compares
 * the raw BSON. Returns a problem, or `undefined` when they are identical.
 */
async function compareDocument(
  collection: Collection,
  backupDocument: Buffer,
): Promise<string | undefined> {
  // Lossless parsing keeps the exact BSON type of the `_id` (Int32 vs Double vs Long),
  // and the stored field order of an embedded `_id` with integer-like field names, so
  // the lookup matches the stored value exactly.
  const parsed = deserializeInStoredOrder(backupDocument);
  if (!Object.hasOwn(parsed, "_id")) {
    return "a sampled backup document has no _id (MongoDB stores an _id in every document, so the backup was altered)";
  }
  const id: unknown = parsed._id;
  const filter: Document = { _id: valueInStoredOrder(id) };
  const cursor = collection.find(filter, { raw: true, limit: 1 });
  let restored: Uint8Array | undefined;
  for await (const document of cursor) restored = rawBytes(document);

  if (restored === undefined) return `sampled document ${describeId(id)} is missing`;
  if (!backupDocument.equals(restored)) {
    return `sampled document ${describeId(id)} differs from the backup (values or field order)`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Time series: measurements, not documents
// ---------------------------------------------------------------------------

/** Restored measurements compared per sampled one (time series `_id`s are not unique). */
const MAX_MEASUREMENT_CANDIDATES = 16;

/** The time and meta field names of a time series collection's backed-up options. */
interface TimeSeriesFields {
  readonly timeField: string;
  readonly metaField: string | undefined;
}

function timeSeriesFieldsOf(metadata: CollectionMetadata): TimeSeriesFields | undefined {
  const timeseries: unknown = metadata.options.timeseries;
  if (typeof timeseries !== "object" || timeseries === null) return undefined;
  const timeField: unknown = Reflect.get(timeseries, "timeField");
  const metaField: unknown = Reflect.get(timeseries, "metaField");
  if (typeof timeField !== "string") return undefined;
  return { timeField, metaField: typeof metaField === "string" ? metaField : undefined };
}

/**
 * Looks one backed-up measurement up in the restored time series and compares it.
 *
 * A time series stores measurements in buckets and rebuilds them on read, so the
 * restored copy lists its fields in another order (time and meta first, the rest
 * sorted), the server normalizes the meta field (sorts the fields of its documents),
 * and `_id`s are not unique. The lookup uses `_id` and the time (which also lets the
 * server use the bucket bounds); the comparison takes the measurement as a set of
 * fields, each compared byte for byte, with the meta field normalized on both sides.
 * Any one equal candidate passes.
 */
async function compareMeasurement(
  collection: Collection,
  backupMeasurement: Buffer,
  fields: TimeSeriesFields,
): Promise<string | undefined> {
  const { timeField, metaField } = fields;
  const parsed = BSON.deserialize(backupMeasurement, LOSSLESS_DESERIALIZE_OPTIONS);
  const filter: Document = {};
  if (Object.hasOwn(parsed, "_id")) filter._id = parsed._id;
  if (Object.hasOwn(parsed, timeField)) filter[timeField] = parsed[timeField];
  const describe =
    parsed._id === undefined
      ? "a sampled measurement"
      : `sampled measurement ${describeId(parsed._id)}`;
  if (Object.keys(filter).length === 0) {
    return `${describe} has neither an _id nor a time field "${timeField}"`;
  }

  const expected = fieldFingerprint(parsed, metaField);
  const cursor = collection.find(filter, { raw: true, limit: MAX_MEASUREMENT_CANDIDATES });
  let candidates = 0;
  for await (const document of cursor) {
    const bytes = rawBytes(document);
    if (bytes === undefined) continue;
    candidates += 1;
    const restored = BSON.deserialize(bytes, LOSSLESS_DESERIALIZE_OPTIONS);
    if (fieldFingerprint(restored, metaField) === expected) return undefined;
  }
  if (candidates === 0) return `${describe} is missing`;
  return `${describe} differs from the backup (field values)`;
}

/**
 * A measurement's fields as a canonical string: field names sorted, each value as its
 * BSON bytes (in hex), the meta field with the fields of its documents sorted. Equal
 * fingerprints mean the same fields with identical values, whatever their order.
 */
export function fieldFingerprint(document: Document, metaField?: string): string {
  const names = Object.keys(document).sort();
  return names
    .map((name) => {
      const value: unknown = name === metaField ? sortedFields(document[name]) : document[name];
      const bytes = Buffer.from(BSON.serialize({ value })).toString("hex");
      return `${JSON.stringify(name)}:${bytes}`;
    })
    .join(",");
}

/** Embedded documents with their fields sorted by name, at every depth (arrays keep order). */
function sortedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element: unknown) => sortedFields(element));
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "_bsontype") !== undefined
  ) {
    return value;
  }
  if (value instanceof Date || value instanceof RegExp) return value;
  const sorted: Document = {};
  for (const name of Object.keys(value).sort())
    sorted[name] = sortedFields(Reflect.get(value, name));
  return sorted;
}

/**
 * With `raw: true` the driver yields each document as its BSON bytes, while typing
 * it as a parsed document; this narrows it back.
 */
function rawBytes(document: unknown): Uint8Array | undefined {
  return document instanceof Uint8Array ? document : undefined;
}

/**
 * Names a document in a problem without revealing data: ObjectIds and numbers are
 * shown, other `_id`s only by type, since natural keys (emails, customer numbers)
 * are personal data and drill reports are stored and shared.
 */
export function describeId(id: unknown): string {
  if (id instanceof BSON.ObjectId) return `ObjectId("${id.toHexString()}")`;
  if (id instanceof BSON.Int32 || id instanceof BSON.Double || id instanceof BSON.Long) {
    return `_id ${id.toString()}`;
  }
  if (typeof id === "number") return `_id ${id}`;
  if (typeof id === "string") return "with a string _id";
  if (typeof id === "object" && id !== null && "_bsontype" in id) {
    return `with a ${String(id._bsontype)} _id`;
  }
  return "with an _id of another type";
}

/** The message of an error, for problem lists. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
