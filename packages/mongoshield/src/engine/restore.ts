/**
 * The restore engine: puts the namespaces of a backup into a MongoDB deployment.
 *
 *   1. plan          select the backup, filter, rename, inspect targets, pick actions
 *                    (`restore-plan.ts`); conflicts stop here with MS_RESTORE_CONFLICT
 *   2. pre-flight    keys present (MS_NO_IDENTITY), every metadata file read and
 *                    decrypted (proves the key works), privileges checked.
 *                    Nothing has been written yet; a dry run stops here.
 *   3. collections   `parallelism` collections at once, each: drop? → create with its
 *                    options → load documents with `insertWorkers` workers → indexes
 *                    Converge backups (manifest `changes`): every collection's documents
 *                    first, then the change events of the backup window are replayed
 *                    (converge-replay.ts), then the indexes are built.
 *   4. views         last, in dependency order, `viewOn` adjusted for renames
 *   5. users/roles   only with `usersAndRoles` "create" / "replace" (restore-authz.ts)
 *
 * Safety: the default mode never touches existing data, every failure before step 3
 * leaves the target untouched, and a failure during steps 3–4 is reported with the
 * namespaces that were completed and the ones that may be partial. Restores cannot
 * be rolled back, so the error says exactly what to clean up or re-run.
 */

import {
  type Db,
  type Document,
  type MongoClient,
  MongoServerError,
  type WriteConcernSettings,
} from "mongodb";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import type { ChangesFile } from "../format/manifest.ts";
import type { CollectionMetadata } from "../format/metadata.ts";
import type { Logger } from "../logger.ts";
import {
  assertPrivileges,
  type CollectionSpec,
  checkPrivileges,
  compileNamespaceFilter,
  orderForRestore,
  splitNamespace,
} from "../mongo/index.ts";
import { withEngineSpan } from "../telemetry/engine-spans.ts";
import { ATTRIBUTES, ENGINE_SPANS } from "../telemetry/names.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { RestoreOptions, RestoreResult, SearchIndexRef } from "../types.ts";
import type { RestoreContext } from "./context.ts";
import { replayChanges } from "./converge-replay.ts";
import {
  type ChangeWindowSummary,
  checkWindowTargets,
  planReplayTargets,
  type ReplayTargets,
  scanChangeWindow,
} from "./converge-targets.ts";
import { mapWithConcurrency } from "./pool.ts";
import { ProgressTracker } from "./progress.ts";
import { openBackupSource, readMetadataFile, type StoredBackupSource } from "./read-pipeline.ts";
import { planUsersAndRoles, restoreUsersAndRoles } from "./restore-authz.ts";
import {
  createNamespace,
  createOptionsFrom,
  dropNamespace,
  withViewSource,
} from "./restore-collections.ts";
import { loadDocuments, type WriteMode } from "./restore-documents.ts";
import { prepareIndexSpecs, restoreIndexes } from "./restore-indexes.ts";
import {
  assertNoConflicts,
  buildRestorePlan,
  type DetailedRestorePlan,
  type PlannedNamespace,
} from "./restore-plan.ts";
import { compileRenameMap, type NamespaceMapper } from "./restore-rename.ts";
import { restoreSearchIndexes } from "./restore-search-indexes.ts";

export { planRestore } from "./restore-plan.ts";

/** Collections restored at the same time when `parallelism` is not given. */
export const DEFAULT_RESTORE_PARALLELISM = 4;

/** Insert workers per collection when `insertWorkers` is not given. */
export const DEFAULT_INSERT_WORKERS = 2;

/** Metadata files read at the same time during pre-flight (small files; latency-bound). */
const METADATA_READ_CONCURRENCY = 8;

/** A planned namespace together with its decrypted metadata. */
interface RestoreItem {
  readonly planned: PlannedNamespace;
  readonly metadata: CollectionMetadata;
}

