/**
 * Document history: how one document looked over time, from every backup that holds
 * its collection and, when a change journal exists, every change made to it in between.
 * "Who changed acme's billing address, and what was it last Tuesday?"
 *
 *   list complete backups (newest first, at most `backups` that hold the namespace)
 *   → per backup: open it, read only the parts whose `_id` range can hold the id,
 *     stop at the first match → the document, or "absent"
 *   → journal (optional): every event of (oldest backup, recovery point] whose
 *     namespace and `documentKey._id` match, plus drops/renames of the collection
 *   → one list, newest first
 *
 * Times: a backup stands at the cluster time it is consistent at (snapshot: its read
 * time; converge: the end of its window), or at its completion time for consistency
 * "none". Converge backups show the document as it was at the end of their window
 * (like `find`, the changes recorded during the backup are overlaid on the dump).
 *
 * `_id`s are compared with query equality (`$eq`), so `42` finds an `_id` stored as
 * Int32, Long or Double 42. Memory: one document per backup plus the matching events.
 */

import { BSON, type Document, MaxKey } from "mongodb";
import { listBackups } from "../catalog/index.ts";
import type { EngineContext } from "../engine/context.ts";
import { type ChangeEvent, collectionNamespaceOf } from "../engine/converge-events.ts";
import { compareClusterTimes } from "../engine/converge-time.ts";
import { compileFilter, type DocumentMatcher } from "../engine/filter.ts";
import { compareValues, isDocument } from "../engine/filter-values.ts";
import { matchingDocuments } from "../engine/find.ts";
import { openBackupSource } from "../engine/read-pipeline.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { ClusterTime, CollectionEntry, DataFile, Manifest } from "../format/manifest.ts";
import { baseTimeOf, loadJournalCoverage, readJournalSegments } from "../journal/index.ts";
import { clusterTimeOfDate, dateOfClusterTime, isAfter } from "../journal/time.ts";
import type { DecryptionOptions } from "../types.ts";
import { assertNamespace, documentNamespace, manifestOf } from "./read-backup.ts";

/** How many backups `documentHistory` searches when `backups` is not given. */
export const DEFAULT_HISTORY_BACKUPS = 10;

/** Options for `documentHistory`. */
export interface DocumentHistoryOptions {
  /** The collection, `<database>.<collection>`. */
  readonly namespace: string;
  /** The document's `_id`, with its BSON type (e.g. `new ObjectId("…")`, `42`, `"ada"`). */
  readonly id: unknown;
  /**
   * How many backups that hold the namespace to search, newest first: a number, or
   * `"all"`. Defaults to {@link DEFAULT_HISTORY_BACKUPS} (each search reads the
   * collection's parts that may hold the id).
   */
  readonly backups?: "all" | number;
  /** Include the journaled changes (when a journal exists). Defaults to true. */
  readonly journal?: boolean;
  /** Keys for encrypted backups and journal segments. */
  readonly decryption?: DecryptionOptions;
  readonly signal?: AbortSignal;
}

/** The document as one backup holds it. */
export interface BackupVersion {
  readonly kind: "backup";
  readonly backupId: string;
  /** The cluster time the backup stands for (see the file header). */
  readonly time: ClusterTime;
  /** When the backup completed. */
  readonly completedAt: Date;
  /** `"absent"`: the backup holds the collection, but not this document. */
  readonly state: "present" | "absent";
  /** The document, parsed losslessly. Only when present. */
  readonly document?: Document;
}

/** One journaled change to the document (or to its whole collection). */
export interface ChangeVersion {
  readonly kind: "change";
  readonly time: ClusterTime;
  /** The second of `time`, as a date. */
  readonly at: Date;
  /** `insert`, `update`, `replace`, `delete`, or `drop` / `rename` / `dropDatabase`. */
  readonly operationType: string;
  /** The document after the change, when the event carries it (insert, replace, some updates). */
  readonly document?: Document;
  /** `update` events: the changed fields (dotted path → new value). */
  readonly updatedFields?: Document;
  /** `update` events: the removed fields. */
  readonly removedFields?: readonly string[];
}

/** One entry of a document's history. */
export type HistoryVersion = BackupVersion | ChangeVersion;

/** What the journal contributed. */
export interface HistoryJournalInfo {
  /** `"read"`: events were read; `"none"`: no journal exists; `"disabled"`: `journal: false`. */
  readonly status: "read" | "none" | "disabled";
  /** The time span that was read, when `status` is `"read"`. */
  readonly from?: ClusterTime;
  readonly to?: ClusterTime;
  /** Gaps (lost change history) inside the span that was read. */
  readonly gaps: number;
}

/** The result of `documentHistory`. */
export interface DocumentHistory {
  readonly namespace: string;
  readonly id: unknown;
  /** Every version, newest first. */
  readonly versions: readonly HistoryVersion[];
  /** Backups searched (those holding the namespace, up to `backups`). */
  readonly backupsSearched: number;
  readonly journal: HistoryJournalInfo;
}

