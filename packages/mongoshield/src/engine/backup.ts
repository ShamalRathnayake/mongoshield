/**
 * The backup engine: dumps MongoDB namespaces into a storage adapter in mongodump's
 * layout (BSON + metadata.json per collection), compressed and optionally
 * age-encrypted, and commits the result by writing the manifest LAST.
 *
 *   validate options ─▶ describe deployment ─▶ (converge: read T0) ─▶ discover namespaces
 *        ─▶ check privileges ─▶ (snapshot session | converge: capture changes)
 *        ─▶ plan namespaces (metadata files, part boundaries)
 *        ─▶ dump parts, N at a time ─▶ (converge: drain to T1)
 *        ─▶ (includeUsersAndRoles: users and roles) ─▶ write manifest
 *
 * A backup without a manifest is incomplete by definition, so a crash at any point
 * never produces something that looks like a valid backup. When a run fails or is
 * aborted, it also deletes the files it wrote (best effort) before rethrowing.
 *
 * Resumable runs (`maxDurationMs` or `resume`) are different: they keep a checkpoint
 * (`_state/checkpoints/<id>.json`, rewritten after every part), stop starting parts
 * when their time budget runs out, and keep their files when they fail, so a later
 * call with `resume` continues where they stopped. They always read with
 * consistency `none`. See docs/specs/PARTS-AND-RESUME.md.
 *
 * Helpers live next to this file:
 *   backup-options.ts      validation and the encryption plan
 *   backup-key.ts          the key envelope of passphrase backups
 *   backup-consistency.ts  consistency modes and the snapshot session
 *   converge-capture.ts    consistency "converge": recording the changes of the window
 *   backup-dump.ts         planning namespaces and running their parts
 *   backup-parts.ts        splitting large collections by `_id` range
 *   backup-namespace.ts    writing one metadata file or one data part
 *   backup-reads.ts        read preference and batch sizes
 *   rate-limit.ts          maxDocumentsPerSecond / maxBytesPerSecond
 *   backup-budget.ts       the time budget of maxDurationMs
 *   backup-checkpoint.ts   the checkpoint format
 *   backup-resume.ts       finding, checking and saving checkpoints
 *   backup-write.ts        stream wiring from a source into storage
 *   backup-manifest.ts     building the manifest
 *   backup-authz.ts        users and roles (includeUsersAndRoles)
 *   backup-errors.ts       translating driver errors
 */

import { isZstdAvailable } from "../compression/index.ts";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import {
  caseCollisionSuffixes,
  manifestKey,
  newBackupId,
  reservedNameSuffix,
  resolveBackupKey,
} from "../format/layout.ts";
import { writeManifest } from "../format/manifest-io.ts";
import type { Logger } from "../logger.ts";
import {
  assertPrivileges,
  type CollectionSpec,
  describeDeployment,
  discoverNamespaces,
} from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type {
  BackupOptions,
  BackupResult,
  CheckpointedBackupResult,
  CompletedBackupResult,
  CompletingBackupOptions,
} from "../types.ts";
import { type AuthzScope, backupUsersAndRoles } from "./backup-authz.ts";
import { TimeBudget } from "./backup-budget.ts";
import {
  backupFingerprint,
  type Checkpoint,
  checkpointKey,
  deleteCheckpoint,
} from "./backup-checkpoint.ts";
import {
  type ConsistencyChoice,
  chooseConsistency,
  openReadConsistency,
} from "./backup-consistency.ts";
import {
  allPartsDone,
  type NamespacePlan,
  namespaceEntry,
  partTotals,
  planFromCheckpoint,
  planNamespace,
  runPendingParts,
} from "./backup-dump.ts";
import { toBackupError } from "./backup-errors.ts";
import { type FileEncryption, prepareFileEncryption } from "./backup-key.ts";
import { buildManifest } from "./backup-manifest.ts";
import type { NamespaceDumpContext } from "./backup-namespace.ts";
import {
  assertQueriesMatchNamespaces,
  type EncryptionPlan,
  planEncryption,
  type RunSettings,
  validateBackupOptions,
  validateRunSettings,
} from "./backup-options.ts";
import { resolveReadPreference } from "./backup-reads.ts";
import { CheckpointSaver, findCheckpointToResume, resumeFileEncryption } from "./backup-resume.ts";
import type { BackupContext } from "./context.ts";
import { type ChangeCapture, startChangeCapture } from "./converge-capture.ts";
import { readClusterTime } from "./converge-time.ts";
import { mapWithConcurrency } from "./pool.ts";
import { ProgressTracker } from "./progress.ts";
import { createRateLimiter } from "./rate-limit.ts";

