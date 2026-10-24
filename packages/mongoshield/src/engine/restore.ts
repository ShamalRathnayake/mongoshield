/**
 * The restore engine: puts the namespaces of a backup into a MongoDB deployment.
 *
 *   1. plan          select the backup, filter, rename, inspect targets, pick actions
 *                    (`restore-plan.ts`); conflicts stop here with MS_RESTORE_CONFLICT
 *   2. pre-flight    keys present (MS_NO_IDENTITY), every metadata file read and
 *                    decrypted (proves the key works), privileges checked, and with
 *                    `verifyFirst` every data file checksummed (restore-verify-first.ts).
 *                    Nothing has been written yet; a dry run stops here.
 *   3. collections   `parallelism` collections at once, each: drop? → create with its
 *                    options → load documents with `insertWorkers` workers → indexes
 *                    Converge backups (manifest `changes`): every collection's documents
 *                    first, then the change events of the backup window are replayed
 *                    (converge-replay.ts), then the indexes are built: the dumped
 *                    ones, then the index changes of the window (converge-indexes.ts).
 *   4. views         last, in dependency order, `viewOn` and the collections their
 *                    pipelines read adjusted for renames (restore-views.ts)
 *   5. users/roles   only with `usersAndRoles` "create" / "replace" (restore-authz.ts)
 *
 * Incremental backups (restore-chain.ts): the plan restores the chain's base full
 * backup, and every incremental's changes are replayed after the base's own window, in
 * order, exactly like a converge window (documents, then all the changes, then the
 * indexes). With `at`, the last window stops at that time. Users and roles come from
 * the newest member of the chain that holds them.
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
import { isAuthzEntry, type Manifest, type StoredFile } from "../format/manifest.ts";
import type { CollectionMetadata } from "../format/metadata.ts";
import { toJournalTime } from "../journal/time.ts";
import type { Logger } from "../logger.ts";
import {
  assertPrivileges,
  type CollectionSpec,
  checkPrivileges,
  compileNamespaceFilter,
  describeDeployment,
  orderForRestore,
  splitNamespace,
  toConnectionError,
} from "../mongo/index.ts";
import { withEngineSpan } from "../telemetry/engine-spans.ts";
import { ATTRIBUTES, ENGINE_SPANS } from "../telemetry/names.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { RestoreOptions, RestoreResult, SearchIndexRef } from "../types.ts";
import { adaptRestoreConcurrency, assertUsersAndRolesRestoreSupported } from "./atlas-adapt.ts";
import type { RestoreContext } from "./context.ts";
import { applyIndexChanges } from "./converge-indexes.ts";
import { replayChangeEvents } from "./converge-replay.ts";
import {
  type ChangeWindowSummary,
  checkWindowTargets,
  planReplayTargets,
  type ReplayTargets,
  summarizeChangeEvents,
} from "./converge-targets.ts";
import { mapWithConcurrency } from "./pool.ts";
import { ProgressTracker } from "./progress.ts";
import { openBackupSource, readMetadataFile, type StoredBackupSource } from "./read-pipeline.ts";
import { planUsersAndRoles, restoreUsersAndRoles } from "./restore-authz.ts";
import {
  CHAIN_PROGRESS_LABEL,
  type ChangeWindowSource,
  chainEvents,
  openIncrementalWindows,
} from "./restore-chain.ts";
import {
  createNamespace,
  createOptionsFrom,
  dropNamespace,
  withViewSource,
} from "./restore-collections.ts";
import { loadDocuments, type WriteMode } from "./restore-documents.ts";
import { prepareIndexSpecs, restoreIndexes } from "./restore-indexes.ts";
import { alignWithLatestMetadata } from "./restore-metadata.ts";
import {
  assertNoConflicts,
  buildRestorePlan,
  type DetailedRestorePlan,
  type PlannedNamespace,
} from "./restore-plan.ts";
import { compileRenameMap, type NamespaceMapper } from "./restore-rename.ts";
import { restoreSearchIndexes } from "./restore-search-indexes.ts";
import { verifyBeforeWriting } from "./restore-verify-first.ts";
import { renameView } from "./restore-views.ts";

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
  /** The backup holding the item's files: the base, or a chain's state member. */
  readonly source: StoredBackupSource;
}

/**
 * The change replay, planned during pre-flight: a converge backup's window, followed by
 * the windows of an incremental chain (restore-chain.ts).
 */
