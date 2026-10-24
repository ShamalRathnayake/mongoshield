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
 * The stream itself (converge-stream.ts) uses the low-level `aggregate` / `getMore`
 * commands, because the drain must know how far the stream has read even when no
 * event arrives (`postBatchResumeToken`, `operationTime`) and the events are stored as
 * the exact bytes the server sent. It also reassembles events the server split
 * (`$changeStreamSplitLargeEvent`) and resumes after transient errors (a dropped
 * connection, a killed session) from the last batch's resume token.
 *
 * Backpressure: the events come from an async generator behind `Readable.from`, and
 * the generator only asks the server for the next batch when the storage side has
 * taken the previous ones. Memory stays flat however busy the database is.
 *
 * Failure is never silent: a lost history (`ChangeStreamHistoryLost`), a connection
 * that stays down after the stream's bounded resume attempts, or a failed write fails
 * the capture, which aborts the dumps and fails the backup. A converge backup that
 * missed events is never committed.
 */

import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { type Document, Long, type MongoClient, MongoServerError } from "mongodb";
import { createCompressor } from "../compression/index.ts";
import { createEncryptStream } from "../crypto/index.ts";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { deserializeInStoredOrder, valueInStoredOrder } from "../format/field-order.ts";
import { changesFileKey, resolveBackupKey } from "../format/layout.ts";
import type { ChangesFile, ClusterTime, Compression } from "../format/manifest.ts";
import { laterOf, predecessor } from "../journal/time.ts";
import type { Logger } from "../logger.ts";
import { type CollectionSpec, compileNamespaceFilter, splitNamespace } from "../mongo/index.ts";
import { compileNamespaceRules } from "../mongo/namespace-filter.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { BackupOptions } from "../types.ts";
import { createCoalescer } from "./backup-coalesce.ts";
import { isCatalogChangedUnderSnapshot, toBackupError } from "./backup-errors.ts";
import type { FileEncryption } from "./backup-key.ts";
import { writeStoredFile } from "./backup-write.ts";
import {
  type ChangeEvent,
  collectionNamespaceOf,
  needsFullDocument,
  serializeChangeEvent,
} from "./converge-events.ts";
import { BINARY_COLLATION } from "./converge-operations.ts";
import {
  type ChangeStreamBatch,
  HISTORY_LOST_CODES,
  ResumableChangeStream,
  type ResumePolicy,
  serverDatabaseFilter,
} from "./converge-stream.ts";
import {
  compareClusterTimes,
  formatClusterTime,
  readClusterTime,
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

/**
 * Reads of a rename's destination that the server refuses because the collection's
 * catalog entry changed at or after the requested time (sharded clusters, see
 * `#openDestinationRead`): attempts, and the wait before the n-th retry (n times this).
 * Ten attempts wait 25 + 50 + … + 225 ms, about 1.1 s in all: the rename's catalog
 * change commits on the shard within milliseconds of its change event, and short
 * waits give a collection that is replaced again and again (a `$out` loop) the best
 * chance to be read between two replacements.
 */
export const DESTINATION_READ_ATTEMPTS = 10;
const DESTINATION_RETRY_DELAY_MS = 25;

/** Databases never backed up unless named explicitly (see namespace discovery). */
const INTERNAL_DATABASES = ["admin", "config", "local"];

/**
 * Collection-name prefix of the scratch collections `$out`, `$merge` and mapReduce
 * write into before renaming them over their target, e.g. `tmp.agg_out.<uuid>`.
 */
const SCRATCH_COLLECTION_PREFIX = "tmp.";

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/** Content type of the changes file (BSON, compressed and maybe encrypted). */
const BINARY_CONTENT_TYPE = "application/octet-stream";

/** Bytes of a reply's event batch are handed over unparsed; int64 cursor ids stay Longs. */
const RAW_BATCH_OPTIONS = {
  fieldsAsRaw: { firstBatch: true, nextBatch: true },
  promoteLongs: false,
} as const;

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
  /**
   * Write the server-side database filter with regexes only (no `$in` / `$nin`):
   * Atlas Free and Flex clusters refuse operators in `ns.db` filters of change streams.
   */
  readonly regexDatabaseFilter?: boolean | undefined;
  /** The caller's signal. */
  readonly signal: AbortSignal | undefined;
  /** Write-once retention for the changes file (`backup({ retainDays })`). */
  readonly retainUntil?: Date | undefined;
  /** How the change stream is reopened after transient errors (tests shorten it). */
  readonly resume?: ResumePolicy | undefined;
  /**
   * What the window is for. `"converge"` (the default): the changes made while the
   * collections are dumped. `"incremental"`: the changes since a parent backup ended
   * (backup-incremental.ts), where nothing is dumped. Two things differ for those:
   *
   * - The restore of an incremental already holds every kept namespace as of `from`
   *   (the chain before it restored them), so a rename out of a kept namespace never
   *   needs its destination recorded as of the rename (see `#needsDestinationSnapshot`).
   * - The drain catches up on everything since the parent, which can take a while on
   *   a busy deployment; it only times out when the stream stops making progress.
   */
  readonly purpose?: "converge" | "incremental" | undefined;
  /** How long the drain may take (or, for incrementals, stall). Defaults to {@link DRAIN_TIMEOUT_MS}. */
  readonly drainTimeoutMs?: number | undefined;
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
  /**
   * Reads T1, drains the stream up to it and completes the changes file. An
   * incremental may name its end itself (`end`, the time of its time series snapshot;
   * see backup-incremental.ts); it is never earlier than the window's start.
   */
  finish(end?: ClusterTime): Promise<CapturedWindow>;
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
  // Aborts the capture: on failure, on stop(), and (linked) on the caller's abort.
  const controller = new AbortController();
  const signal =
    request.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, request.signal]);
  const stream = await ResumableChangeStream.open({
    client: request.client,
    startAt: request.from,
    match: scope.serverFilter,
    comment: `mongoshield backup ${request.backupId} (${request.purpose ?? "converge"})`,
    logger: request.logger,
    signal,
    awaitDataMs: AWAIT_DATA_MS,
    resume: request.resume,
    toError: (error) => toCaptureError(error, request.from),
  });

  const capture = new CaptureRun(request, scope, stream, controller, signal);
  request.logger.debug("Capturing changes", { from: formatClusterTime(request.from) });
  return capture;
}

