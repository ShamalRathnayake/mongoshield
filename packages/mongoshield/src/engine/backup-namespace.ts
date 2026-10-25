/**
 * Dumping one namespace: its metadata file, and its data in one or more parts
 * (split collections have one part per `_id` range, see backup-parts.ts).
 *
 *   metadata:  serializeCollectionMetadata → (encrypt) → digest → storage.put
 *   one part:  find({ raw: true }) → count → (throttle) → coalesce → compress → (encrypt)
 *              → digest → storage.put
 *
 * Documents are never parsed: `raw: true` makes the driver hand over each document
 * as the exact BSON bytes the server sent, which is what a `.bson` file contains.
 * Time series collections are read through their namespace too, which returns
 * plain measurements (not the internal buckets); restore rebuilds the buckets.
 *
 * A collection dropped, renamed or replaced (`$out`) while its cursor is open kills
 * the cursor (QueryPlanKilled, "collection dropped" / "collection renamed"). What
 * happens then depends on the consistency mode (`whenReplaced`, see
 * `ReplacedCollectionPolicy`): converge keeps what it read, `none` reads the
 * collection again or leaves it out when it is gone, snapshot fails.
 */

import { Readable, type Transform } from "node:stream";
import {
  type ClientSession,
  type Document,
  type FindCursor,
  type FindOptions,
  MaxKey,
  type MongoClient,
  MongoServerError,
  ReadPreference,
} from "mongodb";
import { createCompressor } from "../compression/index.ts";
import { createEncryptStream } from "../crypto/index.ts";
import { isMongoShieldError, throwIfAborted } from "../errors.ts";
import { valueInStoredOrder } from "../format/field-order.ts";
import { createCountingStream } from "../format/hashing.ts";
import { metadataFileKey, resolveBackupKey } from "../format/layout.ts";
import type { ClusterTime, Compression, StoredFile } from "../format/manifest.ts";
import { serializeCollectionMetadata } from "../format/metadata.ts";
import type { Logger } from "../logger.ts";
import type { CollectionSpec } from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { createCoalescer } from "./backup-coalesce.ts";
import { toBackupError } from "./backup-errors.ts";
import type { FileEncryption } from "./backup-key.ts";
import { ID_INDEX, type PartBounds } from "./backup-parts.ts";
import { writeStoredFile } from "./backup-write.ts";
import { toTimestamp } from "./converge-time.ts";
import { createThrottleStream, type RateLimiter } from "./rate-limit.ts";

/** Content type of data files and of every encrypted file. */
const BINARY_CONTENT_TYPE = "application/octet-stream";

/** Content type of unencrypted metadata files. */
const JSON_CONTENT_TYPE = "application/json";

/**
 * What a part does when its collection is dropped, renamed or replaced under it:
 *
 * - `"keep-partial"` (converge): store the documents read so far and record the part
 *   as usual. The change window holds the drop or rename that killed the cursor (it
 *   happened after the dump started, so after T0), and replaying it empties or
 *   replaces the target, so whatever the part holds is overwritten: the restore is
 *   exact either way. Failing instead would make every converge backup of a
 *   collection that a `$out` loop rebuilds fail.
 * - `"retry"` (none): read the collection again from the start, once; when it no
 *   longer exists, the part is reported `vanished` and the backup leaves the
 *   namespace out (with a manifest warning) rather than failing as a whole: in mode
 *   `none` every collection is as of the moment it was read anyway, and a collection
 *   that was dropped is simply not there at that moment.
 * - `"fail"` (snapshot, and the default): fail the backup. A snapshot read sees the
 *   collection as of the snapshot whatever happens to it later (replica sets keep a
 *   point-in-time catalog), so a failure means the server cannot honour the snapshot,
 *   and reading it again at another time would break the snapshot's promise.
 */
export type ReplacedCollectionPolicy = "keep-partial" | "retry" | "fail";

/** Everything shared by the namespace dumps of one backup run. */
export interface NamespaceDumpContext {
  readonly client: MongoClient;
  readonly storage: StorageAdapter;
  readonly logger: Logger;
  readonly backupId: string;
  readonly compression: Compression;
  /** `undefined` for unencrypted backups. */
  readonly encryption: FileEncryption | undefined;
  /** The snapshot session every read must use, or `undefined` for plain reads. */
  readonly session: ClientSession | undefined;
  /** Where data is read from (see backup-reads.ts). */
  readonly readPreference: ReadPreference;
  /**
   * Converge backups reading from secondaries: every cursor must see at least this
   * cluster time (the window start T0), see backup-reads.ts. `undefined` otherwise.
   */
  readonly readAfter: ClusterTime | undefined;
  /** Shared by all parts, so the limits hold for the whole backup. */
  readonly rateLimiter: RateLimiter | undefined;
  /** Write-once retention for every stored file, when `retainDays` is set. */
  readonly retainUntil: Date | undefined;
  /**
   * Full keys of every object this run started writing. Filled before each write
   * starts, so a failed run knows exactly what to delete.
   */
  readonly writtenKeys: Set<string>;
  /** See {@link ReplacedCollectionPolicy}; `"fail"` when omitted. */
  readonly whenReplaced?: ReplacedCollectionPolicy | undefined;
}

