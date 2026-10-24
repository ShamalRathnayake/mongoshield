/**
 * The copy engine: streams namespaces from one deployment straight into another,
 * masking and subsetting on the way. Nothing is stored in between.
 *
 *   1. plan          discover source namespaces, rename, inspect targets, pick actions
 *                    (`copy-plan.ts`); conflicts stop here with MS_RESTORE_CONFLICT
 *   2. pre-flight    mask and subset configs compiled, privileges checked on both
 *                    sides. Nothing has been written yet; a dry run stops here.
 *   3. targets       every collection dropped? and created with its source options
 *   4. documents     `parallelism` collections at once: the whole collection, or the
 *                    subset filter's documents. Each batch: references noted (source
 *                    values), then masked, then written by `insertWorkers` workers.
 *   5. references    subsetting only: the documents referenced by what was copied,
 *                    round after round until nothing new is referenced
 *                    (`subset/reference-set.ts` explains the bounded-memory design)
 *   6. indexes       built after the data, one bulk build per collection
 *   7. views         last, in dependency order, `viewOn` adjusted for renames
 *
 * Reads use `secondaryPreferred` by default, keeping the load off a replica set's
 * primary. Like restore, a copy cannot be rolled back: a failure in steps 3–7 is
 * reported with the namespaces completed and those possibly partial.
 *
 * Not yet supported: resuming an interrupted copy. Re-run it with `--drop` (each
 * namespace is replaced). A resumable copy would checkpoint each namespace's last
 * copied `_id` and continue with `{ _id: { $gt: … } }`, like resumable backups do.
 */

import { randomBytes } from "node:crypto";
import type { Document, MongoClient, ReadPreferenceMode, WriteConcernSettings } from "mongodb";
import { mapWithConcurrency } from "../engine/pool.ts";
import { ProgressTracker } from "../engine/progress.ts";
import type { WriteMode } from "../engine/restore-documents.ts";
import { prepareIndexSpecs, restoreIndexes } from "../engine/restore-indexes.ts";
import { compileRenameMap, type NamespaceMapper } from "../engine/restore-rename.ts";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { compileMask, type Mask } from "../mask/index.ts";
import {
  assertPrivileges,
  type CollectionSpec,
  checkPrivileges,
  orderForRestore,
  splitNamespace,
} from "../mongo/index.ts";
import { type CompiledSubset, ReferenceSets } from "../subset/index.ts";
import type { CopyPlan, CopyResult, RestorePlanEntry } from "../types.ts";
import { copySelection, createView, prepareTarget, toCopyError } from "./copy-namespace.ts";
import {
  assertNoCopyConflicts,
  buildCopyPlan,
  type CopyContext,
  type CopyEngineOptions,
  type DetailedCopyPlan,
  type PlannedCopyNamespace,
} from "./copy-plan.ts";

/** Collections copied at the same time when `parallelism` is not given. */
export const DEFAULT_COPY_PARALLELISM = 4;

/** Insert workers per collection when `insertWorkers` is not given. */
export const DEFAULT_COPY_INSERT_WORKERS = 2;

/** Where source documents are read when `readPreference` is not given. */
export const DEFAULT_COPY_READ_PREFERENCE: ReadPreferenceMode = "secondaryPreferred";

/** Running totals of one target namespace (several passes may write to it). */
interface NamespaceCounts {
  documents: number;
  bytes: number;
}

/** Shared state of one copy run. */
interface CopyRun {
  readonly source: MongoClient;
  readonly target: MongoClient;
  readonly logger: Logger;
  readonly options: CopyEngineOptions;
  readonly insertWorkers: number;
  readonly parallelism: number;
  readonly readPreference: ReadPreferenceMode;
  readonly writeConcern: WriteConcernSettings | undefined;
  readonly bypassDocumentValidation: boolean;
  readonly mask: Mask | undefined;
  readonly subset: CompiledSubset | undefined;
  readonly references: ReferenceSets | undefined;
  readonly renameMapper: NamespaceMapper;
  readonly tracker: ProgressTracker;
  /** Options each target collection has, keyed by target namespace (for index collations). */
  readonly targetOptions: Map<string, Document>;
  readonly counts: Map<string, NamespaceCounts>;
  readonly completed: string[];
  readonly inProgress: Set<string>;
  documentsCopied: number;
}

