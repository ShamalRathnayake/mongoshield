/**
 * Changing live documents safely: every write is journaled first and conditional.
 *
 *   1. read the current document and check it is the version the user loaded
 *      (else 409 CONSOLE_LIVE_CONFLICT, nothing written, nothing journaled)
 *   2. store its pre-image (and the intended post-image) in the journal (journal.ts);
 *      if that fails, stop: nothing is written without a pre-image
 *   3. add a `pending` entry to the journal index (history.ts)
 *   4. write with a compare-and-swap filter: `_id` plus `$expr: $$ROOT == <pre-image>`,
 *      so MongoDB itself refuses the write if the document changed between 1 and 4
 *   5. record the outcome (`applied`, or `conflict` when the swap did not match)
 *
 * A change is a pair of document states, `before` → `after`, either of which may be
 * absent: an insert has no `before`, a delete no `after`. Undo swaps the pair, so it is
 * the same conditional write in reverse, journaled like any other edit (undoing an undo
 * redoes the edit).
 *
 * Bulk edits ("update many", "delete many") and undoing them run as jobs, 100 documents
 * at a time: each batch's pre-images are journaled before any of them is written, and
 * each document is written with its own compare-and-swap, so documents that changed
 * meanwhile are skipped and counted instead of being overwritten.
 */

import { BSON, type Collection, type Document, type MongoClient, MongoServerError } from "mongodb";
import type { JobContext, JobOutcome, JobSpec } from "../../jobs/runner.ts";
import { randomId } from "../../state/crypto.ts";
import { scrubText } from "../../state/redact.ts";
import type { StateStore } from "../../state/store.ts";
import type { ConnectionRecord, LiveEditRecord } from "../../state/types.ts";
import type { AuditInput } from "../audit.ts";
import { ConsoleError, describeError, invalid } from "../errors.ts";
import type { LiveClients } from "./clients.ts";
import {
  FAITHFUL_READ,
  fromExtendedJson,
  idKeyOf,
  idLabelOf,
  isPlainObject,
  toCanonical,
  versionOf,
} from "./documents.ts";
import { addEntry, type EntryPatch, updateEntry } from "./history.ts";
import { type JournalRecord, type LiveJournal, partsOf, RECORDS_PER_PART } from "./journal.ts";

/** Counting the documents of a bulk edit may take at most this long. */
const COUNT_TIMEOUT_MS = 30_000;

/** Databases MongoDB uses for itself: never browsed or changed from the console. */
const INTERNAL_DATABASES = new Set(["admin", "config", "local"]);

/** What the live edit functions need from the console. */
export interface LiveDeps {
  readonly store: StateStore;
  readonly journal: LiveJournal;
  readonly clients: LiveClients;
  readonly now: () => Date;
  /** Writes an audit entry (jobs audit their own outcome). */
  readonly audit: (input: AuditInput) => Promise<void>;
}

/** A change from one document state to another; see the file header. */
export interface DocumentChange {
  readonly before?: Document;
  readonly after?: Document;
}

/** What a conditional write did. */
export type WriteOutcome = "applied" | "conflict";

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/** A database and collection name, checked. */
export interface Namespace {
  readonly db: string;
  readonly collection: string;
  readonly ns: string;
}

/**
 * Parses `db.collection`. Internal databases (`admin`, `config`, `local`) and `system.*`
 * collections are refused: they hold users, roles, sessions and replication state, and
 * editing them from a web page would be a way around MongoDB's own access control.
 */
export function parseNamespace(raw: unknown): Namespace {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255) {
    throw invalid('"ns" (the namespace, e.g. app.users) is required.');
  }
  const dot = raw.indexOf(".");
  const db = dot === -1 ? "" : raw.slice(0, dot);
  const collection = dot === -1 ? "" : raw.slice(dot + 1);
  // Database names cannot contain these characters (MongoDB's own rule on all platforms).
  if (db === "" || collection === "" || /[/\\. "$\0]/.test(db) || collection.includes("\0")) {
    throw invalid(`"${raw.slice(0, 80)}" is not a namespace of the form database.collection.`);
  }
  if (INTERNAL_DATABASES.has(db) || collection.startsWith("system.")) {
    throw invalid(
      `"${raw}" belongs to MongoDB itself and cannot be browsed or changed here.`,
      "Manage users, roles and server settings with MongoDB's own tools.",
    );
  }
  return { db, collection, ns: raw };
}

