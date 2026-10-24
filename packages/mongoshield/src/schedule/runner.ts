/**
 * One scheduled backup job, start to finish:
 *
 *   (jitter) ─▶ lock ─▶ backup (+ guard) ─▶ verify ─▶ prune ─▶ notify + heartbeat ─▶ unlock
 *
 * `runScheduledJob` is what both `mongoshield schedule` (on every cron tick)
 * and `mongoshield run` (once, from system cron, a Kubernetes CronJob, a
 * Lambda…) call. It never throws: every outcome, including failures, comes
 * back as a `RunReport`, which is also what notifications send.
 *
 * Rules worth knowing:
 * - A run that finds the lock taken is `skipped`, not failed, and alerts nobody.
 * - Only transient errors (connection, storage I/O) are retried, per step, so a
 *   flaky verify never produces a second backup.
 * - A failed step stops the run: nothing is pruned after a bad backup.
 * - Retention is scoped: the prune only covers backups of the same source
 *   deployment (`clusterId`) and the same selection (the `mongoshield.shape`
 *   label, or `scopeLabels`), so jobs that share a storage location never
 *   delete each other's backups.
 * - `schedule.timeoutMinutes` bounds the whole run, retries included.
 * - `schedule.verify: "drill"` verifies by restoring the new backup into the
 *   scratch deployment of the `drill` section (a restore drill), which also
 *   measures the recovery time (`verify.rtoMs` in the report).
 * - `backup.incremental` makes each run an incremental backup of the changes since
 *   the previous one, and a full backup whenever a new chain is due (none to
 *   continue, the chain's full backup older than `fullEveryDays`, the chain at
 *   `maxChainLength`, or lost oplog history): "full weekly, incremental hourly" is
 *   an hourly cron with `fullEveryDays: 7`. The report says which kind was taken
 *   (`backup.kind`, `backup.fullBackupReason`). An incremental is verified with its
 *   chain's links only (its parents were verified when they were taken).
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { MongoClient } from "mongodb";
import type { PruneResult } from "../catalog/prune.ts";
import { hasAnyCount, type RetentionPolicy } from "../catalog/retention.ts";
import { describeScope, type PruneScope } from "../catalog/scope.ts";
import { backupTuningFromConfig } from "../config/backup-tuning.ts";
import type { MongoShieldConfig } from "../config/schema.ts";
import { readCheckpoint } from "../engine/backup-checkpoint.ts";
import {
  type BackupGuardPolicy,
  type BeforeCommitHook,
  backupShapeLabel,
  evaluateBackupGuard,
  GUARD_SHAPE_LABEL,
  type GuardResult,
  guardFailedError,
  withShapeLabel,
} from "../engine/backup-guard.ts";
import type { DrillReport, ShieldDrillOptions } from "../engine/drill.ts";
import { loadDrillAssertionsFile } from "../engine/drill-assertions-file.ts";
import { MongoShieldError } from "../errors.ts";
import { replicateToTargets } from "../extras/replicate.ts";
import type { Manifest } from "../format/manifest.ts";
import { type Logger, silentLogger } from "../logger.ts";
import { type MongoConnection, openConnection } from "../mongo/connection.ts";
import { notifyRun } from "../notify/index.ts";
import { redactMongoUri, redactSecrets } from "../redact.ts";
import type { MongoShield } from "../shield.ts";
import { resolveStorage } from "../storage/resolve.ts";
import type {
  BackupOptions,
  BackupResult,
  DecryptionOptions,
  ProgressEvent,
  VerifyReport,
} from "../types.ts";
import {
  createLockOwner,
  DEFAULT_LEASE_MS,
  type JobLock,
  keepLeaseAlive,
  type Lease,
  type LeaseKeeper,
  type LockKind,
  type LockOwner,
  noLock,
} from "./lock.ts";
import { mongoLock } from "./lock-mongo.ts";
import { storageLock } from "./lock-storage.ts";
import {
  RUN_REPORT_VERSION,
  type RunReport,
  type RunStep,
  type ScheduledVerifyMode,
} from "./report.ts";
import {
  DEFAULT_RETRY_POLICY,
  RetriesExhaustedError,
  type RetryPolicy,
  sleep,
  withRetries,
} from "./retry.ts";

/** The parts of `MongoShield` the runner uses (a structural type, so tests can pass a fake). */
export type ScheduledShield = Pick<MongoShield, "storage" | "verify" | "prune" | "drill"> & {
  /** `MongoShield.backup` without its overloads, so test fakes stay simple. */
  readonly backup: (options?: BackupOptions) => Promise<BackupResult>;
};

