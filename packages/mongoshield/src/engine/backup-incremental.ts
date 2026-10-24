/**
 * Incremental backups: store only what changed since a previous backup (the parent),
 * forming a chain full → incremental → incremental (docs/specs/FORMAT.md,
 * "Incremental backups"; operator's view in docs/guides/incremental-backups.md).
 *
 *   validate options ─▶ describe deployment (replica set / sharded, 6.0+)
 *     ─▶ pick the parent (latest or by id) and check it can be continued
 *     ─▶ (key envelope) ─▶ change stream from right after the parent's end time
 *     ─▶ read T1 = now, drain the stream up to T1 into `_changes/window.bson…`
 *     ─▶ (includeUsersAndRoles: a fresh copy of users and roles) ─▶ write manifest
 *
 * The capture is the converge one (converge-capture.ts): the same cluster-wide change
 * stream with `showExpandedEvents` (so DDL is recorded: create, drop, rename, index
 * changes), raw events, split events reassembled, transient errors resumed, the same
 * enrichment of updates replay could not express. Only the window differs: it starts
 * where the parent ends instead of before a dump, and no collection is read.
 *
 * Why the chain is exact: the parent's data is exact at its end time P (a converge
 * backup at `consistency.to`, a snapshot backup at its read time, an incremental at
 * its own `to`). This backup records every change with a cluster time in (P, T1].
 * Restoring the chain loads the base and replays every window in order, which is the
 * converge argument once more: absolute operations, applied in cluster-time order onto
 * a state that is exact at the window's start, end exactly at its end.
 *
 * What makes an incremental impossible, each failing with a hint to take a full backup:
 * a standalone server (no change streams), a parent with consistency `none` (no exact
 * end time), a parent from another deployment or selection, a parent whose own chain is
 * broken, and an oplog that no longer reaches back to P (`MS_CHANGE_HISTORY_LOST`).
 *
 * With `fallbackToFull` (what scheduled runs use: "full weekly, incremental hourly"),
 * each of those cases takes a full backup instead, and so do the chain policies
 * `fullAfterMs` (the chain's base is too old) and `maxChainLength`; the result's
 * `fullBackupReason` says why.
 */

