/**
 * Restore preview: what a restore would change in its target, before it runs.
 *
 *   POST /api/restore/preview ─▶ `preview` job:
 *     shield.planRestore (the action per namespace, as the restore will decide it)
 *     shield.diff(backup → live target, same include/exclude/rename)
 *       → per namespace: documents only in the backup / only in the target / changed /
 *         identical, index and option differences, and the effect in the chosen mode
 *   GET  /api/restore/preview/:id             the result (kept in memory, see PreviewStore)
 *   GET  /api/restore/preview/:id/documents   a page of the listed `_id`s of one category
 *   POST /api/restore/preview/:id/document    one document in both versions, field by field
 *
 * The preview only READS the target: listCollections/listIndexes and counts (planning),
 * `find` (the diff and the document view). It is bounded:
 *
 *   - namespaces with more than `sampleAbove` documents are compared by a sample of
 *     `sampleSize` backed-up documents looked up by `_id` (the library's `diff` with
 *     `sample`), so a huge collection costs a few indexed lookups, not a full scan;
 *     the result says `accuracy: "sampled"` for them
 *   - the job is stopped after `timeoutMs` (and can be cancelled like any job)
 *   - at most `listedPerCategory` `_id`s are kept per namespace and category, and at
 *     most MAX_LISTED_IDS per preview, whatever the number of namespaces
 *   - results live in memory only: at most MAX_PREVIEWS, each for PREVIEW_TTL_MS
 *
 * Typed decryption keys are used by the job and by each document request, and never
 * kept with the preview (the browser sends them again, as it does for the restore).
 */

import { BSON, type Document, type MongoClient } from "mongodb";
import type { DecryptionOptions, NamespaceDiff } from "mongoshield";
import { ConsoleError, notFound } from "../server/errors.ts";
import { withClient } from "../server/mongo-inspect.ts";
import type {
  PreviewCategory,
  PreviewDocumentDiff,
  PreviewDocumentPage,
  PreviewLimits,
  PreviewNamespaceView,
} from "../shared/api.ts";
import { openConnectionUri } from "../state/secrets.ts";
import { diffDocumentFields, redactedJson } from "./preview-diff.ts";
import type { JobSpec } from "./runner.ts";
import {
  connectionById,
  decryptionFor,
  type GivenKeys,
  type RestoreJobInput,
  secretsOf,
  shieldFor,
  type TaskDeps,
} from "./tasks.ts";

/** The bounds a preview runs with unless a test passes others (see the file header). */
export const DEFAULT_PREVIEW_LIMITS: PreviewLimits = {
  sampleAbove: 100_000,
  sampleSize: 1_000,
  listedPerCategory: 500,
  timeoutMs: 10 * 60 * 1000,
};

/** `_id`s kept per preview across all namespaces and categories (bounds memory). */
const MAX_LISTED_IDS = 60_000;

/** Previews kept in memory at most; the oldest is forgotten first. */
export const MAX_PREVIEWS = 20;

/** How long a preview is kept after it was started. */
export const PREVIEW_TTL_MS = 60 * 60 * 1000;

/** One document request may scan the backup for at most this long (as the document browser). */
const DOCUMENT_TIMEOUT_MS = 60_000;

/** The target's version of a document is read with this server-side time limit. */
const LIVE_READ_TIMEOUT_MS = 10_000;

/** A document version larger than this (as JSON) is left out of a document diff. */
const MAX_DOCUMENT_CHARACTERS = 1024 * 1024;

/** BSON parsing that keeps every type (an Int32 stays an Int32), like the library's `find`. */
const LOSSLESS_BSON = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
  useBigInt64: false,
} as const;

/** The categories, in the order they are shown. */
export const PREVIEW_CATEGORIES: readonly PreviewCategory[] = [
  "changed",
  "backup-only",
  "live-only",
];

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/** What a finished preview holds besides its view: the listed `_id`s. */
export interface PreviewResult {
  readonly namespaces: readonly PreviewNamespaceView[];
  /** Per backup namespace and category: canonical Extended JSON of the listed `_id`s. */
  readonly ids: ReadonlyMap<string, Readonly<Record<PreviewCategory, readonly string[]>>>;
}