/** Writes `<collection>.metadata.json[.age]`: options, indexes, uuid, type and search indexes. */
export async function writeMetadataFile(
  spec: CollectionSpec,
  context: NamespaceDumpContext,
  options: { readonly uniqueSuffix: string | undefined; readonly signal: AbortSignal },
): Promise<StoredFile> {
  try {
    throwIfAborted(options.signal);
    const json = serializeCollectionMetadata({
      collectionName: spec.name,
      type: spec.type,
      options: spec.options,
      indexes: [...spec.indexes],
      ...(spec.uuid === undefined ? {} : { uuid: spec.uuid }),
      ...(spec.searchIndexes === undefined ? {} : { searchIndexes: [...spec.searchIndexes] }),
    });

    const relativeKey = metadataFileKey({
      db: spec.db,
      collection: spec.name,
      encrypted: context.encryption !== undefined,
      ...(options.uniqueSuffix === undefined ? {} : { uniqueSuffix: options.uniqueSuffix }),
    });
    const key = resolveBackupKey(context.backupId, relativeKey);
    context.writtenKeys.add(key);

    // Metadata is small (a few KiB), so it goes in as a single chunk. It is not
    // compressed (see layout.ts) but it is encrypted like everything else.
    const digest = await writeStoredFile({
      storage: context.storage,
      key,
      source: Readable.from([Buffer.from(json, "utf8")]),
      transforms: encryptionTransforms(context),
      contentType: context.encryption === undefined ? JSON_CONTENT_TYPE : BINARY_CONTENT_TYPE,
      retainUntil: context.retainUntil,
      signal: options.signal,
    });
    context.logger.debug("Wrote metadata file", { ns: spec.ns, key, size: digest.size });
    return { key: relativeKey, size: digest.size, sha256: digest.sha256 };
  } catch (error) {
    throw toBackupError(error, { ns: spec.ns });
  }
}

/** One data part to dump. */
export interface PartTarget {
  readonly ns: string;
  readonly db: string;
  readonly collection: string;
  /** Key of the data file, relative to the backup directory. */
  readonly key: string;
  /**
   * The `_id` range of a split collection's part, read in `_id` order through the
   * `_id` index; `undefined` for an unsplit collection, read in natural order.
   */
  readonly bounds: PartBounds | undefined;
  /** Cursor batch size (see `batchSizeFor`), or the driver's default. */
  readonly batchSize: number | undefined;
}

/** Per-part settings. */
export interface PartDumpOptions {
  /** Filter for the documents to dump. Defaults to every document. */
  readonly query: Document | undefined;
  /** Aborts on the caller's abort or when another part failed. */
  readonly signal: AbortSignal;
  /** Running totals of the part, called per document (keep it cheap). */
  readonly onCounts?: ((documents: number, bytes: number) => void) | undefined;
}

/** What dumping one part produced. */
export interface PartResult {
  readonly file: StoredFile;
  readonly documents: number;
  readonly bytesRaw: number;
  /**
   * True when the collection was dropped or replaced while it was read and the part
   * holds only the documents read until then (`"keep-partial"`).
   */
  readonly truncated: boolean;
}

/** The part's collection no longer exists (`"retry"` only): leave the namespace out. */
export interface VanishedPart {
  readonly vanished: true;
}

/**
 * Streams one part's documents into its data file and returns the stored file
 * with its counts, applying `context.whenReplaced` when the collection is dropped,
 * renamed or replaced under the cursor.
 *
 * @throws MongoShieldError; driver errors are translated by `toBackupError`.
 */
export async function dumpPart(
  target: PartTarget,
  context: NamespaceDumpContext,
  options: PartDumpOptions,
): Promise<PartResult | VanishedPart> {
  try {
    const result = await dumpPartOnce(target, context, options);
    // Dropped before the read began: the cursor found nothing to kill.
    if (context.whenReplaced === "retry" && result.documents === 0) {
      if (!(await collectionExists(context, target))) return vanished(context, target);
    }
    return result;
  } catch (error) {
    if (context.whenReplaced !== "retry" || !isReplacedCollection(error)) throw error;
    if (!(await collectionExists(context, target))) return vanished(context, target);
    context.logger.info("A collection was replaced while it was backed up; reading it again", {
      ns: target.ns,
    });
    return dumpPartOnce(target, context, options);
  }
}