import type { ReadPreference } from "mongodb";
import { type CatalogEntry, listBackups } from "../catalog/catalog.ts";
import { chainEndTime, inspectChain } from "../catalog/chain.ts";
import { PLAN_LABEL } from "../catalog/scope.ts";
import { selectBackup } from "../catalog/select.ts";
import { abortError, isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import {
  caseCollisionSuffixes,
  manifestKey,
  newBackupId,
  reservedNameSuffix,
} from "../format/layout.ts";
import {
  type ChainInfo,
  type ClusterTime,
  isIncrementalManifest,
  type Manifest,
  type NamespaceEntry,
  type Selection,
} from "../format/manifest.ts";
import { writeManifest } from "../format/manifest-io.ts";
import { successor } from "../journal/time.ts";
import type { Logger } from "../logger.ts";
import {
  type CollectionSpec,
  type DeploymentInfo,
  describeDeployment,
  discoverNamespaces,
} from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type {
  BackupOptions,
  BackupResult,
  CompletedBackupResult,
  IncrementalOptions,
} from "../types.ts";
import { type AuthzScope, backupUsersAndRoles } from "./backup-authz.ts";
import { openReadConsistency, resolveConsistencyMode } from "./backup-consistency.ts";
import { namespaceEntry, planNamespace, runPendingParts } from "./backup-dump.ts";
import { toBackupError } from "./backup-errors.ts";
import { type FileEncryption, prepareFileEncryption } from "./backup-key.ts";
import { buildManifest, selectionOf } from "./backup-manifest.ts";
import { type NamespaceDumpContext, writeMetadataFile } from "./backup-namespace.ts";
import { planEncryption, validateBackupOptions } from "./backup-options.ts";
import { deleteOrphans } from "./backup-orphans.ts";
import { DEFAULT_PART_SIZE_BYTES } from "./backup-parts.ts";
import { resolveReadPreference } from "./backup-reads.ts";
import type { BackupContext } from "./context.ts";
import { type ChangeCapture, startChangeCapture } from "./converge-capture.ts";
import { compareClusterTimes, formatClusterTime, readLatestClusterTime } from "./converge-time.ts";
import { mapWithConcurrency } from "./pool.ts";
import { ProgressTracker } from "./progress.ts";

/** How long cleanup of a failed run may take before it gives up (it is best effort). */
const CLEANUP_TIMEOUT_MS = 60_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The advice every "cannot take an incremental" error ends with. */
const TAKE_A_FULL_BACKUP = "Take a full backup (without --incremental) to start a new chain.";

/** The parent an incremental continues, with what the chain needs from it. */
export interface IncrementalParent {
  readonly manifest: Manifest;
  /** The cluster time the parent's data is exact at; the new window starts right after. */
  readonly endTime: ClusterTime;
  /** The new backup's place in the chain. */
  readonly chain: ChainInfo;
}

/**
 * Takes an incremental backup (see the file header).
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for options an incremental cannot honour
 *   (a `query`, `maxDurationMs`/`resume`, consistency `none`/`snapshot`) or a parent
 *   that cannot be continued, `MS_BACKUP_NOT_FOUND` when there is no parent,
 *   `MS_UNSUPPORTED_TOPOLOGY` on a standalone server, `MS_CHANGE_HISTORY_LOST` when the
 *   oplog no longer reaches back to the parent's end, `MS_PERMISSION_DENIED` without
 *   change stream privileges, storage errors, `MS_ABORTED`.
 */
export async function runIncrementalBackup(
  context: BackupContext,
  options: BackupOptions,
  runFull: (options: BackupOptions) => Promise<BackupResult>,
): Promise<BackupResult> {
  const { client, logger, storage } = context;
  const { signal } = options;

  // 1. The options themselves (the rest is checked in step 2, where a refusal can
  //    still become a full backup with fallbackToFull).
  const incremental = incrementalOptionsOf(options);
  const fallback = incremental.fallbackToFull === true;
  throwIfAborted(signal);

  /** The full backup taken instead (fallbackToFull, or a chain policy). */
  const fullInstead = async (reason: string): Promise<BackupResult> => {
    logger.info("Taking a full backup instead of an incremental one", { reason });
    const { incremental: _incremental, ...fullOptions } = options;
    const result = await runFull(fullOptions);
    return result.status === "complete" ? { ...result, fullBackupReason: reason } : result;
  };
  /** Rethrows `error`, or takes a full backup when falling back is allowed for it. */
  const fallBackOn = (error: unknown): Promise<BackupResult> => {
    if (fallback && isMongoShieldError(error) && FALLBACK_CODES.has(error.code)) {
      return fullInstead(error.message);
    }
    throw error;
  };

  // 2. The deployment must have change streams, and the parent must be continuable.
  let parent: IncrementalParent;
  let entries: readonly CatalogEntry[];
  let deployment: DeploymentInfo;
  try {
    // A query, say, rules an incremental out: with fallbackToFull that means a full one.
    assertIncrementalOptions(options, fallback);
    deployment = await describeDeployment(client).catch(rethrowTyped);
    assertChangeStreams(deployment);
    entries = await listBackups(storage, { logger, ...(signal ? { signal } : {}) });
    parent = chooseParent(entries, {
      from: incremental.from ?? "latest",
      deployment,
      selection: selectionOf(options),
      labels: options.labels ?? {},
    });
  } catch (error) {
    return fallBackOn(error);
  }
  // 3. The chain policies: a new chain once the current one is old or long enough.
  const due = fullBackupDue(entries, parent, incremental, new Date());
  if (due !== undefined) return fullInstead(due);

  try {
    return await takeIncremental(context, options, { deployment, parent });
  } catch (error) {
    // Lost oplog history is found only once the change stream opens.
    return fallBackOn(error);
  }
}

/**
 * Errors that `fallbackToFull` answers with a full backup: "no incremental possible".
 * `MS_SNAPSHOT_TOO_OLD`: a rename's destination had to be read as of the rename (see
 * converge-capture.ts), which is outside the server's snapshot window by now.
 * `MS_PERMISSION_DENIED`: the user may not open a change stream; an unattended run is
 * better off with a full backup (consistency `auto` then reads without one) than none.
 */
const FALLBACK_CODES = new Set([
  "MS_BACKUP_NOT_FOUND",
  "MS_CONFIG_INVALID",
  "MS_UNSUPPORTED_TOPOLOGY",
  "MS_CHANGE_HISTORY_LOST",
  "MS_SNAPSHOT_TOO_OLD",
  "MS_PERMISSION_DENIED",
]);

/**
 * Why the chain policies ask for a full backup now, or `undefined`: the chain's base
 * completed more than `fullAfterMs` ago, or the chain already holds `maxChainLength`
 * incrementals.
 */
export function fullBackupDue(
  entries: readonly CatalogEntry[],
  parent: IncrementalParent,
  policy: IncrementalOptions,
  now: Date,
): string | undefined {
  const { fullAfterMs, maxChainLength } = policy;
  if (maxChainLength !== undefined && parent.chain.length > maxChainLength) {
    return `the chain of ${parent.chain.base} already has ${maxChainLength} incremental backups (maxChainLength)`;
  }
  if (fullAfterMs === undefined) return undefined;
  const base = entries.find((entry) => entry.id === parent.chain.base)?.manifest;
  const completedAt = base === undefined ? undefined : Date.parse(base.completedAt);
  if (completedAt !== undefined && now.getTime() - completedAt < fullAfterMs) return undefined;
  return `the chain's full backup ${parent.chain.base} is older than ${formatDays(fullAfterMs)} (fullAfterMs)`;
}

/** `7 days`, `12 hours`: a policy interval for a message. */
function formatDays(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24} day${hours === 24 ? "" : "s"}`;
  return `${Number(hours.toFixed(2))} hours`;
}

/** Takes the incremental itself, once the parent is known (see the file header). */
async function takeIncremental(
  context: BackupContext,
  options: BackupOptions,
  known: { readonly deployment: DeploymentInfo; readonly parent: IncrementalParent },
): Promise<CompletedBackupResult> {
  const startedAt = new Date();
  const clock = performance.now();
  const { client, logger, storage } = context;
  const { signal } = options;
  const { deployment, parent } = known;
  const encryptionPlan = planEncryption(context.encryption);
  assertRetentionSupported(storage, options.retainDays);
  const selection = selectionOf(options);
  const labels = options.labels ?? {};

  // A parent that ends after "now" cannot come from this deployment's history.
  const now = await readLatestClusterTime(client).catch(rethrowTyped);
  if (compareClusterTimes(parent.endTime, now) > 0) {
    throw cannotContinue(
      parent.manifest,
      `it ends at ${formatClusterTime(parent.endTime)}, after the deployment's current time ${formatClusterTime(now)}`,
    );
  }

  const id = newBackupId(startedAt);
  const retainUntil =
    options.retainDays === undefined
      ? undefined
      : new Date(startedAt.getTime() + options.retainDays * MS_PER_DAY);
  logger.info("Starting incremental backup", {
    id,
    parent: parent.manifest.id,
    base: parent.chain.base,
    position: parent.chain.length,
    from: formatClusterTime(parent.endTime),
  });

  const writtenKeys = new Set<string>();
  let capture: ChangeCapture | undefined;
  let manifestAttempted = false;
  try {
    // 3. The key envelope (passphrase and KMS backups), as for any backup.
    const encryption: FileEncryption | undefined =
      encryptionPlan === undefined
        ? undefined
        : await prepareFileEncryption(encryptionPlan, {
            storage,
            backupId: id,
            writtenKeys,
            retainUntil,
            signal: signal ?? new AbortController().signal,
          });

    // 4. The window: every change after the parent's end, up to now. The namespaces
    //    that exist now (plus the selection's patterns) decide which events are kept.
    const specs = await discoverNamespaces(client, {
      include: options.include,
      exclude: options.exclude,
      signal,
      logger,
    }).catch(rethrowTyped);
    capture = await startChangeCapture({
      client,
      storage,
      logger,
      backupId: id,
      compression: context.compression,
      encryption,
      writtenKeys,
      // Events at exactly the parent's end are in the parent already.
      from: successor(parent.endTime),
      specs,
      include: options.include,
      exclude: options.exclude,
      serverVersion: deployment.serverVersion,
      signal,
      retainUntil,
      purpose: "incremental",
    }).catch((error: unknown) => {
      throw toIncrementalError(error, parent);
    });
    // 5. What change events cannot tell the chain, read while the stream records:
    //    every namespace's metadata (option, validator and view changes) and every
    //    time series collection whole, in a snapshot whose time becomes the end.
    const runningCapture = capture;
    const state = await copyNamespaceState(
      dumpContextFor(context, options, { id, encryption, writtenKeys, retainUntil }),
      specs,
      {
        parallelism: validateBackupOptions(options),
        partSizeBytes: options.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES,
        readPreference: resolveReadPreference(options, "snapshot"),
        progress: new ProgressTracker({ onProgress: options.onProgress, logger }),
        telemetry: context.telemetry,
        // A capture failure stops the copies at once: the backup is lost anyway.
        signal: runningCapture.signal,
      },
    ).catch((error: unknown) => {
      throw toIncrementalError(runningCapture.failure ?? error, parent);
    });
    const captured = await capture.finish(state.end).catch((error: unknown) => {
      throw toIncrementalError(capture?.failure ?? error, parent);
    });
    // The window is recorded as (parent end, T1]: exclusive start, like the chain says.
    const window = { ...captured, from: parent.endTime };

    // 6. Users and roles (opt-in): a fresh copy, small, so the newest one wins on restore.
    const authzEntries =
      options.includeUsersAndRoles === true
        ? await backupUsersAndRoles(
            dumpContextFor(context, options, { id, encryption, writtenKeys, retainUntil }),
            authzScope(options, specs),
            signal ?? new AbortController().signal,
          )
        : [];

    // 7. Commit: the manifest is the very last object written.
    const manifest = buildManifest({
      id,
      startedAt,
      completedAt: new Date(),
      deployment,
      consistency: { mode: "converge", clusterTime: undefined, window },
      compression: context.compression,
      encryption,
      labels,
      // Collections and views by name, then users and roles, as in a full backup.
      namespaces: [
        ...state.entries,
        ...authzEntries.map((entry) => ({ ...entry, content: "full" as const })),
      ],
      immutableUntil: retainUntil,
      selection,
      chain: parent.chain,
    });
    await options.beforeCommit?.(manifest, signal === undefined ? {} : { signal });
    await deleteOrphans(storage, manifest, logger, signal);
    manifestAttempted = true;
    await writeManifest(storage, manifest, {
      ...(signal === undefined ? {} : { signal }),
      ...(retainUntil === undefined ? {} : { retainUntil }),
    });

    const durationMs = Math.round(performance.now() - clock);
    logger.info("Incremental backup complete", {
      id,
      parent: parent.manifest.id,
      events: window.file.events,
      bytesStored: manifest.totals.bytesStored,
      durationMs,
    });
    return { status: "complete", id, manifest, durationMs };
  } catch (error) {
    const failure = signal?.aborted ? abortError(signal) : toBackupError(error);
    await capture?.stop();
    logger.error("Incremental backup failed", { id, code: failure.code, error: failure.message });
    await deletePartialIncremental(storage, logger, { id, writtenKeys, manifestAttempted });
    throw failure;
  }
}

