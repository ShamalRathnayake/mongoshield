/**
 * The copy engine: streams namespaces from one deployment straight into another,
 * masking and subsetting on the way. Nothing is stored in between.
 *
 *   1. plan          discover source namespaces, rename, inspect targets, pick actions
 *                    (`copy-plan.ts`); conflicts stop here with MS_RESTORE_CONFLICT
 *   2. pre-flight    mask and subset configs compiled, privileges checked on both
 *                    sides, the checkpoint to resume checked (`copy-preflight.ts`).
 *                    Nothing has been written yet; a dry run stops here.
 *   3. targets       every collection dropped? and created with its source options
 *   4. documents     the whole collection, or the subset filter's documents, in parts
 *                    (`copy-roots.ts`), `parallelism` at once. Each batch: references
 *                    noted (source values), then masked, then written by
 *                    `insertWorkers` workers.
 *   5. references    subsetting only: the documents referenced by what was copied,
 *                    round after round until nothing new is referenced
 *                    (`subset/reference-set.ts` explains the bounded-memory design)
 *   6. indexes       built after the data, one bulk build per collection, then the
 *                    Atlas Search / Vector Search indexes (where the target has them)
 *   7. views         last, in dependency order, `viewOn` adjusted for renames
 *
 * Reads use `secondaryPreferred` by default, keeping the load off a replica set's
 * primary. Like restore, a copy cannot be rolled back: a failure in steps 3–7 is
 * reported with the namespaces completed and those possibly partial.
 *
 * With `checkpoint`, progress is recorded in a local file after every step and every
 * written chunk of documents (`copy-checkpoint.ts`), and `resume` continues an
 * interrupted copy from there: finished namespaces and parts are skipped, unfinished
 * parts continue after their last checkpointed `_id`, and references are followed
 * again (writing only what is missing). Masking is keyed by the secret alone, so the
 * documents a resumed run writes are masked exactly like the first run's.
 */

import type { ReadPreferenceMode } from "mongodb";
import { mapWithConcurrency } from "../engine/pool.ts";
import { ProgressTracker } from "../engine/progress.ts";
import { prepareIndexSpecs, restoreIndexes } from "../engine/restore-indexes.ts";
import { compileRenameMap } from "../engine/restore-rename.ts";
import { restoreSearchIndexes } from "../engine/restore-search-indexes.ts";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { valueInStoredOrder } from "../format/field-order.ts";
import { compileMask } from "../mask/index.ts";
import { parseFieldPath } from "../mask/paths.ts";
import { type CollectionSpec, orderForRestore, splitNamespace } from "../mongo/index.ts";
import type { ReferenceSets } from "../subset/index.ts";
import type { CopyPlan, CopyResult } from "../types.ts";
import {
  assertTargetsUnchanged,
  CheckpointFile,
  canonicalFilters,
  collectionUuid,
  copyFingerprint,
  newCopyCheckpoint,
} from "./copy-checkpoint.ts";
import { createView, prepareTarget, toCopyError, UNORDERED_READING } from "./copy-namespace.ts";
import {
  assertNoCopyConflicts,
  buildCopyPlan,
  type CopyContext,
  type CopyEngineOptions,
  type PlannedCopyNamespace,
} from "./copy-plan.ts";
import { checkCopyPrivileges, createReferenceSets, resolveResume } from "./copy-preflight.ts";
import { collectCopiedReferences, copyRoots } from "./copy-roots.ts";
import {
  type CopyRun,
  copyDocuments,
  countsOf,
  followWriteMode,
  namespaceState,
} from "./copy-run.ts";

/** Collections copied at the same time when `parallelism` is not given. */
export const DEFAULT_COPY_PARALLELISM = 4;

/** Insert workers per collection when `insertWorkers` is not given. */
export const DEFAULT_COPY_INSERT_WORKERS = 2;

/** Where source documents are read when `readPreference` is not given. */
export const DEFAULT_COPY_READ_PREFERENCE: ReadPreferenceMode = "secondaryPreferred";

