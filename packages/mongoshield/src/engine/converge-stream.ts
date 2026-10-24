/**
 * The deployment-wide change stream shared by the converge capture
 * (converge-capture.ts) and the journal writer (src/journal/change-stream.ts), with
 * the three things both need beyond a plain cursor:
 *
 *   aggregate $changeStream (allChangesForCluster, startAtOperationTime, expanded events)
 *     [$match …] [$changeStreamSplitLargeEvent]
 *     → batch → reassemble split events → events (raw bytes) + how far the stream read
 *     → getMore … on a transient error: reopen with resumeAfter the last batch's token
 *
 * 1. Raw replies. The low-level `aggregate` / `getMore` commands are used instead of the
 *    driver's ChangeStream because callers must know how far the stream has read even
 *    when no event arrives (`postBatchResumeToken`, `operationTime`), and `fieldsAsRaw`
 *    hands over each event as the exact bytes the server sent.
 *
 * 2. Large events. A change event is a BSON document, so the server cannot return one
 *    larger than its internal limit (16 MiB + 16 KiB); it fails the cursor with
 *    `BSONObjectTooLarge` instead. MongoDB 7.0 (and 6.0.9) can split such an event into
 *    fragments (`$changeStreamSplitLargeEvent`, which must be the last stage), each
 *    carrying `splitEvent: { fragment, of }` and some of the event's top-level fields.
 *    The stage is added when the server knows it (an older server rejects it as an
 *    unknown stage and the stream is opened without it) and the fragments are put
 *    back together here, so callers only ever see whole events. Every fragment carries
 *    the resume token, which embeds the document key: an event whose one large field
 *    plus that token does not fit in a fragment cannot be split, and fails with a
 *    clear error (see `isEventTooLarge`).
 *
 * 3. Resuming. Connections drop, primaries step down, operators kill sessions. A
 *    transient error on `getMore` (see `isResumableError`) reopens the stream right
 *    after the last batch the caller has fully received (`resumeAfter` its
 *    `postBatchResumeToken`), waiting 100 ms, 200 ms, 400 ms … between attempts, a
 *    bounded number of times. Callers consume a whole batch before asking for the next
 *    one, so resuming after its token loses nothing and repeats nothing. Lost history
 *    (`ChangeStreamHistoryLost` and friends) and missing privileges are never retried.
 */

import { setTimeout as sleep } from "node:timers/promises";
import {
  type ClientSession,
  type Document,
  Long,
  type MongoClient,
  MongoNetworkError,
  MongoServerError,
  MongoServerSelectionError,
} from "mongodb";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { ClusterTime } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import type { NamespaceRules } from "../mongo/namespace-filter.ts";
import {
  type ChangeEvent,
  changeEventFromDocument,
  plainNumber,
  readChangeEventDocument,
  serializeChangeEvent,
} from "./converge-events.ts";
import {
  clusterTimeOfReply,
  clusterTimeOfResumeToken,
  formatClusterTime,
  toTimestamp,
} from "./converge-time.ts";

/** Event batches are handed over unparsed; int64 cursor ids stay Longs. */
const RAW_BATCH_OPTIONS = {
  fieldsAsRaw: { firstBatch: true, nextBatch: true },
  promoteLongs: false,
} as const;

/** Server error codes that mean the stream cannot reach back to where it should start. */
export const HISTORY_LOST_CODES: ReadonlySet<number> = new Set([
  286, // ChangeStreamHistoryLost: the oplog no longer reaches back to the start point
  280, // ChangeStreamFatalError: e.g. the resume point fell off the oplog
  136, // CappedPositionLost: the oplog rolled over under the cursor
]);

/**
 * Server error codes after which reopening the stream at its last token works: the
 * driver's list of resumable `getMore` errors, plus the three an operator's
 * `killSessions` / `killCursors` / `killOp` produce (Interrupted, CursorKilled,
 * CursorNotFound), which carry no `ResumableChangeStreamError` label.
 */