/**
 * Copies namespaces from `context.source` to `context.target`. See the file header.
 *
 * @throws MongoShieldError `MS_RESTORE_CONFLICT` when targets hold data the mode must
 *   not touch, `MS_CONFIG_INVALID` for bad options, mask or subset configs,
 *   `MS_PERMISSION_DENIED`, `MS_RESTORE_FAILED` for write failures, `MS_ABORTED`.
 */
export async function runCopy(
  context: CopyContext,
  options: CopyEngineOptions,
): Promise<CopyResult> {
  const startedAt = performance.now();
  const parallelism = positiveInteger(options.parallelism, DEFAULT_COPY_PARALLELISM, "parallelism");
  const insertWorkers = positiveInteger(
    options.insertWorkers,
    DEFAULT_COPY_INSERT_WORKERS,
    "insertWorkers",
  );

  // 1–2. Plan and pre-flight: everything that can fail without writing, fails here.
  const mask =
    options.mask === undefined ? undefined : compileMask(options.mask, { logger: context.logger });
  const detailed = await buildCopyPlan(context, options, mask);
  const { plan } = detailed;
  assertNoCopyConflicts(plan);
  const renameMapper = compileRenameMap(options.rename);
  const references = createReferenceSets(context, options, detailed, renameMapper);
  const bypassDocumentValidation = await checkCopyPrivileges(
    context,
    options,
    detailed,
    references,
  );

  if (options.dryRun === true) {
    context.logger.info("Dry run: nothing was written", { namespaces: plan.entries.length });
    return { plan, dryRun: true, documentsCopied: 0, durationMs: elapsedSince(startedAt) };
  }

  const run: CopyRun = {
    source: context.source,
    target: context.target,
    logger: context.logger,
    options,
    insertWorkers,
    parallelism,
    readPreference: options.readPreference ?? DEFAULT_COPY_READ_PREFERENCE,
    writeConcern: options.writeConcern,
    bypassDocumentValidation,
    mask,
    subset: detailed.subset,
    references,
    renameMapper,
    tracker: new ProgressTracker({ onProgress: options.onProgress, logger: context.logger }),
    targetOptions: new Map(),
    counts: new Map(),
    completed: [],
    inProgress: new Set(),
    documentsCopied: 0,
  };
  context.logger.info("Copying", { mode: plan.mode, namespaces: detailed.namespaces.length });

  try {
    await copyAll(run, detailed.namespaces);
  } catch (error) {
    throw describePartialCopy(error, run, detailed.namespaces);
  } finally {
    // Referenced source values must never outlive the copy in the target.
    await references?.dropAll();
  }

  mask?.finish();
  run.tracker.finish();
  const durationMs = elapsedSince(startedAt);
  context.logger.info("Copy complete", { documents: run.documentsCopied, durationMs });
  return {
    plan,
    dryRun: false,
    documentsCopied: run.documentsCopied,
    durationMs,
    ...(mask === undefined ? {} : { mask: mask.report() }),
  };
}

/**
 * Works out what `runCopy` would do, without writing anything and without refusing
 * conflicts: they appear in the plan with `action: "conflict"`, so a caller can show
 * the whole picture before `assertNoCopyConflicts`. Validates the mask and subset.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for bad options, mask or subset configs.
 */
export async function planCopy(
  context: CopyContext,
  options: CopyEngineOptions,
): Promise<CopyPlan> {
  const mask =
    options.mask === undefined ? undefined : compileMask(options.mask, { logger: context.logger });
  const detailed = await buildCopyPlan(context, options, mask);
  return detailed.plan;
}