interface PlannedReplay {
  /**
   * The windows in order, each bounded by its end (`consistency.to`, or `at`): events
   * after it are never replayed.
   */
  readonly windows: readonly ChangeWindowSource[];
  /** True when incremental backups are part of the replay (for progress and logs). */
  readonly chained: boolean;
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
  /** Change events read by the replay (converge windows and incremental chains). */
  eventsReplayed: number;
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
  const requestedParallelism = positiveInteger(
    options.parallelism,
    DEFAULT_RESTORE_PARALLELISM,
    "parallelism",
  );
  const requestedInsertWorkers = positiveInteger(
    options.insertWorkers,
    DEFAULT_INSERT_WORKERS,
    "insertWorkers",
  );

  // 1. Plan (read-only).
  const detailed = await buildRestorePlan(context, options);
  const { plan, manifest } = detailed;
  assertNoConflicts(plan);

  // The target: Atlas refuses users and roles, and its Free/Flex tiers get gentler
  // concurrency unless the caller chose it (atlas-adapt.ts).
  const target = await describeDeployment(context.client).catch((error: unknown) => {
    throw toConnectionError(error, { location: "the restore target" });
  });
  assertUsersAndRolesRestoreSupported(options, target);
  const concurrency = adaptRestoreConcurrency(
    options,
    { parallelism: requestedParallelism, insertWorkers: requestedInsertWorkers },
    target,
  );
  const { parallelism, insertWorkers } = concurrency;
  if (concurrency.adjustments.length > 0) {
    context.logger.info(
      `Atlas Free/Flex tier detected: ${concurrency.adjustments.join(", ")} to stay within the tier's throughput. Set parallelism or insertWorkers to override.`,
    );
  }