/** Options for {@link runScheduledJob}. */
export interface ScheduledJobOptions {
  /** Aborts the run (shutdown, Ctrl-C). The lock is still released and notifications sent. */
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  /** The current time; for tests. */
  readonly now?: () => Date;
  /** Keys for `verify: "deep"` of encrypted backups. */
  readonly decryption?: DecryptionOptions;
  /** Signs webhook notifications (the CLI reads `MONGOSHIELD_WEBHOOK_SECRET`). */
  readonly webhookSecret?: string;
  /** Client for `lock: "mongo"`. Without one, a connection to `config.source.uri` is opened. */
  readonly lockClient?: MongoClient;
  /** Overrides `schedule.verify`. `"drill"` needs the config's `drill` section. */
  readonly verify?: ScheduledVerifyMode | "none";
  /** Directory a relative `drill.assertions` path is resolved against. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Overrides `schedule.prune`. */
  readonly prune?: boolean;
  /**
   * Labels that mark this job's backups and select the backups its retention
   * applies to (together with the source's `clusterId`). They are added to every
   * backup the job writes. Without them the scope is the backup's
   * `mongoshield.shape` label, i.e. "backups of this deployment with the same
   * include/exclude selection". The console passes `{ "mongoshield.plan": <id> }`
   * so two plans with the same selection still keep separate retention.
   */
  readonly scopeLabels?: Readonly<Record<string, string>>;
  /** Wait a random 0–`schedule.jitterSeconds` before starting. `mongoshield run` sets this. */
  readonly applyJitter?: boolean;
  /** Lease length for the lock. Defaults to 5 minutes. */
  readonly leaseMs?: number;
  /** Retry timing (the count comes from `schedule.retries`); for tests. */
  readonly retryDelays?: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">;
  /** Per-request timeout and retry delay of notifications; for tests. */
  readonly notifyTimeoutMs?: number;
  readonly notifyRetryDelayMs?: number;
  /** Progress of the backup step. */
  readonly onProgress?: (event: ProgressEvent) => void;
  /** Random number in [0, 1) for jitter and backoff; for tests. */
  readonly random?: () => number;
}

/** The settings of one run, with every default applied. */
interface RunSettings {
  readonly lock: LockKind;
  readonly verify: ScheduledVerifyMode | "none";
  /** The `drill` section; always present when `verify` is `"drill"`. */
  readonly drill: DrillSection | undefined;
  readonly prune: boolean;
  readonly retry: RetryPolicy;
  readonly timeoutMs: number | undefined;
  readonly jitterMs: number;
  readonly guard: BackupGuardPolicy | undefined;
  readonly retention: RetentionPolicy | undefined;
}

/** The config's `drill` section (scratch target, sample, assertions file, prefix). */
type DrillSection = NonNullable<MongoShieldConfig["drill"]>;

/** A report under construction. */
type Draft = { -readonly [Field in keyof RunReport]: RunReport[Field] };

/** Everything a run needs, passed between the steps. */
interface RunContext {
  readonly shield: ScheduledShield;
  readonly config: MongoShieldConfig;
  readonly options: ScheduledJobOptions;
  readonly settings: RunSettings;
  readonly logger: Logger;
  readonly draft: Draft;
}

/**
 * Runs one scheduled job (see the file header). Never throws; the returned
 * report says what happened.
 */
