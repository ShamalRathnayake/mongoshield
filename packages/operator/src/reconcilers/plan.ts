/**
 * The MongoShieldBackupPlan reconciler.
 *
 * Desired state of a plan:
 *   - a ConfigMap with the generated mongoshield.config.json (resources/config.ts),
 *   - a CronJob running `mongoshield run --json` on the plan's schedule (only when
 *     `spec.schedule` is set),
 *   - one MongoShieldBackup per run the CronJob started, so every scheduled run gets
 *     the same status, events and metrics as a manual one; old ones are pruned by
 *     `spec.history`,
 *   - a status summarising all of that.
 *
 * Why a CronJob instead of a timer inside the operator: the CronJob keeps running
 * backups while the operator is down or being upgraded, and `kubectl create job
 * --from=cronjob/<plan>` works as everyone expects. The operator adds what a CronJob
 * cannot do: validation, results in status, events and metrics.
 *
 * Deletion: a finalizer makes sure the CronJob is gone (foreground deletion: its
 * running Jobs and pods too) before the plan disappears, so no new run can start
 * against a plan that no longer exists. Everything else the plan owns (ConfigMap,
 * run records) is removed by the garbage collector through owner references.
 */

import { Cron } from "croner";
import { ANNOTATIONS, FINALIZERS, LABELS } from "../api/constants.ts";
import {
  type Backup,
  type BackupPlan,
  type BackupPlanStatus,
  type BackupRunSummary,
  TERMINAL_BACKUP_PHASES,
} from "../api/types.ts";
import { type ConditionInput, setConditions } from "../controller/conditions.ts";
import type { ObjectRef, ReconcileResult } from "../controller/controller.ts";
import { addFinalizer, hasFinalizer, removeFinalizer } from "../controller/finalizers.ts";
import { labelValue } from "../controller/names.ts";
import { controllerOf, isOwnedBy } from "../controller/ownership.ts";
import { updateStatus } from "../controller/status.ts";
import { isAlreadyExists, RESOURCES } from "../kube/client.ts";
import type { CronJob, Job } from "../kube/objects.ts";
import { buildMongoShieldConfig, validateMongoShieldConfig } from "../resources/config.ts";
import {
  buildConfigMap,
  buildCronJob,
  buildScheduledBackup,
  configHashOf,
  configMapNameOf,
  cronJobNameOf,
} from "../resources/workloads.ts";
import { DELETION_RECHECK_MS, type ReconcilerContext } from "./context.ts";
import { ensureOwned, NameConflictError } from "./ensure.ts";

/** Defaults of `spec.history`. */
const DEFAULT_SUCCESSFUL_HISTORY = 10;
const DEFAULT_FAILED_HISTORY = 5;

/** Longest delay before the plan is looked at again to refresh `nextScheduleTime`. */
const MAX_SCHEDULE_RECHECK_MS = 60 * 60_000;

/** Set on a CronJob's Job once its MongoShieldBackup was created, so it is never recorded twice. */
export const RECORDED_ANNOTATION = `${ANNOTATIONS.scheduledJob}-recorded`;

