/**
 * The journal writer's view of the deployment-wide change stream: a sequence of items,
 * each either a change event or a "position" saying how far the stream has read.
 *
 *   aggregate $changeStream (allChangesForCluster, startAtOperationTime, expanded events)
 *     → event, event, …            one item per event, raw bytes as the server sent them
 *     → position(T)                after an EMPTY batch: every event up to T was returned
 *
 * Like the converge capture (src/engine/converge-capture.ts), this uses the low-level
 * `aggregate` / `getMore` commands instead of the driver's ChangeStream, for the same
 * two reasons: an empty reply's `postBatchResumeToken` tells how far the stream has
 * read even when nothing happened (that is what moves the recovery point of an idle
 * database), and `fieldsAsRaw` hands over each event's exact bytes.
 *
 * Why positions only come from empty batches: when a batch is full, its resume token
 * is that of its last event, and more events with the same cluster time (the other
 * writes of a transaction) may still follow. After an empty batch the stream has
 * scanned everything up to the token's cluster time. The same rule ends the converge
 * drain (CONSISTENCY.md, step 5).
 *
 * The writer pulls items with `peek()` / `take()`, so it can leave an item for the next
 * segment. Batches are fetched only when the previous one is used up (backpressure).
 */

import {
  type ClientSession,
  type Document,
  Long,
  type MongoClient,
  MongoServerError,
} from "mongodb";
import { toCaptureError } from "../engine/converge-capture.ts";
import { type ChangeEvent, parseChangeEvent } from "../engine/converge-events.ts";
import {
  clusterTimeOfReply,
  clusterTimeOfResumeToken,
  formatClusterTime,
  toTimestamp,
} from "../engine/converge-time.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { ClusterTime } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import { successor } from "./time.ts";

/**
 * How long one `getMore` waits for new events before returning an empty batch. Short,
 * so a stop or an abort is noticed within about a second.
 */
const AWAIT_DATA_MS = 1000;

/** Databases whose changes are never journaled (see the scope in capture.ts). */
export const INTERNAL_DATABASES = ["admin", "config", "local"] as const;

/** Server error codes that mean the stream cannot reach back to where it should start. */
const HISTORY_LOST_CODES = new Set([
  286, // ChangeStreamHistoryLost: the oplog no longer reaches back to the start point
  280, // ChangeStreamFatalError: e.g. the resume point fell off the oplog
  136, // CappedPositionLost: the oplog rolled over under the cursor
]);

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/** Event batches are handed over unparsed; int64 cursor ids stay Longs. */
const RAW_BATCH_OPTIONS = {
  fieldsAsRaw: { firstBatch: true, nextBatch: true },
  promoteLongs: false,
} as const;

/** One item of the stream. */
export type StreamItem =
  | {
      readonly kind: "event";
      readonly raw: Buffer;
      readonly event: ChangeEvent;
    }
  /** Every event with a cluster time up to and including `time` has been returned. */
  | { readonly kind: "position"; readonly time: ClusterTime };

/** An open change stream that yields {@link StreamItem}s. */
export class JournalChangeStream {
  readonly #client: MongoClient;
  readonly #session: ClientSession;
  readonly #queue: StreamItem[] = [];
  #cursorId: Long | number | undefined;

  private constructor(client: MongoClient, session: ClientSession, firstReply: Document) {
    this.#client = client;
    this.#session = session;
    this.#cursorId = cursorIdOf(firstReply);
    this.#enqueue(firstReply, "firstBatch");
  }

  /**
   * Opens the stream so that it returns exactly the events AFTER `after`.
   *
   * @throws MongoShieldError `MS_CHANGE_HISTORY_LOST` when the oplog no longer reaches
   *   back to `after`, `MS_PERMISSION_DENIED` without change stream privileges.
   */
  static async open(
    client: MongoClient,
    after: ClusterTime,
    logger: Logger,
  ): Promise<JournalChangeStream> {
    // getMore must run in the session that opened the cursor. No causal consistency:
    // it would only add `afterClusterTime` to commands that do not need it.
    const session = client.startSession({ causalConsistency: false });
    try {
      const reply = await client.db("admin").command(
        {
          aggregate: 1,
          pipeline: [
            {
              $changeStream: {
                allChangesForCluster: true,
                startAtOperationTime: toTimestamp(successor(after)),
                // DDL events (create, rename, …) and `disambiguatedPaths` need this.
                showExpandedEvents: true,
              },
            },
            // Internal databases never matter; skip them on the server.
            { $match: { "ns.db": { $nin: [...INTERNAL_DATABASES] } } },
          ],
          cursor: {},
        },
        { session, ...RAW_BATCH_OPTIONS },
      );
      logger.debug("Opened the journal's change stream", { after: formatClusterTime(after) });
      return new JournalChangeStream(client, session, reply);
    } catch (error) {
      await session.endSession().catch(() => {});
      throw toStreamError(error, after);
    }
  }