export async function runScheduledJob(
  shield: ScheduledShield,
  config: MongoShieldConfig,
  options: ScheduledJobOptions = {},
): Promise<RunReport> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const clock = performance.now();
  const draft: Draft = {
    version: RUN_REPORT_VERSION,
    runId: randomBytes(6).toString("hex"),
    status: "failure",
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    host: hostname(),
    storage: shield.storage.location,
    lock: { kind: config.schedule?.lock ?? "storage" },
  };

  let step: RunStep = "setup";
  let lease: Lease | undefined;
  let keeper: LeaseKeeper | undefined;
  let lockConnection: MongoConnection | undefined;
  let timeout: Timeout | undefined;

  try {
    const settings = resolveSettings(config, options);
    const context: RunContext = { shield, config, options, settings, logger, draft };
    if (options.applyJitter && settings.jitterMs > 0) {
      const delayMs = Math.round((options.random ?? Math.random)() * settings.jitterMs);
      logger.info("Waiting before the run (jitter)", { delayMs });
      await sleep(delayMs, options.signal);
    }
    timeout = startTimeout(settings.timeoutMs);
    const runSignal = combineSignals([options.signal, timeout?.signal]);

    step = "lock";
    const owner = createLockOwner();
    if (settings.lock === "mongo") lockConnection = await connectForLock(config, options, logger);
    const lock = createLock(settings.lock, {
      owner,
      leaseMs: leaseMsOf(options),
      storage: shield.storage,
      client: lockConnection?.client,
      logger,
    });
    const acquired = await lock.tryAcquire({ signal: runSignal });
    if (!acquired.acquired) {
      draft.status = "skipped";
      if (acquired.holder) {
        draft.lock = {
          kind: settings.lock,
          heldBy: {
            owner: acquired.holder.owner,
            host: acquired.holder.host,
            expiresAt: acquired.holder.expiresAt.toISOString(),
          },
        };
      }
      logger.info("Skipping this run: another runner holds the backup lock", {
        lock: lock.location,
        holder: acquired.holder?.owner,
      });
      // Nothing to release or report; just close what this run opened.
      await lockConnection?.close().catch(() => undefined);
      return finish(draft, clock, now);
    }
    lease = acquired.lease;
    keeper = keepLeaseAlive(lease, { renewEveryMs: leaseMsOf(options) / 3, logger, now });
    const signal = combineSignals([runSignal, keeper.lost]);

    step = "backup";
    const backup = await runBackupStep(context, signal);
    // A checkpointed backup (maxDurationMs) has no manifest to verify yet; the next
    // run resumes it. Pruning still runs: it keeps runs with a fresh checkpoint.
    if (backup.status === "complete") {
      step = "verify";
      await runVerifyStep(context, backup.id, signal);
      if (config.replicate && config.replicate.length > 0) {
        step = "replicate";
        await runReplicateStep(context, backup.id, signal);
      }
    }
    step = "prune";
    await runPruneStep(context, backup, signal);
    draft.status = backup.status === "complete" ? "success" : "checkpointed";
  } catch (error) {
    draft.status = "failure";
    draft.error = describeFailure(error, step, secretsOf(config, options));
    logger.error("Scheduled run failed", {
      step,
      code: draft.error.code,
      error: draft.error.message,
    });
  } finally {
    timeout?.clear();
  }

  // Notify while still holding the lock, so the next runner's report never
  // arrives before ours; notifications have their own short timeouts.
  const report = finish(draft, clock, now);
  try {
    await notifyRun(report, {
      logger,
      ...(config.notify ? { targets: config.notify } : {}),
      ...(config.heartbeat ? { heartbeat: config.heartbeat } : {}),
      ...(options.webhookSecret ? { webhookSecret: options.webhookSecret } : {}),
      ...(options.notifyTimeoutMs ? { timeoutMs: options.notifyTimeoutMs } : {}),
      ...(options.notifyRetryDelayMs ? { retryDelayMs: options.notifyRetryDelayMs } : {}),
    });
  } finally {
    keeper?.stop();
    await releaseQuietly(lease, logger);
    await lockConnection?.close().catch(() => undefined);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Backs up with the guard, retrying transient failures. Fills `draft.backup` and `draft.guard`. */
async function runBackupStep(context: RunContext, signal: AbortSignal): Promise<BackupResult> {
  const { shield, config, settings, logger, draft, options } = context;
  const section = config.backup;

  const attempted = await withRetries(
    async () => {
      // The engine runs the guard right before it writes the manifest; throwing
      // from the hook makes it delete the files instead of committing.
      const beforeCommit: BeforeCommitHook = async (manifest, hookOptions) => {
        const guardResult = await evaluateGuard(context, manifest, hookOptions.signal);
        if (refuses(guardResult)) throw guardFailedError(manifest.id, guardResult);
      };

      const backupOptions: BackupOptions = {
        signal,
        // The shape label lets the guard find comparable backups later, even if
        // the guard is only switched on after a while, and scopes retention to this
        // selection. The scope labels mark the backup as this job's.
        labels: withShapeLabel(
          { ...section?.labels, ...scopeLabelsOf(config, options) },
          section ?? {},
        ),
        ...(section?.include ? { include: section.include } : {}),
        ...(section?.exclude ? { exclude: section.exclude } : {}),
        ...(section?.consistency ? { consistency: section.consistency } : {}),
        ...(section?.parallelism ? { parallelism: section.parallelism } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(settings.guard ? { beforeCommit } : {}),
        ...backupTuningFromConfig(section),
        // With a time budget, every run first continues the newest checkpoint made
        // with the same options (if any), so a big backup completes over several runs.
        ...(section?.maxDurationMs === undefined ? {} : { resume: "auto" }),
        ...incrementalPolicyOf(section),
      };
      return shield.backup(backupOptions);
    },
    { policy: settings.retry, step: "backup", signal, logger, ...randomOption(options) },
  );

  const result = attempted.value;
  if (result.status === "checkpointed") {
    draft.backup = {
      id: result.id,
      status: "checkpointed",
      namespaces: 0,
      documents: result.checkpoint.documents,
      bytesRaw: result.checkpoint.bytesRaw,
      bytesStored: 0,
      durationMs: result.durationMs,
      attempts: attempted.attempts,
      parts: { done: result.checkpoint.partsDone, total: result.checkpoint.partsTotal },
    };
    return result;
  }
  const totals = result.manifest.totals;
  const chain = result.manifest.chain;
  draft.backup = {
    status: "complete",
    id: result.id,
    namespaces: totals.namespaces,
    documents: totals.documents,
    bytesRaw: totals.bytesRaw,
    bytesStored: totals.bytesStored,
    durationMs: result.durationMs,
    attempts: attempted.attempts,
    // Only jobs that take incrementals report the kind (old reports stay as they were).
    ...(section?.incremental === undefined
      ? {}
      : chain === undefined
        ? {
            kind: "full" as const,
            ...(result.fullBackupReason === undefined
              ? {}
              : { fullBackupReason: result.fullBackupReason }),
          }
        : {
            kind: "incremental" as const,
            parent: chain.parent,
            changes: result.manifest.changes?.events ?? 0,
          }),
  };
  return result;
}

/** A new chain is due once its full backup is this many days old (`backup.incremental`). */
export const DEFAULT_FULL_EVERY_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `backup.incremental` as backup options: an incremental of the newest backup, with a
 * full backup whenever a new chain is due or no incremental is possible (see the file
 * header).
 */
export function incrementalPolicyOf(
  section: MongoShieldConfig["backup"],
): Pick<BackupOptions, "incremental"> {
  const policy = section?.incremental;
  if (policy === undefined) return {};
  return {
    incremental: {
      from: "latest",
      fallbackToFull: true,
      fullAfterMs: (policy.fullEveryDays ?? DEFAULT_FULL_EVERY_DAYS) * MS_PER_DAY,
      ...(policy.maxChainLength === undefined ? {} : { maxChainLength: policy.maxChainLength }),
    },
  };
}

/** True when the guard result means "do not commit". */
function refuses(result: GuardResult): boolean {
  return !result.ok && result.action === "fail";
}

/** Runs the guard (never throws for findings) and records its result in the report. */
async function evaluateGuard(
  context: RunContext,
  manifest: Manifest,
  signal: AbortSignal | undefined,
): Promise<GuardResult> {
  const policy = context.settings.guard ?? {};
  const result = await evaluateBackupGuard({
    storage: context.shield.storage,
    candidate: manifest,
    policy,
    logger: context.logger,
    ...(signal ? { signal } : {}),
  });
  context.draft.guard = {
    ok: result.ok,
    action: result.action,
    findings: result.findings,
    ...(result.baselineId === undefined ? {} : { baselineId: result.baselineId }),
  };
  return result;
}

/** Verifies the new backup. A backup with problems fails the run (and is not retried). */
/**
 * Copies the new backup to every `replicate` target (the "1 off-site copy" of the
 * 3-2-1 rule). All targets are tried; if any failed, the run fails afterwards so the
 * missing copy is reported and alerted on, while the backup itself stays committed.
 */
async function runReplicateStep(
  context: RunContext,
  backupId: string,
  signal: AbortSignal,
): Promise<void> {
  const { shield, config, logger, draft } = context;
  const outcomes = await replicateToTargets(shield.storage, config.replicate ?? [], backupId, {
    resolve: resolveStorage,
    logger,
    signal,
  });
  draft.replicate = outcomes.map((outcome) => ({
    location: outcome.location,
    ok: outcome.error === undefined,
    ...(outcome.error === undefined ? {} : { error: errorMessage(outcome.error) }),
  }));

  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  if (failed.length > 0) {
    throw new MongoShieldError(
      "MS_STORAGE_IO",
      `Backup ${backupId} was not copied to ${failed.map((outcome) => outcome.location).join(", ")}.`,
      {
        hint: "The backup itself is committed. Check the replication target's credentials and space.",
      },
    );
  }
}

/** A short, secret-free description of an unknown error. */
function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error), []);
}