/** Filled in by the job when it succeeds; read by the routes. */
export interface PreviewOutcome {
  result?: PreviewResult;
}

/**
 * A preview job. Its lane is per target connection but separate from backups and
 * restores, so a preview never waits for a long backup of the same deployment; two
 * previews of one target run one after the other.
 */
export function previewJob(
  deps: TaskDeps,
  input: RestoreJobInput,
  startedBy: string,
  limits: PreviewLimits = DEFAULT_PREVIEW_LIMITS,
): { readonly spec: JobSpec; readonly outcome: PreviewOutcome } {
  const outcome: PreviewOutcome = {};
  const uri = openConnectionUri(deps.store, input.target);
  const decryption = decryptionFor(deps.store, input.storage.id, input.keys);
  const spec: JobSpec = {
    kind: "preview",
    lane: `preview:${input.target.id}`,
    startedBy,
    storageId: input.storage.id,
    backupId: input.backupId,
    secrets: [uri, ...secretsOf(decryption)],
    run: async (context) => {
      const timeout = AbortSignal.timeout(limits.timeoutMs);
      const signal = AbortSignal.any([context.signal, timeout]);
      try {
        outcome.result = await runPreview(deps, input, limits, signal);
      } catch (error) {
        // A cancel ends the job as cancelled (the runner sees its own signal); a
        // timeout is a failure that says what to do instead.
        if (timeout.aborted && !context.signal.aborted) throw previewTimeout(limits);
        throw error;
      }
      const changed = outcome.result.namespaces.filter((namespace) => !namespace.identical);
      return {
        summary: `Previewed ${outcome.result.namespaces.length} namespaces of ${input.target.name}: ${changed.length} would change.`,
        backupId: input.backupId,
      };
    },
  };
  return { spec, outcome };
}

function previewTimeout(limits: PreviewLimits): ConsoleError {
  return new ConsoleError(
    504,
    "CONSOLE_PREVIEW_TIMEOUT",
    `The preview took longer than ${Math.round(limits.timeoutMs / 60_000)} minutes and was stopped.`,
    "Preview fewer namespaces at a time, or restore under another name and compare there.",
  );
}

/**
 * Plans the restore and compares the backup with the target. Exported for tests,
 * which run it with small limits; the job above is the only other caller.
 */
export async function runPreview(
  deps: TaskDeps,
  input: RestoreJobInput,
  limits: PreviewLimits,
  signal: AbortSignal,
): Promise<PreviewResult> {
  const uri = openConnectionUri(deps.store, input.target);
  const decryption = decryptionFor(deps.store, input.storage.id, input.keys);
  const shield = await shieldFor(deps, input.storage);
  const selection = {
    ...(input.include === undefined ? {} : { include: input.include }),
    ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
    ...(decryption === undefined ? {} : { decryption }),
  };
  const plan = await shield.planRestore({
    backup: input.backupId,
    target: { uri },
    mode: input.mode,
    signal,
    ...selection,
    ...(input.rename === undefined ? {} : { rename: input.rename }),
  });

  // Fewer listed ids per category when there are many namespaces (MAX_LISTED_IDS).
  const perCategory = Math.max(
    1,
    Math.min(
      limits.listedPerCategory,
      Math.floor(MAX_LISTED_IDS / (PREVIEW_CATEGORIES.length * Math.max(1, plan.entries.length))),
    ),
  );
  const diff = await withClient(uri, (client: MongoClient) =>
    shield.diff({
      from: plan.backupId,
      to: { live: client },
      // Always rules (possibly none): the target side is then exactly the namespaces the
      // restore writes to, never other collections of the target's databases.
      rename: input.rename ?? {},
      examples: perCategory,
      sample: { above: limits.sampleAbove, size: limits.sampleSize },
      signal,
      ...selection,
    }),
  );

  const actions = new Map(plan.entries.map((entry) => [entry.from, entry]));
  const namespaces: PreviewNamespaceView[] = [];
  const ids = new Map<string, Record<PreviewCategory, readonly string[]>>();
  for (const namespace of diff.namespaces) {
    const entry = actions.get(namespace.namespace);
    const listed = listedIds(namespace);
    // The diff gives no examples for a target that does not exist yet (every document
    // is new); list the first backed-up ones so they can be opened all the same.
    if (namespace.presence === "only-from" && namespace.type.from !== "view") {
      listed["backup-only"] = await firstIds(shield, {
        backup: plan.backupId,
        namespace: namespace.namespace,
        limit: perCategory,
        signal,
        ...(decryption === undefined ? {} : { decryption }),
      });
    }
    ids.set(namespace.namespace, listed);
    namespaces.push(
      namespaceView(namespace, entry === undefined ? { action: "skip" } : entry, listed),
    );
  }
  return { namespaces, ids };
}

