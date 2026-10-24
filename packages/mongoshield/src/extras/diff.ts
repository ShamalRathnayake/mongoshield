/**
 * Diff: what changed between two backups, or between a backup and the live deployment.
 * "What did last night's import touch?", "how far has staging drifted from the backup?"
 *
 *   open both sides → namespaces of each (include/exclude) → for every namespace:
 *     only on one side            → reported as added / removed (with its document count)
 *     on both                     → collection options and indexes (from metadata, or
 *                                   listCollections/listIndexes for the live side)
 *                                 → documents: added / removed / changed / unchanged by `_id`
 *
 * How documents are matched, and why not a sorted merge: a merge by `_id` needs both
 * sides in `_id` order. Split backup parts are (each part is read through the `_id`
 * index), but unsplit collections are stored in natural order, and sorting them would
 * need an external merge sort with BSON-order comparisons across mixed `_id` types.
 * Instead each document is reduced to a small record, `(_id bytes, SHA-256 of the
 * document bytes)`, and records are matched by hash:
 *
 *   up to `maxRecordsInMemory` documents   records of the "from" side in a Map; the
 *                                          "to" side streams past it
 *   more                                   records are spilled into N bucket files by a
 *                                          hash of the `_id` (both sides), then each
 *                                          bucket pair is compared in memory
 *
 * Every side is read exactly once, in any order, and memory stays bounded by one
 * bucket (~100 bytes per document) whatever the collection size. A document counts as
 * changed when its BSON bytes differ, which includes a different field order (MongoDB
 * treats such documents as different too). `_id`s are compared by their exact BSON
 * bytes, so an Int32 1 and a Double 1 count as different documents.
 *
 * Converge backups are compared in their state at the END of their window (T1), like
 * `find` reads them: the changes recorded during the backup are overlaid on the dumped
 * documents (src/engine/find-window.ts). Documents the window did not touch keep their
 * stored bytes; the others are encoded again in their stored field order. A collection
 * the window dropped is still listed, with the documents it had at T1 (none).
 *
 * The live side is read without a snapshot, so a deployment that is being written to
 * gives an approximate answer. Collections whose `_id` is not unique (time series) are
 * compared approximately: duplicate `_id`s collapse into one record.
 *
 * Two options shape a diff for previewing a restore (the console's "Preview changes"):
 *
 *   rename   each `from` namespace is compared with the `to` namespace the restore
 *            rename rules map it to; the `to` side is then limited to those targets
 *   sample   against a live `to` side, a namespace above a size is compared by a sample:
 *            the first N documents of the `from` side are looked up on the live side by
 *            `_id` (one `$in` query per batch), and the counts are extrapolated. Reading
 *            the whole live collection is what makes an exact diff of a big collection
 *            slow and heavy on the target; the sample costs N indexed lookups instead.
 *            "Added" (live-only) is then estimated from the live count, and has no examples.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Binary, BSON, type Document, type MongoClient } from "mongodb";
import type { EngineContext } from "../engine/context.ts";
import { orderedEntries } from "../engine/filter-values.ts";
import { documentsAtWindowEnd, needsOverlay } from "../engine/find-window.ts";
import { readMetadataFile } from "../engine/read-pipeline.ts";
import { metadataReading, namespaceReading } from "../engine/restore-chain.ts";
import { compileRenameMap, type NamespaceMapper } from "../engine/restore-rename.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "../format/bson-stream.ts";
import { type CollectionEntry, collectionEntries } from "../format/manifest.ts";
import type { CollectionType } from "../format/metadata.ts";
import { compileNamespaceFilter, discoverNamespaces, splitNamespace } from "../mongo/index.ts";
import type { BackupSelector, DecryptionOptions, NamespacePattern } from "../types.ts";
import {
  type OpenedBackup,
  openedNamespace,
  openSelectedBackup,
  parseRawDocument,
  rawDocumentsOf,
} from "./read-backup.ts";

/** Example `_id`s kept per category (added / removed / changed) when not given. */
export const DEFAULT_DIFF_EXAMPLES = 10;

/** Documents per side compared fully in memory; larger collections spill to disk. */
export const DEFAULT_MAX_RECORDS_IN_MEMORY = 250_000;

/** Documents compared per sampled namespace when `sample.size` is not given. */
export const DEFAULT_DIFF_SAMPLE_SIZE = 1000;

/** `_id`s per `$in` lookup of a sampled comparison (small enough for any `_id` type). */
const SAMPLE_LOOKUP_BATCH = 500;

/** Upper bound on bucket files per side, to keep file handles and pending buffers small. */
const MAX_BUCKETS = 4096;