const RESUMABLE_CODES: ReadonlySet<number> = new Set([
  6, // HostUnreachable
  7, // HostNotFound
  43, // CursorNotFound: the cursor was killed (or timed out) between two getMores
  63, // StaleShardVersion
  89, // NetworkTimeout
  91, // ShutdownInProgress
  133, // FailedToSatisfyReadPreference
  150, // StaleEpoch
  189, // PrimarySteppedDown
  234, // RetryChangeStream
  237, // CursorKilled: killCursors while a getMore was running
  262, // ExceededTimeLimit
  9001, // SocketException
  10107, // NotWritablePrimary
  11600, // InterruptedAtShutdown
  11601, // Interrupted: killOp / killSessions while a getMore was running
  11602, // InterruptedDueToReplStateChange
  13388, // StaleConfig
  13435, // NotPrimaryNoSecondaryOk
  13436, // NotPrimaryOrSecondary
]);

/** BSONObjectTooLarge: an event over the server's limit, without the split stage. */
const OBJECT_TOO_LARGE_CODE = 10334;

/** "Splitting change event failed": one field plus the resume token is still too large. */
const SPLIT_FAILED_CODE = 7182500;

/** "Unrecognized pipeline stage name": a server without `$changeStreamSplitLargeEvent`. */
const UNKNOWN_STAGE_CODE = 40324;

/** How often a dropped stream is reopened, and how long to wait between attempts. */
export interface ResumePolicy {
  /** Reopen attempts per failure before giving up (the failure is then thrown). */
  readonly attempts: number;
  /** Wait before the first attempt; doubles with every further attempt. */
  readonly initialDelayMs: number;
  /** Upper bound of the wait between attempts. */
  readonly maxDelayMs: number;
}

/**
 * Five attempts over about three seconds: enough for a dropped connection, a killed
 * session or a quick primary election, short enough that a server that is really
 * gone fails the backup (or, for the journal, falls back to the writer's own retry
 * from its last commit) without a long hang.
 */
export const DEFAULT_RESUME_POLICY: ResumePolicy = {
  attempts: 5,
  initialDelayMs: 100,
  maxDelayMs: 2000,
};

/** What `ResumableChangeStream.open` needs. */
export interface ChangeStreamOptions {
  readonly client: MongoClient;
  /** The stream returns the events at or after this cluster time. */
  readonly startAt: ClusterTime;
  /** A `$match` stage run by the server (skips whole databases cheaply). */
  readonly match: Document;
  /**
   * Shown in the server's `currentOp` and logs, so operators can tell what a
   * long-running cursor belongs to (e.g. "mongoshield backup <id> (converge)").
   */
  readonly comment: string;
  readonly logger: Logger;
  /** Stops the waits between resume attempts. */
  readonly signal?: AbortSignal | undefined;
  /** How long one `getMore` waits for new events before returning an empty batch. */
  readonly awaitDataMs: number;
  readonly resume?: ResumePolicy | undefined;
  /** Translates errors the stream cannot recover from (lost history, privileges, …). */
  readonly toError: (error: unknown) => MongoShieldError;
}

/** One change event, whole, with its exact bytes. */
export interface StreamedEvent {
  readonly raw: Buffer;
  readonly event: ChangeEvent;
}

/** One reply of the server, as the callers need it. */
export interface ChangeStreamBatch {
  /** The whole events of the reply (fragments of a split event come out reassembled). */
  readonly events: readonly StreamedEvent[];
  /** True when the server returned no document at all. */
  readonly empty: boolean;
  /**
   * The cluster time of the reply's `postBatchResumeToken`: every event before it has
   * been returned. `undefined` when the token cannot be read, and while a split event
   * is only partly received (its remaining fragments are still to come).
   */
  readonly position: ClusterTime | undefined;
  /**
   * The reply's `operationTime` (or gossiped cluster time), a fallback for `position`;
   * `undefined` while a split event is only partly received.
   */
  readonly operationTime: ClusterTime | undefined;
}