function vanished(context: NamespaceDumpContext, target: PartTarget): VanishedPart {
  context.logger.warn("A collection was dropped while it was backed up; it is left out", {
    ns: target.ns,
  });
  return { vanished: true };
}

/** One attempt of {@link dumpPart}. */
async function dumpPartOnce(
  target: PartTarget,
  context: NamespaceDumpContext,
  options: PartDumpOptions,
): Promise<PartResult> {
  const key = resolveBackupKey(context.backupId, target.key);
  // A converge backup reading from secondaries gets its own causally consistent
  // session per part, so the cursor's reads wait for T0 (see backup-reads.ts).
  const ownSession = await openReadAfterSession(context);
  try {
    throwIfAborted(options.signal);
    // Counting happens on raw documents (one Buffer per document), before compression,
    // so it measures documents and BSON bytes, which is what the manifest records.
    const onCounts = options.onCounts;
    const counter = createCountingStream(
      onCounts === undefined
        ? {}
        : { onProgress: (counts) => onCounts(counts.items, counts.bytes) },
    );
    // Build the transforms before opening the cursor: they validate their settings
    // synchronously, and a failure here must not leave a cursor open.
    const transforms = [
      counter.stream,
      ...(context.rateLimiter === undefined ? [] : [createThrottleStream(context.rateLimiter)]),
      // Many small documents → few large chunks, so compression runs at full speed.
      createCoalescer(),
      createCompressor(context.compression),
      ...encryptionTransforms(context),
    ];

    const session = context.session ?? ownSession;
    const collection = context.client.db(target.db).collection(target.collection);
    const cursors = [
      collection.find(options.query ?? {}, findOptionsFor(target, context, session)),
    ];
    // Index bounds are exclusive at the top even when only `min` is given, so the
    // last part of a split collection would miss a document whose `_id` is MaxKey
    // (`_id` is unique: there is at most one). It is read separately, last, which
    // is also where it sorts.
    if (target.bounds !== undefined && target.bounds.upper === undefined) {
      cursors.push(
        collection.find(withMaxKeyId(options.query), {
          raw: true,
          readPreference: context.readPreference,
          ...(session === undefined ? {} : { session }),
        }),
      );
    }

    context.writtenKeys.add(key);
    const replaced = { truncated: false };
    try {
      // A cursor stream fetches the next batch only when read, and destroying it
      // (which pipeline() does on any failure) closes the server-side cursor.
      const [onlyCursor] = cursors;
      const source =
        context.whenReplaced === "keep-partial"
          ? Readable.from(untilReplaced(cursors, replaced, context, target), { objectMode: true })
          : cursors.length === 1 && onlyCursor !== undefined
            ? onlyCursor.stream()
            : Readable.from(concatCursors(cursors), { objectMode: true });
      const digest = await writeStoredFile({
        storage: context.storage,
        key,
        source,
        transforms,
        contentType: BINARY_CONTENT_TYPE,
        retainUntil: context.retainUntil,
        signal: options.signal,
      });
      const counts = counter.counts();
      context.logger.debug("Wrote data file", { ns: target.ns, key, size: digest.size });
      return {
        file: { key: target.key, size: digest.size, sha256: digest.sha256 },
        documents: counts.items,
        bytesRaw: counts.bytes,
        truncated: replaced.truncated,
      };
    } finally {
      // Closing an exhausted or already-closed cursor is a no-op. On failure this
      // makes sure the server-side cursor is released even if the stream was never read.
      for (const cursor of cursors) {
        await cursor.close().catch((error: unknown) => {
          context.logger.debug("Closing a cursor failed", { ns: target.ns, error: String(error) });
        });
      }
    }
  } catch (error) {
    throw toBackupError(error, { ns: target.ns });
  } finally {
    await ownSession?.endSession().catch(() => undefined);
  }
}

/**
 * The find options of one part. Split parts are read through the `_id` index
 * between index bounds (`min` inclusive, `max` exclusive), in `_id` order; see
 * backup-parts.ts for why bounds and not `$gte`/`$lt`.
 */
function findOptionsFor(
  target: PartTarget,
  context: NamespaceDumpContext,
  session: ClientSession | undefined,
): FindOptions {
  const { bounds } = target;
  return {
    raw: true,
    readPreference: context.readPreference,
    ...(session === undefined ? {} : { session }),
    ...(target.batchSize === undefined ? {} : { batchSize: target.batchSize }),
    ...(bounds === undefined
      ? {}
      : {
          hint: ID_INDEX,
          sort: ID_INDEX,
          // In stored field order: an embedded-document bound with integer-like
          // names is another value in JavaScript order (see backup-parts.ts).
          ...(bounds.lower === undefined
            ? {}
            : { min: { _id: valueInStoredOrder(bounds.lower.value) } }),
          ...(bounds.upper === undefined
            ? {}
            : { max: { _id: valueInStoredOrder(bounds.upper.value) } }),
        }),
  };
}