async function runVerifyStep(
  context: RunContext,
  backupId: string,
  signal: AbortSignal,
): Promise<void> {
  const { shield, settings, logger, draft, options } = context;
  const mode = settings.verify;
  if (mode === "none") return;
  if (mode === "drill") {
    await runDrillStep(context, backupId, signal);
    return;
  }

  const attempted = await withRetries(
    () =>
      shield.verify({
        backup: backupId,
        mode,
        // An incremental's parents were verified by the runs that took them: checking
        // their files again every hour would re-read the whole full backup each time.
        ...(draft.backup?.kind === "incremental" ? { chain: "links" as const } : {}),
        signal,
        ...(options.decryption ? { decryption: options.decryption } : {}),
      }),
    { policy: settings.retry, step: "verify", signal, logger, ...randomOption(options) },
  );
  const report: VerifyReport = attempted.value;
  draft.verify = { mode, ok: report.ok, problems: report.problems, attempts: attempted.attempts };
  if (!report.ok) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `Backup ${backupId} failed ${mode} verification with ${report.problems.length} problem(s), e.g. ${report.problems[0]?.subject ?? ""}: ${report.problems[0]?.problem ?? ""}`,
      { hint: `Do not rely on this backup. Run \`mongoshield verify ${backupId}\` for details.` },
    );
  }
}