/** Pending bytes per bucket before they are appended to its file. */
const BUCKET_FLUSH_BYTES = 64 * 1024;

/** SHA-256 digest length in bytes; every spilled record ends with one. */
const DIGEST_BYTES = 32;

/** The live deployment as one side of a diff. */
export interface LiveDeployment {
  /** A connected client; it is not closed. */
  readonly live: MongoClient;
}

/** Options for `diffBackups`. */
export interface DiffOptions {
  /** The older side: a backup id, `"latest"`, or `{ before: date }`. */
  readonly from: BackupSelector;
  /** The newer side: another backup, or `{ live: client }` for the live deployment. */
  readonly to: BackupSelector | LiveDeployment;
  /**
   * Only these namespaces. Against a live deployment, defaults to the databases the
   * `from` backup holds (`<db>.*`), so unrelated databases do not show up as added.
   */
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /** Example `_id`s to keep per category. Defaults to {@link DEFAULT_DIFF_EXAMPLES}. */
  readonly examples?: number;
  /** Keys for encrypted backups (used for both sides). */
  readonly decryption?: DecryptionOptions;
  /** Documents per side compared in memory before spilling (mainly for tests). */
  readonly maxRecordsInMemory?: number;
  /** Where spill files go. Defaults to the OS temp directory. Removed afterwards. */
  readonly workDirectory?: string;
  /**
   * Compare each `from` namespace with the `to` namespace these rules map it to, in the
   * restore `rename` syntax: `{ "app.*": "app_restored.*", "app.users": "app.people" }`.
   * `include`/`exclude` select `from` namespaces by their own name; the `to` side is then
   * limited to the namespaces they map to (nothing else there is compared, so no
   * namespace is "only-to"). Results keep the `from` name in `namespace` and give the
   * other one in `targetNamespace` when it differs.
   */
  readonly rename?: Readonly<Record<string, string>>;
  /**
   * Compare namespaces with more than `above` documents (on either side) by a sample
   * instead of reading them fully: the first `size` documents of the `from` side
   * (default {@link DEFAULT_DIFF_SAMPLE_SIZE}) are looked up by `_id` on the `to` side.
   * Only for a live `to` side. Sampled namespaces carry `sampled`, and their counts are
   * estimates (see the file header).
   */
  readonly sample?: { readonly above: number; readonly size?: number };
  readonly signal?: AbortSignal;
}

/** One side of a diff, for the report. */
export type DiffSideInfo =
  | { readonly kind: "backup"; readonly backupId: string }
  | { readonly kind: "live" };

/** Document counts of one namespace. */
export interface DocumentDiffCounts {
  /** Documents on the `from` side. */
  readonly from: number;
  /** Documents on the `to` side (an estimate for a live namespace that only exists there). */
  readonly to: number;
  /** `_id`s only on the `to` side. */
  readonly added: number;
  /** `_id`s only on the `from` side. */
  readonly removed: number;
  /** `_id`s on both sides whose documents differ. */
  readonly changed: number;
  readonly unchanged: number;
}

/** Up to `examples` `_id`s per category (BSON values; `null` for a document without `_id`). */
export interface DiffExamples {
  readonly added: readonly unknown[];
  readonly removed: readonly unknown[];
  readonly changed: readonly unknown[];
}

/** Index names that differ, by category. */
export interface IndexDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Same name, different key or options. */
  readonly changed: readonly string[];
}

/** The differences of one namespace. */
export interface NamespaceDiff {
  readonly namespace: string;
  /** Where the namespace exists. */
  readonly presence: "both" | "only-from" | "only-to";
  readonly type: { readonly from?: CollectionType; readonly to?: CollectionType };
  readonly documents: DocumentDiffCounts;
  readonly examples: DiffExamples;
  readonly indexes: IndexDiff;
  /** Collection options (validator, collation, …) whose values differ. */
  readonly options: readonly string[];
  readonly identical: boolean;
  /** The `to` side's name, when the `rename` option maps `namespace` elsewhere. */
  readonly targetNamespace?: string;
  /**
   * Set when the documents were compared by a sample (`DiffOptions.sample`): `documents`
   * of the `from` side's `of` were compared, and the counts are extrapolated from them.
   */
  readonly sampled?: { readonly documents: number; readonly of: number };
}

/** The result of `diffBackups`. */
export interface DiffResult {
  readonly from: DiffSideInfo;
  readonly to: DiffSideInfo;
  /** Every namespace of either side, sorted by name. */
  readonly namespaces: readonly NamespaceDiff[];
  readonly identical: boolean;
  /** True when some collection was large enough to be compared through spill files. */
  readonly spilled: boolean;
  readonly durationMs: number;
}