/** Steps 3–7 of the file header. */
async function copyAll(run: CopyRun, namespaces: readonly PlannedCopyNamespace[]): Promise<void> {
  const signal = run.options.signal;
  const storage = namespaces.filter(
    (item) => item.spec.type !== "view" && item.entry.action !== "skip",
  );

  // 3. Targets first: following references may write to any collection at any time.
  await mapWithConcurrency(storage, (item) => prepare(run, item), {
    concurrency: run.parallelism,
    signal,
  });
  await run.references?.create();

  // 4. Documents selected without references: everything, or the filter's documents.
  const roots = storage.filter((item) => item.entry.subset !== "referenced");
  await mapWithConcurrency(
    roots,
    (item, _index, jobSignal) =>
      copyDocuments(
        run,
        item,
        run.subset?.filters.get(item.spec.ns) ?? {},
        rootWriteMode(item.entry),
        jobSignal,
      ),
    { concurrency: run.parallelism, signal },
  );

  // 5. Documents referenced by what was copied, until nothing new is referenced.
  if (run.references !== undefined) await followReferences(run, run.references, storage);

  // 6. Indexes, after all data.
  await mapWithConcurrency(storage, (item) => finishCollection(run, item), {
    concurrency: run.parallelism,
    signal,
  });

  // 7. Views last, one by one in dependency order (a view may read from another view).
  for (const item of orderViews(namespaces)) {
    throwIfAborted(signal);
    await copyView(run, item);
  }
}

/** Drops and/or creates one target collection. */
async function prepare(run: CopyRun, item: PlannedCopyNamespace): Promise<void> {
  const { entry, spec } = item;
  const { database, collection } = splitNamespace(entry.to);
  run.inProgress.add(entry.to);
  run.tracker.startNamespace(entry.to, entry.subset === "all" ? entry.documents : 0);
  run.logger.info("Copying namespace", { from: entry.from, to: entry.to, action: entry.action });
  const options = await prepareTarget(
    run.target.db(database),
    collection,
    spec,
    entry.action,
    run.writeConcern,
  );
  run.targetOptions.set(entry.to, options);
  run.counts.set(entry.to, { documents: 0, bytes: 0 });
}

/** Copies the source documents of `item` matching `filter`, masking them on the way. */
async function copyDocuments(
  run: CopyRun,
  item: PlannedCopyNamespace,
  filter: Document,
  mode: WriteMode,
  signal: AbortSignal,
): Promise<void> {
  const { entry, spec } = item;
  const { database, collection } = splitNamespace(entry.to);
  const counts = run.counts.get(entry.to) ?? { documents: 0, bytes: 0 };
  const before = { ...counts };
  const result = await copySelection({
    source: run.source,
    spec,
    filter,
    readPreference: run.readPreference,
    target: run.target.db(database).collection(collection),
    mode,
    workers: run.insertWorkers,
    bypassDocumentValidation: run.bypassDocumentValidation,
    writeConcern: run.writeConcern,
    signal,
    transformBatch: batchTransform(run, spec.ns),
    onProgress: (documents, bytes) =>
      run.tracker.updateNamespace(entry.to, before.documents + documents, before.bytes + bytes),
  });
  counts.documents += result.documents;
  counts.bytes += result.bytes;
  run.counts.set(entry.to, counts);
  run.documentsCopied += result.documents;
}

/**
 * What happens to each parsed batch of `ns`: references are noted FIRST, from the
 * unmasked source values (they are used to query the source), then documents are
 * masked in place. `undefined` when there is nothing to do.
 */
function batchTransform(
  run: CopyRun,
  ns: string,
): ((documents: Document[]) => Promise<Document[]>) | undefined {
  const namespaceMask = run.mask?.forNamespace(ns);
  const references = run.references;
  const hasReferences = (run.subset?.outgoing(ns).length ?? 0) > 0;
  if (namespaceMask === undefined && !hasReferences) return undefined;
  return async (documents) => {
    if (hasReferences && references !== undefined) await references.collect(ns, documents);
    if (namespaceMask !== undefined)
      for (const document of documents) namespaceMask.apply(document);
    return documents;
  };
}

/**
 * Follows references breadth-first: round 0 holds the values found while copying the
 * root documents; values found while copying round n's documents go into round n + 1.
 * Every value is followed once, so this ends even when references form cycles.
 */