/** A difference between two versions of a document, found by {@link diffDocuments}. */
export interface FieldChange {
  /** Dotted path, e.g. `address.city`. Arrays are compared as a whole. */
  readonly path: string;
  readonly kind: "added" | "removed" | "changed";
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * Collects the history of one document.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for a bad namespace, id or `backups`;
 *   key and integrity errors from reading backups or journal segments; `MS_ABORTED`.
 */
export async function documentHistory(
  context: EngineContext,
  options: DocumentHistoryOptions,
): Promise<DocumentHistory> {
  assertNamespace(options.namespace);
  assertUsableId(options.id);
  const limit = validateBackupLimit(options.backups);
  // `$eq` keeps an id that is itself a document (`{ a: 1 }`) from being read as operators.
  const idMatcher = compileFilter({ _id: { $eq: options.id } });

  const holding = await backupsHolding(context, options.namespace, limit, options.signal);
  const manifests = holding.map((backup) => backup.manifest);
  const versions: HistoryVersion[] = [];
  for (const backup of holding) {
    throwIfAborted(options.signal);
    versions.push(await versionInBackup(context, backup, idMatcher, options));
  }

  const journal =
    options.journal === false
      ? { info: { status: "disabled", gaps: 0 } as const, changes: [] }
      : await journaledChanges(context, manifests, idMatcher, options);
  versions.push(...journal.changes);
  versions.sort((left, right) => compareClusterTimes(right.time, left.time));

  return {
    namespace: options.namespace,
    id: options.id,
    versions,
    backupsSearched: manifests.length,
    journal: journal.info,
  };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

function assertUsableId(id: unknown): void {
  if (id === undefined || Array.isArray(id)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "Which document? Pass its _id (not an array).",
      {
        hint: 'Example: { $oid: "6523f1c2a1b2c3d4e5f60718" } in Extended JSON, or a number or string.',
      },
    );
  }
}

function validateBackupLimit(backups: "all" | number | undefined): number {
  if (backups === undefined) return DEFAULT_HISTORY_BACKUPS;
  if (backups === "all") return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(backups) || backups < 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `backups must be "all" or a whole number ≥ 1 (got ${String(backups)}).`,
    );
  }
  return backups;
}

/** A backup that holds the namespace, with the namespace's manifest entry. */
interface HoldingBackup {
  readonly manifest: Manifest;
  readonly entry: CollectionEntry;
}

