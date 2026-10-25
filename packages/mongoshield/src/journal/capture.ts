/**
 * Which change events the journal keeps, and the two cases where it stores more than
 * the server's event (the same two as the converge capture, CONSISTENCY.md):
 *
 * - An update to a field name containing `.` or starting with `$` cannot be replayed
 *   with `$set`/`$unset`; the document is read as of the event (a snapshot read) and
 *   stored as the event's `fullDocument`.
 * - A rename `A → B` into a journaled namespace replays as "B becomes A". That is only
 *   right when the restore holds A as of the rename. The journal cannot know which base
 *   backup a restore will start from, so whenever A is not journaled itself (it is
 *   excluded, or it is a `$out` / `$merge` scratch collection, which the journal skips),
 *   B is read as of the rename and stored as `drop` + `create` + one `insert` per
 *   document right after the rename (marked `synthesized: true`), so B is exact
 *   whatever A held.
 *
 * Both reads are snapshot reads at the event's cluster time, so they need the writer to
 * be within the server's snapshot window (`minSnapshotHistoryWindowInSeconds`, 300 s by
 * default) of the present. A writer that is catching up from further behind logs an
 * error for each event it could not record exactly.
 */

import { type Document, Long, type MongoClient } from "mongodb";
import {
  type ChangeEvent,
  collectionNamespaceOf,
  needsFullDocument,
  serializeChangeEvent,
} from "../engine/converge-events.ts";
import { BINARY_COLLATION } from "../engine/converge-operations.ts";
import { serverDatabaseFilter } from "../engine/converge-stream.ts";
import { formatClusterTime, toTimestamp } from "../engine/converge-time.ts";
import { throwIfAborted } from "../errors.ts";
import { deserializeInStoredOrder, valueInStoredOrder } from "../format/field-order.ts";
import type { Logger } from "../logger.ts";
import {
  compileNamespaceRules,
  matchesRules,
  mayIncludeDatabase,
  splitNamespace,
} from "../mongo/namespace-filter.ts";
import type { NamespacePattern } from "../types.ts";
import { INTERNAL_DATABASES } from "./change-stream.ts";

/**
 * Collection-name prefix of the scratch collections `$out`, `$merge` and mapReduce
 * fill before renaming them over their target, e.g. `tmp.agg_out.<uuid>`.
 */
const SCRATCH_COLLECTION_PREFIX = "tmp.";

/** Raw batches for the snapshot reads; int64 cursor ids stay Longs. */
const RAW_BATCH_OPTIONS = {
  fieldsAsRaw: { firstBatch: true, nextBatch: true },
  promoteLongs: false,
} as const;

/** Decides which events the journal keeps. */
export interface JournalScope {
  /** `$match` run by the server, to skip whole databases cheaply (`serverDatabaseFilter`). */
  readonly serverFilter: Document;
  /** True for collection namespaces whose changes are journaled. */
  keepsNamespace(ns: string): boolean;
  /** True for events that belong in the journal. */
  keeps(event: ChangeEvent): boolean;
  /** True for renames whose destination must be recorded as of the rename (file header). */
  needsDestinationSnapshot(event: ChangeEvent): boolean;
}

/**
 * The journal's scope: every namespace the include/exclude patterns select, except
 * internal databases, `system.*` and scratch collections; plus `dropDatabase` of any
 * database that may hold such namespaces, and renames into them.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for malformed patterns.
 */
export function createJournalScope(patterns: {
  readonly include?: readonly NamespacePattern[] | undefined;
  readonly exclude?: readonly NamespacePattern[] | undefined;
}): JournalScope {
  const rules = compileNamespaceRules(patterns);
  const isUserDatabase = (db: string): boolean =>
    !(INTERNAL_DATABASES as readonly string[]).includes(db);

  const keepsNamespace = (ns: string): boolean => {
    const { database, collection } = splitNamespace(ns);
    if (!isUserDatabase(database)) return false;
    if (collection.startsWith("system.") || collection.startsWith(SCRATCH_COLLECTION_PREFIX)) {
      return false;
    }
    return matchesRules(rules, ns);
  };

  const keeps = (event: ChangeEvent): boolean => {
    if (event.operationType === "dropDatabase") {
      return (
        event.ns !== undefined &&
        isUserDatabase(event.ns.db) &&
        mayIncludeDatabase(rules, event.ns.db)
      );
    }
    const ns = collectionNamespaceOf(event.ns);
    if (ns === undefined) return false;
    if (keepsNamespace(ns)) return true;
    const to = collectionNamespaceOf(event.to);
    return event.operationType === "rename" && to !== undefined && keepsNamespace(to);
  };

  const needsDestinationSnapshot = (event: ChangeEvent): boolean => {
    if (event.operationType !== "rename") return false;
    const from = collectionNamespaceOf(event.ns);
    const to = collectionNamespaceOf(event.to);
    return from !== undefined && to !== undefined && keepsNamespace(to) && !keepsNamespace(from);
  };

  const serverFilter = serverDatabaseFilter(rules, [], INTERNAL_DATABASES);
  return { serverFilter, keepsNamespace, keeps, needsDestinationSnapshot };
}

/**
 * The bytes to store for an event: the server's own, except for updates that replay
 * cannot express as `$set`/`$unset` (see `needsFullDocument`), which get the document
 * as of the event as their `fullDocument`. When that read fails the event is stored
 * as is (replay skips it with a warning) and an error is logged.
 */