/** Reconciles one plan. */
export async function reconcilePlan(
  context: ReconcilerContext,
  ref: ObjectRef,
): Promise<ReconcileResult | undefined> {
  const cached = context.plans.get(ref.namespace, ref.name);
  // Gone: the garbage collector removes what it owned.
  if (!cached) return undefined;
  if (cached.metadata.deletionTimestamp) return finalizePlan(context, cached);

  const plan = await addFinalizer(context.client, RESOURCES.plans, cached, FINALIZERS.plan);

  // 1. Is the plan valid? Check with MongoShield's own config schema and the cron parser.
  const config = buildMongoShieldConfig(plan);
  const problem = validateMongoShieldConfig(config) ?? validateSchedule(plan);
  if (problem !== undefined) {
    await context.events.record(plan, "Warning", "InvalidSpec", problem);
    await writePlanStatus(context, plan, {
      ready: { type: "Ready", status: "False", reason: "InvalidSpec", message: problem },
    });
    // Nothing to retry: a spec change triggers the next reconcile.
    return undefined;
  }

  // 2. The ConfigMap and the CronJob.
  const configHash = configHashOf(config);
  try {
    const configOutcome = await ensureOwned(
      context.client,
      RESOURCES.configMaps,
      plan,
      buildConfigMap(plan, config),
    );
    if (configOutcome === "updated") {
      await context.events.record(
        plan,
        "Normal",
        "ConfigUpdated",
        `Updated ConfigMap ${configMapNameOf(plan)}`,
      );
    }
    await reconcileCronJob(context, plan, configHash);
  } catch (error) {
    if (!(error instanceof NameConflictError)) throw error;
    await context.events.record(plan, "Warning", "NameConflict", error.message);
    await writePlanStatus(context, plan, {
      ready: { type: "Ready", status: "False", reason: "NameConflict", message: error.message },
    });
    return undefined;
  }

  // 3. Record the CronJob's runs, and prune old records.
  await recordScheduledRuns(context, plan);
  await pruneRunHistory(context, plan);

  // 4. Status.
  const message = plan.spec.schedule
    ? `CronJob ${cronJobNameOf(plan)} runs "${plan.spec.schedule.cron}" (${plan.spec.schedule.timeZone ?? "Etc/UTC"})${plan.spec.schedule.suspend ? ", suspended" : ""}`
    : "No schedule: only manual MongoShieldBackups run";
  const status = await writePlanStatus(context, plan, {
    ready: { type: "Ready", status: "True", reason: "Reconciled", message },
  });

  // Come back when the next run is due, so nextScheduleTime never goes stale.
  return requeueForNextRun(context, status.nextScheduleTime);
}

/** Creates, updates or removes the plan's CronJob. */
async function reconcileCronJob(
  context: ReconcilerContext,
  plan: BackupPlan,
  configHash: string,
): Promise<void> {
  const name = cronJobNameOf(plan);
  const namespace = plan.metadata.namespace ?? "";
  if (plan.spec.schedule) {
    const outcome = await ensureOwned(
      context.client,
      RESOURCES.cronJobs,
      plan,
      buildCronJob(plan, context.defaults, configHash),
    );
    if (outcome === "created") {
      await context.events.record(plan, "Normal", "CronJobCreated", `Created CronJob ${name}`);
    } else if (outcome === "updated") {
      await context.events.record(plan, "Normal", "CronJobUpdated", `Updated CronJob ${name}`);
    }
    return;
  }
  // The schedule was removed: delete the CronJob if it is ours.
  const existing = await context.client.get<CronJob>(RESOURCES.cronJobs, namespace, name);
  if (existing && isOwnedBy(existing, plan)) {
    await context.client.delete(RESOURCES.cronJobs, namespace, name, "Background");
    await context.events.record(
      plan,
      "Normal",
      "CronJobDeleted",
      `Deleted CronJob ${name}: the plan has no schedule`,
    );
  }
}

/** Creates a MongoShieldBackup for each Job the plan's CronJob started. */
async function recordScheduledRuns(context: ReconcilerContext, plan: BackupPlan): Promise<void> {
  const namespace = plan.metadata.namespace ?? "";
  const cronJobName = cronJobNameOf(plan);
  for (const job of jobsOfPlan(context, plan)) {
    const owner = controllerOf(job, "CronJob");
    if (owner?.name !== cronJobName) continue;
    if (job.metadata.annotations?.[RECORDED_ANNOTATION] === "true") continue;
    const name = job.metadata.name ?? "";
    if (!context.backups.get(namespace, name)) {
      try {
        await context.client.create(RESOURCES.backups, namespace, buildScheduledBackup(plan, job));
      } catch (error) {
        // Created a moment ago by an earlier reconcile the cache hasn't caught up with.
        if (!isAlreadyExists(error)) throw error;
      }
    }
    // Mark the Job, so a record pruned by the history limit is never re-created.
    await context.client.mergePatch<Job>(RESOURCES.jobs, namespace, name, {
      metadata: { annotations: { [RECORDED_ANNOTATION]: "true" } },
    });
  }
}