// ---------------------------------------------------------------------------
// Metadata and time series
// ---------------------------------------------------------------------------

/** How `copyNamespaceState` reads and writes. */
interface StateCopySettings {
  readonly parallelism: number;
  readonly partSizeBytes: number;
  /** Primary: snapshot reads of time series go where the snapshot was pinned. */
  readonly readPreference: ReadPreference;
  readonly progress: ProgressTracker;
  readonly telemetry: BackupContext["telemetry"];
  readonly signal: AbortSignal;
}

/**
 * The part of an incremental that is not change events (FORMAT.md, "Incremental
 * backups"):
 *
 * - a metadata file for every selected collection and view (`content: "metadata"`), as
 *   discovered at the start of the backup: collection options, validators, collation,
 *   TTL and hidden indexes, view definitions. Change events do not carry `collMod` or
 *   view changes; a chain restore applies the newest member's metadata.
 * - every selected time series collection whole (`content: "full"`), with the dump a
 *   full backup uses, read in one snapshot. Change streams do not report time series
 *   writes, so a chain restore takes them from its newest member. The snapshot's time
 *   is returned as `end`: the incremental ends exactly where its time series were read.
 *   A snapshot that outlives the server's snapshot window fails with
 *   `MS_SNAPSHOT_TOO_OLD` (never a partial copy).
 */