export async function storedEventBytes(
  client: MongoClient,
  raw: Buffer,
  event: ChangeEvent,
  logger: Logger,
): Promise<Buffer> {
  if (!needsFullDocument(event)) return raw;
  const document = await documentAt(client, event, logger);
  if (document === undefined) {
    logger.error(
      "An update to a field name containing a dot or starting with $ could not be recorded exactly; restores will skip it",
      { ns: collectionNamespaceOf(event.ns), at: formatClusterTime(event.clusterTime) },
    );
    return raw;
  }
  return serializeChangeEvent({ ...event.document, fullDocument: document });
}

/** The changed document as of the event's cluster time, or undefined if it cannot be read. */
async function documentAt(
  client: MongoClient,
  event: ChangeEvent,
  logger: Logger,
): Promise<Document | undefined> {
  const db = event.ns?.db;
  const collection = event.ns?.coll;
  if (db === undefined || collection === undefined) return undefined;
  try {
    const reply = await client.db(db).command(
      {
        find: collection,
        // In stored field order: an embedded `_id` must match field by field.
        filter: { _id: valueInStoredOrder(event.documentKey?._id) },
        limit: 1,
        singleBatch: true,
        collation: BINARY_COLLATION,
        readConcern: { level: "snapshot", atClusterTime: toTimestamp(event.clusterTime) },
      },
      { fieldsAsRaw: { firstBatch: true } },
    );
    const [found] = batchOf(reply, "firstBatch");
    // Parsed with its stored field order, which `serializeChangeEvent` writes back.
    return found === undefined ? undefined : deserializeInStoredOrder(found);
  } catch (error) {
    logger.debug("Reading a document at an update's cluster time failed", {
      ns: `${db}.${collection}`,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The rename's destination as it was right after the rename, as events with the
 * rename's cluster time: a `drop` and a `create` (empty it, but keep it), then one
 * `insert` per document. The same records as the converge capture's (FORMAT.md).
 *
 * The first batch is read BEFORE anything is yielded: when the snapshot read fails
 * (typically `SnapshotTooOld`, because the writer is too far behind), an error is
 * logged and `undefined` returned, so the journal never holds a half-recorded
 * collection. Once the cursor is open its snapshot stays readable; a later failure
 * fails the segment, which the writer then writes again.
 */
export async function openDestinationSnapshot(
  client: MongoClient,
  event: ChangeEvent,
  signal: AbortSignal | undefined,
  logger: Logger,
): Promise<AsyncGenerator<Buffer> | undefined> {
  const to = event.to;
  if (to?.coll === undefined) return undefined;
  const ns = { db: to.db, coll: to.coll };
  const clusterTime = toTimestamp(event.clusterTime);
  // The cursor's getMores must run in the session of its find.
  const session = client.startSession({ causalConsistency: false });
  const database = client.db(ns.db);
  let firstReply: Document;
  try {
    firstReply = await database.command(
      { find: ns.coll, filter: {}, readConcern: { level: "snapshot", atClusterTime: clusterTime } },
      { session, ...RAW_BATCH_OPTIONS },
    );
  } catch (error) {
    await session.endSession().catch(() => {});
    logger.error(
      "A collection replaced by a rename could not be recorded as of the rename; restores past this point keep its earlier content",
      {
        ns: `${ns.db}.${ns.coll}`,
        at: formatClusterTime(event.clusterTime),
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }

  const synthesized = (fields: Document): Buffer =>
    serializeChangeEvent({ ...fields, clusterTime, ns, synthesized: true });
  const insertOf = (raw: Uint8Array): Buffer => {
    const fullDocument = deserializeInStoredOrder(raw);
    return synthesized({
      operationType: "insert",
      documentKey: { _id: fullDocument._id },
      fullDocument,
    });
  };

  async function* generate(): AsyncGenerator<Buffer> {
    let cursorId = cursorIdOf(firstReply);
    try {
      yield synthesized({ operationType: "drop" });
      yield synthesized({ operationType: "create", operationDescription: {} });
      for (const raw of batchOf(firstReply, "firstBatch")) yield insertOf(raw);
      while (cursorId !== undefined && !isZero(cursorId)) {
        throwIfAborted(signal);
        const reply = await database.command(
          { getMore: cursorId, collection: ns.coll },
          { session, ...RAW_BATCH_OPTIONS },
        );
        cursorId = cursorIdOf(reply);
        for (const raw of batchOf(reply, "nextBatch")) yield insertOf(raw);
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
  return generate();
}

function batchOf(reply: Document, field: "firstBatch" | "nextBatch"): Uint8Array[] {
  const cursor: unknown = reply.cursor;
  const batch: unknown =
    typeof cursor === "object" && cursor !== null ? Reflect.get(cursor, field) : undefined;
  if (!Array.isArray(batch)) return [];
  return batch.filter((item): item is Uint8Array => item instanceof Uint8Array);
}

function cursorIdOf(reply: Document): Long | number | undefined {
  const cursor: unknown = reply.cursor;
  const id: unknown =
    typeof cursor === "object" && cursor !== null ? Reflect.get(cursor, "id") : undefined;
  if (typeof id === "number" || id instanceof Long) return id;
  return undefined;
}

function isZero(cursorId: Long | number): boolean {
  return typeof cursorId === "number" ? cursorId === 0 : cursorId.isZero();
}