/** A change stream that reassembles split events and resumes after transient errors. */
export class ResumableChangeStream {
  readonly #options: ChangeStreamOptions;
  readonly #policy: ResumePolicy;
  #session: ClientSession;
  #cursorId: Long | number | undefined;
  /** The aggregate's first batch, until `next()` hands it out. */
  #pending: Reply | undefined;
  /** The last `postBatchResumeToken` handed out: where a resume starts. */
  #resumeToken: unknown;
  /** Whether the server accepts `$changeStreamSplitLargeEvent`. */
  #splitsLargeEvents: boolean;
  readonly #assembler: SplitEventAssembler;
  #resumes = 0;
  /** Set by `close()`: a resume still in progress must not leave a new cursor behind. */
  #closed = false;

  private constructor(
    options: ChangeStreamOptions,
    session: ClientSession,
    firstReply: Document,
    splitsLargeEvents: boolean,
  ) {
    this.#options = options;
    this.#policy = options.resume ?? DEFAULT_RESUME_POLICY;
    this.#session = session;
    this.#cursorId = cursorIdOf(firstReply);
    this.#pending = { reply: firstReply, field: "firstBatch" };
    this.#splitsLargeEvents = splitsLargeEvents;
    this.#assembler = new SplitEventAssembler(options.logger);
  }

