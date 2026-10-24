/**
 * The backup side of consistency mode `converge` (docs/specs/CONSISTENCY.md): records
 * every change made while collections are being dumped, so restore can replay them
 * and bring every collection to the same moment, the end of the window (T1).
 *
 *   T0 (read before discovery) ─▶ open a cluster-wide change stream at T0
 *     ─▶ background: getMore → filter → (enrich) → coalesce → compress → (encrypt)
 *                    → digest → storage.put of `_changes/window.bson…`
 *     ─▶ the collections are dumped meanwhile (backup.ts)
 *     ─▶ T1 = now ─▶ drain until the stream has passed T1 ─▶ drop events after T1
 *
 * Why the low-level `aggregate` / `getMore` commands instead of the driver's
 * ChangeStream: the drain must know how far the stream has read even when no event
 * arrives, which only the raw replies say (`postBatchResumeToken`, `operationTime`),
 * and `fieldsAsRaw` hands over each event as the exact bytes the server sent, which
 * are stored without being re-encoded.
 *
 * Backpressure: the events come from an async generator behind `Readable.from`, and
 * the generator only asks the server for the next batch when the storage side has
 * taken the previous ones. Memory stays flat however busy the database is.
 *
 * Failure is never silent: a lost history (`ChangeStreamHistoryLost`), a dropped
 * connection or a failed write fails the capture, which aborts the dumps and fails
 * the backup. A converge backup that missed events is never committed.
 */

import { Readable } from "node:stream";
import {
  BSON,
  type ClientSession,
  type Document,
  Long,
  type MongoClient,
  MongoServerError,
} from "mongodb";
import { createCompressor } from "../compression/index.ts";
import { createEncryptStream } from "../crypto/index.ts";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "../format/bson-stream.ts";
import { changesFileKey, resolveBackupKey } from "../format/layout.ts";
import type { ChangesFile, ClusterTime, Compression } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import { type CollectionSpec, compileNamespaceFilter, splitNamespace } from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { BackupOptions } from "../types.ts";
import { createCoalescer } from "./backup-coalesce.ts";
import { toBackupError } from "./backup-errors.ts";
import type { FileEncryption } from "./backup-key.ts";
import { writeStoredFile } from "./backup-write.ts";
import {
  type ChangeEvent,
  collectionNamespaceOf,
  needsFullDocument,
  parseChangeEvent,
} from "./converge-events.ts";
import { BINARY_COLLATION } from "./converge-operations.ts";
import {
  clusterTimeOfReply,
  clusterTimeOfResumeToken,
  compareClusterTimes,
  formatClusterTime,
  readLatestClusterTime,
  toTimestamp,
} from "./converge-time.ts";

/**
 * How long one `getMore` waits for new events before returning an empty batch. Short
 * enough that the drain and an abort react quickly, long enough not to spin.
 */
const AWAIT_DATA_MS = 1000;

/**
 * The drain normally ends within one `getMore` of T1. On a replica set whose majority
 * lags far behind, or a sharded cluster waiting for an idle shard's periodic no-op
 * write (every 10 s), it takes longer; past this the backup fails rather than hang.
 */
export const DRAIN_TIMEOUT_MS = 5 * 60_000;

/** Databases never backed up unless named explicitly (see namespace discovery). */
const INTERNAL_DATABASES = ["admin", "config", "local"];

/**
 * Collection-name prefix of the scratch collections `$out`, `$merge` and mapReduce
 * write into before renaming them over their target, e.g. `tmp.agg_out.<uuid>`.
 */
const SCRATCH_COLLECTION_PREFIX = "tmp.";

/** Server error codes that mean the change stream lost part of the window. */
const HISTORY_LOST_CODES = new Set([
  286, // ChangeStreamHistoryLost: the oplog no longer reaches back to T0
  280, // ChangeStreamFatalError: e.g. the resume point fell off the oplog
  136, // CappedPositionLost: the oplog rolled over under the cursor
]);

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/** Content type of the changes file (BSON, compressed and maybe encrypted). */
const BINARY_CONTENT_TYPE = "application/octet-stream";