/** Deletes the oldest finished run records beyond `spec.history`. */
async function pruneRunHistory(context: ReconcilerContext, plan: BackupPlan): Promise<void> {
  const successfulLimit = plan.spec.history?.successfulLimit ?? DEFAULT_SUCCESSFUL_HISTORY;
  const failedLimit = plan.spec.history?.failedLimit ?? DEFAULT_FAILED_HISTORY;
  const finished = backupsOfPlan(context, plan)
    .filter((backup) => backup.metadata.labels?.[LABELS.trigger] === "schedule")
    .filter(
      (backup) => backup.status?.phase && TERMINAL_BACKUP_PHASES.includes(backup.status.phase),
    )
    .sort(newestFirst);
  const failed = finished.filter((backup) => backup.status?.phase === "Failed");
  const successful = finished.filter((backup) => backup.status?.phase !== "Failed");
  const doomed = [...successful.slice(successfulLimit), ...failed.slice(failedLimit)];
  for (const backup of doomed) {
    await context.client.delete(
      RESOURCES.backups,
      backup.metadata.namespace ?? "",
      backup.metadata.name ?? "",
    );
  }
}

/** The plan's finalizer: remove the CronJob (and its running Jobs) first. */
async function finalizePlan(
  context: ReconcilerContext,
  plan: BackupPlan,
): Promise<ReconcileResult | undefined> {
  if (!hasFinalizer(plan, FINALIZERS.plan)) return undefined;
  const namespace = plan.metadata.namespace ?? "";
  const name = cronJobNameOf(plan);
  const cronJob = await context.client.get<CronJob>(RESOURCES.cronJobs, namespace, name);
  if (cronJob && isOwnedBy(cronJob, plan)) {
    if (!cronJob.metadata.deletionTimestamp) {
      // Foreground: the CronJob stays (marked as deleting) until its Jobs and their
      // pods are gone, which is exactly what we wait for.
      await context.client.delete(RESOURCES.cronJobs, namespace, name, "Foreground");
      await context.events.record(
        plan,
        "Normal",
        "Deleting",
        `Deleting CronJob ${name} and its running Jobs`,
      );
    }
    return { requeueAfterMs: DELETION_RECHECK_MS };
  }
  // Run records with `deletionPolicy: Delete` need this plan's storage settings (its
  // ConfigMap) to delete their data. Delete the plan's own records now, and wait for
  // every record that is deleting its data, before the plan (and the ConfigMap, by
  // garbage collection) goes away.
  const waiting = backupsOfPlan(context, plan).filter((backup) =>
    backup.metadata.finalizers?.includes(FINALIZERS.backupData),
  );
  if (waiting.length > 0) {
    for (const backup of waiting) {
      if (!backup.metadata.deletionTimestamp && isOwnedBy(backup, plan)) {
        await context.client.delete(RESOURCES.backups, namespace, backup.metadata.name ?? "");
      }
    }
    await context.events.record(
      plan,
      "Normal",
      "WaitingForBackupData",
      `Waiting for ${waiting.length} MongoShieldBackup(s) with deletionPolicy Delete to delete their data`,
    );
    return { requeueAfterMs: DELETION_RECHECK_MS };
  }
  await removeFinalizer(context.client, RESOURCES.plans, plan, FINALIZERS.plan);
  return undefined;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Computes and writes the plan's status; returns the status written. */
async function writePlanStatus(
  context: ReconcilerContext,
  plan: BackupPlan,
  inputs: { readonly ready: ConditionInput },
): Promise<BackupPlanStatus> {
  const now = context.now();
  const backups = backupsOfPlan(context, plan).sort(newestFirst);
  const finished = backups.filter(
    (backup) => backup.status?.phase && TERMINAL_BACKUP_PHASES.includes(backup.status.phase),
  );
  const lastBackup = finished[0];
  const lastSuccessful = finished.find((backup) => backup.status?.phase === "Succeeded");
  const active = backups.filter((backup) => !finished.includes(backup)).length;

  const cronJob = plan.spec.schedule
    ? context.cronJobs.get(plan.metadata.namespace ?? "", cronJobNameOf(plan))
    : undefined;
  const nextRun = inputs.ready.status === "True" ? nextScheduleTime(plan, now) : undefined;

  const status: BackupPlanStatus = {
    observedGeneration: plan.metadata.generation ?? 0,
    conditions: setConditions(
      plan.status?.conditions,
      [inputs.ready, lastBackupCondition(lastBackup)],
      plan.metadata.generation,
      now,
    ),
    configMapName: configMapNameOf(plan),
    ...(plan.spec.schedule ? { cronJobName: cronJobNameOf(plan) } : {}),
    ...(cronJob?.status?.lastScheduleTime
      ? { lastScheduleTime: cronJob.status.lastScheduleTime }
      : {}),
    ...(nextRun ? { nextScheduleTime: nextRun.toISOString() } : {}),
    ...(lastBackup ? { lastBackup: summarize(lastBackup) } : {}),
    ...(lastSuccessful ? { lastSuccessfulBackup: summarize(lastSuccessful) } : {}),
    activeBackups: active,
  };
  await updateStatus(context.client, RESOURCES.plans, plan, status);
  return status;
}

/** `LastBackupSucceeded`: did the newest finished run succeed? */
function lastBackupCondition(lastBackup: Backup | undefined): ConditionInput {
  if (!lastBackup) {
    return {
      type: "LastBackupSucceeded",
      status: "Unknown",
      reason: "NoBackupYet",
      message: "No run has finished yet",
    };
  }
  const phase = lastBackup.status?.phase;
  if (phase === "Failed") {
    const error = lastBackup.status?.error;
    return {
      type: "LastBackupSucceeded",
      status: "False",
      reason: "BackupFailed",
      message: `${lastBackup.metadata.name}: ${error ? `${error.code}: ${error.message}` : "failed"}`,
    };
  }
  return {
    type: "LastBackupSucceeded",
    status: "True",
    reason: phase === "Succeeded" ? "BackupSucceeded" : `Backup${phase ?? ""}`,
    message: `${lastBackup.metadata.name}${lastBackup.status?.backupId ? `: ${lastBackup.status.backupId}` : ""}`,
  };
}

function summarize(backup: Backup): BackupRunSummary {
  return {
    name: backup.metadata.name ?? "",
    phase: backup.status?.phase ?? "Pending",
    ...(backup.status?.backupId ? { backupId: backup.status.backupId } : {}),
    ...(backup.status?.completionTime ? { completionTime: backup.status.completionTime } : {}),
    ...(backup.status?.bytesStored !== undefined ? { bytesStored: backup.status.bytesStored } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Checks the cron expression and time zone the way the CronJob controller will need them. */
export function validateSchedule(plan: BackupPlan): string | undefined {
  const schedule = plan.spec.schedule;
  if (!schedule) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone ?? "Etc/UTC" });
  } catch {
    return `Unknown time zone "${schedule.timeZone}": use an IANA name such as Etc/UTC or Europe/Berlin.`;
  }
  try {
    // "5-part": exactly the fields a Kubernetes CronJob accepts (no seconds field).
    new Cron(schedule.cron, {
      paused: true,
      mode: "5-part",
      timezone: schedule.timeZone ?? "Etc/UTC",
    });
    return undefined;
  } catch (error) {
    return `Invalid cron expression "${schedule.cron}": ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** When the CronJob will next start a run (undefined without a schedule, or when suspended). */
export function nextScheduleTime(plan: BackupPlan, now: Date): Date | undefined {
  const schedule = plan.spec.schedule;
  if (!schedule || schedule.suspend) return undefined;
  const cron = new Cron(schedule.cron, {
    paused: true,
    mode: "5-part",
    timezone: schedule.timeZone ?? "Etc/UTC",
  });
  return cron.nextRun(now) ?? undefined;
}

/** Requeue shortly after the next run is due (capped, so the plan is revisited hourly). */
function requeueForNextRun(
  context: ReconcilerContext,
  next: string | undefined,
): ReconcileResult | undefined {
  if (!next) return undefined;
  const delay = Date.parse(next) - context.now().getTime() + 1000;
  return { requeueAfterMs: Math.min(Math.max(delay, 1000), MAX_SCHEDULE_RECHECK_MS) };
}

/** Jobs labelled with this plan, from the cache. */
function jobsOfPlan(context: ReconcilerContext, plan: BackupPlan): Job[] {
  const label = labelValue(plan.metadata.name ?? "");
  return context.jobs
    .list(plan.metadata.namespace)
    .filter((job) => job.metadata.labels?.[LABELS.plan] === label);
}

/** MongoShieldBackups of this plan, from the cache. */
function backupsOfPlan(context: ReconcilerContext, plan: BackupPlan): Backup[] {
  return context.backups
    .list(plan.metadata.namespace)
    .filter((backup) => backup.spec.planRef.name === plan.metadata.name);
}

/** Sort order: newest first, by completion time, then creation time. */
function newestFirst(a: Backup, b: Backup): number {
  const timeOf = (backup: Backup): string =>
    backup.status?.completionTime ?? backup.metadata.creationTimestamp ?? "";
  return timeOf(b).localeCompare(timeOf(a));
}