/** One namespace of one side, read lazily. */
interface SideNamespace {
  readonly ns: string;
  readonly type: CollectionType;
  /**
   * Exact for plain backups, an estimate for live collections, the dumped count for
   * converge backups (see `atWindowEnd`).
   */
  readonly documentCount: number;
  /**
   * True when `documents()` overlays a converge backup's window, so the count at T1
   * is only known by reading them.
   */
  readonly atWindowEnd: boolean;
  metadata(): Promise<{ readonly options: Document; readonly indexes: readonly Document[] }>;
  documents(): AsyncIterable<Uint8Array>;
  /** Live collections only: the raw documents with these `_id`s (for sampling). */
  lookup?(ids: readonly unknown[]): AsyncIterable<Uint8Array>;
}

/** One opened side. */
interface OpenedSide {
  readonly info: DiffSideInfo;
  readonly namespaces: ReadonlyMap<string, SideNamespace>;
}

/**
 * Compares two backups, or a backup with the live deployment.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for bad options; `MS_BACKUP_NOT_FOUND`;
 *   key and integrity errors from reading the backups; connection errors for the live
 *   side; `MS_ABORTED`.
 */
export async function diffBackups(
  context: EngineContext,
  options: DiffOptions,
): Promise<DiffResult> {
  const startedAt = performance.now();
  const examples = validateCount(options.examples, DEFAULT_DIFF_EXAMPLES, "examples", 0);
  const maxRecords = validateCount(
    options.maxRecordsInMemory,
    DEFAULT_MAX_RECORDS_IN_MEMORY,
    "maxRecordsInMemory",
    1,
  );

  const sample = validateSample(options);
  const mapper = options.rename === undefined ? undefined : compileRenameMap(options.rename);

  const fromBackup = await openSelectedBackup(context, { ...options, backup: options.from });
  const from = backupSide(fromBackup, options);
  // With rename rules the `to` side is exactly the namespaces the `from` side maps to.
  const targets =
    mapper === undefined ? undefined : new Set([...from.namespaces.keys()].map(mapper));
  const to = isLive(options.to)
    ? await liveSide(options.to.live, fromBackup, options, targets)
    : backupSide(
        await openSelectedBackup(context, { ...options, backup: options.to }),
        options,
        targets,
      );

  const namespaces: NamespaceDiff[] = [];
  let spilled = false;
  for (const pair of namespacePairs(from, to, mapper)) {
    throwIfAborted(options.signal);
    const compared = await diffNamespace(pair.from, pair.to, {
      examples,
      maxRecords,
      sample,
      workDirectory: options.workDirectory ?? tmpdir(),
      signal: options.signal,
    });
    spilled ||= compared.spilled;
    namespaces.push(
      pair.targetNamespace === undefined
        ? compared.diff
        : { ...compared.diff, targetNamespace: pair.targetNamespace },
    );
  }

  const result: DiffResult = {
    from: from.info,
    to: to.info,
    namespaces,
    identical: namespaces.every((namespace) => namespace.identical),
    spilled,
    durationMs: Math.round(performance.now() - startedAt),
  };
  context.logger.info("Compared backups", {
    namespaces: namespaces.length,
    identical: result.identical,
  });
  return result;
}

function isLive(side: BackupSelector | LiveDeployment): side is LiveDeployment {
  return typeof side === "object" && "live" in side;
}

/** The namespaces to compare: one side's and the other's under the same (or mapped) name. */
interface NamespacePair {
  readonly from: SideNamespace | undefined;
  readonly to: SideNamespace | undefined;
  /** The `to` name, when rename rules give it another name than `from`. */
  readonly targetNamespace?: string;
}

/**
 * Without rename rules, every namespace of either side by name (sorted). With them,
 * every `from` namespace (sorted) with the `to` namespace it maps to.
 */
function namespacePairs(
  from: OpenedSide,
  to: OpenedSide,
  mapper: NamespaceMapper | undefined,
): NamespacePair[] {
  if (mapper === undefined) {
    const names = [...new Set([...from.namespaces.keys(), ...to.namespaces.keys()])].sort();
    return names.map((name) => ({ from: from.namespaces.get(name), to: to.namespaces.get(name) }));
  }
  return [...from.namespaces.keys()].sort().map((name) => {
    const target = mapper(name);
    return {
      from: from.namespaces.get(name),
      to: to.namespaces.get(target),
      ...(target === name ? {} : { targetNamespace: target }),
    };
  });
}