async function copyNamespaceState(
  context: NamespaceDumpContext,
  specs: readonly CollectionSpec[],
  settings: StateCopySettings,
): Promise<{ readonly entries: NamespaceEntry[]; readonly end: ClusterTime | undefined }> {
  const suffixes = uniqueSuffixes(specs);
  const metadataOnly = await mapWithConcurrency(
    specs.filter((spec) => spec.type !== "timeseries"),
    async (spec, _index, jobSignal): Promise<NamespaceEntry> => ({
      ns: spec.ns,
      db: spec.db,
      collection: spec.name,
      type: spec.type,
      documents: 0,
      bytesRaw: 0,
      files: [],
      metadata: await writeMetadataFile(spec, context, {
        uniqueSuffix: suffixes.get(spec.ns),
        signal: jobSignal,
      }),
      content: "metadata",
    }),
    { concurrency: settings.parallelism, signal: settings.signal },
  );

  const timeSeries = specs.filter((spec) => spec.type === "timeseries");
  if (timeSeries.length === 0) return { entries: byNamespace(metadataOnly), end: undefined };
  const snapshot = await openReadConsistency(
    context.client,
    "snapshot",
    timeSeries,
    context.logger,
  );
  try {
    const snapshotContext: NamespaceDumpContext = {
      ...context,
      session: snapshot.session,
      readPreference: settings.readPreference,
      readAfter: undefined,
      // The snapshot still holds a collection dropped meanwhile; anything else fails.
      whenReplaced: "fail",
    };
    const plans = await mapWithConcurrency(
      timeSeries,
      (spec, _index, jobSignal) =>
        planNamespace(spec, snapshotContext, {
          partSizeBytes: settings.partSizeBytes,
          uniqueSuffix: suffixes.get(spec.ns),
          reads: {
            client: context.client,
            readPreference: settings.readPreference,
            logger: context.logger,
            signal: jobSignal,
          },
          signal: jobSignal,
        }),
      { concurrency: settings.parallelism, signal: settings.signal },
    );
    await runPendingParts(plans, snapshotContext, {
      parallelism: settings.parallelism,
      query: undefined,
      signal: settings.signal,
      budget: undefined,
      progress: settings.progress,
      onPartDone: async () => {},
      onNamespaceDone: async () => {},
      telemetry: settings.telemetry,
    });
    const copies = plans.map((plan) => ({ ...namespaceEntry(plan), content: "full" as const }));
    return { entries: byNamespace([...metadataOnly, ...copies]), end: snapshot.clusterTime };
  } finally {
    await snapshot.close();
  }
}