/**
 * Copies namespaces from `context.source` to `context.target`. See the file header.
 *
 * @throws MongoShieldError `MS_RESTORE_CONFLICT` when targets hold data the mode must
 *   not touch, `MS_CONFIG_INVALID` for bad options, mask or subset configs, or a
 *   checkpoint that cannot be resumed, `MS_PERMISSION_DENIED`, `MS_RESTORE_FAILED`
 *   for write failures, `MS_ABORTED`.
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
  const resume = await resolveResume(context, options);
  const effective = resume.options;
  const mask =
    effective.mask === undefined
      ? undefined
      : compileMask(effective.mask, { logger: context.logger });
  const detailed = await buildCopyPlan(context, effective, mask, resume.checkpoint);
  const { plan } = detailed;
  assertNoCopyConflicts(plan);
  if (resume.checkpoint !== undefined)
    await assertTargetsUnchanged(context.target, resume.checkpoint);
  const renameMapper = compileRenameMap(effective.rename);
  const references = createReferenceSets(context, effective, detailed, renameMapper);
  const bypassDocumentValidation = await checkCopyPrivileges(
    context,
    effective,
    detailed,
    references,
  );

  if (effective.dryRun === true) {
    context.logger.info("Dry run: nothing was written", { namespaces: plan.entries.length });
    return {
      plan,
      dryRun: true,
      documentsCopied: 0,
      durationMs: elapsedSince(startedAt),
      ...(resume.checkpoint === undefined ? {} : { resumed: true }),
    };
  }

  const checkpoint =
    effective.checkpoint === undefined
      ? undefined
      : new CheckpointFile(
          effective.checkpoint,
          resume.checkpoint ??
            newCopyCheckpoint(copyFingerprint(effective), canonicalFilters(effective.subset)),
          context.logger,
        );
  const run: CopyRun = {
    source: context.source,
    target: context.target,
    logger: context.logger,
    options: effective,
    insertWorkers,
    parallelism,
    readPreference: effective.readPreference ?? DEFAULT_COPY_READ_PREFERENCE,
    writeConcern: effective.writeConcern,
    bypassDocumentValidation,
    mask,
    subset: detailed.subset,
    references,
    renameMapper,
    tracker: new ProgressTracker({ onProgress: effective.onProgress, logger: context.logger }),
    checkpoint,
    resuming: resume.checkpoint !== undefined,
    targetOptions: new Map(),
    counts: new Map(),
    completed: [],
    inProgress: new Set(),
    searchIndexes: { created: [], notCreated: [] },
    documentsCopied: 0,
  };
  context.logger.info(run.resuming ? "Resuming an interrupted copy" : "Copying", {
    mode: plan.mode,
    namespaces: detailed.namespaces.length,
  });

  try {
    await copyAll(run, detailed.namespaces);
    // Only a durable checkpoint lets a copy that fails later (indexes, views) resume.
    await checkpoint?.flush();
  } catch (error) {
    await saveAfterFailure(run);
    throw describePartialCopy(error, run, detailed.namespaces);
  } finally {
    // Referenced source values must never outlive the copy in the target.
    await references?.dropAll();
  }
  await checkpoint?.remove();

  mask?.finish();
  run.tracker.finish();
  const durationMs = elapsedSince(startedAt);
  context.logger.info("Copy complete", { documents: run.documentsCopied, durationMs });
  const { created, notCreated } = run.searchIndexes;
  return {
    plan,
    dryRun: false,
    documentsCopied: run.documentsCopied,
    durationMs,
    ...(mask === undefined ? {} : { mask: mask.report() }),
    ...(created.length + notCreated.length === 0 ? {} : { searchIndexes: { created, notCreated } }),
    ...(run.resuming ? { resumed: true } : {}),
  };
}

/**
 * Works out what `runCopy` would do, without writing anything and without refusing
 * conflicts: they appear in the plan with `action: "conflict"`, so a caller can show
 * the whole picture before `assertNoCopyConflicts`. Validates the mask and subset,
 * and with `resume`, the checkpoint (each entry then says what is left to do).
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for bad options, mask or subset
 *   configs, or a checkpoint that cannot be resumed.
 */