/** Sampling settings after validation (`undefined`: compare everything fully). */
interface SampleSettings {
  readonly above: number;
  readonly size: number;
}

function validateSample(options: DiffOptions): SampleSettings | undefined {
  if (options.sample === undefined) return undefined;
  if (!isLive(options.to)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "sample needs the live deployment as the `to` side.",
      { hint: "Sampling looks documents up by _id, which only a live collection can do." },
    );
  }
  return {
    above: validateCount(options.sample.above, 0, "sample.above", 0),
    size: validateCount(options.sample.size, DEFAULT_DIFF_SAMPLE_SIZE, "sample.size", 1),
  };
}

function validateCount(
  value: number | undefined,
  fallback: number,
  name: string,
  min: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `${name} must be a whole number ≥ ${min} (got ${value}).`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

/**
 * The namespaces of a backup, filtered by include/exclude, or exactly `only` (the
 * rename targets) when given.
 */
function backupSide(
  backup: OpenedBackup,
  options: DiffOptions,
  only?: ReadonlySet<string>,
): OpenedSide {
  const filter = compileNamespaceFilter({ include: options.include, exclude: options.exclude });
  const selected = (ns: string): boolean => (only === undefined ? filter(ns) : only.has(ns));
  const namespaces = new Map<string, SideNamespace>();
  // Users and roles entries are not collections and are not compared.
  for (const entry of collectionEntries(backup.manifest.namespaces)) {
    if (selected(entry.ns))
      namespaces.set(entry.ns, backupNamespace(backup, entry, options.signal));
  }
  // An incremental's own id, not its chain's base (see restore-chain.ts).
  return {
    info: { kind: "backup", backupId: backup.chain?.backupId ?? backup.manifest.id },
    namespaces,
  };
}

function backupNamespace(
  backup: OpenedBackup,
  entry: CollectionEntry,
  signal: AbortSignal | undefined,
): SideNamespace {
  // Converge windows and incremental chains are read as of their end; a chain's time
  // series and newest metadata come from the incremental itself (restore-chain.ts).
  const reading = namespaceReading(backup, entry);
  const metadata = metadataReading(backup, entry);
  const atWindowEnd = needsOverlay(reading) && entry.type !== "view";
  return {
    ns: entry.ns,
    type: entry.type,
    documentCount: reading.entry.documents,
    atWindowEnd,
    metadata: () => readMetadataFile(metadata.source, metadata.file, { signal }),
    documents: () =>
      atWindowEnd
        ? documentsAtT1(backup, entry, signal)
        : rawDocumentsOf(reading.source, reading.entry.files, signal),
  };
}

/** The documents of a converge backup's namespace at the end of its window, as BSON. */
async function* documentsAtT1(
  backup: OpenedBackup,
  entry: CollectionEntry,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  const documents = documentsAtWindowEnd(openedNamespace(backup, entry), { signal });
  for await (const match of documents) {
    yield match.raw ?? BSON.serialize(orderedFields(match.document), { checkKeys: false });
  }
}

/** The fields of a document as a Map in stored order (see `inStoredOrder`). */
function orderedFields(document: Document): Map<string, unknown> {
  const ordered = new Map<string, unknown>();
  for (const [field, child] of orderedEntries(document)) ordered.set(field, inStoredOrder(child));
  return ordered;
}

/**
 * A parsed document as Maps in its stored field order, for encoding: BSON.serialize
 * writes a plain object's fields in JavaScript order, which lists integer-like names
 * ("0", "1") first, but keeps a Map's order (see find-parse.ts for why the order is
 * recorded at all). BSON values, dates and regular expressions are kept as they are.
 */
function inStoredOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element: unknown) => inStoredOrder(element));
  return isPlainDocument(value) ? orderedFields(value) : value;
}

/** An embedded document: not an array, Date, RegExp or BSON value (those have `_bsontype`). */
function isPlainDocument(value: unknown): value is Document {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (value instanceof Date || value instanceof RegExp) return false;
  return Reflect.get(value, "_bsontype") === undefined;
}

/**
 * The live deployment's namespaces: by default within the databases of the `from`
 * backup, or exactly `only` (the rename targets) when given.
 */
