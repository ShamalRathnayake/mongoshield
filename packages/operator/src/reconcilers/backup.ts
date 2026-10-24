/**
 * The MongoShieldBackup reconciler: one backup run, from start to recorded result.
 *
 * Two kinds of MongoShieldBackup exist:
 *   - manual ones, created by a user (`kubectl apply`): the reconciler creates their
 *     Job (`mongoshield run --json --no-prune`, owned by the backup);
 *   - scheduled ones, created by the plan reconciler for each Job its CronJob
 *     started: they carry the `mongoshield.io/scheduled-job` annotation and adopt
 *     that Job instead of creating one.
 *
 * Either way the steps are the same:
 *   1. wait for the plan to be Ready (its ConfigMap holds the current config),
 *   2. hold a finalizer while the Job may run (see runs.ts),
 *   3. while the Job runs: phase Running, and report stuck pods (missing Secret,
 *      image pull errors) in the conditions,
 *   4. when the Job finishes: read MongoShield's run report from the pod log, copy it
 *      into the status (backup id, sizes, verification), emit an event, release the
 *      finalizer. The status is then final; the Job may be garbage-collected.
 *
 * Conditions (like a batch Job's): `Complete` (True once the run succeeded,
 * checkpointed or was skipped), `Failed` (True when it failed) and `Verified`.
 */

import { ANNOTATIONS, FINALIZERS } from "../api/constants.ts";
import { type Backup, type BackupStatus, TERMINAL_BACKUP_PHASES } from "../api/types.ts";
import { type ConditionInput, setConditions } from "../controller/conditions.ts";
import type { ObjectRef, ReconcileResult } from "../controller/controller.ts";
import { addFinalizer, syncFinalizers } from "../controller/finalizers.ts";
import { controllerOf, isOwnedBy } from "../controller/ownership.ts";
import { updateStatus } from "../controller/status.ts";
import { isAlreadyExists, RESOURCES } from "../kube/client.ts";
import type { Job } from "../kube/objects.ts";
import { buildMongoShieldConfig } from "../resources/config.ts";
import { backupJobNameOf, buildBackupJob, configHashOf } from "../resources/workloads.ts";
import { jobState, readJobResult, stuckReason } from "../results/job-result.ts";
import { backupOutcome } from "../results/to-status.ts";
import { finalizeBackupData, wantsDataFinalizer } from "./backup-data.ts";
import { type ReconcilerContext, RUNNING_RECHECK_MS, WAITING_RECHECK_MS } from "./context.ts";
import { finalizeRun, planNotReadyReason } from "./runs.ts";

/** Reconciles one MongoShieldBackup. */
export async function reconcileBackup(
  context: ReconcilerContext,
  ref: ObjectRef,
): Promise<ReconcileResult | undefined> {
  const cached = context.backups.get(ref.namespace, ref.name);
  if (!cached) return undefined;
  const scheduledJob = cached.metadata.annotations?.[ANNOTATIONS.scheduledJob];
  const jobName = scheduledJob ?? backupJobNameOf(cached);

  if (cached.metadata.deletionTimestamp) {
    // First stop a running Job; then, with deletionPolicy Delete, delete the data.
    const stopping = await finalizeRun(
      context,
      RESOURCES.backups,
      cached,
      FINALIZERS.backup,
      jobName,
      (job) => (scheduledJob ? controllerOf(job, "CronJob") !== undefined : isOwnedBy(job, cached)),
    );
    if (stopping) return stopping;
    const fresh = await context.client.get<Backup>(RESOURCES.backups, ref.namespace, ref.name);
    return fresh ? finalizeBackupData(context, fresh) : undefined;
  }

  // Finished runs never change again: no Job finalizer any more, and the data
  // finalizer exactly when `deletionPolicy: Delete` (which may be changed later).
  if (isTerminal(cached)) {
    await syncFinalizers(context.client, RESOURCES.backups, cached, {
      [FINALIZERS.backup]: false,
      [FINALIZERS.backupData]: wantsDataFinalizer(cached),
    });
    return undefined;
  }

  const existingJob = await context.client.get<Job>(RESOURCES.jobs, ref.namespace, jobName);
  if (!existingJob) {
    if (scheduledJob) {
      // The CronJob's Job is gone before we saw it finish (deleted by hand, or its TTL
      // passed while the operator was down): nothing left to read a result from.
      return finish(context, cached, {
        phase: "Failed",
        reason: "JobNotFound",
        message: `Job ${jobName} of this scheduled run no longer exists; its result is unknown`,
        fields: {
          jobName,
          error: { code: "JOB_NOT_FOUND", message: `Job ${jobName} no longer exists` },
        },
      });
    }
    return startManualBackup(context, cached, jobName);
  }

  // A manual backup's Job must be ours; never adopt a stranger's Job by name.
  if (!scheduledJob && !isOwnedBy(existingJob, cached)) {
    return finish(context, cached, {
      phase: "Failed",
      reason: "NameConflict",
      message: `Job ${jobName} already exists and does not belong to this backup`,
      fields: { error: { code: "NAME_CONFLICT", message: `Job ${jobName} already exists` } },
    });
  }

  const backup = await addFinalizer(context.client, RESOURCES.backups, cached, FINALIZERS.backup);
  const state = jobState(existingJob);
  if (state.phase === "running") return markRunning(context, backup, existingJob);

  // Finished: read MongoShield's report and record it for good.
  const result = await readJobResult(context.client, existingJob);
  const outcome = backupOutcome(state, result);
  return finish(context, backup, {
    ...outcome,
    fields: {
      ...outcome.fields,
      jobName,
      ...(state.startTime ? { startTime: state.startTime } : {}),
      completionTime: state.completionTime ?? context.now().toISOString(),
    },
  });
}