/** The collection of a namespace on a connection's live client. */
export async function collectionOf(
  deps: Pick<LiveDeps, "clients">,
  connection: ConnectionRecord,
  namespace: Namespace,
): Promise<Collection<Document>> {
  const client: MongoClient = await deps.clients.clientFor(connection);
  return client.db(namespace.db).collection(namespace.collection);
}

/**
 * The collection of a namespace for a write: views and time series collections are
 * refused (the data browser shows them read-only, and the server enforces it). A
 * collection that does not exist yet is fine: an insert creates it.
 */
export async function writableCollectionOf(
  deps: Pick<LiveDeps, "clients">,
  connection: ConnectionRecord,
  namespace: Namespace,
): Promise<Collection<Document>> {
  const client: MongoClient = await deps.clients.clientFor(connection);
  const [info] = await client
    .db(namespace.db)
    .listCollections({ name: namespace.collection }, { nameOnly: false })
    .toArray();
  if (info?.type === "view" || info?.type === "timeseries") {
    throw invalid(
      `"${namespace.ns}" is a ${info.type === "view" ? "view" : "time series collection"} and read-only here.`,
    );
  }
  return client.db(namespace.db).collection(namespace.collection);
}

// ---------------------------------------------------------------------------
// Conditional writes
// ---------------------------------------------------------------------------

/**
 * A filter that matches the document only while it is exactly `document`: same `_id`,
 * and the whole stored document equal to it (`$literal` keeps field names that start
 * with `$` from being read as expressions).
 */
export function unchangedFilter(document: Document): Document {
  return { _id: document._id, $expr: { $eq: ["$$ROOT", { $literal: document }] } };
}

/** The current version of a document by `_id`, read without losing types; `undefined` if missing. */
export async function readCurrent(
  collection: Collection<Document>,
  id: unknown,
): Promise<Document | undefined> {
  // A plain Document filter: `_id` may be of any BSON type, not just ObjectId.
  const filter: Document = { _id: id };
  const found = await collection.findOne(filter, FAITHFUL_READ);
  return found ?? undefined;
}

/** MongoDB's duplicate key error code. */
const DUPLICATE_KEY = 11000;

/**
 * Applies one change with a compare-and-swap (see the file header). Never overwrites a
 * document that is not exactly `before`, and never inserts over an existing `_id`.
 */
export async function conditionalWrite(
  collection: Collection<Document>,
  change: DocumentChange,
): Promise<WriteOutcome> {
  const { before, after } = change;
  if (before !== undefined && after !== undefined) {
    const result = await collection.replaceOne(unchangedFilter(before), after);
    return result.matchedCount === 1 ? "applied" : "conflict";
  }
  if (before !== undefined) {
    const result = await collection.deleteOne(unchangedFilter(before));
    return result.deletedCount === 1 ? "applied" : "conflict";
  }
  if (after !== undefined) {
    try {
      await collection.insertOne(after);
      return "applied";
    } catch (error) {
      if (Reflect.get(Object(error), "code") === DUPLICATE_KEY) return "conflict";
      throw error;
    }
  }
  throw new Error("A change needs a before or an after state.");
}

/** True when the stored document (or its absence) is what `expected` says. */
export function matchesExpected(
  current: Document | undefined,
  expected: Document | undefined,
): boolean {
  if (expected === undefined) return current === undefined;
  return current !== undefined && versionOf(current) === versionOf(expected);
}

/** The 409 for a document that changed since it was loaded. */
export function conflictError(what: "edit" | "undo"): ConsoleError {
  return what === "edit"
    ? new ConsoleError(
        409,
        "CONSOLE_LIVE_CONFLICT",
        "The document changed after you loaded it (or was deleted), so your change was not saved.",
        "Reload the document, check what changed, and make your edit again.",
      )
    : new ConsoleError(
        409,
        "CONSOLE_LIVE_CONFLICT",
        "The document changed after this edit, so undoing it would overwrite newer changes. Nothing was changed.",
        "Open the document in the data browser to see its current state.",
      );
}

// ---------------------------------------------------------------------------
// Single-document edits
// ---------------------------------------------------------------------------

/** One single-document change to journal and apply. */
export interface SingleEditInput {
  readonly connection: ConnectionRecord;
  readonly namespace: Namespace;
  readonly op: "insert" | "update" | "delete" | "undo";
  readonly by: string;
  readonly change: DocumentChange;
  readonly undoOf?: string;
}