/**
 * Verifies the new backup with a restore drill into the configured scratch
 * deployment. Records the measured restore time as `verify.rtoMs`; a drill that
 * finds problems fails the run like a failed verification.
 */
async function runDrillStep(
  context: RunContext,
  backupId: string,
  signal: AbortSignal,
): Promise<void> {
  const { shield, settings, logger, draft, options } = context;
  const section = settings.drill;
  if (section === undefined) throw missingDrillSectionError();

  // Loaded once per run, before any retry, so a broken file fails fast as a config error.
  const assertions =
    section.assertions === undefined
      ? undefined
      : await loadDrillAssertionsFile(section.assertions, options.cwd ?? process.cwd());
  const drillOptions: ShieldDrillOptions = {
    backup: backupId,
    target: { uri: section.targetUri },
    signal,
    ...(section.sample === undefined ? {} : { sample: section.sample }),
    ...(section.prefix === undefined ? {} : { prefix: section.prefix }),
    ...(assertions === undefined ? {} : { assertions }),
    ...(options.decryption ? { decryption: options.decryption } : {}),
  };

  const attempted = await withRetries(() => shield.drill(drillOptions), {
    policy: settings.retry,
    step: "verify",
    signal,
    logger,
    ...randomOption(options),
  });
  const report: DrillReport = attempted.value;
  draft.verify = {
    mode: "drill",
    ok: report.ok,
    problems: report.problems,
    attempts: attempted.attempts,
    rtoMs: Math.round(report.restoreDurationMs),
  };
  if (!report.ok) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `Backup ${backupId} failed its restore drill with ${report.problems.length} problem(s), e.g. ${report.problems[0]?.subject ?? ""}: ${report.problems[0]?.problem ?? ""}`,
      {
        hint: `Do not rely on this backup. Run \`mongoshield drill ${backupId} --target-uri <scratch>\` for details.`,
      },
    );
  }
}