/** Bytes of a reply's event batch are handed over unparsed; int64 cursor ids stay Longs. */
const RAW_BATCH_OPTIONS = {
  fieldsAsRaw: { firstBatch: true, nextBatch: true },
  promoteLongs: false,
} as const;

/** Re-encoding an enriched event exactly as it was parsed (see `LOSSLESS_DESERIALIZE_OPTIONS`). */
const SERIALIZE_OPTIONS = { checkKeys: false, ignoreUndefined: false } as const;

/** What `startChangeCapture` needs. */
export interface ChangeCaptureRequest {
  readonly client: MongoClient;
  readonly storage: StorageAdapter;
  readonly logger: Logger;
  readonly backupId: string;
  readonly compression: Compression;
  readonly encryption: FileEncryption | undefined;
  /** Receives the changes file's key before it is written, for cleanup on failure. */
  readonly writtenKeys: Set<string>;
  /** T0: the stream starts here. Read before namespace discovery. */
  readonly from: ClusterTime;
  /** The namespaces being backed up. */
  readonly specs: readonly CollectionSpec[];
  /** The backup's include/exclude patterns, so collections created later are kept too. */
  readonly include: BackupOptions["include"];
  readonly exclude: BackupOptions["exclude"];
  /** Version of the source deployment, for the manifest warnings. */
  readonly serverVersion: string;
  /** The caller's signal. */
  readonly signal: AbortSignal | undefined;
  /** Write-once retention for the changes file (`backup({ retainDays })`). */
  readonly retainUntil?: Date | undefined;
}

/** The captured window, for the manifest. */
export interface CapturedWindow {
  readonly from: ClusterTime;
  readonly to: ClusterTime;
  readonly file: ChangesFile;
  /** Known limits that apply to this backup, for `consistency.warning`. */
  readonly warnings: readonly string[];
}

/** A running capture. */
export interface ChangeCapture {
  /**
   * Fires when the capture fails (or the caller's signal fires). Pass it to the dumps
   * so they stop at once: the backup is lost anyway.
   */
  readonly signal: AbortSignal;
  /** Why the capture failed, once it has. */
  readonly failure: MongoShieldError | undefined;
  /** Records that a namespace's dump has finished (see `#needsDestinationSnapshot`). */
  markDumped(ns: string): Promise<void>;
  /** Reads T1, drains the stream up to it and completes the changes file. */
  finish(): Promise<CapturedWindow>;
  /** Stops capturing after a failure elsewhere. Never throws. */
  stop(): Promise<void>;
}

/**
 * Opens the change stream at `request.from` and starts writing the changes file in
 * the background.
 *
 * @throws MongoShieldError `MS_PERMISSION_DENIED` without change stream privileges,
 *   `MS_CHANGE_HISTORY_LOST` when the oplog no longer reaches back to T0.
 */
export async function startChangeCapture(request: ChangeCaptureRequest): Promise<ChangeCapture> {
  const scope = createCaptureScope(request.specs, request);
  // getMore must run in the session that opened the cursor. No causal consistency:
  // it would only add `afterClusterTime` to commands that do not need it.
  const session = request.client.startSession({ causalConsistency: false });
  let reply: Document;
  try {
    reply = await request.client.db("admin").command(
      {
        aggregate: 1,
        pipeline: [
          {
            $changeStream: {
              allChangesForCluster: true,
              startAtOperationTime: toTimestamp(request.from),
              // DDL events (create, rename, …) and `disambiguatedPaths` need this.
              showExpandedEvents: true,
            },
          },
          { $match: scope.serverFilter },
        ],
        cursor: {},
      },
      { session, ...RAW_BATCH_OPTIONS },
    );
  } catch (error) {
    await session.endSession().catch(() => {});
    throw toCaptureError(error, request.from);
  }

  const capture = new CaptureRun(request, scope, session, reply);
  request.logger.debug("Capturing changes", { from: formatClusterTime(request.from) });
  return capture;
}

// ---------------------------------------------------------------------------
// Which events belong to the backup
// ---------------------------------------------------------------------------

/** Decides which change events the capture keeps. */
export interface CaptureScope {
  /** `$match` run by the server, to skip whole databases cheaply. */
  readonly serverFilter: Document;
  /** True for collection namespaces whose changes belong in the window. */
  keepsNamespace(ns: string): boolean;
  /** True for events that belong in the window. */
  keeps(event: ChangeEvent): boolean;
}