/**
 * Journals and applies one change (steps 2-5 of the file header; the caller has done
 * step 1). Returns the final journal entry; its status is `conflict` when the
 * compare-and-swap did not match.
 */
export async function applySingleEdit(
  deps: LiveDeps,
  input: SingleEditInput,
): Promise<LiveEditRecord> {
  const { change } = input;
  const sample = change.before ?? change.after;
  if (sample === undefined) throw new Error("A change needs a before or an after state.");
  const entry: LiveEditRecord = {
    id: randomId(),
    connectionId: input.connection.id,
    ns: input.namespace.ns,
    op: input.op,
    by: input.by,
    at: deps.now().toISOString(),
    status: "pending",
    documents: 1,
    applied: 0,
    conflicts: 0,
    documentId: idLabelOf(sample._id),
    ...(change.before === undefined ? {} : { beforeHash: versionOf(change.before) }),
    ...(change.after === undefined ? {} : { afterHash: versionOf(change.after) }),
    ...(input.undoOf === undefined ? {} : { undoOf: input.undoOf }),
    journal: deps.journal.locationFor(input.connection.liveEdits?.journalStorageId),
    parts: 1,
  };
  await journalOrRefuse(deps, entry, 0, [recordOf(change)]);
  await addEntry(deps.store, entry);

  const collection = await collectionOf(deps, input.connection, input.namespace);
  let outcome: WriteOutcome;
  try {
    outcome = await conditionalWrite(collection, change);
  } catch (error) {
    await updateEntry(deps.store, entry.id, { status: "failed", error: describeError(error) });
    throw error;
  }
  const patch: EntryPatch =
    outcome === "applied"
      ? { status: "applied", applied: 1 }
      : { status: "conflict", conflicts: 1 };
  return (await updateEntry(deps.store, entry.id, patch)) ?? { ...entry, ...patch };
}

/** Writes a journal part, turning a storage failure into a clear "nothing was changed". */
async function journalOrRefuse(
  deps: LiveDeps,
  entry: LiveEditRecord,
  part: number,
  records: readonly JournalRecord[],
): Promise<void> {
  try {
    await deps.journal.writePart(entry, part, records);
  } catch (error) {
    throw new ConsoleError(
      502,
      "CONSOLE_LIVE_JOURNAL",
      `The pre-image could not be saved in the edit journal, so nothing was changed (${describeError(error).message}).`,
      "Check the journal storage location of this connection (Storage → Test).",
    );
  }
}

/** A change as a journal record (canonical Extended JSON keeps every type). */
function recordOf(change: DocumentChange): JournalRecord {
  const sample = change.before ?? change.after;
  if (sample === undefined) throw new Error("A change needs a before or an after state.");
  return {
    id: idKeyOf(sample),
    ...(change.before === undefined ? {} : { before: toCanonical(change.before) }),
    ...(change.after === undefined ? {} : { after: toCanonical(change.after) }),
  };
}

/** A journal record back as a change. */
export function changeOf(record: JournalRecord): DocumentChange {
  return {
    ...(record.before === undefined ? {} : { before: parseJournalDocument(record.before) }),
    ...(record.after === undefined ? {} : { after: parseJournalDocument(record.after) }),
  };
}

function parseJournalDocument(text: string): Document {
  const parsed = fromExtendedJson(text);
  if (!isPlainObject(parsed)) throw new Error("A journaled document is not an object.");
  return parsed;
}

/**
 * The change that undoes a journaled record, or `undefined` when it cannot be undone
 * conditionally: a bulk update whose post-image was never recorded (the console stopped
 * mid-batch) has no known state to compare against.
 */
export function inverseOf(
  op: LiveEditRecord["op"],
  record: JournalRecord,
): JournalRecord | undefined {
  if (record.before === undefined && record.after === undefined) return undefined;
  if (op === "bulk-update" && record.after === undefined) return undefined;
  return {
    id: record.id,
    ...(record.after === undefined ? {} : { before: record.after }),
    ...(record.before === undefined ? {} : { after: record.before }),
  };
}

// ---------------------------------------------------------------------------
// Bulk edits (jobs)
// ---------------------------------------------------------------------------