  // 2. Pre-flight: everything that can fail without writing, fails here.
  // Checks the keys and, for passphrase backups, unlocks the key envelope once.
  const source = await openBackupSource(context.storage, manifest, options.decryption, {
    signal: options.signal,
  });
  // A chain: every incremental opened once too (each has its own keys).
  const sources = await openChainSources(context, options, detailed, source);
  const items = await readAllMetadata(sources, detailed.namespaces, options.signal);
  // Converge backups: the whole changes file is read now, so a damaged one is found
  // while the target is still untouched.
  const replay = await planReplay(context, options, detailed, sources);
  // Chains: the newest metadata of each collection, applied after the replay.
  const latest = await readLatestMetadata(detailed, sources, replay, options.signal);
  // Users and roles (opt-in): read and checked now too, written last (step 5). In a
  // chain, the newest member holding them wins (incrementals may carry fresh copies).
  const authz = authzSourceOf(manifest, source, detailed.incrementals, replay);
  const usersAndRoles = await planUsersAndRoles({
    mode: options.usersAndRoles,
    manifest: authz.manifest,
    source: authz.source,
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
  // verifyFirst: every data file to be read is checksummed now, so a file damaged
  // late in a large collection cannot stop the restore halfway (restore-verify-first.ts).
  if (options.verifyFirst === true) {
    // Each backup of a chain through its own source.
    for (const [backupId, backupSource] of sources) {
      const files = filesToRead(items, replay, backupId);
      if (files.length === 0) continue;
      await verifyBeforeWriting({
        source: backupSource,
        files,
        logger: context.logger,
        signal: options.signal,
      });
    }
  }

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
    eventsReplayed: 0,
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
      await restoreConverged(run, storageItems, replay, {
        insertWorkers,
        parallelism,
        latest,
      });
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
    ...(plan.chain === undefined ? {} : { eventsReplayed: run.eventsReplayed }),
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
  sources: ReadonlyMap<string, StoredBackupSource>,
  namespaces: readonly PlannedNamespace[],
  signal: AbortSignal | undefined,
): Promise<RestoreItem[]> {
  return mapWithConcurrency(
    namespaces,
    async (planned, _index, jobSignal) => {
      const source = sourceOf(sources, planned.backupId);
      return {
        planned,
        source,
        metadata: await readMetadataFile(source, planned.source.metadata, { signal: jobSignal }),
      };
    },
    { concurrency: METADATA_READ_CONCURRENCY, signal },
  );
}

/** The opened source of one backup of the restore (the base, or a chain member). */
function sourceOf(
  sources: ReadonlyMap<string, StoredBackupSource>,
  backupId: string,
): StoredBackupSource {
  const source = sources.get(backupId);
  if (source === undefined) {
    throw new MongoShieldError("MS_INTERNAL", `Backup ${backupId} was not opened for the restore.`);
  }
  return source;
}

/**
 * The sources of every backup the restore reads: the restored backup, and for a chain
 * each incremental (its keys checked, a key envelope unlocked once).
 */
async function openChainSources(
  context: RestoreContext,
  options: RestoreOptions,
  detailed: DetailedRestorePlan,
  source: StoredBackupSource,
): Promise<Map<string, StoredBackupSource>> {
  const sources = new Map([[detailed.manifest.id, source]]);
  for (const incremental of detailed.incrementals) {
    throwIfAborted(options.signal);
    sources.set(
      incremental.id,
      await openBackupSource(context.storage, incremental, options.decryption, {
        signal: options.signal,
      }),
    );
  }
  return sources;
}

/**
 * Chains: the state member's metadata of every collection the restore writes (base
 * collections and collections created later in the chain), by target namespace, read
 * and decrypted now like every other file. Empty for other restores.
 */
async function readLatestMetadata(
  detailed: DetailedRestorePlan,
  sources: ReadonlyMap<string, StoredBackupSource>,
  replay: PlannedReplay | undefined,
  signal: AbortSignal | undefined,
): Promise<Map<string, CollectionMetadata>> {
  const latest = new Map<string, CollectionMetadata>();
  const stateId = detailed.stateBackupId;
  if (stateId === undefined) return latest;
  const source = sourceOf(sources, stateId);
  const targets = new Map<string, string>();
  for (const planned of detailed.namespaces) {
    // Existing targets (insert, upsert) keep their own options, as in any restore.
    const created = planned.entry.action === "create" || planned.entry.action === "drop-and-create";
    if (created && planned.entry.type === "collection")
      targets.set(planned.entry.from, planned.entry.to);
  }
  for (const [from, to] of replay?.targets.windowTargets ?? []) targets.set(from, to);
  for (const [from, to] of targets) {
    throwIfAborted(signal);
    const file = detailed.latestMetadata.get(from);
    if (file === undefined) continue;
    const metadata = await readMetadataFile(source, file, { signal });
    if (metadata.type === "collection") latest.set(to, metadata);
  }
  return latest;
}

/**
 * The files of backup `backupId` that the restore will read: what `verifyFirst` checks.
 */
function filesToRead(
  items: readonly RestoreItem[],
  replay: PlannedReplay | undefined,
  backupId: string,
): StoredFile[] {
  const files: StoredFile[] = [];
  for (const item of items) {
    if (item.planned.entry.action === "skip" || item.planned.backupId !== backupId) continue;
    files.push(...item.planned.source.files);
  }
  for (const window of replay?.windows ?? []) {
    if (window.backupId === backupId) files.push(window.file);
  }
  return files;
}

/**
 * Where users and roles come from: the newest member of the chain that holds them
 * (an incremental taken with `includeUsersAndRoles` stores a fresh copy), else the
 * restored backup itself.
 */
function authzSourceOf(
  manifest: Manifest,
  source: StoredBackupSource,
  incrementals: DetailedRestorePlan["incrementals"],
  replay: PlannedReplay | undefined,
): { readonly manifest: Manifest; readonly source: StoredBackupSource } {
  for (const incremental of [...incrementals].reverse()) {
    if (!incremental.namespaces.some(isAuthzEntry)) continue;
    const window = replay?.windows.find((candidate) => candidate.backupId === incremental.id);
    if (window !== undefined) return { manifest: incremental, source: window.source };
  }
  return { manifest, source };
}

/**
 * For converge backups and incremental chains: scans every changes file once
 * (integrity, decryption) and decides where its events are replayed. `undefined` when
 * there is nothing to replay.
 *
 * @throws MongoShieldError read-pipeline errors for a damaged changes file,
 *   `MS_RESTORE_CONFLICT` when collections created during the window would overwrite data.
 */
async function planReplay(
  context: RestoreContext,
  options: RestoreOptions,
  detailed: DetailedRestorePlan,
  sources: ReadonlyMap<string, StoredBackupSource>,
): Promise<PlannedReplay | undefined> {
  const { manifest } = detailed;
  const source = sourceOf(sources, manifest.id);
  const chained = detailed.plan.chain !== undefined;
  const own = manifest.changes;
  const windows: ChangeWindowSource[] = [
    // The manifest's T1 bounds the replay, not the file: see eventsUntil.
    ...(own === undefined
      ? []
      : [{ backupId: manifest.id, source, file: own, until: manifest.consistency.to }]),
    ...(await openIncrementalWindows(context.storage, detailed.incrementals, {
      decryption: options.decryption,
      // A point-in-time restore inside a chain stops its last window at `at`.
      until: chained && options.at !== undefined ? toJournalTime(options.at) : undefined,
      signal: options.signal,
      sources,
    })),
  ];
  if (windows.length === 0) return undefined;
  const summary = await summarizeChangeEvents(chainEvents(windows, options.signal));
  const restored = new Map<string, string>();
  const backedUp = new Set(detailed.manifest.namespaces.map((entry) => entry.ns));
  for (const planned of detailed.namespaces) {
    backedUp.add(planned.entry.from);
    // A chain's views and time series come from its state member, which already
    // reflects every change up to its end: the windows' events must not touch them.
    if (planned.backupId !== manifest.id) continue;
    if (planned.entry.action !== "skip") restored.set(planned.entry.from, planned.entry.to);
  }
  const targets = planReplayTargets({
    backedUp,
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
  context.logger.info(
    chained
      ? "Replaying the changes of the incremental backups after the base backup"
      : "The backup holds changes made while it ran; they are replayed",
    {
      events: summary.events,
      windows: windows.length,
      createdDuringBackup: [...targets.windowTargets.values()],
    },
  );
  return { windows, chained, summary, targets, dropFirst };
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
  limits: {
    readonly insertWorkers: number;
    readonly parallelism: number;
    /** Chains: the newest metadata of each collection, by target namespace. */
    readonly latest: ReadonlyMap<string, CollectionMetadata>;
  },
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
      const replayed = await replayChangeEvents({
        client: run.client,
        logger: run.logger,
        // Each window is already bounded by its own end (restore-chain.ts).
        events: chainEvents(replay.windows, signal),
        until: undefined,
        ...(replay.chained ? { progressLabel: CHAIN_PROGRESS_LABEL } : {}),
        targets: replay.targets,
        writeConcern: run.writeConcern,
        bypassDocumentValidation: run.bypassDocumentValidation,
        tracker: run.tracker,
        expectedEvents: replay.summary.events,
        signal,
      });
      span.setAttributes({ [ATTRIBUTES.events]: replayed.applied });
      run.eventsReplayed += replayed.events;
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

  // Index changes made during the window, on top of the dumped indexes; for
  // collections created during the window they are the only ones (converge-indexes.ts).
  if (run.options.skipIndexes !== true) {
    for (const [target, plan] of result.indexChanges) {
      throwIfAborted(signal);
      await applyIndexChanges(run.client, target, plan, {
        writeConcern: run.writeConcern,
        logger: run.logger,
      });
    }
  }

  // Chains: options and index properties changed after the base (collMod), from the
  // chain's newest metadata (restore-metadata.ts).
  for (const [target, metadata] of limits.latest) {
    throwIfAborted(signal);
    if (result.removedTargets.has(target)) continue;
    const { database, collection } = splitNamespace(target);
    const aligned = await inStep(target, "Updating the options of", () =>
      alignWithLatestMetadata(run.client.db(database), collection, metadata, {
        writeConcern: run.writeConcern,
        includeIndexes: run.options.skipIndexes !== true,
        logger: run.logger,
      }),
    );
    for (const warning of aligned.warnings) run.logger.warn(warning);
  }
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
    // The base's files, or a chain's state member's (time series).
    source: item.source,
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

/** Recreates one view, reading from the (possibly renamed) source collections. */
async function restoreView(run: RestoreRun, item: RestoreItem): Promise<void> {
  const { entry } = item.planned;
  const { database, collection } = splitNamespace(entry.to);
  const db = run.client.db(database);
  run.inProgress.add(entry.to);
  run.tracker.startNamespace(entry.to, 0);

  const options = viewOptionsAfterRename(run, item, createOptionsFrom(item.metadata.options));
  await inStep(entry.to, "Creating the view", async () => {
    if (entry.action === "drop-and-create") await dropNamespace(db, collection, run.writeConcern);
    await createNamespace(db, collection, options, run.writeConcern);
  });

  run.tracker.finishNamespace(entry.to, 0, 0);
  run.inProgress.delete(entry.to);
  run.completed.push(entry.to);
}

/**
 * `viewOn` and the collections the pipeline reads (`$lookup`, `$graphLookup`,
 * `$unionWith`, …) follow the rename rules, as long as they stay in the view's
 * database (a view cannot read from another database); see restore-views.ts.
 * References that cannot follow keep their old name, with a warning.
 */
function viewOptionsAfterRename(run: RestoreRun, item: RestoreItem, options: Document): Document {
  const { entry, source } = item.planned;
  const renamed = renameView(
    { viewOn: options.viewOn, pipeline: options.pipeline },
    {
      sourceDatabase: source.db,
      targetDatabase: splitNamespace(entry.to).database,
      rename: run.renameMapper,
    },
  );
  for (const reference of renamed.unfollowed) {
    run.logger.warn(
      "A view's source was renamed into another database; the view keeps its old source name",
      {
        view: entry.to,
        field: reference.field,
        source: reference.collection,
        sourceRestoredTo: reference.restoredTo,
      },
    );
  }
  const result =
    typeof renamed.viewOn === "string" ? withViewSource(options, renamed.viewOn) : { ...options };
  if (options.pipeline !== undefined) result.pipeline = renamed.pipeline;
  return result;
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
