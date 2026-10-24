/**
 * The MongoShieldDrill reconciler: one restore drill, from backup choice to result.
 *
 * A drill proves a backup can be restored: `mongoshield drill <id> --json` restores it
 * into temporary databases on a scratch deployment, checks counts, indexes and an
 * optional sample of documents, drops the temporary databases, and reports the
 * measured restore time (the RTO). The steps mirror a restore (restore.ts):
 *
 *   1. Which backup: `spec.backup.name` (a MongoShieldBackup that succeeded),
 *      `spec.backup.id`, or "latest".
 *   2. Wait for the plan to be Ready, hold a finalizer, create the Job. The scratch
 *      deployment reaches the pod only as MONGOSHIELD_DRILL_URI from the drill's
 *      Secret; there is no MONGODB_URI at all (a drill never touches the source), and
 *      MongoShield itself refuses a target that is the backup's own source.
 *   3. When the Job finishes, record the drill report: ok, RTO, problems.
 *
 * Phases: Succeeded when the drill passed; Failed when it found problems
 * (`DrillFoundProblems`) or could not run. Like restores, a drill runs once; create a
 * new object (or use `verify: drill` on the plan) to drill again.
 */

import { FINALIZERS } from "../api/constants.ts";
import type { Drill, DrillStatus } from "../api/types.ts";
import { type ConditionInput, setConditions } from "../controller/conditions.ts";
import type { ObjectRef, ReconcileResult } from "../controller/controller.ts";
import { addFinalizer, hasFinalizer, removeFinalizer } from "../controller/finalizers.ts";
import { isOwnedBy } from "../controller/ownership.ts";
import { updateStatus } from "../controller/status.ts";
import { isAlreadyExists, RESOURCES } from "../kube/client.ts";
import type { Job } from "../kube/objects.ts";
import { buildMongoShieldConfig } from "../resources/config.ts";
import { buildDrillJob, configHashOf, drillJobNameOf } from "../resources/workloads.ts";
import { jobState, readJobResult, stuckReason } from "../results/job-result.ts";
import { drillOutcome } from "../results/to-status.ts";
import { type ReconcilerContext, RUNNING_RECHECK_MS, WAITING_RECHECK_MS } from "./context.ts";
import { resolveBackupId } from "./restore.ts";
import { finalizeRun, planNotReadyReason } from "./runs.ts";

/** Reconciles one MongoShieldDrill. */
export async function reconcileDrill(
  context: ReconcilerContext,
  ref: ObjectRef,
): Promise<ReconcileResult | undefined> {
  const cached = context.drills.get(ref.namespace, ref.name);
  if (!cached) return undefined;
  const jobName = drillJobNameOf(cached);

  if (cached.metadata.deletionTimestamp) {
    return finalizeRun(context, RESOURCES.drills, cached, FINALIZERS.drill, jobName, (job) =>
      isOwnedBy(job, cached),
    );
  }
  if (cached.status?.phase === "Succeeded" || cached.status?.phase === "Failed") {
    await removeFinalizer(context.client, RESOURCES.drills, cached, FINALIZERS.drill);
    return undefined;
  }

  const job = await context.client.get<Job>(RESOURCES.jobs, ref.namespace, jobName);
  if (job) return observeJob(context, cached, job);

  // 1. Which backup.
  const resolved = resolveBackupId(context, cached);
  if (resolved.kind === "wait") {
    await writeStatus(context, cached, { phase: "Pending" }, [
      { type: "Complete", status: "False", reason: resolved.reason, message: resolved.message },
    ]);
    return { requeueAfterMs: WAITING_RECHECK_MS };
  }
  if (resolved.kind === "fail") {
    return finish(context, cached, "Failed", resolved.reason, resolved.message, {
      error: { code: "BACKUP_UNUSABLE", message: resolved.message },
    });
  }

  // 2. The plan.
  const plan = context.plans.get(ref.namespace, cached.spec.planRef.name);
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

  const drill = await addFinalizer(context.client, RESOURCES.drills, cached, FINALIZERS.drill);
  const configHash = configHashOf(buildMongoShieldConfig(plan));
  try {
    await context.client.create(
      RESOURCES.jobs,
      ref.namespace,
      buildDrillJob(drill, plan, resolved.backupId, context.defaults, configHash),
    );
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await context.events.record(
    drill,
    "Normal",
    "Started",
    `Created Job ${jobName}: drill of ${resolved.backupId}`,
  );
  await writeStatus(
    context,
    drill,
    {
      phase: "Running",
      jobName,
      backupId: resolved.backupId,
      startTime: context.now().toISOString(),
    },
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

/** Follows a drill's Job until it finishes, then records the report. */
async function observeJob(
  context: ReconcilerContext,
  cached: Drill,
  job: Job,
): Promise<ReconcileResult | undefined> {
  const jobName = job.metadata.name ?? "";
  if (!isOwnedBy(job, cached)) {
    const message = `Job ${jobName} already exists and does not belong to this drill`;
    return finish(context, cached, "Failed", "NameConflict", message, {
      error: { code: "NAME_CONFLICT", message },
    });
  }
  const drill = await addFinalizer(context.client, RESOURCES.drills, cached, FINALIZERS.drill);
  const state = jobState(job);
  if (state.phase === "running") {
    const stuck = await stuckReason(context.client, job);
    await writeStatus(context, drill, { phase: "Running", jobName }, [
      stuck
        ? { type: "Complete", status: "False", reason: "PodStuck", message: stuck }
        : {
            type: "Complete",
            status: "False",
            reason: "Running",
            message: `Job ${jobName} is running`,
          },
    ]);
    return { requeueAfterMs: RUNNING_RECHECK_MS };
  }
  const result = await readJobResult(context.client, job);
  const outcome = drillOutcome(state, result);
  return finish(context, drill, outcome.phase, outcome.reason, outcome.message, {
    ...outcome.fields,
    jobName,
    ...(state.startTime ? { startTime: state.startTime } : {}),
    ...(state.completionTime ? { completionTime: state.completionTime } : {}),
  });
}

/** Writes the final status, emits the outcome event, releases the finalizer. */
async function finish(
  context: ReconcilerContext,
  drill: Drill,
  phase: "Succeeded" | "Failed",
  reason: string,
  message: string,
  fields: Partial<DrillStatus>,
): Promise<undefined> {
  const failed = phase === "Failed";
  const updated = await writeStatus(
    context,
    drill,
    {
      ...fields,
      phase,
      ...(fields.completionTime ? {} : { completionTime: context.now().toISOString() }),
    },
    [
      { type: "Complete", status: failed ? "False" : "True", reason, message },
      { type: "Failed", status: failed ? "True" : "False", reason, message },
    ],
  );
  await context.events.record(updated, failed ? "Warning" : "Normal", reason, message);
  context.metrics.runsFinished.inc({ kind: "drill", phase });
  if (hasFinalizer(updated, FINALIZERS.drill)) {
    await removeFinalizer(context.client, RESOURCES.drills, updated, FINALIZERS.drill);
  }
  return undefined;
}

/** Merges fields and conditions into the status and writes it if it changed. */
async function writeStatus(
  context: ReconcilerContext,
  drill: Drill,
  fields: Partial<DrillStatus>,
  conditions: readonly ConditionInput[],
): Promise<Drill> {
  const status: DrillStatus = {
    ...drill.status,
    ...fields,
    observedGeneration: drill.metadata.generation ?? 0,
    conditions: setConditions(
      drill.status?.conditions,
      conditions,
      drill.metadata.generation,
      context.now(),
    ),
  };
  return updateStatus(context.client, RESOURCES.drills, drill, status);
}