async function liveSide(
  client: MongoClient,
  fromBackup: OpenedBackup,
  options: DiffOptions,
  only?: ReadonlySet<string>,
): Promise<OpenedSide> {
  // Exact namespaces are valid patterns; the result is still checked against `only`
  // below, in case a collection name contains a wildcard character.
  const include =
    only === undefined
      ? (options.include ?? [
          ...new Set(fromBackup.manifest.namespaces.map((entry) => `${entry.db}.*`)),
        ])
      : [...only];
  const namespaces = new Map<string, SideNamespace>();
  // A backup without namespaces gives no default scope; then there is nothing to compare.
  if (include.length === 0) return { info: { kind: "live" }, namespaces };
  const specs = await discoverNamespaces(client, {
    include,
    ...(only === undefined ? { exclude: options.exclude } : {}),
    signal: options.signal,
  });
  for (const spec of specs) {
    if (only !== undefined && !only.has(spec.ns)) continue;
    namespaces.set(spec.ns, {
      ns: spec.ns,
      type: spec.type,
      documentCount: spec.estimatedDocuments,
      atWindowEnd: false,
      metadata: async () => ({ options: spec.options, indexes: spec.indexes }),
      documents: () =>
        spec.type === "view" ? emptyDocuments() : liveDocuments(client, spec.ns, options.signal),
      lookup: (ids) =>
        spec.type === "view"
          ? emptyDocuments()
          : liveDocuments(client, spec.ns, options.signal, { _id: { $in: [...ids] } }),
    });
  }
  return { info: { kind: "live" }, namespaces };
}

/** Raw BSON of the documents of a live collection (`raw: true` skips parsing); all by default. */
async function* liveDocuments(
  client: MongoClient,
  namespace: string,
  signal: AbortSignal | undefined,
  filter: Document = {},
): AsyncGenerator<Uint8Array> {
  const { database, collection } = splitNamespace(namespace);
  const cursor = client.db(database).collection(collection).find(filter, { raw: true });
  try {
    for await (const document of cursor) {
      throwIfAborted(signal);
      // With `raw: true` the driver yields Buffers, although the cursor is typed as documents.
      const raw: unknown = document;
      if (!(raw instanceof Uint8Array)) {
        throw new MongoShieldError(
          "MS_INTERNAL",
          "The driver returned a parsed document for a raw find.",
        );
      }
      yield raw;
    }
  } finally {
    await cursor.close();
  }
}

async function* emptyDocuments(): AsyncGenerator<Uint8Array> {}

// ---------------------------------------------------------------------------
// One namespace
// ---------------------------------------------------------------------------

/** Settings shared by every namespace comparison. */
interface CompareSettings {
  readonly examples: number;
  readonly maxRecords: number;
  readonly sample: SampleSettings | undefined;
  readonly workDirectory: string;
  readonly signal: AbortSignal | undefined;
}

const NO_EXAMPLES: DiffExamples = { added: [], removed: [], changed: [] };
const NO_INDEX_CHANGES: IndexDiff = { added: [], removed: [], changed: [] };

async function diffNamespace(
  from: SideNamespace | undefined,
  to: SideNamespace | undefined,
  settings: CompareSettings,
): Promise<{ diff: NamespaceDiff; spilled: boolean }> {
  if (from === undefined || to === undefined) {
    return { diff: await oneSidedDiff(from, to, settings.signal), spilled: false };
  }

  const [fromMetadata, toMetadata] = [await from.metadata(), await to.metadata()];
  const indexes = compareIndexes(fromMetadata.indexes, toMetadata.indexes);
  const options = compareOptions(fromMetadata.options, toMetadata.options);
  const expected = Math.max(from.documentCount, to.documentCount);
  // Large namespaces are sampled when asked to and the `to` side can look documents up.
  const { sample } = settings;
  const lookup = to.lookup;
  const compared =
    sample !== undefined && lookup !== undefined && expected > sample.above
      ? await compareBySample(from, to, lookup, sample.size, settings)
      : await compareDocumentStreams(from.documents(), to.documents(), { ...settings, expected });
  const { counts } = compared;
  const identical =
    from.type === to.type &&
    counts.added + counts.removed + counts.changed === 0 &&
    indexes.added.length + indexes.removed.length + indexes.changed.length === 0 &&
    options.length === 0;
  return {
    diff: {
      namespace: from.ns,
      presence: "both",
      type: { from: from.type, to: to.type },
      documents: counts,
      examples: compared.examples,
      indexes,
      options,
      identical,
      ...(compared.sampled === undefined ? {} : { sampled: compared.sampled }),
    },
    spilled: compared.spilled,
  };
}