// ---------------------------------------------------------------------------
// Which events belong to the backup
// ---------------------------------------------------------------------------

/** Decides which change events the capture keeps. */
export interface CaptureScope {
  /** `$match` run by the server, to skip whole databases cheaply (`serverDatabaseFilter`). */
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
  patterns: Pick<ChangeCaptureRequest, "include" | "exclude" | "regexDatabaseFilter">,
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

  return {
    serverFilter: serverDatabaseFilter(
      compileNamespaceRules(patterns),
      databases,
      INTERNAL_DATABASES,
      { regexOnly: patterns.regexDatabaseFilter === true },
    ),
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
  readonly #stream: ResumableChangeStream;
  readonly #relativeKey: string;
  /** Aborts the capture: on failure, on stop(), and (linked) on the caller's abort. */
  readonly #controller: AbortController;
  readonly #writing: Promise<{ readonly size: number; readonly sha256: string }>;
  readonly #warnings: string[];

  #failure: MongoShieldError | undefined;
  #stopping = false;
  /** T1, once `finish()` has read it. */
  #stopAt: ClusterTime | undefined;
  #drainStartedAt = 0;
  /** When the stream last moved forward (incrementals time out on a stall, see the request). */
  #lastProgressAt = 0;
  /** The latest time a rename's destination was read at after a refusal (see #extendEnd). */
  #latestDestinationRead: ClusterTime | undefined;
  #events = 0;

  /** First cluster time of a `create` event per namespace. */
  readonly #createdAt = new Map<string, ClusterTime>();
  /** Cluster time read right after each namespace's dump finished. */
  readonly #dumpedAt = new Map<string, ClusterTime>();

  constructor(
    request: ChangeCaptureRequest,
    scope: CaptureScope,
    stream: ResumableChangeStream,
    controller: AbortController,
    signal: AbortSignal,
  ) {
    this.#request = request;
    this.#scope = scope;
    this.#stream = stream;
    this.#controller = controller;
    this.signal = signal;
    this.#warnings = initialWarnings(request);

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

  async finish(end?: ClusterTime): Promise<CapturedWindow> {
    const { from } = this.#request;
    let digest: { readonly size: number; readonly sha256: string };
    try {
      if (this.#failure !== undefined) throw this.#failure;
      const to = await this.#readEnd(end);
      // Never before a destination read at a later time (see #extendEnd).
      const latestRead = this.#latestDestinationRead;
      this.#stopAt =
        latestRead !== undefined && compareClusterTimes(latestRead, to) > 0 ? latestRead : to;
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

  /**
   * T1. A converge window must not end earlier than anything its dumps read, so it
   * reads the logical clock, erring late (readLatestClusterTime). An incremental reads
   * no documents: any end works as long as the drain records every event up to it, so
   * it takes the time of the last write the node applied (operationTime), which the
   * stream reaches at once. The logical clock can be ahead of the last oplog entry (a
   * batched delete reserves a timestamp per document but writes one entry), and on an
   * idle deployment the stream would only pass it at the next periodic no-op write, up
   * to 10 s and more later. It never ends before the window starts.
   */
  async #readEnd(end: ClusterTime | undefined): Promise<ClusterTime> {
    const { client, purpose, from } = this.#request;
    if (purpose !== "incremental") return readLatestClusterTime(client);
    return laterOf(end ?? (await readClusterTime(client)), predecessor(from));
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
    for (;;) {
      const batch = await this.#stream.next();
      let passedEnd = false;
      for (const { raw, event } of batch.events) {
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
      if (passedEnd || this.#reachedEnd(batch)) return;
      if (batch.events.length > 0 || batch.position !== undefined) {
        this.#lastProgressAt = performance.now();
      }

      throwIfAborted(this.signal);
      this.#assertDrainInTime();
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
  #reachedEnd(batch: ChangeStreamBatch): boolean {
    const stopAt = this.#stopAt;
    if (stopAt === undefined) return false;
    if (batch.position !== undefined) {
      const comparison = compareClusterTimes(batch.position, stopAt);
      return comparison > 0 || (comparison === 0 && batch.empty);
    }
    return (
      batch.empty &&
      batch.operationTime !== undefined &&
      compareClusterTimes(batch.operationTime, stopAt) >= 0
    );
  }

  #assertDrainInTime(): void {
    if (this.#stopAt === undefined) return;
    const timeoutMs = this.#request.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    // An incremental's drain is its whole job: only a stream that stops moving fails.
    const incremental = this.#request.purpose === "incremental";
    const since = incremental
      ? Math.max(this.#drainStartedAt, this.#lastProgressAt)
      : this.#drainStartedAt;
    if (performance.now() - since <= timeoutMs) return;
    throw new MongoShieldError(
      "MS_TIMEOUT",
      `The change stream did not reach the end of the backup window (${formatClusterTime(this.#stopAt)}) ${incremental ? "and made no progress for" : "within"} ${formatMinutes(timeoutMs)}.`,
      {
        hint: "The replica set's majority may be lagging far behind. Check replication, then run the backup again.",
      },
    );
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
    return serializeChangeEvent({ ...event.document, fullDocument: document });
  }

  /**
   * The changed document as of the event's cluster time, or undefined if it cannot be
   * read.
   *
   * Field order (src/format/field-order.ts): an embedded-document `_id` is looked up
   * in its stored order, because the server compares embedded documents field by
   * field and the reordered JavaScript object would match nothing. The document read
   * keeps its stored order too, so `serializeChangeEvent` writes it byte for byte.
   */
  async #documentAt(event: ChangeEvent): Promise<Document | undefined> {
    const db = event.ns?.db;
    const collection = event.ns?.coll;
    if (db === undefined || collection === undefined) return undefined;
    try {
      const reply = await this.#request.client.db(db).command(
        {
          find: collection,
          filter: { _id: valueInStoredOrder(event.documentKey?._id) },
          limit: 1,
          singleBatch: true,
          collation: BINARY_COLLATION,
          readConcern: { level: "snapshot", atClusterTime: toTimestamp(event.clusterTime) },
        },
        { fieldsAsRaw: { firstBatch: true } },
      );
      const [found] = batchOf(reply, "firstBatch");
      return found === undefined ? undefined : deserializeInStoredOrder(found);
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
    // Incrementals: the chain before this window holds every kept namespace as of the
    // window's start, and every later change of it is in the window, so the restore
    // knows exactly what `from` held at the rename. Scratch collections are the
    // exception: a chain replays them only when their rename lands in the same window.
    if (
      this.#request.purpose === "incremental" &&
      this.#scope.keepsNamespace(from) &&
      !splitNamespace(from).collection.startsWith(SCRATCH_COLLECTION_PREFIX)
    ) {
      return false;
    }
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
   *
   * The read may happen at a later time than the rename (see `#openDestinationRead`):
   * the records then hold the destination as of that later time, still stamped with
   * the rename's cluster time, and the events between the two follow in the file.
   * Replaying them onto a newer state converges, for the same reason replaying the
   * window onto a dump read at some moment inside it does (CONSISTENCY.md).
   */
  async *#destinationSnapshot(event: ChangeEvent): AsyncGenerator<Buffer> {
    const to = event.to;
    if (to?.coll === undefined) return;
    const ns = { db: to.db, coll: to.coll };
    const clusterTime = toTimestamp(event.clusterTime);
    const synthesized = (fields: Document): Buffer => {
      this.#events += 1;
      return serializeChangeEvent({ ...fields, clusterTime, ns, synthesized: true });
    };
    this.#request.logger.debug("Recording a rename's destination as of the rename", {
      ns: `${ns.db}.${ns.coll}`,
      at: formatClusterTime(event.clusterTime),
    });

    // The cursor's getMores must run in the session of its find.
    const session = this.#request.client.startSession({ causalConsistency: false });
    const database = this.#request.client.db(ns.db);
    let cursorId: Long | number | undefined;
    try {
      let reply = await this.#openDestinationRead(ns, event.clusterTime, session);
      cursorId = cursorIdOf(reply);
      yield synthesized({ operationType: "drop" });
      yield synthesized({ operationType: "create", operationDescription: {} });
      let batch = batchOf(reply, "firstBatch");
      for (;;) {
        for (const raw of batch) {
          // Parsed with its stored field order recorded, so the synthesized insert
          // (written by `serializeChangeEvent`) holds the document byte for byte; the
          // `_id` in `documentKey` is the same object and keeps its order as well.
          const fullDocument = deserializeInStoredOrder(raw);
          yield synthesized({
            operationType: "insert",
            documentKey: { _id: fullDocument._id },
            fullDocument,
          });
        }
        if (cursorId === undefined || isZero(cursorId)) break;
        throwIfAborted(this.signal);
        reply = await database.command(
          { getMore: cursorId, collection: ns.coll },
          { session, ...RAW_BATCH_OPTIONS },
        );
        cursorId = cursorIdOf(reply);
        batch = batchOf(reply, "nextBatch");
      }
    } finally {
      if (cursorId !== undefined && !isZero(cursorId)) {
        await database
          .command({ killCursors: ns.coll, cursors: [cursorId] }, { session })
          .catch(() => {});
      }
      await session.endSession().catch(() => {});
    }
  }

  /**
   * Opens the snapshot read of a rename's destination: at the rename's cluster time,
   * or, when the server refuses that time because the collection's catalog entry
   * changed at or after it, at a later one.
   *
   * Why the server refuses: on a sharded cluster a shard cannot read a collection as
   * of a time before its current catalog entry. The rename (also the one `$out` ends
   * with) commits its catalog change on the shard after the change event's cluster
   * time, and the collection may have been replaced again since (a `$out` loop). The
   * capture also sees events late through mongos (it waits for every shard), often
   * after T1 is known, so even T1 may be too early for the current collection.
   *
   * So each retry reads at the newest cluster time the client knows (the logical
   * clock, `readLatestClusterTime`), after an ordinary read that makes mongos refresh
   * its routing for the collection. When that time is after T1, the end of the window
   * moves to it (`#extendEnd`): T1 only has to be after every dump, and a later T1
   * just means the drain records, and restore replays, a few more events (the same
   * reason T1 errs late, see converge-time.ts). A bounded number of attempts is made,
   * then the backup fails with `MS_UNSUPPORTED_TOPOLOGY`.
   */
  async #openDestinationRead(
    ns: { readonly db: string; readonly coll: string },
    renamedAt: ClusterTime,
    session: ReturnType<MongoClient["startSession"]>,
  ): Promise<Document> {
    const database = this.#request.client.db(ns.db);
    let at = renamedAt;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const reply = await database.command(
          {
            find: ns.coll,
            filter: {},
            readConcern: { level: "snapshot", atClusterTime: toTimestamp(at) },
          },
          { session, ...RAW_BATCH_OPTIONS },
        );
        if (attempt > 1) this.#extendEnd(at);
        return reply;
      } catch (error) {
        if (!isCatalogChangedUnderSnapshot(error)) throw error;
        if (attempt >= DESTINATION_READ_ATTEMPTS) {
          throw destinationUnreadable(ns, renamedAt, attempt, error);
        }
        await sleep(DESTINATION_RETRY_DELAY_MS * attempt, undefined, { signal: this.signal });
        await database
          .command({
            find: ns.coll,
            filter: {},
            limit: 1,
            singleBatch: true,
            projection: { _id: 1 },
          })
          .catch(() => {});
        const latest = await readLatestClusterTime(this.#request.client);
        if (compareClusterTimes(latest, at) > 0) at = latest;
        this.#request.logger.debug("Reading a rename's destination at a later time", {
          ns: `${ns.db}.${ns.coll}`,
          renamedAt: formatClusterTime(renamedAt),
          at: formatClusterTime(at),
          attempt: attempt + 1,
        });
      }
    }
  }

  /**
   * Moves the end of the window (T1) to `time` when T1 is known and earlier: the
   * drain then keeps reading up to `time`, and the manifest records it as `to`.
   * Before `finish()` has T1, it takes the later of the T1 it reads and `time`.
   */
  #extendEnd(time: ClusterTime): void {
    const latest = this.#latestDestinationRead;
    if (latest === undefined || compareClusterTimes(time, latest) > 0) {
      this.#latestDestinationRead = time;
    }
    const stopAt = this.#stopAt;
    if (stopAt === undefined || compareClusterTimes(time, stopAt) <= 0) return;
    this.#request.logger.debug("Moving the end of the backup window later", {
      from: formatClusterTime(stopAt),
      to: formatClusterTime(time),
    });
    this.#stopAt = time;
  }

  #addWarning(warning: string): void {
    if (!this.#warnings.includes(warning)) this.#warnings.push(warning);
  }

  /** Kills the server cursor and ends the session. Safe to call more than once. */
  async #release(): Promise<void> {
    await this.#stream.close();
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
  // Incrementals copy their time series whole, as of their end (backup-incremental.ts).
  if (timeSeries.length > 0 && request.purpose !== "incremental") {
    const names = timeSeries.map((spec) => spec.ns).join(", ");
    warnings.push(
      `Time series collections are restored as read, without converging (change streams do not report their writes): ${names}.`,
    );
  }
  if (!hasDisambiguatedPaths(request.serverVersion)) {
    warnings.push(
      `MongoDB ${request.serverVersion} does not report disambiguatedPaths (6.1+): updates to field names containing dots may replay as nested fields.`,
    );
  }
  return warnings;
}

/** `5 minutes`, `30 seconds`: a timeout for a message. */
function formatMinutes(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} minutes`;
  return `${Math.round(ms / 1000)} seconds`;
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

/** No snapshot read of a rename's destination worked, up to T1. */
function destinationUnreadable(
  ns: { readonly db: string; readonly coll: string },
  renamedAt: ClusterTime,
  attempts: number,
  cause: MongoServerError,
): MongoShieldError {
  return new MongoShieldError(
    "MS_UNSUPPORTED_TOPOLOGY",
    `The backup could not read ${ns.db}.${ns.coll} as of its rename at ${formatClusterTime(renamedAt)}, nor at a later time up to the end of the window (${attempts} attempts), because the server reports a catalog change: ${cause.message}`,
    {
      cause,
      hint: 'The collection was renamed or replaced (e.g. by $out) again and again during the backup. Run the backup again; on sharded clusters avoid $out and renameCollection into backed-up collections during converge backups, or use consistency "none".',
      details: { serverCode: cause.code, renamedAt, attempts },
    },
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