/** `verify: "drill"` without a `drill` section (only possible through the `verify` override). */
function missingDrillSectionError(): MongoShieldError {
  return new MongoShieldError(
    "MS_CONFIG_INVALID",
    'Verifying with "drill" needs a scratch deployment to restore into.',
    { hint: "Add `drill: { targetUri: process.env.SCRATCH_URI }` to mongoshield.config.ts." },
  );
}

/**
 * Applies the retention policy, when pruning is on and a policy is configured,
 * to the backups of this job's scope only (see {@link pruneScopeOf}).
 */
async function runPruneStep(
  context: RunContext,
  backup: BackupResult,
  signal: AbortSignal,
): Promise<void> {
  const { shield, settings, logger, draft, options } = context;
  if (!settings.prune) return;
  if (settings.retention === undefined) {
    logger.debug("Not pruning: no retention policy is configured");
    return;
  }
  const scope = await pruneScopeOf(context, backup, signal);
  if (scope === undefined) {
    // Without the deployment's id the prune could only be scoped by selection,
    // and another cluster with the same selection in this storage would lose
    // backups. Keeping a few too many is the safe side.
    logger.warn("Not pruning: the backup does not record which deployment it came from", {
      id: backup.id,
    });
    return;
  }
  const policy = settings.retention;
  const now = options.now ?? (() => new Date());
  const attempted = await withRetries(
    (): Promise<PruneResult> => shield.prune(policy, { now: now(), signal, scope }),
    { policy: settings.retry, step: "prune", signal, logger, ...randomOption(options) },
  );
  const result = attempted.value;
  if (result.outOfScope.length > 0) {
    logger.info("Retention left the backups of other sources or selections alone", {
      scope: describeScope(scope),
      outOfScope: result.outOfScope.length,
    });
  }
  draft.prune = {
    deletedBackups: result.deletedBackups,
    deletedBytes: result.deletedBytes,
    kept: result.plan.keep.length,
    outOfScope: result.outOfScope.length,
  };
}

/**
 * The backups this job's retention covers: same deployment as the backup just
 * written, and the same `scopeLabels` (or, by default, the same shape label as
 * that backup carries). `undefined` when the deployment is unknown.
 *
 * The cluster id comes from what the run itself recorded (the manifest, or the
 * checkpoint of a run that used up its time budget) rather than from a second
 * connection, so it is exactly what the job's backups carry.
 */
async function pruneScopeOf(
  context: RunContext,
  backup: BackupResult,
  signal: AbortSignal,
): Promise<PruneScope | undefined> {
  const { shield, config, options } = context;
  const clusterId =
    backup.status === "complete"
      ? backup.manifest.source.clusterId
      : (await readCheckpoint(shield.storage, backup.id, signal))?.source.clusterId;
  if (clusterId === undefined) return undefined;
  // Empty scope labels would widen the scope to every backup of the deployment,
  // so they fall back to the shape label like absent ones.
  const custom = scopeLabelsOf(config, options);
  const labels =
    custom !== undefined && Object.keys(custom).length > 0
      ? custom
      : { [GUARD_SHAPE_LABEL]: backupShapeLabel(config.backup ?? {}) };
  return { clusterId, labels };
}