/**
 * The canonical Extended JSON of the first `limit` backed-up `_id`s of a namespace,
 * reading only as far as needed (the storage download stops there).
 */
async function firstIds(
  shield: Awaited<ReturnType<typeof shieldFor>>,
  options: {
    readonly backup: string;
    readonly namespace: string;
    readonly limit: number;
    readonly signal: AbortSignal;
    readonly decryption?: DecryptionOptions;
  },
): Promise<string[]> {
  const ids: string[] = [];
  for await (const document of shield.find({ ...options, projection: { _id: 1 } })) {
    if (document._id !== undefined)
      ids.push(BSON.EJSON.stringify(document._id, { relaxed: false }));
  }
  return ids;
}

/** The canonical Extended JSON of the example `_id`s, by category (documents without `_id` are left out). */
function listedIds(namespace: NamespaceDiff): Record<PreviewCategory, readonly string[]> {
  const canonical = (values: readonly unknown[]): string[] =>
    values.filter((id) => id !== null).map((id) => BSON.EJSON.stringify(id, { relaxed: false }));
  // The library's sides are backup ("from") and target ("to"): removed = only in the backup.
  return {
    changed: canonical(namespace.examples.changed),
    "backup-only": canonical(namespace.examples.removed),
    "live-only": canonical(namespace.examples.added),
  };
}

/** One namespace of the result: the diff in restore terms, plus the plan's action. */
export function namespaceView(
  namespace: NamespaceDiff,
  entry: { readonly action: string; readonly reason?: string | undefined },
  listed: Readonly<Record<PreviewCategory, readonly string[]>>,
): PreviewNamespaceView {
  const counts = namespace.documents;
  const documents = {
    backup: counts.from,
    live: counts.to,
    backupOnly: counts.removed,
    liveOnly: counts.added,
    changed: counts.changed,
    identical: counts.unchanged,
  };
  const effect = restoreEffect(entry.action, documents);
  const { reason } = entry;
  return {
    from: namespace.namespace,
    to: namespace.targetNamespace ?? namespace.namespace,
    targetExists: namespace.presence === "both",
    action: entry.action,
    ...(reason === undefined ? {} : { reason }),
    accuracy: namespace.sampled === undefined ? "exact" : "sampled",
    ...(namespace.sampled === undefined ? {} : { sample: namespace.sampled }),
    documents,
    ...(effect === undefined ? {} : { effect }),
    indexes: {
      backupOnly: namespace.indexes.removed,
      liveOnly: namespace.indexes.added,
      different: namespace.indexes.changed,
    },
    options: namespace.options,
    listed: {
      changed: listed.changed.length,
      "backup-only": listed["backup-only"].length,
      "live-only": listed["live-only"].length,
    },
    identical: namespace.identical,
  };
}