/** "Update many" / "delete many", as confirmed by the user. */
export interface BulkEditInput {
  readonly connection: ConnectionRecord;
  readonly namespace: Namespace;
  readonly op: "update" | "delete";
  readonly filter: Document;
  readonly update?: Document;
  /** The count the user confirmed; the job refuses to run if it changed. */
  readonly expectedCount: number;
  /** The connection's cap. */
  readonly max: number;
  readonly by: string;
  /** Resolves with the job's id once the runner has assigned it (stored on the entry). */
  readonly jobId: Promise<string>;
  /** Strings to scrub from errors (the connection URI). */
  readonly secrets: readonly string[];
}

/** The verb of an operation for summaries and confirmations. */
function verbOf(op: "update" | "delete"): string {
  return op === "update" ? "update" : "delete";
}

/** The text a user types to confirm a bulk edit, e.g. `delete 42 documents in app.users`. */
export function bulkConfirmText(op: "update" | "delete", count: number, ns: string): string {
  return `${verbOf(op)} ${count} ${count === 1 ? "document" : "documents"} in ${ns}`;
}

/** Counts the documents a bulk filter matches (bounded in time). */
export async function countMatching(
  collection: Collection<Document>,
  filter: Document,
): Promise<number> {
  return collection.countDocuments(filter, { maxTimeMS: COUNT_TIMEOUT_MS });
}

/** The job of a bulk edit. */
export function bulkEditJob(deps: LiveDeps, input: BulkEditInput): JobSpec {
  return {
    kind: "live-edit",
    lane: `live:${input.connection.id}`,
    startedBy: input.by,
    secrets: input.secrets,
    run: (context) => runBulkEdit(deps, input, context),
  };
}

/** The work of {@link bulkEditJob}; see the file header. */
async function runBulkEdit(
  deps: LiveDeps,
  input: BulkEditInput,
  context: JobContext,
): Promise<JobOutcome> {
  const { namespace } = input;
  const collection = await collectionOf(deps, input.connection, namespace);

  // The data may have changed since the preview: refuse rather than touch a different set.
  const matched = await countMatching(collection, input.filter);
  if (matched !== input.expectedCount) {
    throw new ConsoleError(
      409,
      "CONSOLE_LIVE_COUNT_CHANGED",
      `The filter now matches ${matched} documents instead of the ${input.expectedCount} you confirmed. Nothing was changed.`,
      "Preview the edit again and confirm the new count.",
    );
  }
  if (matched > input.max) throw tooManyDocuments(matched, input.max);

  // Only the ids are collected up front (at most max + 1 ≤ 10 001 of them), so later
  // batches re-read each document by id: a document the update makes stop matching is
  // never visited twice, and one that stopped matching meanwhile is skipped.
  const ids = await collection
    .find(input.filter, {
      projection: { _id: 1 },
      sort: { _id: 1 },
      limit: input.max + 1,
      ...FAITHFUL_READ,
    })
    .map((document) => document._id as unknown)
    .toArray();
  if (ids.length > input.max) throw tooManyDocuments(ids.length, input.max);

  const entry: LiveEditRecord = {
    id: randomId(),
    connectionId: input.connection.id,
    ns: namespace.ns,
    op: input.op === "update" ? "bulk-update" : "bulk-delete",
    by: input.by,
    at: deps.now().toISOString(),
    status: "pending",
    documents: 0,
    applied: 0,
    conflicts: 0,
    jobId: await input.jobId,
    journal: deps.journal.locationFor(input.connection.liveEdits?.journalStorageId),
    parts: Math.ceil(ids.length / RECORDS_PER_PART),
  };
  await addEntry(deps.store, entry);
  context.log("info", `Journaling and changing ${ids.length} documents in ${namespace.ns}.`);

  const totals = { documents: 0, applied: 0, conflicts: 0 };
  const startedAt = Date.now();
  try {
    const batches = partsOf(ids);
    for (const [part, batch] of batches.entries()) {
      context.signal.throwIfAborted();
      await bulkBatch(deps, input, collection, entry, part, batch, totals);
      context.progress({
        type: "overall",
        documents: totals.applied + totals.conflicts,
        estimatedDocuments: ids.length,
        bytes: 0,
        elapsedMs: Date.now() - startedAt,
        etaMs: undefined,
      });
      await updateEntry(deps.store, entry.id, { ...totals });
    }
  } catch (caught) {
    const error = jobFailure(caught, input.secrets);
    await updateEntry(deps.store, entry.id, {
      ...totals,
      status: "failed",
      error: describeError(error, input.secrets),
    });
    await auditBulk(deps, input, entry, totals, "failure");
    throw error;
  }

  const status = totals.conflicts === 0 ? "applied" : totals.applied === 0 ? "conflict" : "partial";
  await updateEntry(deps.store, entry.id, { ...totals, status });
  await auditBulk(deps, input, entry, totals, "success");
  const verb = input.op === "update" ? "updated" : "deleted";
  const skipped =
    totals.conflicts === 0 ? "" : `; ${totals.conflicts} skipped because they changed meanwhile`;
  return {
    summary: `${verb} ${totals.applied} of ${ids.length} documents in ${namespace.ns}${skipped}`,
  };
}