/** Manifest order: sorted by namespace. */
function byNamespace(entries: NamespaceEntry[]): NamespaceEntry[] {
  return entries.sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
}

/**
 * Key suffixes that keep file names unique, as full backups use them (backup.ts):
 * case collisions (`Users` next to `users`) and the reserved `_changes.window`.
 */
function uniqueSuffixes(specs: readonly CollectionSpec[]): Map<string, string> {
  const namesByDatabase = new Map<string, string[]>();
  for (const spec of specs) {
    namesByDatabase.set(spec.db, [...(namesByDatabase.get(spec.db) ?? []), spec.name]);
  }
  const suffixes = new Map<string, string>();
  for (const [db, names] of namesByDatabase) {
    for (const [name, suffix] of caseCollisionSuffixes(names))
      suffixes.set(`${db}.${name}`, suffix);
  }
  for (const spec of specs) {
    const reserved = reservedNameSuffix(spec.db, spec.name);
    if (reserved !== undefined && !suffixes.has(spec.ns)) suffixes.set(spec.ns, reserved);
  }
  return suffixes;
}

// ---------------------------------------------------------------------------
// Choosing and checking the parent
// ---------------------------------------------------------------------------

/** What the new backup must have in common with its parent. */
export interface ParentRequirements {
  /** `"latest"` or a backup id. */
  readonly from: string;
  readonly deployment: Pick<DeploymentInfo, "clusterId">;
  readonly selection: Selection;
  /** The new backup's labels (a `mongoshield.plan` label narrows `"latest"`). */
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * Picks the parent and works out the new backup's place in the chain. Pure, so every
 * rule is unit-tested.
 *
 * `"latest"` is the backup with the newest end time among the complete backups that
 * an incremental of this deployment and selection may follow (and of the same console
 * plan, when the new backup carries a plan label). An explicit id must name such a
 * backup.
 *
 * @throws MongoShieldError `MS_BACKUP_NOT_FOUND` when there is no such backup,
 *   `MS_CONFIG_INVALID` when the named one cannot be continued (and why).
 */
export function chooseParent(
  entries: readonly CatalogEntry[],
  requirements: ParentRequirements,
): IncrementalParent {
  if (requirements.from !== "latest") {
    const manifest = selectBackup(entries, requirements.from).manifest;
    if (manifest === undefined) {
      throw new MongoShieldError("MS_INTERNAL", `Backup ${requirements.from} has no manifest.`);
    }
    const reason = whyNotParent(entries, manifest, requirements);
    if (reason !== undefined) throw cannotContinue(manifest, reason);
    return parentFrom(manifest);
  }

  let newest: IncrementalParent | undefined;
  for (const entry of entries) {
    const manifest = entry.manifest;
    if (entry.status !== "complete" || manifest === undefined) continue;
    if (whyNotParent(entries, manifest, requirements) !== undefined) continue;
    const candidate = parentFrom(manifest);
    if (newest === undefined || compareClusterTimes(candidate.endTime, newest.endTime) > 0) {
      newest = candidate;
    }
  }
  if (newest === undefined) {
    throw new MongoShieldError(
      "MS_BACKUP_NOT_FOUND",
      "There is no backup this incremental backup could continue: none of this deployment, with the same include/exclude selection, taken with consistency converge or snapshot.",
      { hint: TAKE_A_FULL_BACKUP },
    );
  }
  return newest;
}

/** Why `manifest` cannot be the parent, or `undefined` when it can. */
function whyNotParent(
  entries: readonly CatalogEntry[],
  manifest: Manifest,
  requirements: ParentRequirements,
): string | undefined {
  if (chainEndTime(manifest) === undefined) {
    return `it was taken with consistency "${manifest.consistency.mode}", so it has no exact end time to continue from (incrementals need a converge or snapshot backup)`;
  }
  const clusterId = manifest.source.clusterId;
  if (clusterId === undefined || clusterId !== requirements.deployment.clusterId) {
    return "it was taken from a different deployment";
  }
  if (manifest.selection === undefined) {
    return "it does not record its include/exclude selection (it was written by an older release)";
  }
  if (manifest.selection.query.length > 0 || requirements.selection.query.length > 0) {
    return "it filters collections with a query, which change events cannot honour";
  }
  if (!sameSelection(manifest.selection, requirements.selection)) {
    return `it backs up a different selection (include ${listOf(manifest.selection.include)}, exclude ${listOf(manifest.selection.exclude)})`;
  }
  const plan = requirements.labels[PLAN_LABEL];
  if (plan !== undefined && manifest.labels[PLAN_LABEL] !== plan) {
    return `it was written by another plan (label ${PLAN_LABEL})`;
  }
  const inspection = inspectChain(entries, manifest);
  const problem = inspection.problems[0];
  if (problem !== undefined)
    return `its own chain is broken (${problem.backupId}: ${problem.problem})`;
  return undefined;
}

/** The parent's end time and the new backup's place after it. */
function parentFrom(manifest: Manifest): IncrementalParent {
  const endTime = chainEndTime(manifest);
  if (endTime === undefined) {
    throw new MongoShieldError("MS_INTERNAL", `Backup ${manifest.id} has no end time.`);
  }
  const chain: ChainInfo = isIncrementalManifest(manifest)
    ? { base: manifest.chain.base, parent: manifest.id, length: manifest.chain.length + 1 }
    : { base: manifest.id, parent: manifest.id, length: 1 };
  return { manifest, endTime, chain };
}

/** Equal patterns (both are sorted by `selectionOf`; old manifests may not be). */
export function sameSelection(a: Selection, b: Selection): boolean {
  const same = (x: readonly string[], y: readonly string[]): boolean => {
    const left = [...x].sort();
    const right = [...y].sort();
    return left.length === right.length && left.every((value, index) => value === right[index]);
  };
  return same(a.include, b.include) && same(a.exclude, b.exclude) && same(a.query, b.query);
}

function listOf(patterns: readonly string[]): string {
  return patterns.length === 0 ? "(none)" : patterns.join(", ");
}

// ---------------------------------------------------------------------------
// Validation and errors
// ---------------------------------------------------------------------------

/** `true` → `{}`; an object as it is. */
function incrementalOptionsOf(options: BackupOptions): IncrementalOptions {
  const { incremental } = options;
  if (incremental === true || incremental === undefined || incremental === false) return {};
  if (typeof incremental !== "object" || incremental === null) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      'incremental must be true or { from: "latest" | <backup id> }.',
    );
  }
  if (incremental.from !== undefined && typeof incremental.from !== "string") {
    throw new MongoShieldError("MS_CONFIG_INVALID", "incremental.from must be a string.");
  }
  const { fullAfterMs, maxChainLength } = incremental;
  if (fullAfterMs !== undefined && !(Number.isFinite(fullAfterMs) && fullAfterMs > 0)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `incremental.fullAfterMs must be a positive number of milliseconds, got ${String(fullAfterMs)}.`,
    );
  }
  if (
    maxChainLength !== undefined &&
    !(Number.isSafeInteger(maxChainLength) && maxChainLength >= 1)
  ) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `incremental.maxChainLength must be a whole number of at least 1, got ${String(maxChainLength)}.`,
    );
  }
  return incremental;
}