export async function planCopy(
  context: CopyContext,
  options: CopyEngineOptions,
): Promise<CopyPlan> {
  const resume = await resolveResume(context, options);
  const mask =
    resume.options.mask === undefined
      ? undefined
      : compileMask(resume.options.mask, { logger: context.logger });
  const detailed = await buildCopyPlan(context, resume.options, mask, resume.checkpoint);
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
  await run.checkpoint?.flush();
  await run.references?.create();

  // 4. Documents selected without references: everything, or the filter's documents.
  const roots = storage.filter((item) => item.entry.subset !== "referenced");
  const referencesDone = run.checkpoint?.state.referencesDone === true;
  if (run.resuming && !referencesDone) await collectCopiedReferences(run, roots);
  await copyRoots(run, roots);

  // 5. Documents referenced by what was copied, until nothing new is referenced.
  if (run.references !== undefined && !referencesDone) {
    await followReferences(run, run.references, storage);
  }
  if (run.checkpoint !== undefined) {
    run.checkpoint.state.referencesDone = true;
    await run.checkpoint.flush();
  }

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

/**
 * Drops and/or creates one target collection, and records it in the checkpoint with
 * its UUID. A resumed copy keeps targets it already prepared, except those it must
 * copy again from the start (see `CopyResumeState`): they are cleared first.
 */
async function prepare(run: CopyRun, item: PlannedCopyNamespace): Promise<void> {
  const { entry, spec } = item;
  const { database, collection } = splitNamespace(entry.to);
  const db = run.target.db(database);
  const state = namespaceState(run, item);
  run.inProgress.add(entry.to);
  run.tracker.startNamespace(entry.to, entry.subset === "all" ? entry.documents : 0);
  countsOf(run, entry.to);
  if (entry.resume === "done") return;

  if (state?.prepared === true && entry.resume === "partial") {
    // Kept as the interrupted run left it; its own options decide index collations.
    run.targetOptions.set(
      entry.to,
      await prepareTarget(db, collection, spec, "insert", run.writeConcern),
    );
    return;
  }
  run.logger.info("Copying namespace", { from: entry.from, to: entry.to, action: entry.action });
  const action = entry.resume === "restart" ? await clearForRestart(run, item) : entry.action;
  run.targetOptions.set(
    entry.to,
    await prepareTarget(db, collection, spec, action, run.writeConcern),
  );
  if (state === undefined) return;
  // A namespace the interrupted run never prepared gets this run's decision (its target
  // may have changed meanwhile); a restarted one keeps the first run's.
  if (entry.resume !== "restart" && entry.action !== "conflict") state.action = entry.action;
  state.targetUuid = (await collectionUuid(run.target, entry.to)) ?? null;
  state.prepared = true;
  state.parts = [];
  state.rootsDone = false;
  run.checkpoint?.save();
}

/**
 * Empties a target that a resumed copy must fill again from the start, and returns
 * the action that prepares it. Targets the copy created are recreated; an `insert`
 * target of a time series was empty before the copy (time series are only merged
 * into empty ones), so deleting its documents restores that. Other merge targets keep
 * their documents: they have a unique `_id`, so writing again skips what is there.
 */
async function clearForRestart(
  run: CopyRun,
  item: PlannedCopyNamespace,
): Promise<PlannedCopyNamespace["entry"]["action"]> {
  const { entry, spec } = item;
  if (entry.action === "create" || entry.action === "drop-and-create") return "drop-and-create";
  if (spec.type === "timeseries") {
    const { database, collection } = splitNamespace(entry.to);
    try {
      await run.target
        .db(database)
        .collection(collection)
        .deleteMany({}, run.writeConcern ? { writeConcern: run.writeConcern } : {});
    } catch (error) {
      throw toCopyError(entry.to, "Clearing", error);
    }
  }
  return entry.action;
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
        // A time series cannot skip a measurement it already holds (no unique _id).
        const singleReference =
          item.spec.type === "timeseries" ? parseFieldPath(set.path) : undefined;
        for await (const values of references.values(set, round, batchSize, signal)) {
          await copyDocuments(
            run,
            item,
            {
              // In stored order: an embedded-document value with integer-like
              // names matches nothing in JavaScript order (reference-set.ts).
              filter: { [set.path]: { $in: values.map((value) => valueInStoredOrder(value)) } },
              reading: UNORDERED_READING,
              mode: followWriteMode(item.entry),
              singleReference,
            },
            signal,
          );
        }
      },
      { concurrency: run.parallelism, signal: run.options.signal },
    );
  }
}