export { DEFAULT_BACKUP_PARALLELISM } from "./backup-options.ts";
export { DEFAULT_PART_SIZE_BYTES } from "./backup-parts.ts";

/** How long cleanup of a failed run may take before it gives up (it is best effort). */
const CLEANUP_TIMEOUT_MS = 60_000;

/** At most this many existing namespaces are listed in the "nothing matched" hint. */
const MAX_NAMESPACES_IN_HINT = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Where a run starts from: a new backup, or the checkpoint of an earlier invocation. */
interface RunOrigin {
  readonly id: string;
  /** Start of the backup (of its first invocation, for resumed runs). */
  readonly startedAt: Date;
  readonly checkpoint: Checkpoint | undefined;
}

/**
 * Backs up the namespaces selected by `options`. Without `maxDurationMs` and
 * `resume` the result is always a committed backup; with them it may also be a
 * checkpoint (`status: "checkpointed"`) to resume later.
 *
 * @throws MongoShieldError, e.g. `MS_CONFIG_INVALID` for bad options or when no
 *   namespace matches, `MS_PERMISSION_DENIED`, `MS_UNSUPPORTED_TOPOLOGY` (snapshot
 *   or converge on a standalone), `MS_SNAPSHOT_TOO_OLD`, `MS_CHANGE_HISTORY_LOST`
 *   (a converge backup outlasted the oplog), `MS_BACKUP_NOT_FOUND` /
 *   `MS_INTEGRITY_FAILED` when a checkpoint cannot be resumed, `MS_STORAGE_*`,
 *   `MS_ABORTED` / `MS_TIMEOUT` when `options.signal` fires.
 */