/**
 * Options that make no sense for a backup that stores only change events. With
 * `fallbackToFull`, `maxDurationMs` and `resume` are allowed: they apply to the full
 * backup taken instead.
 */
function assertIncrementalOptions(options: BackupOptions, fallback: boolean): void {
  const refuse = (what: string, hint: string): never => {
    throw new MongoShieldError("MS_CONFIG_INVALID", `An incremental backup cannot ${what}.`, {
      hint,
    });
  };
  if (options.query !== undefined && Object.keys(options.query).length > 0) {
    refuse(
      "filter collections with a query: change events are recorded whole",
      "Drop the query, or take full backups for this selection.",
    );
  }
  if (!fallback && (options.maxDurationMs !== undefined || options.resume !== undefined)) {
    refuse(
      "be checkpointed or resumed (maxDurationMs, resume)",
      "Drop maxDurationMs/resume: an incremental only records changes and is quick.",
    );
  }
  const consistency = options.consistency ?? "auto";
  if (consistency !== "auto" && consistency !== "converge") {
    refuse(
      `use consistency "${consistency}": it is exact at its end time by construction`,
      'Leave consistency at "auto" (or "converge") for incremental backups.',
    );
  }
}

/** Incrementals record changes with a change stream: replica sets and sharded clusters, 6.0+. */
function assertChangeStreams(deployment: DeploymentInfo): void {
  try {
    resolveConsistencyMode("converge", deployment);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MongoShieldError(
      "MS_UNSUPPORTED_TOPOLOGY",
      `Incremental backups record changes with a change stream, which this deployment cannot provide. ${reason}`,
      { cause: error, hint: "Take full backups of standalone servers (or use a replica set)." },
    );
  }
}