/** Builds the indexes (regular, then search) of one collection and records it as completed. */
async function finishCollection(run: CopyRun, item: PlannedCopyNamespace): Promise<void> {
  const { entry, spec } = item;
  const state = namespaceState(run, item);
  if (state?.finished !== true) {
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
    await copySearchIndexes(run, item);
    if (state !== undefined) {
      state.finished = true;
      run.checkpoint?.save();
    }
  }
  const counts = countsOf(run, entry.to);
  run.tracker.finishNamespace(entry.to, counts.documents, counts.bytes);
  run.inProgress.delete(entry.to);
  run.completed.push(entry.to);
}

/**
 * Recreates the source collection's Atlas Search / Vector Search index definitions
 * on the target, exactly like a restore does (`engine/restore-search-indexes.ts`):
 * indexes of the same name are kept, a target without Atlas Search gets a warning
 * and the names are reported as not created. Atlas builds them in the background.
 */
async function copySearchIndexes(run: CopyRun, item: PlannedCopyNamespace): Promise<void> {
  const definitions = item.spec.searchIndexes ?? [];
  if (definitions.length === 0) return;
  const ns = item.entry.to;
  if (run.options.skipSearchIndexes === true) {
    run.logger.info("Skipping search indexes (skipSearchIndexes)", {
      ns,
      indexes: definitions.map((definition) => definition.name),
    });
    return;
  }
  const { database, collection } = splitNamespace(ns);
  let outcome: Awaited<ReturnType<typeof restoreSearchIndexes>>;
  try {
    outcome = await restoreSearchIndexes(
      run.target.db(database).collection(collection),
      definitions,
      { ns, logger: run.logger },
    );
  } catch (error) {
    throw toCopyError(ns, "Creating the search indexes of", error);
  }
  const names = outcome.status === "created" ? outcome.created : outcome.notCreated;
  const report =
    outcome.status === "created" ? run.searchIndexes.created : run.searchIndexes.notCreated;
  for (const name of names) report.push({ ns, name });
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
  const state = namespaceState(run, item);
  run.inProgress.add(entry.to);
  run.tracker.startNamespace(entry.to, 0);
  if (state?.finished !== true) {
    await createView(run.target.db(database), collection, spec, {
      drop: entry.action === "drop-and-create",
      viewOn: viewSourceAfterRename(run, spec, database),
      writeConcern: run.writeConcern,
    });
    if (state !== undefined) {
      state.finished = true;
      run.checkpoint?.save();
    }
  }
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
// Failure reporting and small helpers
// ---------------------------------------------------------------------------

/** Writes the checkpoint one last time after a failure, so the run can be resumed. */
async function saveAfterFailure(run: CopyRun): Promise<void> {
  try {
    await run.checkpoint?.flush();
  } catch (error) {
    run.logger.warn("Could not save the copy checkpoint after the failure", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
  const resumable = run.checkpoint !== undefined;
  const resumeHint =
    "Then run the same copy again with --resume (resume: true) to continue where it stopped.";
  return new MongoShieldError(base.code, `${base.message}${summary}`, {
    cause: base,
    hint: resumable
      ? `${base.hint ?? "Fix the cause."} ${resumeHint}`
      : (base.hint ??
        "Fix the cause, then copy again with --drop (replaces the partial namespaces)."),
    details: {
      ...base.details,
      completedNamespaces: [...run.completed],
      partialNamespaces: partial,
      notStartedNamespaces: notStarted,
      ...(resumable ? { checkpoint: run.checkpoint?.path } : {}),
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