/**
 * The namespaces whose changes are kept:
 *
 * - every namespace being backed up;
 * - collections created during the window that the backup's patterns select, so a
 *   collection created after discovery is restored from its events;
 * - scratch collections (`tmp.*`) in the databases being backed up, because `$out`
 *   and `$merge` fill one and then rename it over their target;
 * - `dropDatabase` of any database that may hold such namespaces.
 *
 * `system.*` collections never produce events that matter: the server reports changes
 * to time series and views through their user-facing namespaces (or not at all).
 */
export function createCaptureScope(
  specs: readonly CollectionSpec[],
  patterns: Pick<ChangeCaptureRequest, "include" | "exclude">,
): CaptureScope {
  const backedUp = new Set(specs.map((spec) => spec.ns));
  const databases = new Set(specs.map((spec) => spec.db));
  const matchesPatterns = compileNamespaceFilter(patterns);
  const isUserDatabase = (db: string) => databases.has(db) || !INTERNAL_DATABASES.includes(db);

  const keepsNamespace = (ns: string): boolean => {
    if (backedUp.has(ns)) return true;
    const { database, collection } = splitNamespace(ns);
    if (collection.startsWith("system.") || !isUserDatabase(database)) return false;
    if (collection.startsWith(SCRATCH_COLLECTION_PREFIX) && databases.has(database)) return true;
    return matchesPatterns(ns);
  };

  const keeps = (event: ChangeEvent): boolean => {
    if (event.operationType === "dropDatabase") {
      return event.ns !== undefined && isUserDatabase(event.ns.db);
    }
    const ns = collectionNamespaceOf(event.ns);
    if (ns === undefined) return false;
    if (keepsNamespace(ns)) return true;
    // A rename into a kept namespace matters even when its source does not.
    const to = collectionNamespaceOf(event.to);
    return event.operationType === "rename" && to !== undefined && keepsNamespace(to);
  };

  const skippedDatabases = INTERNAL_DATABASES.filter((db) => !databases.has(db));
  return {
    serverFilter: { "ns.db": { $nin: skippedDatabases } },
    keepsNamespace,
    keeps,
  };
}

// ---------------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------------

/** One running capture: the stream reader, the file writer and the bookkeeping. */
class CaptureRun implements ChangeCapture {
  readonly signal: AbortSignal;
  readonly #request: ChangeCaptureRequest;
  readonly #scope: CaptureScope;
  readonly #session: ClientSession;
  readonly #relativeKey: string;
  /** Aborts the capture: on failure, on stop(), and (linked) on the caller's abort. */
  readonly #controller = new AbortController();
  readonly #writing: Promise<{ readonly size: number; readonly sha256: string }>;
  readonly #warnings: string[];

  /** The first reply, consumed by the generator. */
  #firstReply: Document | undefined;
  /** The server cursor, until it is exhausted or killed. */
  #cursorId: Long | number | undefined;
  #failure: MongoShieldError | undefined;
  #stopping = false;
  /** T1, once `finish()` has read it. */
  #stopAt: ClusterTime | undefined;
  #drainStartedAt = 0;
  #events = 0;

  /** First cluster time of a `create` event per namespace. */
  readonly #createdAt = new Map<string, ClusterTime>();
  /** Cluster time read right after each namespace's dump finished. */
  readonly #dumpedAt = new Map<string, ClusterTime>();

  constructor(
    request: ChangeCaptureRequest,
    scope: CaptureScope,
    session: ClientSession,
    firstReply: Document,
  ) {
    this.#request = request;
    this.#scope = scope;
    this.#session = session;
    this.#firstReply = firstReply;
    this.#cursorId = cursorIdOf(firstReply);
    this.#warnings = initialWarnings(request);
    this.signal =
      request.signal === undefined
        ? this.#controller.signal
        : AbortSignal.any([this.#controller.signal, request.signal]);

    this.#relativeKey = changesFileKey({
      compression: request.compression,
      encrypted: request.encryption !== undefined,
    });
    const key = resolveBackupKey(request.backupId, this.#relativeKey);
    request.writtenKeys.add(key);

    // Build the transforms first: they validate their settings synchronously.
    const transforms = [
      createCoalescer(),
      createCompressor(request.compression),
      ...(request.encryption === undefined
        ? []
        : [createEncryptStream({ recipients: request.encryption.recipients })]),
    ];
    this.#writing = writeStoredFile({
      storage: request.storage,
      key,
      source: Readable.from(this.#readEvents(), { objectMode: true }),
      transforms,
      contentType: BINARY_CONTENT_TYPE,
      retainUntil: request.retainUntil,
      signal: this.signal,
    });
    // Fail fast: a capture error aborts the dumps through `signal`.
    this.#writing.catch((error: unknown) => this.#fail(error));
  }