/**
 * One batch of a bulk edit: read the documents, journal their pre-images, change each
 * one conditionally, then rewrite the journal part with the post-images of the documents
 * that were changed (skipped ones are dropped: they were not touched).
 */
async function bulkBatch(
  deps: LiveDeps,
  input: BulkEditInput,
  collection: Collection<Document>,
  entry: LiveEditRecord,
  part: number,
  batchIds: readonly unknown[],
  totals: { documents: number; applied: number; conflicts: number },
): Promise<void> {
  // At most RECORDS_PER_PART documents, read by id and still matching the filter.
  const documents = await collection
    .find({ $and: [{ _id: { $in: batchIds } }, input.filter] }, FAITHFUL_READ)
    .toArray();
  totals.conflicts += batchIds.length - documents.length;
  await journalOrRefuse(
    deps,
    entry,
    part,
    documents.map((document) => recordOf({ before: document })),
  );

  const changed: JournalRecord[] = [];
  try {
    for (const before of documents) {
      if (input.op === "delete") {
        const outcome = await conditionalWrite(collection, { before });
        if (outcome === "applied") changed.push(recordOf({ before }));
        countOutcome(totals, outcome);
        continue;
      }
      const after = await collection.findOneAndUpdate(unchangedFilter(before), input.update ?? {}, {
        returnDocument: "after",
        ...FAITHFUL_READ,
      });
      if (after === null) {
        countOutcome(totals, "conflict");
        continue;
      }
      changed.push(recordOf({ before, after }));
      countOutcome(totals, "applied");
    }
  } finally {
    // Even when a write fails midway, the documents changed so far keep their post-images.
    totals.documents += changed.length;
    await deps.journal.writePart(entry, part, changed);
  }
}

/**
 * A job's error as the client should see it: MongoDB's refusal of a change (a type
 * mismatch for `$inc`, a validation rule, a unique index) keeps its message, scrubbed of
 * the connection string, instead of becoming a generic internal error.
 */
function jobFailure(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof MongoServerError)) return error;
  return new ConsoleError(
    400,
    "CONSOLE_LIVE_QUERY",
    `MongoDB refused a change: ${scrubText(error.message, secrets)}`,
    "Documents changed before this one keep their change and can be undone from the Edit history.",
  );
}

/** Adds one outcome to the running totals. */
function countOutcome(totals: { applied: number; conflicts: number }, outcome: WriteOutcome): void {
  if (outcome === "applied") totals.applied += 1;
  else totals.conflicts += 1;
}

/** The refusal for a bulk edit over the connection's cap. */
function tooManyDocuments(count: number, max: number): ConsoleError {
  return new ConsoleError(
    422,
    "CONSOLE_LIVE_BULK_TOO_LARGE",
    `The filter matches ${count} documents; this connection allows at most ${max} per bulk edit.`,
    "Narrow the filter, or ask an admin to raise the connection's limit.",
  );
}