function assertRetentionSupported(storage: StorageAdapter, retainDays: number | undefined): void {
  if (retainDays === undefined || storage.capabilities.objectLock) return;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `retainDays needs storage with object lock, but the ${storage.kind} storage at ${storage.location} has none.`,
    {
      hint: "Write immutable backups to S3 (Object Lock), Google Cloud Storage or Azure Blob Storage, or drop retainDays.",
    },
  );
}

/** "Backup X cannot be continued by an incremental backup: <reason>." */
function cannotContinue(manifest: Manifest, reason: string): MongoShieldError {
  return new MongoShieldError(
    "MS_CONFIG_INVALID",
    `Backup ${manifest.id} cannot be continued by an incremental backup: ${reason}.`,
    { hint: TAKE_A_FULL_BACKUP, details: { parent: manifest.id } },
  );
}

/**
 * Translates capture failures. Lost history gets the incremental explanation: the
 * oplog no longer holds every change since the parent ended, so the only way forward
 * is a new full backup.
 */
function toIncrementalError(error: unknown, parent: IncrementalParent): MongoShieldError {
  const typed = toBackupError(error);
  if (typed.code !== "MS_CHANGE_HISTORY_LOST") return typed;
  return new MongoShieldError(
    "MS_CHANGE_HISTORY_LOST",
    `The oplog no longer holds every change since backup ${parent.manifest.id} ended (cluster time ${formatClusterTime(parent.endTime)}), so an incremental backup cannot continue it.`,
    {
      cause: typed,
      hint: `${TAKE_A_FULL_BACKUP} Take incrementals more often than the oplog window (rs.printReplicationInfo()), or enlarge the oplog (replSetResizeOplog).`,
      details: { ...typed.details, parent: parent.manifest.id, parentEnd: parent.endTime },
    },
  );
}