/**
 * The job's scope labels: the `scopeLabels` option (the console passes its plan id),
 * else the config's `retention.scopeLabels` (how `mongoshield run` and the
 * Kubernetes operator set them), else none.
 */
function scopeLabelsOf(
  config: MongoShieldConfig,
  options: ScheduledJobOptions,
): Readonly<Record<string, string>> | undefined {
  return options.scopeLabels ?? config.retention?.scopeLabels;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Applies the defaults documented in the config schema. */
function resolveSettings(config: MongoShieldConfig, options: ScheduledJobOptions): RunSettings {
  const schedule = config.schedule;
  const timeoutMinutes = schedule?.timeoutMinutes;
  const verify = options.verify ?? schedule?.verify ?? "fast";
  // The schema refuses `schedule.verify: "drill"` without a `drill` section, but the
  // `verify` option can still ask for a drill; fail during setup, before any backup.
  if (verify === "drill" && config.drill === undefined) throw missingDrillSectionError();
  return {
    lock: schedule?.lock ?? "storage",
    verify,
    drill: config.drill,
    prune: options.prune ?? schedule?.prune ?? true,
    retry: {
      ...DEFAULT_RETRY_POLICY,
      ...options.retryDelays,
      retries: schedule?.retries ?? DEFAULT_RETRY_POLICY.retries,
    },
    timeoutMs: timeoutMinutes === undefined ? undefined : timeoutMinutes * 60_000,
    jitterMs: (schedule?.jitterSeconds ?? 0) * 1000,
    guard: config.guard === undefined ? undefined : guardPolicyFrom(config.guard),
    retention: retentionPolicyFrom(config.retention),
  };
}

/** The config's `guard` section without `undefined` fields (exactOptionalPropertyTypes). */
function guardPolicyFrom(section: NonNullable<MongoShieldConfig["guard"]>): BackupGuardPolicy {
  return {
    ...(section.maxDocumentDropPercent === undefined
      ? {}
      : { maxDocumentDropPercent: section.maxDocumentDropPercent }),
    ...(section.maxSizeDropPercent === undefined
      ? {}
      : { maxSizeDropPercent: section.maxSizeDropPercent }),
    ...(section.failOnMissingCollection === undefined
      ? {}
      : { failOnMissingCollection: section.failOnMissingCollection }),
    ...(section.action === undefined ? {} : { action: section.action }),
  };
}

/** The retention policy, or `undefined` when none is configured (pruning is then skipped). */
function retentionPolicyFrom(section: MongoShieldConfig["retention"]): RetentionPolicy | undefined {
  if (section === undefined) return undefined;
  const policy: { -readonly [Field in keyof RetentionPolicy]: RetentionPolicy[Field] } = {};
  for (const field of [
    "last",
    "hourly",
    "daily",
    "weekly",
    "monthly",
    "yearly",
    "minVerified",
  ] as const) {
    const value = section[field];
    if (value !== undefined) policy[field] = value;
  }
  return hasAnyCount(policy) ? policy : undefined;
}

function leaseMsOf(options: ScheduledJobOptions): number {
  return options.leaseMs ?? DEFAULT_LEASE_MS;
}

/** Builds the configured lock. */
function createLock(
  kind: LockKind,
  parts: {
    readonly owner: LockOwner;
    readonly leaseMs: number;
    readonly storage: ScheduledShield["storage"];
    readonly client: MongoClient | undefined;
    readonly logger: Logger;
  },
): JobLock {
  const { owner, leaseMs, logger } = parts;
  switch (kind) {
    case "none":
      return noLock(owner);
    case "storage":
      return storageLock({ storage: parts.storage, owner, leaseMs, logger });
    case "mongo":
      if (parts.client === undefined) {
        throw new MongoShieldError("MS_INTERNAL", "The MongoDB lock needs a connected client.");
      }
      return mongoLock({ client: parts.client, owner, leaseMs, logger });
  }
}

/** Opens the connection the MongoDB lock uses (unless the caller supplied a client). */
async function connectForLock(
  config: MongoShieldConfig,
  options: ScheduledJobOptions,
  logger: Logger,
): Promise<MongoConnection> {
  if (options.lockClient) return openConnection({ client: options.lockClient }, { logger });
  const uri = config.source?.uri;
  if (uri === undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      'schedule.lock "mongo" needs a source connection string.',
      {
        hint: 'Set source.uri, or use schedule.lock "storage".',
      },
    );
  }
  return openConnection({ uri }, { logger, appName: "mongoshield-lock" });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A running timeout for the whole run. */
interface Timeout {
  readonly signal: AbortSignal;
  clear(): void;
}

/** Aborts with `MS_TIMEOUT` after `timeoutMs`; `undefined` when there is no limit. */
function startTimeout(timeoutMs: number | undefined): Timeout | undefined {
  if (timeoutMs === undefined) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new MongoShieldError(
        "MS_TIMEOUT",
        `The scheduled run took longer than ${timeoutMs / 60_000} minutes.`,
        {
          hint: "Raise schedule.timeoutMinutes, or back up less per run.",
        },
      ),
    );
  }, timeoutMs);
  timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** One signal that fires when any of `signals` does. */