/** The audit entry at the end of a bulk edit (outcome and counts; never documents). */
async function auditBulk(
  deps: LiveDeps,
  input: BulkEditInput,
  entry: LiveEditRecord,
  totals: { documents: number; applied: number; conflicts: number },
  outcome: "success" | "failure",
): Promise<void> {
  await deps.audit({
    actor: input.by,
    action: input.op === "update" ? "live.bulk_update" : "live.bulk_delete",
    target: input.namespace.ns,
    outcome,
    details: {
      connection: input.connection.name,
      entry: entry.id,
      job: entry.jobId ?? "",
      applied: totals.applied,
      conflicts: totals.conflicts,
      journaled: totals.documents,
    },
  });
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** Undoing a journal entry with many documents, as a job. */
export interface UndoJobInput {
  readonly connection: ConnectionRecord;
  readonly namespace: Namespace;
  readonly original: LiveEditRecord;
  readonly by: string;
  readonly jobId: Promise<string>;
  readonly secrets: readonly string[];
}

/** The job that undoes a bulk entry. */
export function undoJob(deps: LiveDeps, input: UndoJobInput): JobSpec {
  return {
    kind: "live-edit",
    lane: `live:${input.connection.id}`,
    startedBy: input.by,
    secrets: input.secrets,
    run: (context) => runUndo(deps, input, context),
  };
}

/** The work of {@link undoJob}: every record reversed conditionally, journaled part by part. */
async function runUndo(
  deps: LiveDeps,
  input: UndoJobInput,
  context: JobContext,
): Promise<JobOutcome> {
  const { original } = input;
  const collection = await collectionOf(deps, input.connection, input.namespace);
  const entry: LiveEditRecord = {
    id: randomId(),
    connectionId: input.connection.id,
    ns: original.ns,
    op: "undo",
    by: input.by,
    at: deps.now().toISOString(),
    status: "pending",
    documents: 0,
    applied: 0,
    conflicts: 0,
    undoOf: original.id,
    jobId: await input.jobId,
    journal: deps.journal.locationFor(input.connection.liveEdits?.journalStorageId),
    parts: original.parts,
  };
  await addEntry(deps.store, entry);

  const totals = { documents: 0, applied: 0, conflicts: 0 };
  const startedAt = Date.now();
  try {
    for await (const { part, records } of deps.journal.records(original)) {
      context.signal.throwIfAborted();
      const inverses: JournalRecord[] = [];
      for (const record of records) {
        const inverse = inverseOf(original.op, record);
        if (inverse === undefined) totals.conflicts += 1;
        else inverses.push(inverse);
      }
      // The undo's own pre-images (the documents as the original edit left them) first.
      await journalOrRefuse(deps, entry, part, inverses);
      const applied: JournalRecord[] = [];
      try {
        for (const inverse of inverses) {
          const outcome = await conditionalWrite(collection, changeOf(inverse));
          if (outcome === "applied") applied.push(inverse);
          countOutcome(totals, outcome);
        }
      } finally {
        totals.documents += applied.length;
        await deps.journal.writePart(entry, part, applied);
      }
      context.progress({
        type: "overall",
        documents: totals.applied + totals.conflicts,
        estimatedDocuments: original.documents,
        bytes: 0,
        elapsedMs: Date.now() - startedAt,
        etaMs: undefined,
      });
      await updateEntry(deps.store, entry.id, { ...totals });
    }
  } catch (caught) {
    const error = jobFailure(caught, input.secrets);
    await updateEntry(deps.store, entry.id, {
      ...totals,
      status: "failed",
      error: describeError(error, input.secrets),
    });
    await auditUndo(deps, input, entry, totals, "failure");
    throw error;
  }

  const status = totals.conflicts === 0 ? "applied" : totals.applied === 0 ? "conflict" : "partial";
  await updateEntry(deps.store, entry.id, { ...totals, status });
  if (totals.applied > 0) await updateEntry(deps.store, original.id, { undoneBy: entry.id });
  await auditUndo(deps, input, entry, totals, "success");
  const skipped =
    totals.conflicts === 0 ? "" : `; ${totals.conflicts} skipped because they changed since`;
  return { summary: `undid the edit of ${totals.applied} documents in ${original.ns}${skipped}` };
}

/** The audit entry at the end of a bulk undo. */
async function auditUndo(
  deps: LiveDeps,
  input: UndoJobInput,
  entry: LiveEditRecord,
  totals: { applied: number; conflicts: number },
  outcome: "success" | "failure",
): Promise<void> {
  await deps.audit({
    actor: input.by,
    action: "live.undo",
    target: input.original.ns,
    outcome,
    details: {
      connection: input.connection.name,
      entry: entry.id,
      undoOf: input.original.id,
      job: entry.jobId ?? "",
      applied: totals.applied,
      conflicts: totals.conflicts,
    },
  });
}

/** Canonical Extended JSON of an `_id`, parsed (journal record ids). */
export function idFromKey(key: string): unknown {
  return BSON.EJSON.parse(key, { relaxed: false });
}