  get failure(): MongoShieldError | undefined {
    return this.#failure;
  }

  async markDumped(ns: string): Promise<void> {
    // Erring late is the safe side here: a later "dumped at" only makes more renames
    // take a destination snapshot (see #needsDestinationSnapshot).
    this.#dumpedAt.set(ns, await readLatestClusterTime(this.#request.client));
  }

  async finish(): Promise<CapturedWindow> {
    const { from } = this.#request;
    let digest: { readonly size: number; readonly sha256: string };
    try {
      if (this.#failure !== undefined) throw this.#failure;
      // T1 must not be earlier than anything the dump read: see readLatestClusterTime.
      const to = await readLatestClusterTime(this.#request.client);
      this.#stopAt = to;
      this.#drainStartedAt = performance.now();
      this.#request.logger.debug("Draining the change stream", { to: formatClusterTime(to) });
      digest = await this.#writing;
    } catch (error) {
      throw this.#failure ?? toCaptureError(error, from);
    } finally {
      await this.#release();
    }

    const to = this.#stopAt;
    if (to === undefined) throw new MongoShieldError("MS_INTERNAL", "The capture has no end.");
    this.#request.logger.info("Captured the changes of the backup window", {
      from: formatClusterTime(from),
      to: formatClusterTime(to),
      events: this.#events,
      bytesStored: digest.size,
    });
    return {
      from,
      to,
      file: {
        key: this.#relativeKey,
        size: digest.size,
        sha256: digest.sha256,
        events: this.#events,
      },
      warnings: this.#warnings,
    };
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#controller.abort();
    await this.#writing.catch(() => {});
    await this.#release();
  }