/** The part's filter, narrowed to the document whose `_id` is MaxKey. */
function withMaxKeyId(query: Document | undefined): Document {
  const maxKeyId = { _id: new MaxKey() };
  return query === undefined ? maxKeyId : { $and: [query, maxKeyId] };
}

/**
 * {@link concatCursors}, ending quietly when the collection is dropped, renamed or
 * replaced under the cursor (`"keep-partial"`, see `ReplacedCollectionPolicy`).
 */
async function* untilReplaced(
  cursors: readonly FindCursor[],
  replaced: { truncated: boolean },
  context: NamespaceDumpContext,
  target: PartTarget,
): AsyncGenerator<unknown> {
  try {
    yield* concatCursors(cursors);
  } catch (error) {
    if (!isReplacedCollection(error)) throw error;
    replaced.truncated = true;
    context.logger.info(
      "A collection was dropped or replaced while it was backed up; the change window rebuilds it",
      { ns: target.ns, reason: error instanceof Error ? error.message : String(error) },
    );
  }
}

/**
 * True for the errors of a cursor whose collection was dropped, renamed or replaced
 * (`$out` drops and renames) under it: QueryPlanKilled with "collection dropped" or
 * "collection renamed", and NamespaceNotFound.
 */
export function isReplacedCollection(error: unknown): boolean {
  const cause = isMongoShieldError(error) ? error.cause : error;
  if (!(cause instanceof MongoServerError)) return false;
  if (cause.code === NAMESPACE_NOT_FOUND_CODE) return true;
  return (
    cause.code === QUERY_PLAN_KILLED_CODE && /collection (dropped|renamed)/i.test(cause.message)
  );
}

/** QueryPlanKilled: the cursor's plan died, e.g. its collection was dropped. */
const QUERY_PLAN_KILLED_CODE = 175;

/** NamespaceNotFound. */
const NAMESPACE_NOT_FOUND_CODE = 26;

/** True when the part's collection (or view) exists now. */
async function collectionExists(
  context: NamespaceDumpContext,
  target: PartTarget,
): Promise<boolean> {
  const found = await context.client
    .db(target.db)
    .listCollections({ name: target.collection }, { nameOnly: true, authorizedCollections: true })
    .toArray();
  return found.length > 0;
}

/** Yields every document of each cursor in turn (each is read only when needed). */
async function* concatCursors(cursors: readonly FindCursor[]): AsyncGenerator<unknown> {
  for (const cursor of cursors) {
    for await (const document of cursor) yield document;
  }
}

/**
 * A session whose reads wait for `readAfter`, or `undefined` when none is needed.
 *
 * A member only accepts `afterClusterTime` up to its own logical clock (otherwise:
 * InvalidOptions, "afterClusterTime value must not be greater than the current
 * clusterTime"), and a secondary's clock only moves when it replicates or is told a
 * later cluster time. The driver tells it what the *connection* last saw, or the
 * session's cluster time when that is later, and a fresh connection to a secondary
 * can lag the primary's T0. So the session first pings the primary, which gives it a
 * signed cluster time at or after T0 to gossip with every read. (The ping also moves
 * the session's operation time past T0, a little later inside the converge window,
 * which is just as correct.) If the ping fails, for example during an election, the
 * reads go ahead and report any lasting problem themselves.
 */
async function openReadAfterSession(
  context: NamespaceDumpContext,
): Promise<ClientSession | undefined> {
  if (context.readAfter === undefined || context.session !== undefined) return undefined;
  const session = context.client.startSession({ causalConsistency: true });
  try {
    await context.client
      .db("admin")
      .command({ ping: 1 }, { session, readPreference: ReadPreference.primaryPreferred });
  } catch {
    // See above: the cursor's own errors are the ones worth reporting.
  }
  // The driver sends `readConcern.afterClusterTime = operationTime` with every read
  // of a causally consistent session.
  session.advanceOperationTime(toTimestamp(context.readAfter));
  return session;
}

/** The encrypt stream for one file, or nothing for unencrypted backups. */
export function encryptionTransforms(context: NamespaceDumpContext): Transform[] {
  if (context.encryption === undefined) return [];
  // A new stream per file: age gives every file its own random file key.
  return [createEncryptStream({ recipients: context.encryption.recipients })];
}