  /**
   * The next item, without consuming it. Fetches batches as needed; an empty batch
   * whose position cannot be read yields nothing and the next batch is fetched.
   */
  async peek(signal: AbortSignal | undefined, resumedAfter: ClusterTime): Promise<StreamItem> {
    for (;;) {
      const item = this.#queue[0];
      if (item !== undefined) return item;
      throwIfAborted(signal);
      const reply = await this.#getMore(resumedAfter);
      this.#enqueue(reply, "nextBatch");
    }
  }

  /** Consumes the item `peek()` returned. */
  take(): void {
    this.#queue.shift();
  }

  /** Kills the server cursor and ends the session. Never throws; safe to call twice. */
  async close(logger: Logger): Promise<void> {
    const cursorId = this.#cursorId;
    this.#cursorId = undefined;
    try {
      if (cursorId !== undefined && !isZero(cursorId)) {
        await this.#client
          .db("admin")
          .command(
            { killCursors: "$cmd.aggregate", cursors: [cursorId] },
            { session: this.#session },
          );
      }
    } catch (error) {
      logger.debug("Closing the journal's change stream failed", { error: String(error) });
    }
    await this.#session.endSession().catch(() => {});
  }

  async #getMore(resumedAfter: ClusterTime): Promise<Document> {
    const cursorId = this.#cursorId;
    if (cursorId === undefined || isZero(cursorId)) throw streamClosed();
    try {
      const reply = await this.#client
        .db("admin")
        .command(
          { getMore: cursorId, collection: "$cmd.aggregate", maxTimeMS: AWAIT_DATA_MS },
          { session: this.#session, ...RAW_BATCH_OPTIONS },
        );
      this.#cursorId = cursorIdOf(reply) ?? cursorId;
      return reply;
    } catch (error) {
      throw toStreamError(error, resumedAfter);
    }
  }

  /** Turns a reply's batch into items (see the file header for positions). */
  #enqueue(reply: Document, field: "firstBatch" | "nextBatch"): void {
    const batch = batchOf(reply, field);
    for (const raw of batch) {
      const event = parseChangeEvent(raw);
      // A deployment-wide stream is never invalidated in practice; if it is, the
      // writer reopens it from its last commit.
      if (event.operationType === "invalidate") throw streamClosed();
      this.#queue.push({
        kind: "event",
        raw: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength),
        event,
      });
    }
    if (batch.length > 0) return;
    const cursor = asDocument(reply.cursor);
    const position =
      clusterTimeOfResumeToken(cursor?.postBatchResumeToken) ?? clusterTimeOfReply(reply);
    if (position !== undefined) this.#queue.push({ kind: "position", time: position });
  }
}

/** True for errors that mean change history was lost (the journal records a gap). */
export function isHistoryLost(error: unknown): boolean {
  return error instanceof MongoShieldError && error.code === "MS_CHANGE_HISTORY_LOST";
}

/**
 * Translates stream failures: lost history and missing privileges get a journal
 * specific explanation; everything else is translated like a converge capture error
 * (connection problems, …).
 */
function toStreamError(error: unknown, after: ClusterTime): MongoShieldError {
  if (error instanceof MongoShieldError) return error;
  if (error instanceof MongoServerError && typeof error.code === "number") {
    if (HISTORY_LOST_CODES.has(error.code)) {
      return new MongoShieldError(
        "MS_CHANGE_HISTORY_LOST",
        `The oplog no longer holds the changes after cluster time ${formatClusterTime(after)}, so the journal has a gap: ${error.message}`,
        {
          cause: error,
          hint: "The journal writer was stopped (or fell behind) for longer than the oplog window. Take a new base backup; increase the oplog size (replSetResizeOplog) to tolerate longer outages.",
          details: { serverCode: error.code },
        },
      );
    }
    if (error.code === UNAUTHORIZED_CODE) {
      return new MongoShieldError(
        "MS_PERMISSION_DENIED",
        `MongoDB refused to open the journal's change stream: ${error.message}`,
        {
          cause: error,
          hint: "The journal needs the changeStream and find actions on every database (e.g. the readAnyDatabase role).",
        },
      );
    }
  }
  return toCaptureError(error, after);
}

function streamClosed(): MongoShieldError {
  return new MongoShieldError("MS_INTERNAL", "The server closed the journal's change stream.", {
    hint: "The writer reopens it from its last committed segment; report it if it keeps happening.",
  });
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