async function followReferences(
  run: CopyRun,
  references: ReferenceSets,
  storage: readonly PlannedCopyNamespace[],
): Promise<void> {
  const byNs = new Map(storage.map((item) => [item.spec.ns, item]));
  const batchSize = run.subset?.batchSize ?? 1;
  for (let round = 0; await references.startRound(round); round += 1) {
    run.logger.debug("Following references", { round });
    await mapWithConcurrency(
      references.sets,
      async (set, _index, signal) => {
        const item = byNs.get(set.ns);
        if (item === undefined) return;
        for await (const values of references.values(set, round, batchSize, signal)) {
          await copyDocuments(
            run,
            item,
            { [set.path]: { $in: values } },
            followWriteMode(item.entry),
            signal,
          );
        }
      },
      { concurrency: run.parallelism, signal: run.options.signal },
    );
  }
}

/** Builds the indexes of one collection and records it as completed. */
async function finishCollection(run: CopyRun, item: PlannedCopyNamespace): Promise<void> {
  const { entry, spec } = item;
  const { database, collection } = splitNamespace(entry.to);
  if (run.options.skipIndexes !== true) {
    const specs = prepareIndexSpecs(spec.indexes, run.targetOptions.get(entry.to) ?? {});
    try {
      await restoreIndexes(run.target.db(database), collection, specs, {
        writeConcern: run.writeConcern,
        keepConflictingTargetIndexes: entry.action === "insert" || entry.action === "upsert",
        logger: run.logger,
      });
    } catch (error) {
      throw toCopyError(entry.to, "Building the indexes of", error);
    }
  }
  const counts = run.counts.get(entry.to) ?? { documents: 0, bytes: 0 };
  run.tracker.finishNamespace(entry.to, counts.documents, counts.bytes);
  run.inProgress.delete(entry.to);
  run.completed.push(entry.to);
}

/**
 * How root documents are written. Existing collections (also empty ones kept in
 * fail-if-exists mode) may hold the same `_id` already; only there are duplicates
 * expected and skipped.
 */
function rootWriteMode(entry: RestorePlanEntry): WriteMode {
  if (entry.action === "upsert") return "upsert";
  if (entry.action === "insert") return "insert-skip-duplicates";
  return "insert-new";
}

/**
 * How referenced documents are written: the same document may be referenced again
 * (it was already copied as a root, or another rule points at it), so duplicates of
 * an `_id` already written are expected and skipped.
 */