/**
 * What the restore does with the target's documents, by the plan's action:
 *
 *   action            backup-only   changed     target-only   identical
 *   create            inserted      –           –             –          (no target yet)
 *   drop-and-create   inserted      replaced    deleted       kept
 *   upsert            inserted      replaced    kept          kept
 *   insert            inserted      kept        kept          kept       (duplicates skipped)
 *   conflict, skip    nothing happens: no effect
 *
 * "Kept" target documents end up exactly as they are now. A drop rewrites identical
 * documents, but they end up the same, so they count as kept too.
 */
export function restoreEffect(
  action: string,
  documents: PreviewNamespaceView["documents"],
): PreviewNamespaceView["effect"] {
  const { backupOnly, liveOnly, changed, identical } = documents;
  switch (action) {
    case "create":
      return { inserted: backupOnly, replaced: 0, deleted: 0, kept: 0 };
    case "drop-and-create":
      return { inserted: backupOnly, replaced: changed, deleted: liveOnly, kept: identical };
    case "upsert":
      return { inserted: backupOnly, replaced: changed, deleted: 0, kept: identical + liveOnly };
    case "insert":
      return {
        inserted: backupOnly,
        replaced: 0,
        deleted: 0,
        kept: identical + changed + liveOnly,
      };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Kept previews
// ---------------------------------------------------------------------------

/** A preview the console remembers: what was asked (without keys) and the job's outcome. */
export interface PreviewRecord {
  readonly jobId: string;
  readonly storageId: string;
  readonly backupId: string;
  /** Looked up again on every request: a target marked production since needs an admin now. */
  readonly targetConnectionId: string;
  readonly mode: RestoreJobInput["mode"];
  readonly createdAt: Date;
  readonly outcome: PreviewOutcome;
}

/** The previews of this process, in memory only (see the file header). */
export class PreviewStore {
  readonly #records = new Map<string, PreviewRecord>();
  readonly #now: () => Date;

  constructor(now: () => Date) {
    this.#now = now;
  }

  /** Remembers a preview, forgetting the oldest beyond {@link MAX_PREVIEWS}. */
  add(record: PreviewRecord): void {
    this.#records.set(record.jobId, record);
    while (this.#records.size > MAX_PREVIEWS) {
      const oldest = this.#records.keys().next().value;
      if (oldest === undefined) break;
      this.#records.delete(oldest);
    }
  }

  /** A preview by job id, or 404 when it is unknown or has expired. */
  get(jobId: string): PreviewRecord {
    const record = this.#records.get(jobId);
    if (record === undefined || this.#now().getTime() >= this.expiresAt(record).getTime()) {
      this.#records.delete(jobId);
      throw notFound("The preview");
    }
    return record;
  }

  expiresAt(record: PreviewRecord): Date {
    return new Date(record.createdAt.getTime() + PREVIEW_TTL_MS);
  }
}

/** A preview's result, or 409 while its job has not succeeded (yet). */
export function resultOf(record: PreviewRecord): PreviewResult {
  const result = record.outcome.result;
  if (result === undefined) {
    throw new ConsoleError(
      409,
      "CONSOLE_PREVIEW_NOT_READY",
      "This preview has no result: it is still running, or it failed or was cancelled.",
      "Wait for the preview job to finish, or start the preview again.",
    );
  }
  return result;
}

/** The listed `_id`s of one namespace of a result, or 404. */
function listedOf(
  result: PreviewResult,
  ns: string,
): Readonly<Record<PreviewCategory, readonly string[]>> {
  const listed = result.ids.get(ns);
  if (listed === undefined) throw notFound(`The namespace "${ns}" of this preview`);
  return listed;
}

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

/**
 * One page of the listed `_id`s of a category. The cursor is the position in the list
 * (the list never changes once the preview has finished).
 */
export function previewPage(
  result: PreviewResult,
  ns: string,
  category: PreviewCategory,
  limit: number,
  after: number,
): PreviewDocumentPage {
  const listed = listedOf(result, ns)[category];
  const page = listed.slice(after, after + limit);
  const next = after + page.length;
  return {
    documents: page.map((id) => ({
      id,
      label: BSON.EJSON.stringify(BSON.EJSON.parse(id, { relaxed: false }), { relaxed: true }),
    })),
    listed: listed.length,
    ...(next < listed.length ? { next: String(next) } : {}),
  };
}

/**
 * One document in the backup and in the target, with its differing fields. Only
 * `_id`s the preview listed can be opened, so this is never a way to read arbitrary
 * documents of the target.
 */
export async function previewDocument(
  deps: TaskDeps,
  record: PreviewRecord,
  request: { readonly ns: string; readonly id: string; readonly keys: GivenKeys },
  signal: AbortSignal,
): Promise<PreviewDocumentDiff> {
  const result = resultOf(record);
  const namespace = result.namespaces.find((candidate) => candidate.from === request.ns);
  const listed = listedOf(result, request.ns);
  if (namespace === undefined || !PREVIEW_CATEGORIES.some((c) => listed[c].includes(request.id))) {
    throw notFound("That document of this preview");
  }
  const id: unknown = BSON.EJSON.parse(request.id, { relaxed: false });
  const storage = deps.store.current.storage.find((entry) => entry.id === record.storageId);
  if (storage === undefined) throw notFound("The storage location");
  const target = connectionById(deps.store, record.targetConnectionId);

  const backup = await backedUpVersion(deps, storage, record, request, id, signal);
  const live = await withClient(openConnectionUri(deps.store, target), (client) =>
    liveVersion(client, namespace.to, id),
  );
  const { fields, truncated } = diffDocumentFields(backup, live);
  const backupJson = backup === undefined ? undefined : redactedJson(backup);
  const liveJson = live === undefined ? undefined : redactedJson(live);
  const omitted =
    (backupJson?.length ?? 0) > MAX_DOCUMENT_CHARACTERS ||
    (liveJson?.length ?? 0) > MAX_DOCUMENT_CHARACTERS;
  return {
    ns: namespace.from,
    to: namespace.to,
    label: BSON.EJSON.stringify(id, { relaxed: true }),
    ...(omitted || backupJson === undefined ? {} : { backup: backupJson }),
    ...(omitted || liveJson === undefined ? {} : { live: liveJson }),
    ...(omitted ? { documentsOmitted: true } : {}),
    fields,
    truncated,
  };
}

/** The backed-up version of a document (the first with that `_id`), or undefined. */
async function backedUpVersion(
  deps: TaskDeps,
  storage: Parameters<typeof shieldFor>[1],
  record: PreviewRecord,
  request: { readonly ns: string; readonly keys: GivenKeys },
  id: unknown,
  signal: AbortSignal,
): Promise<Document | undefined> {
  const shield = await shieldFor(deps, storage);
  const decryption = decryptionFor(deps.store, storage.id, request.keys);
  const found = shield.find({
    backup: record.backupId,
    namespace: request.ns,
    filter: { _id: id },
    limit: 1,
    signal: AbortSignal.any([signal, AbortSignal.timeout(DOCUMENT_TIMEOUT_MS)]),
    ...(decryption === undefined ? {} : { decryption }),
  });
  for await (const document of found) return document;
  return undefined;
}

/** The target's current version of a document, parsed losslessly, or undefined. */
async function liveVersion(
  client: MongoClient,
  namespace: string,
  id: unknown,
): Promise<Document | undefined> {
  const dot = namespace.indexOf(".");
  const collection = client.db(namespace.slice(0, dot)).collection(namespace.slice(dot + 1));
  // A plain document filter: the driver's typed filter expects an ObjectId `_id`.
  const filter: Document = { _id: id };
  const found = await collection.findOne(filter, {
    ...LOSSLESS_BSON,
    maxTimeMS: LIVE_READ_TIMEOUT_MS,
  });
  return found ?? undefined;
}