/** A namespace that exists on one side only. */
async function oneSidedDiff(
  from: SideNamespace | undefined,
  to: SideNamespace | undefined,
  signal: AbortSignal | undefined,
): Promise<NamespaceDiff> {
  const present = from ?? to;
  if (present === undefined)
    throw new MongoShieldError("MS_INTERNAL", "A namespace on neither side.");
  const fromCount = from === undefined ? 0 : await documentCountOf(from, signal);
  const toCount = to === undefined ? 0 : await documentCountOf(to, signal);
  return {
    namespace: present.ns,
    presence: from === undefined ? "only-to" : "only-from",
    type: { ...(from ? { from: from.type } : {}), ...(to ? { to: to.type } : {}) },
    documents: {
      from: fromCount,
      to: toCount,
      added: toCount,
      removed: fromCount,
      changed: 0,
      unchanged: 0,
    },
    examples: NO_EXAMPLES,
    indexes: NO_INDEX_CHANGES,
    options: [],
    identical: false,
  };
}

/** The side's document count; at the end of the window it means reading them. */
async function documentCountOf(
  side: SideNamespace,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (!side.atWindowEnd) return side.documentCount;
  let count = 0;
  for await (const _document of side.documents()) {
    throwIfAborted(signal);
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * Compares index definitions by name. The `v` (index format version) and `ns` fields
 * are ignored, numbers compare by value (an Int32 1 equals a Double 1 here: both build
 * the same index), and options compare whatever order they are listed in. The `key`
 * keeps its order, which matters for compound indexes.
 */
export function compareIndexes(from: readonly Document[], to: readonly Document[]): IndexDiff {
  const fromByName = indexesByName(from);
  const toByName = indexesByName(to);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, definition] of fromByName) {
    const other = toByName.get(name);
    if (other === undefined) removed.push(name);
    else if (other !== definition) changed.push(name);
  }
  for (const name of toByName.keys()) if (!fromByName.has(name)) added.push(name);
  return { added, removed, changed };
}

/** Index name → normalized definition (a string, compared for equality). */
function indexesByName(indexes: readonly Document[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const index of indexes) {
    const { name, key, v: _version, ns: _namespace, ...rest } = index;
    if (typeof name !== "string") continue;
    byName.set(name, relaxedJson({ key, options: sortedFields(rest) }));
  }
  return byName;
}

/** The names of collection options that differ (added, removed or changed). */
export function compareOptions(from: Document, to: Document): string[] {
  const names = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  return names.filter((name) => relaxedJson(from[name]) !== relaxedJson(to[name]));
}

function sortedFields(document: Document): Document {
  const sorted: Document = {};
  for (const name of Object.keys(document).sort()) sorted[name] = document[name];
  return sorted;
}