function followWriteMode(entry: RestorePlanEntry): WriteMode {
  return entry.action === "upsert" ? "upsert" : "insert-skip-duplicates";
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The views to create, each after the view it reads from. */
function orderViews(namespaces: readonly PlannedCopyNamespace[]): PlannedCopyNamespace[] {
  const views = namespaces.filter(
    (item) => item.spec.type === "view" && item.entry.action !== "skip",
  );
  const byNs = new Map(views.map((item) => [item.spec.ns, item]));
  const ordered: PlannedCopyNamespace[] = [];
  for (const spec of orderForRestore(views.map((item) => item.spec))) {
    const item = byNs.get(spec.ns);
    if (item !== undefined) ordered.push(item);
  }
  return ordered;
}

async function copyView(run: CopyRun, item: PlannedCopyNamespace): Promise<void> {
  const { entry, spec } = item;
  const { database, collection } = splitNamespace(entry.to);
  run.inProgress.add(entry.to);
  run.tracker.startNamespace(entry.to, 0);
  await createView(run.target.db(database), collection, spec, {
    drop: entry.action === "drop-and-create",
    viewOn: viewSourceAfterRename(run, spec, database),
    writeConcern: run.writeConcern,
  });
  run.tracker.finishNamespace(entry.to, 0, 0);
  run.inProgress.delete(entry.to);
  run.completed.push(entry.to);
}

/**
 * `viewOn` names a collection in the view's own database. When the rename rules moved
 * that collection, the view follows it, as long as it stays in the view's database
 * (a view cannot read from another database).
 */
function viewSourceAfterRename(
  run: CopyRun,
  spec: CollectionSpec,
  viewDatabase: string,
): string | undefined {
  const viewOn: unknown = spec.options.viewOn;
  if (typeof viewOn !== "string") return undefined;
  const renamed = splitNamespace(run.renameMapper(`${spec.db}.${viewOn}`));
  if (renamed.database === viewDatabase) return renamed.collection;
  run.logger.warn(
    "A view's source was renamed into another database; the view keeps its old source name",
    { view: spec.ns, viewOn },
  );
  return viewOn;
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/** The reference sets of a subset with `follow` rules, or `undefined`. */
function createReferenceSets(
  context: CopyContext,
  options: CopyEngineOptions,
  detailed: DetailedCopyPlan,
  renameMapper: NamespaceMapper,
): ReferenceSets | undefined {
  const follows = detailed.subset?.follows ?? [];
  if (follows.length === 0) return undefined;
  return new ReferenceSets({
    client: context.target,
    follows,
    databaseFor: (sourceNs) => splitNamespace(renameMapper(sourceNs)).database,
    runId: randomBytes(4).toString("hex"),
    writeConcern: options.writeConcern,
    logger: context.logger,
  });
}

/**
 * Checks both users' privileges before anything is written: the source user must be
 * able to read (the `backup` role's actions), the target user to restore (the
 * `restore` role's actions), plus `update` for upserts and `find` on the temporary
 * reference collections when following references.
 *
 * @returns true when inserts may bypass document validation.
 * @throws MongoShieldError `MS_PERMISSION_DENIED` listing every missing privilege.
 */
async function checkCopyPrivileges(
  context: CopyContext,
  options: CopyEngineOptions,
  detailed: DetailedCopyPlan,
  references: ReferenceSets | undefined,
): Promise<boolean> {
  const sourceNamespaces = detailed.namespaces.map((item) => item.spec.ns);
  if (sourceNamespaces.length === 0) return true;
  await assertPrivileges(context.source, {
    operation: "backup",
    databases: [...new Set(detailed.namespaces.map((item) => item.spec.db))],
    namespaces: sourceNamespaces,
  });

  const temporary = (references?.sets ?? []).map((set) => `${set.database}.${set.collection}`);
  const namespaces = [...detailed.namespaces.map((item) => item.entry.to), ...temporary];
  const databases = [...new Set(namespaces.map((ns) => splitNamespace(ns).database))];
  const extraActions = [
    ...(options.mode === "upsert" ? ["update"] : []),
    ...(references === undefined ? [] : ["find"]),
  ];
  await assertPrivileges(context.target, {
    operation: "restore",
    databases,
    namespaces,
    extraActions,
  });
  const bypass = await checkPrivileges(context.target, {
    operation: "restore",
    databases,
    namespaces,
    extraActions: [...extraActions, "bypassDocumentValidation"],
  });
  if (!bypass.ok) {
    context.logger.warn(
      "The target user lacks bypassDocumentValidation; documents are checked against validators while copying",
      { missing: bypass.missing },
    );
  }
  return bypass.ok;
}

// ---------------------------------------------------------------------------
// Failure reporting and small helpers
// ---------------------------------------------------------------------------

/**
 * Adds to a failure which namespaces were completed and which may be partial, so the
 * user knows exactly what the target looks like. Keeps the original error code.
 */
function describePartialCopy(
  error: unknown,
  run: CopyRun,
  namespaces: readonly PlannedCopyNamespace[],
): MongoShieldError {
  const partial = [...run.inProgress];
  const notStarted = namespaces
    .map((item) => item.entry.to)
    .filter((ns) => !run.completed.includes(ns) && !run.inProgress.has(ns));
  const base = isMongoShieldError(error) ? error : toCopyError("the target", "Copying to", error);
  const summary =
    ` Copy stopped: ${run.completed.length} namespace(s) completed` +
    (partial.length > 0 ? `; possibly partial: ${partial.join(", ")}` : "") +
    (notStarted.length > 0 ? `; not started: ${notStarted.length}` : "") +
    ".";
  return new MongoShieldError(base.code, `${base.message}${summary}`, {
    cause: base,
    hint:
      base.hint ?? "Fix the cause, then copy again with --drop (replaces the partial namespaces).",
    details: {
      ...base.details,
      completedNamespaces: [...run.completed],
      partialNamespaces: partial,
      notStartedNamespaces: notStarted,
    },
  });
}

/** Validates a user-supplied concurrency option. */
function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `${name} must be a whole number of at least 1, got ${String(value)}.`,
    );
  }
  return value;
}

function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