/** A converge backup's change replay, planned during pre-flight. */
interface PlannedReplay {
  readonly file: ChangesFile;
  readonly summary: ChangeWindowSummary;
  readonly targets: ReplayTargets;
  /** Targets of collections created during the window that `drop` mode replaces. */
  readonly dropFirst: readonly string[];
}

/** What loading a collection's documents left for the finishing step. */
interface LoadedCollection {
  /** The options the target collection has (they decide index collations). */
  readonly targetOptions: Document;
  readonly documents: number;
  readonly bytes: number;
}

/** Shared state of one restore run. */
interface RestoreRun {
  readonly client: MongoClient;
  readonly logger: Logger;
  readonly options: RestoreOptions;
  readonly source: StoredBackupSource;
  readonly tracker: ProgressTracker;
  readonly writeConcern: WriteConcernSettings | undefined;
  readonly bypassDocumentValidation: boolean;
  readonly renameMapper: NamespaceMapper;
  /** Per-collection and replay spans; `undefined` records nothing. */
  readonly telemetry: Telemetry | undefined;
  /** Target namespaces finished so far, for the failure report. */
  readonly completed: string[];
  /** Target namespaces started but not finished, for the failure report. */
  readonly inProgress: Set<string>;
  /** Atlas Search indexes sent to the target, and those it could not take. */
  readonly searchIndexes: {
    readonly created: SearchIndexRef[];
    readonly notCreated: SearchIndexRef[];
  };
  documentsRestored: number;
}

/**
 * Restores (part of) a backup. See the file header for the steps.
 *
 * @throws MongoShieldError `MS_RESTORE_CONFLICT` when targets hold data in
 *   `fail-if-exists` mode, `MS_NO_IDENTITY` / `MS_DECRYPTION_FAILED` for missing or wrong
 *   keys, `MS_PERMISSION_DENIED`, `MS_INTEGRITY_FAILED` for damaged files,
 *   `MS_RESTORE_FAILED` for write failures, `MS_ABORTED` when the signal fires.
 */