/** Creates the Job of a manual backup once its plan is ready. */
async function startManualBackup(
  context: ReconcilerContext,
  cached: Backup,
  jobName: string,
): Promise<ReconcileResult | undefined> {
  const plan = context.plans.get(cached.metadata.namespace ?? "", cached.spec.planRef.name);
  const notReady = planNotReadyReason(plan, cached.spec.planRef.name);
  if (notReady || !plan) {
    await writeStatus(context, cached, { phase: "Pending" }, [
      {
        type: "Complete",
        status: "False",
        reason: notReady?.reason ?? "PlanNotFound",
        message: notReady?.message ?? "",
      },
    ]);
    return { requeueAfterMs: WAITING_RECHECK_MS };
  }

  // The finalizer goes on before the Job exists, so there is never a running Job
  // whose backup could vanish without stopping it.
  const backup = await addFinalizer(context.client, RESOURCES.backups, cached, FINALIZERS.backup);
  const configHash = configHashOf(buildMongoShieldConfig(plan));
  try {
    await context.client.create(
      RESOURCES.jobs,
      backup.metadata.namespace ?? "",
      buildBackupJob(backup, plan, context.defaults, configHash),
    );
  } catch (error) {
    // Created by an earlier attempt whose status write failed: carry on with it.
    if (!isAlreadyExists(error)) throw error;
  }
  await context.events.record(backup, "Normal", "Started", `Created Job ${jobName}`);
  await writeStatus(
    context,
    backup,
    { phase: "Running", jobName, startTime: context.now().toISOString() },
    [
      {
        type: "Complete",
        status: "False",
        reason: "Running",
        message: `Job ${jobName} is running`,
      },
    ],
  );
  return { requeueAfterMs: RUNNING_RECHECK_MS };
}

/** Status while the Job runs, with any reason its pod is stuck. */
async function markRunning(
  context: ReconcilerContext,
  backup: Backup,
  job: Job,
): Promise<ReconcileResult> {
  const jobName = job.metadata.name ?? "";
  const stuck = await stuckReason(context.client, job);
  const startTime =
    backup.status?.startTime ?? job.status?.startTime ?? context.now().toISOString();
  await writeStatus(context, backup, { phase: "Running", jobName, startTime }, [
    stuck
      ? { type: "Complete", status: "False", reason: "PodStuck", message: stuck }
      : {
          type: "Complete",
          status: "False",
          reason: "Running",
          message: `Job ${jobName} is running`,
        },
  ]);
  if (
    stuck &&
    backup.status?.conditions?.find((condition) => condition.type === "Complete")?.reason !==
      "PodStuck"
  ) {
    await context.events.record(backup, "Warning", "PodStuck", stuck);
  }
  return { requeueAfterMs: RUNNING_RECHECK_MS };
}

/** What `finish` records. */
interface FinishInput {
  readonly phase: "Succeeded" | "Checkpointed" | "Skipped" | "Failed";
  readonly reason: string;
  readonly message: string;
  readonly fields: Partial<BackupStatus>;
}

/** Writes the final status, emits the outcome event, releases the finalizer. */
async function finish(
  context: ReconcilerContext,
  backup: Backup,
  input: FinishInput,
): Promise<undefined> {
  const failed = input.phase === "Failed";
  const conditions: ConditionInput[] = [
    {
      type: "Complete",
      status: failed ? "False" : "True",
      reason: input.reason,
      message: input.message,
    },
    {
      type: "Failed",
      status: failed ? "True" : "False",
      reason: input.reason,
      message: input.message,
    },
  ];
  const verification = input.fields.verification;
  if (verification) {
    conditions.push({
      type: "Verified",
      status: verification.ok ? "True" : "False",
      reason: verification.ok ? "VerifyPassed" : "VerifyFailed",
      message: `verify ${verification.mode}: ${verification.problemCount} problem(s)`,
    });
  }
  const updated = await writeStatus(
    context,
    backup,
    {
      ...input.fields,
      phase: input.phase,
      ...(input.fields.completionTime ? {} : { completionTime: context.now().toISOString() }),
    },
    conditions,
    // A finished run's status is written once, from scratch: no stale fields survive.
    true,
  );
  await context.events.record(updated, failed ? "Warning" : "Normal", input.reason, input.message);
  context.metrics.runsFinished.inc({ kind: "backup", phase: input.phase });
  await syncFinalizers(context.client, RESOURCES.backups, updated, {
    [FINALIZERS.backup]: false,
    [FINALIZERS.backupData]: wantsDataFinalizer(updated),
  });
  return undefined;
}

/** Writes status fields and conditions; keeps the other fields unless `replace`. */
async function writeStatus(
  context: ReconcilerContext,
  backup: Backup,
  fields: Partial<BackupStatus>,
  conditions: readonly ConditionInput[],
  replace = false,
): Promise<Backup> {
  const base: BackupStatus = replace ? {} : { ...backup.status };
  const status: BackupStatus = {
    ...base,
    ...(replace && backup.status?.startTime ? { startTime: backup.status.startTime } : {}),
    ...fields,
    observedGeneration: backup.metadata.generation ?? 0,
    conditions: setConditions(
      backup.status?.conditions,
      conditions,
      backup.metadata.generation,
      context.now(),
    ),
  };
  return updateStatus(context.client, RESOURCES.backups, backup, status);
}

/** True once the run reached a final phase. */
function isTerminal(backup: Backup): boolean {
  const phase = backup.status?.phase;
  return phase !== undefined && TERMINAL_BACKUP_PHASES.includes(phase);
}
