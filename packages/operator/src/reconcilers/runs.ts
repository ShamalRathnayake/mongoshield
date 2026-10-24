/**
 * Logic shared by the two run-to-completion kinds, MongoShieldBackup and
 * MongoShieldRestore: finding their plan, and cancelling their Job on deletion.
 *
 * Both follow the same life cycle:
 *
 *   Pending ──(plan ready, Job created)──▶ Running ──(Job finished, result read)──▶ terminal
 *
 * A finalizer is held only while a Job may be running. Deleting a running backup or
 * restore therefore stops its pod first (foreground deletion of the Job) and only
 * then lets the object go: when `kubectl delete msrestore x` returns, nothing is
 * writing to the target anymore. Finished runs carry no finalizer and delete at once.
 */

import type { BackupPlan } from "../api/types.ts";
import { isConditionTrue } from "../controller/conditions.ts";
import type { ReconcileResult } from "../controller/controller.ts";
import type { EventRecorder } from "../controller/events.ts";
import { hasFinalizer, removeFinalizer } from "../controller/finalizers.ts";
import { RESOURCES, type ResourceType } from "../kube/client.ts";
import type { Job, KubeObject } from "../kube/objects.ts";
import { jobState } from "../results/job-result.ts";
import { DELETION_RECHECK_MS, type ReconcilerContext } from "./context.ts";

/** Why a run cannot start yet, or undefined when its plan is ready. */
export function planNotReadyReason(
  plan: BackupPlan | undefined,
  planName: string,
): { reason: string; message: string } | undefined {
  if (!plan) {
    return {
      reason: "PlanNotFound",
      message: `MongoShieldBackupPlan ${planName} does not exist (yet)`,
    };
  }
  if (plan.metadata.deletionTimestamp) {
    return {
      reason: "PlanDeleting",
      message: `MongoShieldBackupPlan ${planName} is being deleted`,
    };
  }
  // The plan must have been reconciled at its current generation, so its ConfigMap
  // holds the config this run will be started with.
  const current = plan.status?.observedGeneration === plan.metadata.generation;
  if (!current || !isConditionTrue(plan.status?.conditions, "Ready")) {
    return { reason: "PlanNotReady", message: `MongoShieldBackupPlan ${planName} is not Ready` };
  }
  return undefined;
}

/**
 * The finalizer of a run: stop its Job if it is still running, wait until it is
 * gone, then release the object.
 *
 * @param mayCancel whether this object may delete the Job (it owns it, or it is the
 *   record of a scheduled run, whose Job belongs to the plan's CronJob).
 */
export async function finalizeRun(
  context: Pick<ReconcilerContext, "client" | "events">,
  type: ResourceType,
  object: KubeObject,
  finalizer: string,
  jobName: string | undefined,
  mayCancel: (job: Job) => boolean,
): Promise<ReconcileResult | undefined> {
  if (!hasFinalizer(object, finalizer)) return undefined;
  const namespace = object.metadata.namespace ?? "";
  const job = jobName
    ? await context.client.get<Job>(RESOURCES.jobs, namespace, jobName)
    : undefined;
  if (job && mayCancel(job) && jobState(job).phase === "running") {
    if (!job.metadata.deletionTimestamp) {
      await context.client.delete(RESOURCES.jobs, namespace, jobName ?? "", "Foreground");
      await cancelledEvent(context.events, object, jobName ?? "");
    }
    // Foreground deletion: the Job stays until its pods are gone. Check again shortly.
    return { requeueAfterMs: DELETION_RECHECK_MS };
  }
  await removeFinalizer(context.client, type, object, finalizer);
  return undefined;
}

function cancelledEvent(events: EventRecorder, object: KubeObject, jobName: string): Promise<void> {
  return events.record(
    object,
    "Warning",
    "Cancelled",
    `Deleted while running: stopping Job ${jobName}`,
  );
}