  /**
   * Opens the stream at `options.startAt`. A transient failure of the first
   * `aggregate` is retried like a dropped stream.
   *
   * @throws MongoShieldError from `options.toError` (lost history, privileges, …), or
   *   the last transient error once the retries are used up.
   */
  static async open(options: ChangeStreamOptions): Promise<ResumableChangeStream> {
    const policy = options.resume ?? DEFAULT_RESUME_POLICY;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const opened = await openCursor(options, { startAtOperationTime: options.startAt }, true);
        return new ResumableChangeStream(options, opened.session, opened.reply, opened.splits);
      } catch (error) {
        if (!isResumableError(error) || attempt > policy.attempts) {
          throw translate(error, options);
        }
        await waitBeforeRetry(options, policy, attempt, error);
      }
    }
  }

  /** How many times the stream was reopened after a transient error. */
  get resumes(): number {
    return this.#resumes;
  }

  /**
   * The next reply: the first batch after opening (or resuming), then one `getMore`
   * per call. Never returns half of a split event.
   *
   * @throws MongoShieldError as {@link open}; `MS_INTERNAL` when the server closed the
   *   stream (an `invalidate` event, or a cursor id of 0).
   */
  async next(): Promise<ChangeStreamBatch> {
    const reply = this.#pending ?? (await this.#getMoreOrResume());
    this.#pending = undefined;
    return this.#toBatch(reply);
  }

  /** Kills the server cursor and ends the session. Never throws; safe to call twice. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#release();
  }

  async #release(): Promise<void> {
    const cursorId = this.#cursorId;
    this.#cursorId = undefined;
    const { client, logger } = this.#options;
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

  /** `getMore`; on a transient error, reopens after the last token (see the file header). */
  async #getMoreOrResume(): Promise<Reply> {
    try {
      return { reply: await this.#getMore(), field: "nextBatch" };
    } catch (error) {
      if (!isResumableError(error)) throw translate(error, this.#options);
      return this.#resume(error);
    }
  }

  async #getMore(): Promise<Document> {
    const cursorId = this.#cursorId;
    if (cursorId === undefined || isZero(cursorId)) throw streamClosed();
    const reply = await this.#options.client
      .db("admin")
      .command(
        { getMore: cursorId, collection: "$cmd.aggregate", maxTimeMS: this.#options.awaitDataMs },
        { session: this.#session, ...RAW_BATCH_OPTIONS },
      );
    this.#cursorId = cursorIdOf(reply) ?? cursorId;
    return reply;
  }

  /**
   * Reopens the stream after the last token handed out (or at the start, when no
   * reply carried one yet) and returns the new cursor's first batch.
   */
  async #resume(cause: unknown): Promise<Reply> {
    const { logger } = this.#options;
    if (this.#closed) throw streamClosed();
    let failure = cause;
    // The old cursor may still exist (a dropped connection does not kill it).
    await this.#release();
    for (let attempt = 1; attempt <= this.#policy.attempts; attempt += 1) {
      await waitBeforeRetry(this.#options, this.#policy, attempt, failure);
      const start =
        this.#resumeToken === undefined
          ? { startAtOperationTime: this.#options.startAt }
          : { resumeAfter: this.#resumeToken };
      try {
        const opened = await openCursor(this.#options, start, this.#splitsLargeEvents);
        this.#session = opened.session;
        if (this.#closed) {
          this.#cursorId = cursorIdOf(opened.reply);
          await this.#release();
          throw streamClosed();
        }
        this.#splitsLargeEvents = opened.splits;
        this.#cursorId = cursorIdOf(opened.reply);
        this.#resumes += 1;
        logger.warn("The change stream was interrupted and has been resumed", {
          error: describe(cause),
          attempts: attempt,
          ...(this.#resumeToken === undefined
            ? { at: formatClusterTime(this.#options.startAt) }
            : {}),
        });
        return { reply: opened.reply, field: "firstBatch" };
      } catch (error) {
        if (!isResumableError(error)) throw translate(error, this.#options);
        failure = error;
      }
    }
    throw translate(failure, this.#options);
  }

  /** Turns a reply into whole events and the stream's position. */
  #toBatch({ reply, field }: Reply): ChangeStreamBatch {
    const documents = batchOf(reply, field);
    const events: StreamedEvent[] = [];
    for (const raw of documents) {
      const whole = this.#assembler.push(raw);
      if (whole === undefined) continue;
      if (whole.event.operationType === "invalidate") throw streamClosed();
      events.push(whole);
    }
    const cursor = asDocument(reply.cursor);
    const token: unknown = cursor?.postBatchResumeToken;
    if (token !== undefined) this.#resumeToken = token;
    // Half a split event: nothing is known to be complete until its last fragment.
    const incomplete = this.#assembler.incomplete;
    return {
      events,
      empty: documents.length === 0,
      position: incomplete ? undefined : clusterTimeOfResumeToken(token),
      operationTime: incomplete ? undefined : clusterTimeOfReply(reply),
    };
  }
}

/**
 * Turns the documents of a change stream back into whole events: unsplit events pass
 * through with their exact bytes; the fragments of a split event are collected until
 * the last one arrives, then merged into one event (`mergeFragments`).
 */
export class SplitEventAssembler {
  readonly #logger: Logger;
  /** Fragments of a split event received so far. */
  #fragments: Document[] = [];

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /** True while a split event is only partly received. */
  get incomplete(): boolean {
    return this.#fragments.length > 0;
  }

  /**
   * One server document → a whole event, or `undefined` while the fragments of a split
   * event are still arriving.
   *
   * @throws MongoShieldError `MS_INTEGRITY_FAILED` for bytes that are not a change
   *   event, `MS_INTERNAL` for fragments out of order.
   */
  push(raw: Uint8Array): StreamedEvent | undefined {
    const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const document = readChangeEventDocument(bytes);
    const split = splitEventOf(document);
    if (split === undefined) {
      if (this.incomplete) throw brokenSplit("an unsplit event arrived between fragments");
      return { raw: bytes, event: changeEventFromDocument(document) };
    }
    if (split.fragment !== this.#fragments.length + 1) {
      throw brokenSplit(`fragment ${split.fragment} arrived after ${this.#fragments.length}`);
    }
    this.#fragments.push(document);
    if (split.fragment < split.of) return undefined;

    const merged = mergeFragments(this.#fragments);
    this.#fragments = [];
    const mergedBytes = serializeChangeEvent(merged);
    this.#logger.debug("Reassembled a change event split by the server", {
      fragments: split.of,
      bytes: mergedBytes.length,
    });
    return { raw: mergedBytes, event: changeEventFromDocument(merged) };
  }
}

/**
 * Puts the fragments of a split event back together: every top-level field of every
 * fragment, in order, without `splitEvent`. The `_id` (resume token) is the last
 * fragment's, which is the one that resumes after the whole event.
 */
export function mergeFragments(fragments: readonly Document[]): Document {
  const merged: Document = {};
  for (const fragment of fragments) {
    for (const [field, value] of Object.entries(fragment)) {
      if (field === "splitEvent") continue;
      merged[field] = value;
    }
  }
  return merged;
}

/** `splitEvent: { fragment, of }` of a fragment, or `undefined` for a whole event. */
export function splitEventOf(
  document: Document,
): { readonly fragment: number; readonly of: number } | undefined {
  const split = asDocument(document.splitEvent);
  if (split === undefined) return undefined;
  const fragment = plainNumber(split.fragment);
  const of = plainNumber(split.of);
  if (fragment === undefined || of === undefined || fragment < 1 || of < fragment) {
    throw brokenSplit("its splitEvent field is malformed");
  }
  return { fragment, of };
}

/**
 * True for errors after which the stream can be reopened at its last token: network
 * errors, server selection timeouts, and server errors labelled
 * `ResumableChangeStreamError` or with a code in `RESUMABLE_CODES`. Lost history is
 * never resumable: the events are gone.
 */
export function isResumableError(error: unknown): boolean {
  if (error instanceof MongoNetworkError || error instanceof MongoServerSelectionError) {
    return true;
  }
  if (!(error instanceof MongoServerError)) return false;
  if (typeof error.code === "number" && HISTORY_LOST_CODES.has(error.code)) return false;
  if (error.hasErrorLabel("ResumableChangeStreamError")) return true;
  return typeof error.code === "number" && RESUMABLE_CODES.has(error.code);
}

/** True for the server's "this change event is too large" errors (see the file header). */
export function isEventTooLarge(error: unknown): error is MongoServerError {
  return (
    error instanceof MongoServerError &&
    (error.code === OBJECT_TOO_LARGE_CODE || error.code === SPLIT_FAILED_CODE)
  );
}

/**
 * The error for a change event the server cannot return. The server's message starts
 * with the event's resume token, whose first bytes encode its cluster time; it is
 * included when it can be read, so the operator can find the change in the oplog.
 */
export function eventTooLargeError(error: MongoServerError): MongoShieldError {
  const at = clusterTimeInMessage(error.message);
  const where = at === undefined ? "" : ` (cluster time ${formatClusterTime(at)})`;
  return new MongoShieldError(
    "MS_UNSUPPORTED_TOPOLOGY",
    `A change${where} produced a change event larger than MongoDB's 16 MiB limit, so the change stream cannot deliver it: ${error.message}`,
    {
      cause: error,
      hint: 'This happens when a document close to 16 MiB also has a large _id, which the event repeats in its resume token and documentKey. Use consistency "none" for this backup; MongoDB 7.0+ splits other large events by itself.',
      details: { serverCode: error.code, ...(at === undefined ? {} : { clusterTime: at }) },
    },
  );
}

/** The cluster time of the first resume token (`_data: "82…"`) quoted in a message. */
function clusterTimeInMessage(message: string): ClusterTime | undefined {
  const match = /_data: "(82[0-9A-Fa-f]{16})/.exec(message);
  return match?.[1] === undefined ? undefined : clusterTimeOfResumeToken({ _data: match[1] });
}

/**
 * The `$match` a deployment-wide stream runs on the server: only the databases that
 * can matter. When every include pattern names its database literally (`app.*`,
 * `shop.orders`), that is those databases (plus `alsoKeep`), as the event's `ns` or as
 * a rename's `to`; otherwise every database except the internal ones not in
 * `alsoKeep`.
 *
 * Why narrow it: the server builds an event before filtering it on the client, so a
 * change in an unrelated database costs a little bandwidth, and a change event there
 * that is too large to send would fail the stream (see `isEventTooLarge`). The
 * server applies a `$match` on `ns.db` before it builds the event.
 */
export function serverDatabaseFilter(
  rules: NamespaceRules,
  alsoKeep: Iterable<string>,
  internalDatabases: readonly string[],
): Document {
  const kept = new Set(alsoKeep);
  const literal = rules.include.every((pattern) => pattern.literalDatabase !== undefined);
  if (rules.include.length > 0 && literal) {
    const databases = new Set(kept);
    for (const pattern of rules.include) {
      if (pattern.literalDatabase !== undefined) databases.add(pattern.literalDatabase);
    }
    const names = [...databases].sort();
    return { $or: [{ "ns.db": { $in: names } }, { "to.db": { $in: names } }] };
  }
  return { "ns.db": { $nin: internalDatabases.filter((db) => !kept.has(db)) } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A server reply and the field its batch is in. */
interface Reply {
  readonly reply: Document;
  readonly field: "firstBatch" | "nextBatch";
}

/** Where a (re)opened stream starts. */
type StreamStart =
  | { readonly startAtOperationTime: ClusterTime }
  | { readonly resumeAfter: unknown };

/**
 * Runs the `aggregate` that opens a stream, in a new session (getMore must run in the
 * session that opened the cursor; no causal consistency, which would only add
 * `afterClusterTime` to commands that do not need it). With `split`, the split stage is
 * added, and dropped again when the server does not know it.
 */
async function openCursor(
  options: ChangeStreamOptions,
  start: StreamStart,
  split: boolean,
): Promise<{
  readonly session: ClientSession;
  readonly reply: Document;
  readonly splits: boolean;
}> {
  const session = options.client.startSession({ causalConsistency: false });
  try {
    const reply = await options.client.db("admin").command(
      {
        aggregate: 1,
        pipeline: pipelineFor(options, start, split),
        cursor: {},
        comment: options.comment,
      },
      { session, ...RAW_BATCH_OPTIONS },
    );
    return { session, reply, splits: split };
  } catch (error) {
    await session.endSession().catch(() => {});
    if (split && error instanceof MongoServerError && error.code === UNKNOWN_STAGE_CODE) {
      options.logger.debug(
        "The server cannot split large change events ($changeStreamSplitLargeEvent needs MongoDB 7.0 or 6.0.9)",
      );
      return openCursor(options, start, false);
    }
    throw error;
  }
}

function pipelineFor(options: ChangeStreamOptions, start: StreamStart, split: boolean): Document[] {
  const position =
    "resumeAfter" in start
      ? { resumeAfter: start.resumeAfter }
      : { startAtOperationTime: toTimestamp(start.startAtOperationTime) };
  return [
    {
      $changeStream: {
        allChangesForCluster: true,
        ...position,
        // DDL events (create, rename, createIndexes, …) and `disambiguatedPaths`.
        showExpandedEvents: true,
      },
    },
    { $match: options.match },
    // Must be the last stage.
    ...(split ? [{ $changeStreamSplitLargeEvent: {} }] : []),
  ];
}

async function waitBeforeRetry(
  options: ChangeStreamOptions,
  policy: ResumePolicy,
  attempt: number,
  error: unknown,
): Promise<void> {
  throwIfAborted(options.signal);
  const delay = Math.min(policy.initialDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  options.logger.debug("Reopening the change stream after a transient error", {
    error: describe(error),
    attempt,
    retryInMs: delay,
  });
  await sleep(delay, undefined, options.signal === undefined ? {} : { signal: options.signal });
}

function translate(error: unknown, options: ChangeStreamOptions): MongoShieldError {
  if (error instanceof MongoShieldError) return error;
  if (isEventTooLarge(error)) return eventTooLargeError(error);
  return options.toError(error);
}

function streamClosed(): MongoShieldError {
  return new MongoShieldError("MS_INTERNAL", "The server closed the change stream.", {
    hint: "Run the operation again; if it keeps happening, report it as a bug.",
  });
}

function brokenSplit(problem: string): MongoShieldError {
  return new MongoShieldError(
    "MS_INTERNAL",
    `The server sent the fragments of a split change event out of order: ${problem}.`,
    { hint: "Run the operation again; if it keeps happening, report it as a bug." },
  );
}

/** The raw documents of a cursor reply's batch. */
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