export async function runRestore(
  context: RestoreContext,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const startedAt = performance.now();
  const parallelism = positiveInteger(
    options.parallelism,
    DEFAULT_RESTORE_PARALLELISM,
    "parallelism",
  );
  const insertWorkers = positiveInteger(
    options.insertWorkers,
    DEFAULT_INSERT_WORKERS,
    "insertWorkers",
  );

  // 1. Plan (read-only).
  const detailed = await buildRestorePlan(context, options);
  const { plan, manifest } = detailed;
  assertNoConflicts(plan);

  // 2. Pre-flight: everything that can fail without writing, fails here.
  // Checks the keys and, for passphrase backups, unlocks the key envelope once.
  const source = await openBackupSource(context.storage, manifest, options.decryption, {
    signal: options.signal,
  });
  const items = await readAllMetadata(source, detailed.namespaces, options.signal);
  // Converge backups: the whole changes file is read now, so a damaged one is found
  // while the target is still untouched.
  const replay = await planReplay(context, options, detailed, source);
  // Users and roles (opt-in): read and checked now too, written last (step 5).
  const usersAndRoles = await planUsersAndRoles({
    mode: options.usersAndRoles,
    manifest,
    source,
    filter: compileNamespaceFilter({ include: options.include, exclude: options.exclude }),
    rename: compileRenameMap(options.rename),
    logger: context.logger,
    signal: options.signal,
  });
  const bypassDocumentValidation = await checkWritePrivileges(
    context,
    options,
    items,
    replay !== undefined,
  );

  if (options.dryRun === true) {
    context.logger.info("Dry run: nothing was written", { backupId: plan.backupId });
    return { plan, dryRun: true, documentsRestored: 0, durationMs: elapsedSince(startedAt) };
  }

  const run: RestoreRun = {
    client: context.client,
    logger: context.logger,
    options,
    source,
    tracker: new ProgressTracker({ onProgress: options.onProgress, logger: context.logger }),
    writeConcern: options.writeConcern,
    bypassDocumentValidation,
    renameMapper: compileRenameMap(options.rename),
    telemetry: context.telemetry,
    completed: [],
    inProgress: new Set(),
    searchIndexes: { created: [], notCreated: [] },
    documentsRestored: 0,
  };
  context.logger.info("Restoring backup", {
    backupId: plan.backupId,
    mode: plan.mode,
    namespaces: items.length,
  });

  try {
    // 3. Collections and time series, several at once.
    const storageItems = items.filter((item) => item.planned.entry.type !== "view");
    if (replay === undefined) {
      await mapWithConcurrency(
        storageItems,
        (item, _index, signal) => restoreCollection(run, item, insertWorkers, signal),
        { concurrency: parallelism, signal: options.signal },
      );
    } else {
      await restoreConverged(run, storageItems, replay, { insertWorkers, parallelism });
    }
    // 4. Views last, one by one in dependency order (a view may read from another view).
    for (const item of orderViews(items)) {
      throwIfAborted(options.signal);
      await restoreView(run, item);
    }
  } catch (error) {
    throw describePartialRestore(error, run, items);
  }

  // 5. Users and roles, once every collection is in place (their errors say so).
  const authzReport =
    usersAndRoles === undefined
      ? undefined
      : await restoreUsersAndRoles(run.client, usersAndRoles, {
          mode: usersAndRoles.mode,
          logger: run.logger,
          writeConcern: run.writeConcern,
          signal: options.signal,
        });

  run.tracker.finish();
  const durationMs = elapsedSince(startedAt);
  context.logger.info("Restore complete", {
    backupId: plan.backupId,
    documents: run.documentsRestored,
    durationMs,
  });
  const { created, notCreated } = run.searchIndexes;
  return {
    plan,
    dryRun: false,
    documentsRestored: run.documentsRestored,
    durationMs,
    ...(created.length + notCreated.length === 0 ? {} : { searchIndexes: { created, notCreated } }),
    ...(authzReport === undefined ? {} : { usersAndRoles: authzReport }),
  };
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/**
 * Reads (and decrypts) every planned namespace's metadata before anything is written.
 * This is where a wrong key or a damaged metadata file is found, while the target is
 * still untouched.
 */
async function readAllMetadata(
  source: StoredBackupSource,
  namespaces: readonly PlannedNamespace[],
  signal: AbortSignal | undefined,
): Promise<RestoreItem[]> {
  return mapWithConcurrency(
    namespaces,
    async (planned, _index, jobSignal) => ({
      planned,
      metadata: await readMetadataFile(source, planned.source.metadata, { signal: jobSignal }),
    }),
    { concurrency: METADATA_READ_CONCURRENCY, signal },
  );
}

/**
 * For converge backups: scans the changes file (integrity, decryption) and decides
 * where its events are replayed. `undefined` for other backups.
 *
 * @throws MongoShieldError read-pipeline errors for a damaged changes file,
 *   `MS_RESTORE_CONFLICT` when collections created during the window would overwrite data.
 */
async function planReplay(
  context: RestoreContext,
  options: RestoreOptions,
  detailed: DetailedRestorePlan,
  source: StoredBackupSource,
): Promise<PlannedReplay | undefined> {
  const file = detailed.manifest.changes;
  if (file === undefined) return undefined;
  const summary = await scanChangeWindow(source, file, options.signal);
  const restored = new Map<string, string>();
  for (const planned of detailed.namespaces) {
    if (planned.entry.action !== "skip") restored.set(planned.entry.from, planned.entry.to);
  }
  const targets = planReplayTargets({
    backedUp: new Set(detailed.manifest.namespaces.map((entry) => entry.ns)),
    restored,
    filter: compileNamespaceFilter({ include: options.include, exclude: options.exclude }),
    rename: compileRenameMap(options.rename),
    summary,
  });
  const dropFirst = await checkWindowTargets(
    context.client,
    targets,
    detailed.plan.mode,
    options.signal,
  );
  context.logger.info("The backup holds changes made while it ran; they are replayed", {
    events: summary.events,
    createdDuringBackup: [...targets.windowTargets.values()],
  });
  return { file, summary, targets, dropFirst };
}

/**
 * Checks the privileges the plan needs, and whether document validation may be
 * bypassed.
 *
 * The built-in `restore` role grants everything a default restore needs, including
 * `bypassDocumentValidation`, but NOT `find`/`update`: upserts need `update` (e.g. the
 * `readWrite` role). `readWrite` in turn lacks `bypassDocumentValidation`; then
 * documents are inserted with validation, and the log says so.
 *
 * Replaying a converge backup's changes also updates and deletes documents.
 *
 * @returns true when inserts may bypass document validation.
 * @throws MongoShieldError `MS_PERMISSION_DENIED` listing every missing privilege.
 */
async function checkWritePrivileges(
  context: RestoreContext,
  options: RestoreOptions,
  items: readonly RestoreItem[],
  replaysChanges: boolean,
): Promise<boolean> {
  const written = items.filter((item) => item.planned.entry.action !== "skip");
  if (written.length === 0) return true;
  const namespaces = written.map((item) => item.planned.entry.to);
  const databases = [...new Set(namespaces.map((ns) => splitNamespace(ns).database))];
  const extraActions = replaysChanges
    ? ["update", "remove"]
    : options.mode === "upsert"
      ? ["update"]
      : [];

  await assertPrivileges(context.client, {
    operation: "restore",
    databases,
    namespaces,
    extraActions,
  });
  const bypass = await checkPrivileges(context.client, {
    operation: "restore",
    databases,
    namespaces,
    extraActions: [...extraActions, "bypassDocumentValidation"],
  });
  if (!bypass.ok) {
    context.logger.warn(
      "The MongoDB user lacks bypassDocumentValidation; documents are checked against validators while restoring",
      { missing: bypass.missing },
    );
  }
  return bypass.ok;
}

// ---------------------------------------------------------------------------
// Collections and time series
// ---------------------------------------------------------------------------

/** Restores one collection or time series: drop? → create → documents → indexes. */
async function restoreCollection(
  run: RestoreRun,
  item: RestoreItem,
  insertWorkers: number,
  signal: AbortSignal,
): Promise<void> {
  await inNamespaceSpan(run, item, async () => {
    const loaded = await loadCollection(run, item, insertWorkers, signal);
    if (loaded !== undefined) await finishCollection(run, item, loaded, { removed: false });
    return loaded;
  });
}

/**
 * Runs restore work for one collection inside a `mongoshield.restore.namespace`
 * span, named by its target, with the documents it restored. Converge restores
 * open two such spans per collection (documents, then indexes after the replay).
 */
function inNamespaceSpan(
  run: RestoreRun,
  item: RestoreItem,
  work: () => Promise<LoadedCollection | undefined>,
): Promise<LoadedCollection | undefined> {
  return withEngineSpan(
    run.telemetry,
    ENGINE_SPANS.restoreNamespace,
    (telemetry) => telemetry.namespaceAttributes(item.planned.entry.to),
    async (span) => {
      const loaded = await work();
      if (loaded !== undefined) span.setAttributes({ [ATTRIBUTES.documents]: loaded.documents });
      return loaded;
    },
  );
}

/**
 * Restores a converge backup's collections: every collection's documents, then the
 * replay of the changes made during the backup, then the indexes. Indexes come last
 * so the replay's intermediate states can never trip a unique index.
 */
async function restoreConverged(
  run: RestoreRun,
  storageItems: readonly RestoreItem[],
  replay: PlannedReplay,
  limits: { readonly insertWorkers: number; readonly parallelism: number },
): Promise<void> {
  const { signal } = run.options;
  const loaded = await mapWithConcurrency(
    storageItems,
    (item, _index, jobSignal) =>
      inNamespaceSpan(run, item, () => loadCollection(run, item, limits.insertWorkers, jobSignal)),
    { concurrency: limits.parallelism, signal },
  );

  for (const target of replay.dropFirst) {
    const { database, collection } = splitNamespace(target);
    await inStep(target, "Dropping", () =>
      dropNamespace(run.client.db(database), collection, run.writeConcern),
    );
  }
  const result = await withEngineSpan(
    run.telemetry,
    ENGINE_SPANS.restoreReplay,
    () => ({}),
    async (span) => {
      const replayed = await replayChanges({
        client: run.client,
        logger: run.logger,
        source: run.source,
        file: replay.file,
        until: undefined,
        targets: replay.targets,
        writeConcern: run.writeConcern,
        bypassDocumentValidation: run.bypassDocumentValidation,
        tracker: run.tracker,
        expectedEvents: replay.summary.events,
        signal,
      });
      span.setAttributes({ [ATTRIBUTES.events]: replayed.applied });
      return replayed;
    },
  );

  const finishing = storageItems.flatMap((item, index) => {
    const loadedItem = loaded[index];
    return loadedItem === undefined ? [] : [{ item, loaded: loadedItem }];
  });
  await mapWithConcurrency(
    finishing,
    (job) =>
      inNamespaceSpan(run, job.item, async () => {
        await finishCollection(run, job.item, job.loaded, {
          removed: result.removedTargets.has(job.item.planned.entry.to),
        });
        return undefined;
      }),
    { concurrency: limits.parallelism, signal },
  );
}

/**
 * The first half of restoring a collection: drop? → create → documents. Returns
 * `undefined` for namespaces the plan skips.
 */
async function loadCollection(
  run: RestoreRun,
  item: RestoreItem,
  insertWorkers: number,
  signal: AbortSignal,
): Promise<LoadedCollection | undefined> {
  const { entry, source } = item.planned;
  if (entry.action === "skip") return undefined;
  const { database, collection } = splitNamespace(entry.to);
  const db = run.client.db(database);

  run.inProgress.add(entry.to);
  run.tracker.startNamespace(entry.to, entry.documents);
  run.logger.info("Restoring namespace", { from: entry.from, to: entry.to, action: entry.action });

  const targetOptions = await inStep(entry.to, "Creating", () =>
    prepareTarget(run, db, collection, item),
  );
  const loaded = await loadDocuments({
    source: run.source,
    files: source.files,
    collection: db.collection(collection),
    mode: writeModeFor(entry.action),
    workers: insertWorkers,
    bypassDocumentValidation: run.bypassDocumentValidation,
    writeConcern: run.writeConcern,
    signal,
    onProgress: (documents, bytes) => run.tracker.updateNamespace(entry.to, documents, bytes),
  });
  run.documentsRestored += loaded.documents;
  if (loaded.documentsRead !== source.documents) {
    // The checksum matched, so the file is what the backup wrote; a different count
    // means the manifest itself is inconsistent. Worth knowing, not worth failing.
    run.logger.warn("The backup holds a different number of documents than its manifest says", {
      ns: entry.from,
      manifest: source.documents,
      read: loaded.documentsRead,
    });
  }
  return { targetOptions, documents: loaded.documents, bytes: loaded.bytes };
}

/**
 * The second half: indexes, then bookkeeping. `removed` is true when replaying a
 * converge backup's changes dropped the target or renamed it away: it did not exist
 * at the end of the backup, so it gets no indexes (creating them would recreate it).
 */
async function finishCollection(
  run: RestoreRun,
  item: RestoreItem,
  loaded: LoadedCollection,
  options: { readonly removed: boolean },
): Promise<void> {
  const { entry } = item.planned;
  const { database, collection } = splitNamespace(entry.to);
  if (options.removed) {
    run.logger.info("The namespace was dropped or renamed while the backup ran; not kept", {
      ns: entry.to,
    });
  } else if (run.options.skipIndexes !== true) {
    const specs = prepareIndexSpecs(item.metadata.indexes, loaded.targetOptions);
    await restoreIndexes(run.client.db(database), collection, specs, {
      writeConcern: run.writeConcern,
      keepConflictingTargetIndexes: entry.action === "insert" || entry.action === "upsert",
      logger: run.logger,
    });
  }
  if (!options.removed) await finishSearchIndexes(run, item);

  run.tracker.finishNamespace(entry.to, loaded.documents, loaded.bytes);
  run.inProgress.delete(entry.to);
  run.completed.push(entry.to);
}

/**
 * Recreates the collection's Atlas Search / Vector Search indexes after its regular
 * indexes (see restore-search-indexes.ts), unless `skipSearchIndexes` is set. They
 * build in the background on Atlas; restore does not wait for them.
 */
async function finishSearchIndexes(run: RestoreRun, item: RestoreItem): Promise<void> {
  const definitions = item.metadata.searchIndexes ?? [];
  if (definitions.length === 0) return;
  const ns = item.planned.entry.to;
  if (run.options.skipSearchIndexes === true) {
    run.logger.info("Skipping search indexes (skipSearchIndexes)", {
      ns,
      indexes: definitions.map((definition) => definition.name),
    });
    return;
  }
  const { database, collection } = splitNamespace(ns);
  const outcome = await inStep(ns, "Creating the search indexes of", () =>
    restoreSearchIndexes(run.client.db(database).collection(collection), definitions, {
      ns,
      logger: run.logger,
    }),
  );
  if (outcome.status === "created") {
    for (const name of outcome.created) run.searchIndexes.created.push({ ns, name });
  } else {
    for (const name of outcome.notCreated) run.searchIndexes.notCreated.push({ ns, name });
  }
}

/**
 * Drops and/or creates the target as the action says, and returns the options the
 * target collection now has (they decide how index collations are restored).
 */
async function prepareTarget(
  run: RestoreRun,
  db: Db,
  collection: string,
  item: RestoreItem,
): Promise<Document> {
  const { action } = item.planned.entry;
  if (action === "drop-and-create") await dropNamespace(db, collection, run.writeConcern);
  if (action === "create" || action === "drop-and-create") {
    const options = createOptionsFrom(item.metadata.options);
    await createNamespace(db, collection, options, run.writeConcern);
    return options;
  }
  // insert / upsert into an existing collection: its own options are kept.
  run.logger.info("Restoring into an existing collection; its options and validator are kept", {
    ns: item.planned.entry.to,
  });
  return existingOptions(db, collection);
}

async function existingOptions(db: Db, collection: string): Promise<Document> {
  const [info] = await db.listCollections({ name: collection }, { nameOnly: false }).toArray();
  const options: unknown = info === undefined ? undefined : Reflect.get(info, "options");
  return isDocument(options) ? options : {};
}

function isDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How documents are written for each action. */
function writeModeFor(action: PlannedNamespace["entry"]["action"]): WriteMode {
  if (action === "upsert") return "upsert";
  // Existing collections (also empty ones kept in fail-if-exists mode) may hold the
  // same _id already; only for those are duplicates expected and skipped.
  if (action === "insert") return "insert-skip-duplicates";
  return "insert-new";
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The view items in an order where each view comes after the view it reads from. */
function orderViews(items: readonly RestoreItem[]): RestoreItem[] {
  const views = items.filter(
    (item) => item.planned.entry.type === "view" && item.planned.entry.action !== "skip",
  );
  const bySourceNs = new Map(views.map((item) => [item.planned.source.ns, item]));
  const specs: CollectionSpec[] = views.map((item) => ({
    ns: item.planned.source.ns,
    db: item.planned.source.db,
    name: item.planned.source.collection,
    type: "view",
    options: item.metadata.options,
    indexes: [],
    estimatedDocuments: 0,
  }));
  const ordered: RestoreItem[] = [];
  for (const spec of orderForRestore(specs)) {
    const item = bySourceNs.get(spec.ns);
    if (item !== undefined) ordered.push(item);
  }
  return ordered;
}

/** Recreates one view, reading from the (possibly renamed) source collection. */
async function restoreView(run: RestoreRun, item: RestoreItem): Promise<void> {
  const { entry } = item.planned;
  const { database, collection } = splitNamespace(entry.to);
  const db = run.client.db(database);
  run.inProgress.add(entry.to);
  run.tracker.startNamespace(entry.to, 0);

  const options = createOptionsFrom(item.metadata.options);
  const viewOn = viewSourceAfterRename(run, item, options.viewOn);
  await inStep(entry.to, "Creating the view", async () => {
    if (entry.action === "drop-and-create") await dropNamespace(db, collection, run.writeConcern);
    await createNamespace(
      db,
      collection,
      viewOn === undefined ? options : withViewSource(options, viewOn),
      run.writeConcern,
    );
  });

  run.tracker.finishNamespace(entry.to, 0, 0);
  run.inProgress.delete(entry.to);
  run.completed.push(entry.to);
}

/**
 * `viewOn` names a collection in the view's own database. When the rename rules
 * moved that collection, the view follows it, as long as it stays in the same
 * database as the view (a view cannot read from another database).
 */
function viewSourceAfterRename(
  run: RestoreRun,
  item: RestoreItem,
  viewOn: unknown,
): string | undefined {
  if (typeof viewOn !== "string") return undefined;
  const { entry, source } = item.planned;
  const renamedSource = splitNamespace(run.renameMapper(`${source.db}.${viewOn}`));
  const viewDatabase = splitNamespace(entry.to).database;
  if (renamedSource.database === viewDatabase) return renamedSource.collection;

  run.logger.warn(
    "A view's source was renamed into another database; the view keeps its old source name",
    {
      view: entry.to,
      viewOn,
      sourceRestoredTo: `${renamedSource.database}.${renamedSource.collection}`,
    },
  );
  return viewOn;
}

// ---------------------------------------------------------------------------
// Failure reporting and small helpers
// ---------------------------------------------------------------------------

/**
 * Adds to a failure which namespaces were completed and which may be partial, so the
 * user knows exactly what the target looks like. Keeps the original error code.
 */
function describePartialRestore(
  error: unknown,
  run: RestoreRun,
  items: readonly RestoreItem[],
): MongoShieldError {
  const partial = [...run.inProgress];
  const notStarted = items
    .map((item) => item.planned.entry.to)
    .filter((ns) => !run.completed.includes(ns) && !run.inProgress.has(ns));
  const base = isMongoShieldError(error)
    ? error
    : new MongoShieldError(
        "MS_RESTORE_FAILED",
        `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
  const summary =
    ` Restore stopped: ${run.completed.length} namespace(s) completed` +
    (partial.length > 0 ? `; possibly partial: ${partial.join(", ")}` : "") +
    (notStarted.length > 0 ? `; not started: ${notStarted.length}` : "") +
    ".";
  return new MongoShieldError(base.code, `${base.message}${summary}`, {
    cause: base,
    hint:
      base.hint ??
      "Fix the cause, then restore again with --drop (replaces the partial namespaces).",
    details: {
      ...base.details,
      completedNamespaces: [...run.completed],
      partialNamespaces: partial,
      notStartedNamespaces: notStarted,
    },
  });
}

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/**
 * Runs one step of restoring a namespace, turning raw server errors into
 * MongoShieldErrors that name the namespace and the step.
 */
async function inStep<T>(ns: string, step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (isMongoShieldError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) {
      throw new MongoShieldError("MS_PERMISSION_DENIED", `${step} ${ns} was refused: ${reason}`, {
        cause: error,
        hint: 'Grant the built-in `restore` role (db: "admin") to the MongoDB user.',
      });
    }
    throw new MongoShieldError("MS_RESTORE_FAILED", `${step} ${ns} failed: ${reason}`, {
      cause: error,
    });
  }
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