function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length === 0 ? new AbortController().signal : AbortSignal.any(present);
}

function randomOption(options: ScheduledJobOptions): { random?: () => number } {
  return options.random ? { random: options.random } : {};
}

/** Releases the lock; a failure only delays the next run until the lease expires. */
async function releaseQuietly(lease: Lease | undefined, logger: Logger): Promise<void> {
  if (lease === undefined) return;
  try {
    await lease.release();
  } catch (error) {
    logger.warn("Could not release the backup lock; it expires on its own", {
      expiresAt: lease.info.expiresAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Stamps the end time on a draft and freezes it into a report. */
function finish(draft: Draft, clock: number, now: () => Date): RunReport {
  draft.finishedAt = now().toISOString();
  draft.durationMs = Math.round(performance.now() - clock);
  return { ...draft };
}

/** Values that must never appear in a report: passwords and passphrases from the config. */
function secretsOf(config: MongoShieldConfig, options: ScheduledJobOptions): string[] {
  const secrets: string[] = [];
  // The source and the drill's scratch deployment can both carry passwords.
  for (const uri of [config.source?.uri, config.drill?.targetUri]) {
    const password = /^mongodb(?:\+srv)?:\/\/[^:@/]*:([^@/]+)@/i.exec(uri ?? "")?.[1];
    if (password) secrets.push(password, safeDecode(password));
  }
  if (config.encryption?.passphrase) secrets.push(config.encryption.passphrase);
  if (config.decryption?.passphrase) secrets.push(config.decryption.passphrase);
  for (const identity of config.decryption?.identities ?? []) secrets.push(identity);
  if (options.decryption?.passphrase) secrets.push(options.decryption.passphrase);
  for (const identity of options.decryption?.identities ?? []) secrets.push(identity);
  if (options.webhookSecret) secrets.push(options.webhookSecret);
  return secrets;
}

/** Turns whatever stopped the run into the report's `error`, with secrets scrubbed. */
function describeFailure(
  error: unknown,
  step: RunStep,
  secrets: readonly string[],
): NonNullable<RunReport["error"]> {
  const attempts = error instanceof RetriesExhaustedError ? error.attempts : undefined;
  const cause = error instanceof RetriesExhaustedError ? error.cause : error;
  const typed =
    cause instanceof MongoShieldError
      ? cause
      : new MongoShieldError("MS_INTERNAL", cause instanceof Error ? cause.message : String(cause));
  return {
    step,
    code: typed.code,
    message: scrub(typed.message, secrets),
    ...(typed.hint ? { hint: scrub(typed.hint, secrets) } : {}),
    ...(attempts !== undefined && attempts > 1 ? { attempts } : {}),
  };
}

/** Redacts connection strings and known secrets in a message. */
function scrub(text: string, secrets: readonly string[]): string {
  const withoutUris = text.replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, (uri) =>
    redactMongoUri(uri),
  );
  return redactSecrets(withoutUris, secrets);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