  /** Records the first failure and aborts everything listening to `signal`. */
  #fail(error: unknown): void {
    if (this.#stopping || this.#failure !== undefined) return;
    this.#failure =
      this.#request.signal?.aborted === true
        ? abortError(this.#request.signal)
        : toCaptureError(error, this.#request.from);
    this.#controller.abort(this.#failure);
  }

  /**
   * The event source of the changes file. Yields the raw bytes of every kept event,
   * fetching the next batch only when the previous one has been consumed.
   */
  async *#readEvents(): AsyncGenerator<Buffer> {
    let reply = this.#firstReply ?? {};
    this.#firstReply = undefined;
    let batch = batchOf(reply, "firstBatch");

    for (;;) {
      let passedEnd = false;
      for (const raw of batch) {
        const event = parseChangeEvent(raw);
        if (event.operationType === "invalidate") throw streamInvalidated();
        // Events arrive in cluster-time order: once one is past T1, so is the rest.
        if (
          this.#stopAt !== undefined &&
          compareClusterTimes(event.clusterTime, this.#stopAt) > 0
        ) {
          passedEnd = true;
          break;
        }
        if (!this.#scope.keeps(event)) continue;
        this.#remember(event);
        this.#events += 1;
        yield await this.#storedBytes(raw, event);
        if (this.#needsDestinationSnapshot(event)) yield* this.#destinationSnapshot(event);
      }
      if (passedEnd || this.#reachedEnd(reply, batch.length)) return;

      throwIfAborted(this.signal);
      this.#assertDrainInTime();
      reply = await this.#getMore();
      batch = batchOf(reply, "nextBatch");
    }
  }

  /**
   * True once every event up to T1 has been returned. The resume token after a batch
   * (`postBatchResumeToken`) marks how far the stream has read, even when no event
   * matched: past T1, or at T1 with nothing left to return, means done. Without a
   * readable token, an empty batch whose `operationTime` reached T1 is used instead.
   *
   * (`operationTime` alone is not enough: a full batch returns before the stream has
   * read everything up to it.)
   */
  #reachedEnd(reply: Document, batchSize: number): boolean {
    const stopAt = this.#stopAt;
    if (stopAt === undefined) return false;
    const cursor = asDocument(reply.cursor);
    const position = clusterTimeOfResumeToken(cursor?.postBatchResumeToken);
    if (position !== undefined) {
      const comparison = compareClusterTimes(position, stopAt);
      return comparison > 0 || (comparison === 0 && batchSize === 0);
    }
    const operationTime = clusterTimeOfReply(reply);
    return (
      batchSize === 0 &&
      operationTime !== undefined &&
      compareClusterTimes(operationTime, stopAt) >= 0
    );
  }

  #assertDrainInTime(): void {
    if (this.#stopAt === undefined) return;
    if (performance.now() - this.#drainStartedAt <= DRAIN_TIMEOUT_MS) return;
    throw new MongoShieldError(
      "MS_TIMEOUT",
      `The change stream did not reach the end of the backup window (${formatClusterTime(this.#stopAt)}) within ${DRAIN_TIMEOUT_MS / 60_000} minutes.`,
      {
        hint: "The replica set's majority may be lagging far behind. Check replication, then run the backup again.",
      },
    );
  }

  async #getMore(): Promise<Document> {
    const cursorId = this.#cursorId;
    if (cursorId === undefined || isZero(cursorId)) throw streamInvalidated();
    const reply = await this.#request.client
      .db("admin")
      .command(
        { getMore: cursorId, collection: "$cmd.aggregate", maxTimeMS: AWAIT_DATA_MS },
        { session: this.#session, ...RAW_BATCH_OPTIONS },
      );
    this.#cursorId = cursorIdOf(reply) ?? cursorId;
    return reply;
  }

  /** Bookkeeping for `#needsDestinationSnapshot`. */
  #remember(event: ChangeEvent): void {
    const ns = collectionNamespaceOf(event.ns);
    if (event.operationType === "create" && ns !== undefined && !this.#createdAt.has(ns)) {
      this.#createdAt.set(ns, event.clusterTime);
    }
  }

  /**
   * The bytes to store for an event: the server's own, except for updates that
   * replay cannot express as `$set`/`$unset` (see `needsFullDocument`). For those the
   * document is read as it was right after the update (a snapshot read at the event's
   * cluster time) and stored in the event's `fullDocument`, like `updateLookup` would.
   */
  async #storedBytes(raw: Uint8Array, event: ChangeEvent): Promise<Buffer> {
    const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    if (!needsFullDocument(event)) return bytes;

    const document = await this.#documentAt(event);
    if (document === undefined) {
      this.#addWarning(
        "Some updates to field names containing dots or starting with $ could not be recorded; restore skips them.",
      );
      return bytes;
    }
    const enriched = { ...event.document, fullDocument: document };
    return Buffer.from(BSON.serialize(enriched, SERIALIZE_OPTIONS));
  }

  /** The changed document as of the event's cluster time, or undefined if it cannot be read. */
  async #documentAt(event: ChangeEvent): Promise<Document | undefined> {
    const db = event.ns?.db;
    const collection = event.ns?.coll;
    if (db === undefined || collection === undefined) return undefined;
    try {
      const reply = await this.#request.client.db(db).command(
        {
          find: collection,
          filter: { _id: event.documentKey?._id },
          limit: 1,
          singleBatch: true,
          collation: BINARY_COLLATION,
          readConcern: { level: "snapshot", atClusterTime: toTimestamp(event.clusterTime) },
        },
        { fieldsAsRaw: { firstBatch: true } },
      );
      const [found] = batchOf(reply, "firstBatch");
      return found === undefined
        ? undefined
        : BSON.deserialize(found, LOSSLESS_DESERIALIZE_OPTIONS);
    } catch (error) {
      this.#request.logger.debug("Reading a document at an update's cluster time failed", {
        ns: `${db}.${collection}`,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * A rename `from → to` replays as "`to` becomes `from` as it was at the rename". That
   * is only right if the backup holds `from` as of the rename: when `from` was created
   * inside the window (all of its documents are events; this is how a `$out` that
   * starts during the backup works), or its dump finished before the rename.
   * Otherwise (a `$out` that started before T0, a collection renamed before it was
   * dumped) the backup does not know what `from` held, and `#destinationSnapshot`
   * records `to` as it was right after the rename instead.
   */
  #needsDestinationSnapshot(event: ChangeEvent): boolean {
    if (event.operationType !== "rename") return false;
    const from = collectionNamespaceOf(event.ns);
    const to = collectionNamespaceOf(event.to);
    // A rename out of the backed-up namespaces replays as a drop: always fine.
    if (from === undefined || to === undefined || !this.#scope.keepsNamespace(to)) return false;
    const createdAt = this.#createdAt.get(from);
    if (createdAt !== undefined && compareClusterTimes(createdAt, event.clusterTime) <= 0) {
      return false;
    }
    const dumpedAt = this.#dumpedAt.get(from);
    return dumpedAt === undefined || compareClusterTimes(dumpedAt, event.clusterTime) >= 0;
  }

  /**
   * Records the rename's destination as it was right after the rename, as events with
   * the rename's cluster time that follow the rename in the file: a `drop` and a
   * `create` (empty it, but keep it), then one `insert` per document, read with a
   * snapshot read at that cluster time. They carry `synthesized: true` (see FORMAT.md).
   * Replaying them makes the destination exactly what it was at the rename, whatever
   * the renamed collection held. Fails the backup when the snapshot read fails (for
   * example when the capture fell further behind than the snapshot window).
   */
  async *#destinationSnapshot(event: ChangeEvent): AsyncGenerator<Buffer> {
    const to = event.to;
    if (to?.coll === undefined) return;
    const ns = { db: to.db, coll: to.coll };
    const clusterTime = toTimestamp(event.clusterTime);
    const synthesized = (fields: Document): Buffer => {
      this.#events += 1;
      const document = { ...fields, clusterTime, ns, synthesized: true };
      return Buffer.from(BSON.serialize(document, SERIALIZE_OPTIONS));
    };
    this.#request.logger.debug("Recording a rename's destination as of the rename", {
      ns: `${ns.db}.${ns.coll}`,
      at: formatClusterTime(event.clusterTime),
    });