function relaxedJson(value: unknown): string {
  return value === undefined ? "<missing>" : BSON.EJSON.stringify(value, { relaxed: true });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** One document reduced for matching: its `_id` bytes and a digest of its content. */
interface DocumentRecord {
  /** BSON of `{ _id }` (or `{ noId: <digest> }` for a document without `_id`). */
  readonly key: Buffer;
  readonly digest: Buffer;
}

/** What `compareDocumentStreams` needs besides the two streams. */
interface StreamCompareOptions extends Omit<CompareSettings, "sample"> {
  /** The larger side's expected document count, to choose in-memory vs spill. */
  readonly expected: number;
}

/** The outcome of comparing the documents of one namespace. */
interface DocumentComparison {
  readonly counts: DocumentDiffCounts;
  readonly examples: DiffExamples;
  readonly spilled: boolean;
  /** Set for a sampled comparison: how many `from` documents of how many were compared. */
  readonly sampled?: { readonly documents: number; readonly of: number };
}

/** Reduces a raw document to its record. */
function recordOf(raw: Uint8Array): DocumentRecord {
  const digest = createHash("sha256").update(raw).digest();
  const document = parseRawDocument(raw);
  const key =
    document._id === undefined
      ? BSON.serialize({ noId: new Binary(digest) })
      : BSON.serialize({ _id: document._id });
  return { key: Buffer.from(key), digest };
}

/**
 * Compares two document streams by `_id` (see the file header for the approach).
 * Exported for unit tests.
 */
export async function compareDocumentStreams(
  from: AsyncIterable<Uint8Array>,
  to: AsyncIterable<Uint8Array>,
  options: StreamCompareOptions,
): Promise<DocumentComparison> {
  const buckets = bucketCountFor(options.expected, options.maxRecords);
  const tally = new Tally(options.examples);
  if (buckets === 1) {
    const fromRecords = new Map<string, string>();
    for await (const raw of from) {
      throwIfAborted(options.signal);
      tally.fromCount += 1;
      const record = recordOf(raw);
      fromRecords.set(record.key.toString("latin1"), record.digest.toString("latin1"));
    }
    await matchAgainst(fromRecords, mapRecords(to), tally, options.signal);
    return { counts: tally.counts(), examples: tally.decodedExamples(), spilled: false };
  }

  const directory = await mkdtemp(join(options.workDirectory, "mongoshield-diff-"));
  try {
    tally.fromCount = await spill(from, join(directory, "from"), buckets, options.signal);
    const toCount = await spill(to, join(directory, "to"), buckets, options.signal);
    for (let bucket = 0; bucket < buckets; bucket++) {
      throwIfAborted(options.signal);
      const fromRecords = new Map<string, string>();
      for (const record of await readBucket(join(directory, "from"), bucket)) {
        fromRecords.set(record.key.toString("latin1"), record.digest.toString("latin1"));
      }
      await matchAgainst(
        fromRecords,
        await readBucket(join(directory, "to"), bucket),
        tally,
        options.signal,
      );
    }
    // matchAgainst counted the "to" side as it went; it must agree with the spill.
    if (tally.toCount !== toCount) {
      throw new MongoShieldError("MS_INTERNAL", "The diff spill files lost records.");
    }
    return { counts: tally.counts(), examples: tally.decodedExamples(), spilled: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function* mapRecords(documents: AsyncIterable<Uint8Array>): AsyncGenerator<DocumentRecord> {
  for await (const raw of documents) yield recordOf(raw);
}

/**
 * Streams the "to" records past the "from" records: unknown keys were added, keys with
 * another digest changed; whatever is left of `fromRecords` afterwards was removed.
 */
async function matchAgainst(
  fromRecords: Map<string, string>,
  toRecords: Iterable<DocumentRecord> | AsyncIterable<DocumentRecord>,
  tally: Tally,
  signal: AbortSignal | undefined,
): Promise<void> {
  for await (const record of toRecords) {
    throwIfAborted(signal);
    tally.toCount += 1;
    const key = record.key.toString("latin1");
    const digest = fromRecords.get(key);
    if (digest === undefined) {
      tally.note("added", key);
    } else {
      if (digest === record.digest.toString("latin1")) tally.unchanged += 1;
      else tally.note("changed", key);
      fromRecords.delete(key);
    }
  }
  for (const key of fromRecords.keys()) tally.note("removed", key);
}

/**
 * Compares a namespace by a sample (see the file header): the first `size` documents of
 * the `from` side, looked up by `_id` on the live side in batches. A sampled document
 * is unchanged, changed, or missing on the live side ("removed"); the counts of the
 * whole namespace are those shares scaled to the `from` side's count. Live documents
 * the sample cannot see ("added") are estimated from the live count: whatever exceeds
 * the `from` documents that are estimated to be there. Documents without `_id` cannot
 * be looked up and are not sampled.
 */
async function compareBySample(
  from: SideNamespace,
  to: SideNamespace,
  lookup: (ids: readonly unknown[]) => AsyncIterable<Uint8Array>,
  size: number,
  settings: CompareSettings,
): Promise<DocumentComparison> {
  const tally = new Tally(settings.examples);
  let batch = new Map<string, { readonly id: unknown; readonly digest: string }>();

  // Looks one batch up and sorts each of its documents into a category.
  const flush = async (): Promise<void> => {
    if (batch.size === 0) return;
    const ids = [...batch.values()].map((entry) => entry.id);
    for await (const raw of lookup(ids)) {
      throwIfAborted(settings.signal);
      const record = recordOf(raw);
      const key = record.key.toString("latin1");
      const sampled = batch.get(key);
      // `$in` matches by value (an Int32 1 finds a Double 1): such a document is not the
      // sampled one by its exact `_id` bytes, as in a full diff, so it does not count.
      if (sampled === undefined) continue;
      if (sampled.digest === record.digest.toString("latin1")) tally.unchanged += 1;
      else tally.note("changed", key);
      batch.delete(key);
    }
    for (const key of batch.keys()) tally.note("removed", key);
    batch = new Map();
  };

  let taken = 0;
  for await (const raw of from.documents()) {
    throwIfAborted(settings.signal);
    const document = parseRawDocument(raw);
    if (document._id === undefined) continue;
    const record = recordOf(raw);
    batch.set(record.key.toString("latin1"), {
      id: document._id,
      digest: record.digest.toString("latin1"),
    });
    taken += 1;
    if (batch.size >= SAMPLE_LOOKUP_BATCH) await flush();
    // Leaving the loop closes the backup stream: the rest is never downloaded.
    if (taken >= size) break;
  }
  await flush();

  const sample = tally.counts();
  const total = Math.max(from.documentCount, taken);
  const scale = taken === 0 ? 0 : total / taken;
  const removed = Math.round(sample.removed * scale);
  const changed = Math.round(sample.changed * scale);
  const examples = tally.decodedExamples();
  return {
    counts: {
      from: total,
      to: to.documentCount,
      // Live documents beyond the `from` documents estimated to exist there.
      added: Math.max(0, to.documentCount - (total - removed)),
      removed,
      changed,
      unchanged: Math.max(0, total - removed - changed),
    },
    // The sample never sees live-only documents, so it has no examples of them.
    examples: { ...examples, added: [] },
    spilled: false,
    sampled: { documents: taken, of: total },
  };
}

/** One bucket when the larger side fits in memory; otherwise buckets about half full. */
function bucketCountFor(expected: number, maxRecords: number): number {
  if (expected <= maxRecords) return 1;
  return Math.min(MAX_BUCKETS, Math.ceil((expected * 2) / maxRecords));
}

/**
 * Writes every record of `documents` to `<prefix>-<bucket>.bin`, the bucket chosen by a
 * hash of the `_id` bytes (so equal `_id`s of both sides land in the same bucket).
 * Record layout: the key's BSON bytes (self-delimiting: they start with their int32
 * length) followed by the 32-byte digest. Returns the number of records.
 */
async function spill(
  documents: AsyncIterable<Uint8Array>,
  prefix: string,
  buckets: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  const pending: Buffer[][] = Array.from({ length: buckets }, () => []);
  const pendingBytes = new Array<number>(buckets).fill(0);
  const flush = async (bucket: number): Promise<void> => {
    const chunks = pending[bucket] ?? [];
    if (chunks.length === 0) return;
    await appendFile(bucketPath(prefix, bucket), Buffer.concat(chunks));
    pending[bucket] = [];
    pendingBytes[bucket] = 0;
  };

  let count = 0;
  for await (const raw of documents) {
    throwIfAborted(signal);
    const record = recordOf(raw);
    const bucket = fnv1a32(record.key) % buckets;
    pending[bucket]?.push(record.key, record.digest);
    pendingBytes[bucket] = (pendingBytes[bucket] ?? 0) + record.key.length + DIGEST_BYTES;
    if ((pendingBytes[bucket] ?? 0) >= BUCKET_FLUSH_BYTES) await flush(bucket);
    count += 1;
  }
  for (let bucket = 0; bucket < buckets; bucket++) await flush(bucket);
  return count;
}

/** Reads one bucket file back (an empty bucket has no file). */
async function readBucket(prefix: string, bucket: number): Promise<DocumentRecord[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(bucketPath(prefix, bucket));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const records: DocumentRecord[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const keyLength = bytes.readInt32LE(offset);
    const key = bytes.subarray(offset, offset + keyLength);
    const digest = bytes.subarray(offset + keyLength, offset + keyLength + DIGEST_BYTES);
    records.push({ key, digest });
    offset += keyLength + DIGEST_BYTES;
  }
  return records;
}

function bucketPath(prefix: string, bucket: number): string {
  return `${prefix}-${bucket}.bin`;
}

/** 32-bit FNV-1a: a fast, well-spread hash for choosing buckets (not for security). */
function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Running counts plus the first few example keys of each category. */
class Tally {
  fromCount = 0;
  toCount = 0;
  unchanged = 0;
  readonly #limit: number;
  readonly #totals = { added: 0, removed: 0, changed: 0 };
  readonly #examples: Record<"added" | "removed" | "changed", string[]> = {
    added: [],
    removed: [],
    changed: [],
  };

  constructor(limit: number) {
    this.#limit = limit;
  }

  note(category: "added" | "removed" | "changed", key: string): void {
    this.#totals[category] += 1;
    const examples = this.#examples[category];
    if (examples.length < this.#limit) examples.push(key);
  }

  counts(): DocumentDiffCounts {
    return {
      from: this.fromCount,
      to: this.toCount,
      ...this.#totals,
      unchanged: this.unchanged,
    };
  }

  /** The example keys turned back into `_id` values (`null` for documents without one). */
  decodedExamples(): DiffExamples {
    const decode = (key: string): unknown => {
      const document = BSON.deserialize(Buffer.from(key, "latin1"), LOSSLESS_DESERIALIZE_OPTIONS);
      return document._id === undefined ? null : document._id;
    };
    return {
      added: this.#examples.added.map(decode),
      removed: this.#examples.removed.map(decode),
      changed: this.#examples.changed.map(decode),
    };
  }
}
