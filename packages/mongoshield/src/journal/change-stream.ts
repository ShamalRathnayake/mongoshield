/**
 * The journal writer's view of the deployment-wide change stream: a sequence of items,
 * each either a change event or a "position" saying how far the stream has read.
 *
 *   aggregate $changeStream (allChangesForCluster, startAtOperationTime, expanded events)
 *     → event, event, …            one item per event, raw bytes as the server sent them
 *     → position(T)                after an EMPTY batch: every event up to T was returned
 *
 * The stream itself is the converge capture's (src/engine/converge-stream.ts): raw
 * `aggregate` / `getMore` replies, because an empty reply's `postBatchResumeToken` tells
 * how far the stream has read even when nothing happened (that is what moves the
 * recovery point of an idle database), events split by the server
 * (`$changeStreamSplitLargeEvent`) put back together, and transient errors (a dropped
 * connection, a killed session) resumed from the last batch's token without the writer
 * noticing. Only when those bounded resume attempts fail does the error reach the
 * writer, which then starts again from its last committed segment.
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

import { type Document, type MongoClient, MongoServerError } from "mongodb";
import { toCaptureError } from "../engine/converge-capture.ts";
import type { ChangeEvent } from "../engine/converge-events.ts";
import {
  HISTORY_LOST_CODES,
  ResumableChangeStream,
  type ResumePolicy,
} from "../engine/converge-stream.ts";
import { formatClusterTime } from "../engine/converge-time.ts";
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

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/** Shown in the server's `currentOp`, so operators can tell what the cursor is. */
const STREAM_COMMENT = "mongoshield journal";

/** One item of the stream. */
export type StreamItem =
  | {
      readonly kind: "event";
      readonly raw: Buffer;
      readonly event: ChangeEvent;
    }
  /** Every event with a cluster time up to and including `time` has been returned. */
  | { readonly kind: "position"; readonly time: ClusterTime };

/** What `JournalChangeStream.open` needs besides the client and the start. */
export interface JournalStreamOptions {
  /** The scope's server-side `$match` (capture.ts). */
  readonly match: Document;
  readonly logger: Logger;
  /** Stops waits between resume attempts (the writer's hard stop). */
  readonly signal?: AbortSignal | undefined;
  /** How a dropped stream is reopened (tests shorten it). */
  readonly resume?: ResumePolicy | undefined;
}

/** An open change stream that yields {@link StreamItem}s. */
export class JournalChangeStream {
  readonly #stream: ResumableChangeStream;
  readonly #queue: StreamItem[] = [];
  /** The writer's last commit, named in error messages (updated by `peek`). */
  readonly #errorContext: { resumedAfter: ClusterTime };

  private constructor(stream: ResumableChangeStream, errorContext: { resumedAfter: ClusterTime }) {
    this.#stream = stream;
    this.#errorContext = errorContext;
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
    options: JournalStreamOptions,
  ): Promise<JournalChangeStream> {
    const errorContext = { resumedAfter: after };
    const stream = await ResumableChangeStream.open({
      client,
      startAt: successor(after),
      match: options.match,
      comment: STREAM_COMMENT,
      logger: options.logger,
      signal: options.signal,
      awaitDataMs: AWAIT_DATA_MS,
      resume: options.resume,
      toError: (error) => toStreamError(error, errorContext.resumedAfter),
    });
    options.logger.debug("Opened the journal's change stream", {
      after: formatClusterTime(after),
    });
    return new JournalChangeStream(stream, errorContext);
  }

  /** How many times the stream was resumed after a transient error. */
  get resumes(): number {
    return this.#stream.resumes;
  }

  /**
   * The next item, without consuming it. Fetches batches as needed; an empty batch
   * whose position cannot be read yields nothing and the next batch is fetched.
   * `resumedAfter` (the writer's last commit) is named in errors.
   */
  async peek(signal: AbortSignal | undefined, resumedAfter: ClusterTime): Promise<StreamItem> {
    this.#errorContext.resumedAfter = resumedAfter;
    for (;;) {
      const item = this.#queue[0];
      if (item !== undefined) return item;
      throwIfAborted(signal);
      const batch = await this.#stream.next();
      for (const { raw, event } of batch.events) this.#queue.push({ kind: "event", raw, event });
      if (!batch.empty) continue;
      const position = batch.position ?? batch.operationTime;
      if (position !== undefined) this.#queue.push({ kind: "position", time: position });
    }
  }

  /** Consumes the item `peek()` returned. */
  take(): void {
    this.#queue.shift();
  }

  /** Kills the server cursor and ends the session. Never throws; safe to call twice. */
  async close(): Promise<void> {
    await this.#stream.close();
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
export function toStreamError(error: unknown, after: ClusterTime): MongoShieldError {
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