    yield synthesized({ operationType: "drop" });
    yield synthesized({ operationType: "create", operationDescription: {} });
    for await (const raw of this.#snapshotDocuments(ns.db, ns.coll, clusterTime)) {
      const fullDocument = BSON.deserialize(raw, LOSSLESS_DESERIALIZE_OPTIONS);
      yield synthesized({
        operationType: "insert",
        documentKey: { _id: fullDocument._id },
        fullDocument,
      });
    }
  }

  /** Every document of a collection as of `atClusterTime`, batch by batch. */
  async *#snapshotDocuments(
    db: string,
    collection: string,
    atClusterTime: ReturnType<typeof toTimestamp>,
  ): AsyncGenerator<Uint8Array> {
    // The cursor's getMores must run in the session of its find.
    const session = this.#request.client.startSession({ causalConsistency: false });
    const database = this.#request.client.db(db);
    let cursorId: Long | number | undefined;
    try {
      let reply = await database.command(
        {
          find: collection,
          filter: {},
          readConcern: { level: "snapshot", atClusterTime },
        },
        { session, ...RAW_BATCH_OPTIONS },
      );
      cursorId = cursorIdOf(reply);
      yield* batchOf(reply, "firstBatch");
      while (cursorId !== undefined && !isZero(cursorId)) {
        throwIfAborted(this.signal);
        reply = await database.command(
          { getMore: cursorId, collection },
          { session, ...RAW_BATCH_OPTIONS },
        );
        cursorId = cursorIdOf(reply);
        yield* batchOf(reply, "nextBatch");
      }
    } finally {
      if (cursorId !== undefined && !isZero(cursorId)) {
        await database
          .command({ killCursors: collection, cursors: [cursorId] }, { session })
          .catch(() => {});
      }
      await session.endSession().catch(() => {});
    }
  }

  #addWarning(warning: string): void {
    if (!this.#warnings.includes(warning)) this.#warnings.push(warning);
  }

  /** Kills the server cursor and ends the session. Safe to call more than once. */
  async #release(): Promise<void> {
    const cursorId = this.#cursorId;
    this.#cursorId = undefined;
    const { client, logger } = this.#request;
    try {
      if (cursorId !== undefined && !isZero(cursorId)) {
        await client
          .db("admin")
          .command(
            { killCursors: "$cmd.aggregate", cursors: [cursorId] },
            { session: this.#session },
          );
      }
    } catch (error) {
      logger.debug("Closing the change stream failed", { error: String(error) });
    }
    await this.#session.endSession().catch((error: unknown) => {
      logger.debug("Ending the change stream session failed", { error: String(error) });
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Limits known up front, recorded in the manifest's `consistency.warning`:
 *
 * - Change streams do not report writes to time series collections (they go to the
 *   internal buckets), so those are restored as read, like in mode `none`.
 * - Before MongoDB 6.1 change events lack `disambiguatedPaths`, so an update to a
 *   field whose name contains a dot looks like an update to a nested field.
 */
function initialWarnings(request: ChangeCaptureRequest): string[] {
  const warnings: string[] = [];
  const timeSeries = request.specs.filter((spec) => spec.type === "timeseries");
  if (timeSeries.length > 0) {
    warnings.push(
      `Time series collections are restored as read, without converging (change streams do not report their writes): ${timeSeries.map((spec) => spec.ns).join(", ")}.`,
    );
  }
  if (!hasDisambiguatedPaths(request.serverVersion)) {
    warnings.push(
      `MongoDB ${request.serverVersion} does not report disambiguatedPaths (6.1+): updates to field names containing dots may replay as nested fields.`,
    );
  }
  return warnings;
}

function hasDisambiguatedPaths(serverVersion: string): boolean {
  const [major = 0, minor = 0] = serverVersion.split(".").map((part) => Number.parseInt(part, 10));
  return major > 6 || (major === 6 && minor >= 1);
}

/** The raw events of a cursor reply's batch. */
function batchOf(reply: Document, field: "firstBatch" | "nextBatch"): Uint8Array[] {
  const batch: unknown = asDocument(reply.cursor)?.[field];
  if (!Array.isArray(batch)) return [];
  return batch.filter((item): item is Uint8Array => item instanceof Uint8Array);
}

function cursorIdOf(reply: Document): Long | number | undefined {
  const id: unknown = asDocument(reply.cursor)?.id;
  if (typeof id === "number" || id instanceof Long) return id;
  return undefined;
}

function isZero(cursorId: Long | number): boolean {
  return typeof cursorId === "number" ? cursorId === 0 : cursorId.isZero();
}

function asDocument(value: unknown): Document | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

function streamInvalidated(): MongoShieldError {
  return new MongoShieldError(
    "MS_INTERNAL",
    "The change stream of the backup window was closed by the server.",
    { hint: "Run the backup again; if it keeps happening, report it as a bug." },
  );
}

/**
 * Translates capture failures. Lost history and missing privileges get their own
 * explanation; everything else is translated like any backup error.
 */
export function toCaptureError(error: unknown, from: ClusterTime): MongoShieldError {
  if (error instanceof MongoShieldError) return error;
  if (error instanceof MongoServerError && typeof error.code === "number") {
    if (HISTORY_LOST_CODES.has(error.code)) {
      return new MongoShieldError(
        "MS_CHANGE_HISTORY_LOST",
        `The oplog no longer holds every change since the backup started (cluster time ${formatClusterTime(from)}), so the backup cannot converge: ${error.message}`,
        {
          cause: error,
          hint: 'The oplog window is too small for how long the backup takes: increase the oplog size (replSetResizeOplog), back up fewer namespaces per run, or use consistency "none".',
          details: { serverCode: error.code },
        },
      );
    }
    if (error.code === UNAUTHORIZED_CODE) {
      return new MongoShieldError(
        "MS_PERMISSION_DENIED",
        `MongoDB refused to open a change stream for consistency "converge": ${error.message}`,
        {
          cause: error,
          hint: 'Converge needs the changeStream and find actions on every database (e.g. the readAnyDatabase role), or use consistency "none".',
        },
      );
    }
  }
  return toBackupError(error);
}