export async function runBackup(
  context: BackupContext,
  options?: CompletingBackupOptions,
): Promise<CompletedBackupResult>;
export async function runBackup(
  context: BackupContext,
  options?: BackupOptions,
): Promise<BackupResult>;
export async function runBackup(
  context: BackupContext,
  options: BackupOptions = {},
): Promise<BackupResult> {
  const invokedAt = new Date();
  const clock = performance.now();
  const { client, logger, storage } = context;
  const { signal } = options;

  // 1. Everything that can be checked without reading data.
  const parallelism = validateBackupOptions(options);
  const settings = validateRunSettings(options);
  const encryptionPlan = planEncryption(context.encryption);
  assertCompressionAvailable(context.compression);
  assertRetentionSupported(storage, options.retainDays);
  throwIfAborted(signal);

  // 2. What are we backing up, from where, and may we?
  const deployment = await describeDeployment(client).catch(rethrowTyped);
  const choice = settings.resumable
    ? resumableConsistency(options)
    : await chooseConsistency(client, options.consistency, deployment);
  const { mode } = choice;
  if (choice.warning !== undefined) logger.warn(choice.warning);
  const fingerprint = backupFingerprint(options, context.compression, encryptionPlan);
  const checkpoint =
    options.resume === undefined
      ? undefined
      : await findCheckpointToResume({
          storage,
          logger,
          resume: options.resume,
          fingerprint,
          deployment,
          signal,
        });
  const origin: RunOrigin =
    checkpoint === undefined
      ? { id: newBackupId(invokedAt), startedAt: invokedAt, checkpoint: undefined }
      : { id: checkpoint.id, startedAt: new Date(checkpoint.startedAt), checkpoint };
  const { id } = origin;

  // Converge: T0 is read BEFORE discovery, so a collection created after discovery
  // has its creation inside the window and is restored from its events.
  const windowStart =
    mode === "converge" ? await readClusterTime(client).catch(rethrowTyped) : undefined;
  const specs = checkpoint === undefined ? await selectNamespaces(context, options) : [];
  throwIfAborted(signal);

  logger.info(checkpoint === undefined ? "Starting backup" : "Resuming backup", {
    id,
    namespaces: checkpoint === undefined ? specs.length : checkpoint.namespaces.length,
    consistency: mode,
    compression: context.compression,
    encryption: encryptionPlan?.kind ?? "none",
    parallelism,
    ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
  });

  // 3. Consistency: for snapshot mode this opens the session every read goes through.
  const consistency = await openReadConsistency(client, mode, specs, logger);
  const readPreference = resolveReadPreference(options, mode);
  const retainUntil =
    options.retainDays === undefined
      ? undefined
      : new Date(origin.startedAt.getTime() + options.retainDays * MS_PER_DAY);

  const progress = new ProgressTracker({ onProgress: options.onProgress, logger });
  const writtenKeys = new Set<string>();
  let manifestAttempted = false;
  let refusedBeforeCommit = false;
  let capture: ChangeCapture | undefined;
  let plans: NamespacePlan[] = [];
  // Set once `plans` holds the real plan: only then may a checkpoint be (re)written.
  let planned = false;
  let encryption: FileEncryption | undefined;
  const labels = checkpoint?.labels ?? options.labels ?? {};
  const saver = settings.resumable
    ? new CheckpointSaver(storage, logger, () => ({
        id,
        startedAt: origin.startedAt,
        invocations: (checkpoint?.invocations ?? 0) + 1,
        fingerprint,
        labels,
        deployment,
        encryption,
        plans,
      }))
    : undefined;
  if (checkpoint !== undefined) saver?.markExisting();

  try {
    // 4. Passphrase backups store their key envelope first (the run's only scrypt);
    //    a resumed run reuses the envelope of its first invocation.
    encryption =
      checkpoint === undefined
        ? await prepareEncryption(encryptionPlan, {
            storage,
            backupId: id,
            writtenKeys,
            retainUntil,
            signal,
          })
        : await resumeFileEncryption(checkpoint, encryptionPlan, storage, signal);

    // 5. Converge: record every change from T0 on, in the background, before the
    //    first document is read. A capture failure aborts the dumps via its signal.
    if (windowStart !== undefined) {
      capture = await startChangeCapture({
        client,
        storage,
        logger,
        backupId: id,
        compression: context.compression,
        encryption,
        writtenKeys,
        from: windowStart,
        specs,
        include: options.include,
        exclude: options.exclude,
        serverVersion: deployment.serverVersion,
        signal,
        retainUntil,
      });
    }
    const runningCapture = capture;
    const runSignal = runningCapture?.signal ?? signal;

    const dumpContext: NamespaceDumpContext = {
      client,
      storage,
      logger,
      backupId: id,
      compression: context.compression,
      encryption,
      session: consistency.session,
      readPreference,
      // Converge reads from secondaries must not see data older than T0.
      readAfter: readPreference.mode === "primary" ? undefined : windowStart,
      rateLimiter: createRateLimiter(options),
      retainUntil,
      writtenKeys,
    };

    // 6. Plan: metadata files and part boundaries (or the plan of the checkpoint).
    plans =
      checkpoint === undefined
        ? await planNamespaces(specs, dumpContext, settings, {
            parallelism,
            signal: runSignal,
          })
        : checkpoint.namespaces.map((namespace) => planFromCheckpoint(namespace));
    planned = true;
    if (saver !== undefined) await saver.save();

    // 7. Dump every pending part, `parallelism` at a time, within the time budget.
    await runPendingParts(plans, dumpContext, {
      parallelism,
      query: options.query,
      signal: runSignal,
      budget:
        options.maxDurationMs === undefined
          ? undefined
          : new TimeBudget(options.maxDurationMs, { startedAt: clock }),
      progress,
      onPartDone: async () => {
        await saver?.saveQuietly();
      },
      onNamespaceDone: async (ns) => {
        await runningCapture?.markDumped(ns);
      },
      telemetry: context.telemetry,
    });
    throwIfAborted(signal);

    // Out of time: save the progress and stop without a manifest.
    if (!allPartsDone(plans)) {
      if (saver === undefined) {
        throw new MongoShieldError("MS_INTERNAL", "Parts were left over in a non-resumable run.");
      }
      await saver.save();
      return checkpointedResult(id, plans, clock, logger);
    }

    // Converge: read T1, then drain the change stream up to it.
    const window = await runningCapture?.finish();

    // Users and roles (opt-in), stored as two extra manifest entries after the
    // collections. See backup-authz.ts.
    const authzEntries =
      options.includeUsersAndRoles === true
        ? await backupUsersAndRoles(
            dumpContext,
            authzScope(options, plans),
            signal ?? new AbortController().signal,
          )
        : [];

    // 8. Commit: the manifest is the very last object written.
    const completedAt = new Date();
    const manifest = buildManifest({
      id,
      startedAt: origin.startedAt,
      completedAt,
      deployment,
      consistency: {
        mode,
        clusterTime: consistency.clusterTime,
        window,
        warning: settings.resumable
          ? resumableWarning(options, origin.startedAt, completedAt, checkpoint)
          : choice.warning,
      },
      compression: context.compression,
      encryption,
      labels,
      namespaces: [...plans.map((plan) => namespaceEntry(plan)), ...authzEntries],
      immutableUntil: retainUntil,
    });
    // The caller's last word (e.g. the backup guard). A throw takes the failure path
    // below, so the files written so far are deleted and no manifest is committed.
    refusedBeforeCommit = true;
    await options.beforeCommit?.(manifest, signal === undefined ? {} : { signal });
    refusedBeforeCommit = false;
    manifestAttempted = true;
    await writeManifest(storage, manifest, {
      ...(signal === undefined ? {} : { signal }),
      ...(retainUntil === undefined ? {} : { retainUntil }),
    });
    if (saver !== undefined) await removeCheckpoint(storage, logger, id);

    progress.finish();
    const durationMs = Math.round(performance.now() - clock);
    logger.info("Backup complete", {
      id,
      namespaces: manifest.totals.namespaces,
      documents: manifest.totals.documents,
      bytesRaw: manifest.totals.bytesRaw,
      bytesStored: manifest.totals.bytesStored,
      durationMs,
    });
    return { status: "complete", id, manifest, durationMs };
  } catch (error) {
    // 9. Failure: report the real cause (when the change capture failed first, the
    //    dumps only saw its abort). A resumable run keeps its progress for a later
    //    resume; any other run (or a refused commit) removes what it wrote.
    const failure = signal?.aborted ? abortError(signal) : toBackupError(capture?.failure ?? error);
    await capture?.stop();
    logger.error("Backup failed", { id, code: failure.code, error: failure.message });
    if (saver?.saved === true && !refusedBeforeCommit) {
      // A resumed run that failed before loading its plan leaves the checkpoint as it was.
      if (planned) await saver.saveQuietly();
      logger.info("Progress was saved; resume this backup to continue", { id, resume: id });
    } else {
      await deletePartialBackup(storage, logger, {
        id,
        writtenKeys: new Set([...writtenKeys, ...knownKeys(id, plans, encryption)]),
        manifestAttempted,
        checkpoint: saver?.saved === true,
      });
    }
    throw failure;
  } finally {
    await consistency.close();
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * The consistency of a resumable run: always `none`, since its parts are read over
 * several invocations. Explicit `snapshot`/`converge` were refused by validation.
 */
function resumableConsistency(options: BackupOptions): ConsistencyChoice {
  const auto = (options.consistency ?? "auto") === "auto";
  return {
    mode: "none",
    warning: auto
      ? 'Consistency "auto" used "none": a resumable backup (maxDurationMs/resume) reads its collections over several invocations.'
      : undefined,
  };
}

/** The manifest warning of a resumable run, naming the time span its reads covered. */
function resumableWarning(
  options: BackupOptions,
  startedAt: Date,
  completedAt: Date,
  checkpoint: Checkpoint | undefined,
): string | undefined {
  if ((options.consistency ?? "auto") !== "auto") return undefined;
  const invocations = (checkpoint?.invocations ?? 0) + 1;
  return `Consistency "auto" used "none" because the backup was resumable: collections were read at different times between ${startedAt.toISOString()} and ${completedAt.toISOString()}, over ${invocations} invocation${invocations === 1 ? "" : "s"}.`;
}

/**
 * Whose users and roles to back up: everyone's when the backup has no `include`
 * patterns (it backs up "everything"), otherwise those of the backed-up databases.
 */
function authzScope(options: BackupOptions, plans: readonly NamespacePlan[]): AuthzScope {
  if ((options.include ?? []).length === 0) return { kind: "all" };
  return { kind: "databases", databases: [...new Set(plans.map((plan) => plan.db))].sort() };
}

/** Writes the key envelope (passphrase and KMS backups) and returns the file settings. */
async function prepareEncryption(
  plan: EncryptionPlan | undefined,
  target: {
    readonly storage: StorageAdapter;
    readonly backupId: string;
    readonly writtenKeys: Set<string>;
    readonly retainUntil: Date | undefined;
    readonly signal: AbortSignal | undefined;
  },
): Promise<FileEncryption | undefined> {
  if (plan === undefined) return undefined;
  return prepareFileEncryption(plan, {
    storage: target.storage,
    backupId: target.backupId,
    writtenKeys: target.writtenKeys,
    retainUntil: target.retainUntil,
    // writeStoredFile needs a signal; without the caller's, one that never fires.
    signal: target.signal ?? new AbortController().signal,
  });
}

/** Writes every metadata file and plans every namespace's parts, N at a time. */
async function planNamespaces(
  specs: readonly CollectionSpec[],
  context: NamespaceDumpContext,
  settings: RunSettings,
  options: { readonly parallelism: number; readonly signal: AbortSignal | undefined },
): Promise<NamespacePlan[]> {
  const suffixes = uniqueSuffixesByNamespace(specs);
  return mapWithConcurrency(
    specs,
    (spec, _index, jobSignal) =>
      planNamespace(spec, context, {
        partSizeBytes: settings.partSizeBytes,
        uniqueSuffix: suffixes.get(spec.ns),
        reads: {
          client: context.client,
          readPreference: context.readPreference,
          logger: context.logger,
          signal: jobSignal,
        },
        signal: jobSignal,
      }),
    { concurrency: options.parallelism, signal: options.signal },
  );
}

/** The result of a run that ran out of time. */
function checkpointedResult(
  id: string,
  plans: readonly NamespacePlan[],
  clock: number,
  logger: Logger,
): CheckpointedBackupResult {
  const totals = partTotals(plans);
  const durationMs = Math.round(performance.now() - clock);
  logger.info("Backup checkpointed; resume it to continue", {
    id,
    partsDone: totals.partsDone,
    partsTotal: totals.partsTotal,
    durationMs,
  });
  return {
    status: "checkpointed",
    id,
    durationMs,
    checkpoint: { key: checkpointKey(id), ...totals },
  };
}

/** Deletes the checkpoint of a committed backup; a failure only leaves a stale file. */
async function removeCheckpoint(
  storage: StorageAdapter,
  logger: Logger,
  id: string,
): Promise<void> {
  try {
    await deleteCheckpoint(storage, id, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
  } catch (error) {
    logger.warn("Could not delete the checkpoint of the completed backup", {
      id,
      key: checkpointKey(id),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Every file of the backup the plans know about, including those written by
 * earlier invocations of a resumed run (which `writtenKeys` does not list).
 */
function knownKeys(
  id: string,
  plans: readonly NamespacePlan[],
  encryption: FileEncryption | undefined,
): string[] {
  const keys: string[] = [];
  if (encryption?.keyFile !== undefined) keys.push(resolveBackupKey(id, encryption.keyFile.key));
  for (const plan of plans) {
    keys.push(resolveBackupKey(id, plan.metadata.key));
    for (const part of plan.parts) {
      if (part.done !== undefined) keys.push(resolveBackupKey(id, part.key));
    }
  }
  return keys;
}

/**
 * Immutable backups need storage that can lock objects. Checked before any data
 * is read, so the run fails in milliseconds rather than at the first upload.
 */
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

/**
 * Discovers the namespaces to back up and checks the user may read them.
 *
 * @throws MS_CONFIG_INVALID when nothing matches, with the existing namespaces in the hint.
 * @throws MS_PERMISSION_DENIED when privileges are missing.
 */
async function selectNamespaces(
  context: BackupContext,
  options: BackupOptions,
): Promise<CollectionSpec[]> {
  const { client, logger } = context;
  const specs = await discoverNamespaces(client, {
    include: options.include,
    exclude: options.exclude,
    signal: options.signal,
    logger,
  }).catch(rethrowTyped);

  if (specs.length === 0) throw await nothingMatchedError(context, options);
  assertQueriesMatchNamespaces(
    options.query,
    specs.map((spec) => spec.ns),
  );

  const databases = [...new Set(specs.map((spec) => spec.db))];
  await assertPrivileges(client, {
    operation: "backup",
    databases,
    namespaces: specs.map((spec) => spec.ns),
    // A backup of "everything" must also be allowed to see every database.
    allDatabases: (options.include ?? []).length === 0,
  }).catch(rethrowTyped);

  logger.debug("Selected namespaces", { namespaces: specs.map((spec) => spec.ns) });
  return specs;
}

/** Builds the "nothing matched" error, listing what does exist to help fix the patterns. */
async function nothingMatchedError(
  context: BackupContext,
  options: BackupOptions,
): Promise<MongoShieldError> {
  let existing: string[] = [];
  try {
    const all = await discoverNamespaces(context.client, { signal: options.signal });
    existing = all.map((spec) => spec.ns);
  } catch (error) {
    context.logger.debug("Listing namespaces for the hint failed", { error: String(error) });
  }

  const shown = existing.slice(0, MAX_NAMESPACES_IN_HINT);
  const more = existing.length - shown.length;
  const hint =
    existing.length === 0
      ? "The deployment has no user namespaces to back up (admin, config, local and system.* are skipped)."
      : `Existing namespaces: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Check the include/exclude patterns.`;
  return new MongoShieldError("MS_CONFIG_INVALID", "No namespace matches the backup filters.", {
    hint,
    details: { include: options.include ?? [], exclude: options.exclude ?? [] },
  });
}

/**
 * MongoDB allows `Users` and `users` in one database, but on case-insensitive
 * filesystems their files would collide; and `_changes.window` would collide with
 * the changes file of converge backups. Returns the extra key suffix for every
 * namespace that needs one, keyed by namespace.
 */
function uniqueSuffixesByNamespace(specs: readonly CollectionSpec[]): Map<string, string> {
  const namesByDatabase = new Map<string, string[]>();
  for (const spec of specs) {
    namesByDatabase.set(spec.db, [...(namesByDatabase.get(spec.db) ?? []), spec.name]);
  }

  const suffixes = new Map<string, string>();
  for (const [db, names] of namesByDatabase) {
    for (const [name, suffix] of caseCollisionSuffixes(names)) {
      suffixes.set(`${db}.${name}`, suffix);
    }
  }
  // `_changes.window` would collide with a converge backup's changes file.
  for (const spec of specs) {
    const reserved = reservedNameSuffix(spec.db, spec.name);
    if (reserved !== undefined && !suffixes.has(spec.ns)) suffixes.set(spec.ns, reserved);
  }
  return suffixes;
}

function assertCompressionAvailable(compression: BackupContext["compression"]): void {
  if (compression === "zstd" && !isZstdAvailable()) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `zstd compression is not available in Node.js ${process.version}.`,
      { hint: "Upgrade to Node.js 22.15+ or 23.8+, or use gzip compression." },
    );
  }
}

/** For `.catch()`: rethrows any error as a `MongoShieldError`. */
function rethrowTyped(error: unknown): never {
  throw toBackupError(error);
}

// ---------------------------------------------------------------------------
// Cleanup after a failed run
// ---------------------------------------------------------------------------

/** What a failed run wrote. */
interface PartialBackup {
  readonly id: string;
  /** Every data and metadata key the run started writing. */
  readonly writtenKeys: ReadonlySet<string>;
  /** True if the manifest write was started (it may or may not have landed). */
  readonly manifestAttempted: boolean;
  /** True if the run saved a checkpoint, which goes too (a refused resumable run). */
  readonly checkpoint: boolean;
}

/**
 * Deletes the objects a failed run wrote. Best effort: problems are logged, never
 * thrown, so the original error is what the caller sees.
 *
 * The manifest (if its write was even attempted) is deleted FIRST, and the data
 * only once that succeeded: if a manifest did land but cannot be removed, deleting
 * its data would turn a complete backup into a corrupt one.
 *
 * Runs on its own timeout rather than the run's signal, which may be the very
 * reason the run failed.
 */
async function deletePartialBackup(
  storage: StorageAdapter,
  logger: Logger,
  partial: PartialBackup,
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
    // The checkpoint goes last: while it exists, prune still knows the run's files.
    if (partial.checkpoint) {
      await deleteCheckpoint(storage, partial.id, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
    }
    logger.info("Removed the files of the failed backup", { id: partial.id, files: keys.length });
  } catch (error) {
    logger.warn("Could not remove the files of the failed backup; delete them by hand", {
      id: partial.id,
      files: keys,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