/** For `.catch()`: rethrows any error as a `MongoShieldError`. */
function rethrowTyped(error: unknown): never {
  throw toBackupError(error);
}

// ---------------------------------------------------------------------------
// Users and roles
// ---------------------------------------------------------------------------

/** The dump context the users-and-roles writer needs (it reads no collections). */
function dumpContextFor(
  context: BackupContext,
  options: BackupOptions,
  run: {
    readonly id: string;
    readonly encryption: FileEncryption | undefined;
    readonly writtenKeys: Set<string>;
    readonly retainUntil: Date | undefined;
  },
): NamespaceDumpContext {
  return {
    client: context.client,
    storage: context.storage,
    logger: context.logger,
    backupId: run.id,
    compression: context.compression,
    encryption: run.encryption,
    session: undefined,
    readPreference: resolveReadPreference(options, "converge"),
    readAfter: undefined,
    rateLimiter: undefined,
    retainUntil: run.retainUntil,
    writtenKeys: run.writtenKeys,
  };
}

/** Everyone's users without include patterns, else those of the selected databases. */
function authzScope(options: BackupOptions, specs: readonly { readonly db: string }[]): AuthzScope {
  if ((options.include ?? []).length === 0) return { kind: "all" };
  return { kind: "databases", databases: [...new Set(specs.map((spec) => spec.db))].sort() };
}

// ---------------------------------------------------------------------------
// Cleanup after a failed run
// ---------------------------------------------------------------------------

/**
 * Deletes what a failed run wrote, manifest first (as backup.ts does): a manifest that
 * landed but cannot be removed must keep its files. Best effort, never throws.
 */
async function deletePartialIncremental(
  storage: StorageAdapter,
  logger: Logger,
  partial: {
    readonly id: string;
    readonly writtenKeys: ReadonlySet<string>;
    readonly manifestAttempted: boolean;
  },
): Promise<void> {
  const keys = [...partial.writtenKeys];
  try {
    if (partial.manifestAttempted) {
      await storage.delete([manifestKey(partial.id)], {
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      });
    }
    if (keys.length > 0) {
      await storage.delete(keys, { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
    }
  } catch (error) {
    logger.warn("Could not remove the files of the failed backup; delete them by hand", {
      id: partial.id,
      files: keys,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