/** The newest `limit` complete backups that hold `namespace` with documents. */
async function backupsHolding(
  context: EngineContext,
  namespace: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<HoldingBackup[]> {
  const entries = await listBackups(context.storage, {
    logger: context.logger,
    ...(signal ? { signal } : {}),
  });
  const holding: HoldingBackup[] = [];
  for (const catalogEntry of entries) {
    if (catalogEntry.status !== "complete") continue;
    const manifest = manifestOf(catalogEntry);
    const entry = documentNamespace(manifest, namespace);
    if (entry !== undefined) holding.push({ manifest, entry });
  }
  holding.sort((left, right) =>
    compareClusterTimes(backupTime(right.manifest), backupTime(left.manifest)),
  );
  return holding.slice(0, limit);
}

/** The cluster time a backup stands for (see the file header). */
function backupTime(manifest: Manifest): ClusterTime {
  return baseTimeOf(manifest) ?? clusterTimeOfDate(new Date(manifest.completedAt));
}

/** Looks the document up in one backup. */
async function versionInBackup(
  context: EngineContext,
  backup: HoldingBackup,
  idMatcher: DocumentMatcher,
  options: DocumentHistoryOptions,
): Promise<BackupVersion> {
  const { manifest, entry } = backup;
  const base = {
    kind: "backup",
    backupId: manifest.id,
    time: backupTime(manifest),
    completedAt: new Date(manifest.completedAt),
  } as const;

  const source = await openBackupSource(context.storage, manifest, options.decryption, {
    signal: options.signal,
  });
  const narrowed: CollectionEntry = { ...entry, files: partsThatMayHold(entry.files, options.id) };
  const opened = { manifest, entry: narrowed, source };
  // `_id`s are unique, so the first match is the document; returning closes the file.
  const matches = matchingDocuments(opened, idMatcher, options.signal, {
    logger: context.logger,
  });
  for await (const match of matches) {
    return { ...base, state: "present", document: match.document };
  }
  return { ...base, state: "absent" };
}

/**
 * The parts of a split collection whose `_id` range (`from <= _id < to`, the last
 * part also holding MaxKey) can contain `id`. Parts without a range (unsplit
 * collections) are always kept, and so is any part whose range cannot be read.
 */
export function partsThatMayHold(files: readonly DataFile[], id: unknown): DataFile[] {
  return files.filter((file) => {
    if (file.range === undefined) return true;
    try {
      const from = fromCanonicalJson(file.range.from);
      const to = fromCanonicalJson(file.range.to);
      const afterStart = compareValues(from, id) <= 0;
      const beforeEnd = to instanceof MaxKey || compareValues(id, to) < 0;
      return afterStart && beforeEnd;
    } catch {
      return true;
    }
  });
}

/** A range bound, stored as canonical Extended JSON, as a BSON value. */
function fromCanonicalJson(value: unknown): unknown {
  const wrapped: unknown = BSON.EJSON.deserialize({ value }, { relaxed: false });
  return isDocument(wrapped) ? wrapped.value : undefined;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/**
 * The journaled changes of the document from the oldest searched backup (or the
 * journal's start) to the recovery point. Each covered range is read separately, so a
 * gap in the journal shortens the history instead of failing it.
 */
async function journaledChanges(
  context: EngineContext,
  manifests: readonly Manifest[],
  idMatcher: DocumentMatcher,
  options: DocumentHistoryOptions,
): Promise<{ info: HistoryJournalInfo; changes: ChangeVersion[] }> {
  const coverage = await loadJournalCoverage(context.storage, options.signal);
  const first = coverage.ranges[0];
  const recoveryPoint = coverage.state?.recoveryPoint;
  if (first === undefined || recoveryPoint === undefined) {
    return { info: { status: "none", gaps: 0 }, changes: [] };
  }

  // Start before the oldest backup (its start, so changes made while it ran are kept).
  const oldest = manifests.at(-1);
  const windowStart =
    oldest === undefined ? first.from : clusterTimeOfDate(new Date(oldest.startedAt));
  const changes: ChangeVersion[] = [];
  let readFrom: ClusterTime | undefined;
  let rangesRead = 0;
  for (const range of coverage.ranges) {
    if (!isAfter(range.to, windowStart)) continue;
    const from = isAfter(windowStart, range.from) ? windowStart : range.from;
    readFrom ??= from;
    rangesRead += 1;
    const events = readJournalSegments(context.storage, {
      from,
      to: range.to,
      coverage,
      decryption: options.decryption,
      signal: options.signal,
    });
    for await (const { event } of events) {
      if (touchesDocument(event, options.namespace, idMatcher)) changes.push(toChange(event));
    }
  }
  if (readFrom === undefined) return { info: { status: "read", gaps: 0 }, changes };
  // Covered ranges are separated by gaps: n ranges read means n - 1 gaps inside the span.
  const gaps = rangesRead - 1;
  return { info: { status: "read", from: readFrom, to: recoveryPoint, gaps }, changes };
}

/** True for document events on this `_id`, and for events that drop or rename the collection. */
function touchesDocument(
  event: ChangeEvent,
  namespace: string,
  idMatcher: DocumentMatcher,
): boolean {
  const eventNamespace = collectionNamespaceOf(event.ns);
  if (event.operationType === "dropDatabase") {
    return event.ns !== undefined && namespace.startsWith(`${event.ns.db}.`);
  }
  if (eventNamespace !== namespace) return false;
  if (event.operationType === "drop" || event.operationType === "rename") return true;
  return event.documentKey !== undefined && idMatcher(event.documentKey);
}

function toChange(event: ChangeEvent): ChangeVersion {
  const change: ChangeVersion = {
    kind: "change",
    time: event.clusterTime,
    at: dateOfClusterTime(event.clusterTime),
    operationType: event.operationType,
    ...(event.fullDocument ? { document: event.fullDocument } : {}),
  };
  const update = event.updateDescription;
  if (update === undefined) return change;
  return { ...change, updatedFields: update.updatedFields, removedFields: update.removedFields };
}

// ---------------------------------------------------------------------------
// Comparing versions
// ---------------------------------------------------------------------------

/**
 * The field-level differences between two versions of a document, in field order.
 * Embedded documents are compared field by field; arrays and other values as a whole,
 * by exact BSON type and value (an Int32 1 and a Double 1 differ).
 */
export function diffDocuments(before: Document, after: Document, prefix = ""): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, oldValue] of Object.entries(before)) {
    const path = `${prefix}${field}`;
    if (!Object.hasOwn(after, field)) {
      changes.push({ path, kind: "removed", before: oldValue });
      continue;
    }
    const newValue: unknown = after[field];
    if (isDocument(oldValue) && isDocument(newValue)) {
      changes.push(...diffDocuments(oldValue, newValue, `${path}.`));
    } else if (!sameBsonValue(oldValue, newValue)) {
      changes.push({ path, kind: "changed", before: oldValue, after: newValue });
    }
  }
  for (const [field, newValue] of Object.entries(after)) {
    if (!Object.hasOwn(before, field)) {
      changes.push({ path: `${prefix}${field}`, kind: "added", after: newValue });
    }
  }
  return changes;
}

/** Exact equality: both values serialize to the same BSON bytes. */
export function sameBsonValue(left: unknown, right: unknown): boolean {
  const leftBytes = BSON.serialize({ value: left });
  const rightBytes = BSON.serialize({ value: right });
  return Buffer.compare(leftBytes, rightBytes) === 0;
}
