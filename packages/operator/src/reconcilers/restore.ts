/**
 * The MongoShieldRestore reconciler: one restore, from checks to recorded result.
 *
 *   1. Safety: modes that can overwrite data (drop, insert, upsert) need
 *      `spec.confirm` set to the target Secret's name, unless it is a dry run. The
 *      CRD enforces this at admission (CEL); the reconciler checks again, so the rule
 *      also holds on clusters without CEL validation and for objects created before
 *      the CRD was upgraded.
 *   2. Which backup: `spec.backup.name` (a MongoShieldBackup, which must have
 *      succeeded), `spec.backup.id`, or "latest".
 *   3. Wait for the plan to be Ready (its ConfigMap has storage and decryption
 *      settings), hold a finalizer, create the Job: `mongoshield restore <id> --json`
 *      with MONGODB_URI set from the restore's target Secret (never the plan's source).
 *   4. When the Job finishes, record MongoShield's restore result.
 *
 * A restore never runs twice: the spec is immutable, the Job has backoffLimit 0 by
 * default, and a finished restore's status is final. To restore again, create a new
 * MongoShieldRestore.
 */

import { FINALIZERS } from "../api/constants.ts";
import { OVERWRITE_MODES, type Restore, type RestoreStatus } from "../api/types.ts";
import { type ConditionInput, setConditions } from "../controller/conditions.ts";
import type { ObjectRef, ReconcileResult } from "../controller/controller.ts";
import { addFinalizer, hasFinalizer, removeFinalizer } from "../controller/finalizers.ts";
import { isOwnedBy } from "../controller/ownership.ts";
import { updateStatus } from "../controller/status.ts";
import { isAlreadyExists, RESOURCES } from "../kube/client.ts";
import type { Job } from "../kube/objects.ts";
import { buildMongoShieldConfig } from "../resources/config.ts";
import { buildRestoreJob, configHashOf, restoreJobNameOf } from "../resources/workloads.ts";
import { jobState, readJobResult, stuckReason } from "../results/job-result.ts";
import { restoreOutcome } from "../results/to-status.ts";
import { type ReconcilerContext, RUNNING_RECHECK_MS, WAITING_RECHECK_MS } from "./context.ts";
import { finalizeRun, planNotReadyReason } from "./runs.ts";

/** Reconciles one MongoShieldRestore. */
export async function reconcileRestore(
  context: ReconcilerContext,
  ref: ObjectRef,
): Promise<ReconcileResult | undefined> {
  const cached = context.restores.get(ref.namespace, ref.name);
  if (!cached) return undefined;
  const jobName = restoreJobNameOf(cached);

  if (cached.metadata.deletionTimestamp) {
    return finalizeRun(context, RESOURCES.restores, cached, FINALIZERS.restore, jobName, (job) =>
      isOwnedBy(job, cached),
    );
  }
  if (cached.status?.phase === "Succeeded" || cached.status?.phase === "Failed") {
    await removeFinalizer(context.client, RESOURCES.restores, cached, FINALIZERS.restore);
    return undefined;
  }

  const job = await context.client.get<Job>(RESOURCES.jobs, ref.namespace, jobName);
  if (job) return observeJob(context, cached, job);

  // 1. Confirmation for overwriting modes.
  const confirmation = confirmationProblem(cached);
  if (confirmation) {
    return finish(context, cached, "Failed", "ConfirmationRequired", confirmation, {
      error: { code: "CONFIRMATION_REQUIRED", message: confirmation },
    });
  }

  // 2. Which backup.
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

  // 3. The plan.
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

  const restore = await addFinalizer(
    context.client,
    RESOURCES.restores,
    cached,
    FINALIZERS.restore,
  );
  const configHash = configHashOf(buildMongoShieldConfig(plan));
  try {
    await context.client.create(
      RESOURCES.jobs,
      ref.namespace,
      buildRestoreJob(restore, plan, resolved.backupId, context.defaults, configHash),
    );
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const what = restore.spec.dryRun ? "dry run of" : "restore of";
  await context.events.record(
    restore,
    "Normal",
    "Started",
    `Created Job ${jobName}: ${what} ${resolved.backupId} (mode ${restore.spec.mode ?? "fail-if-exists"})`,
  );
  await writeStatus(
    context,
    restore,
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

/** Follows a restore's Job until it finishes, then records the result. */
async function observeJob(
  context: ReconcilerContext,
  cached: Restore,
  job: Job,
): Promise<ReconcileResult | undefined> {
  const jobName = job.metadata.name ?? "";
  if (!isOwnedBy(job, cached)) {
    const message = `Job ${jobName} already exists and does not belong to this restore`;
    return finish(context, cached, "Failed", "NameConflict", message, {
      error: { code: "NAME_CONFLICT", message },
    });
  }
  const restore = await addFinalizer(
    context.client,
    RESOURCES.restores,
    cached,
    FINALIZERS.restore,
  );
  const state = jobState(job);
  if (state.phase === "running") {
    const stuck = await stuckReason(context.client, job);
    await writeStatus(context, restore, { phase: "Running", jobName }, [
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
  const outcome = restoreOutcome(state, result);
  return finish(context, restore, outcome.phase, outcome.reason, outcome.message, {
    ...outcome.fields,
    jobName,
    ...(state.startTime ? { startTime: state.startTime } : {}),
    ...(state.completionTime ? { completionTime: state.completionTime } : {}),
  });
}

/** Why an overwriting restore may not run, or undefined when it may. */
export function confirmationProblem(restore: Restore): string | undefined {
  const mode = restore.spec.mode ?? "fail-if-exists";
  if (!OVERWRITE_MODES.includes(mode) || restore.spec.dryRun) return undefined;
  const target = restore.spec.target.uriSecretRef.name;
  if (restore.spec.confirm === target) return undefined;
  return `mode ${mode} can overwrite data in the target: set spec.confirm to "${target}" (the target Secret's name) to confirm`;
}

/** Outcome of working out which backup to restore. */
export type Resolution =
  | { readonly kind: "ok"; readonly backupId: string }
  | { readonly kind: "wait"; readonly reason: string; readonly message: string }
  | { readonly kind: "fail"; readonly reason: string; readonly message: string };

/**
 * Works out the backup id: from a MongoShieldBackup, an explicit id, or "latest".
 * Shared with drills, which pick their backup the same way.
 */
export function resolveBackupId(
  context: Pick<ReconcilerContext, "backups">,
  restore: Pick<Restore, "metadata"> & {
    readonly spec: { readonly backup?: { readonly name?: string; readonly id?: string } };
  },
): Resolution {
  const reference = restore.spec.backup;
  if (reference?.name) {
    const backup = context.backups.get(restore.metadata.namespace ?? "", reference.name);
    if (!backup) {
      return {
        kind: "wait",
        reason: "BackupNotFound",
        message: `MongoShieldBackup ${reference.name} does not exist (yet)`,
      };
    }
    const phase = backup.status?.phase;
    if (phase === undefined || phase === "Pending" || phase === "Running") {
      return {
        kind: "wait",
        reason: "BackupNotReady",
        message: `MongoShieldBackup ${reference.name} is still running`,
      };
    }
    if (phase !== "Succeeded" || !backup.status?.backupId) {
      return {
        kind: "fail",
        reason: "BackupUnusable",
        message: `MongoShieldBackup ${reference.name} ended ${phase}${backup.status?.backupId ? "" : " without a backup id"}; nothing to restore`,
      };
    }
    return { kind: "ok", backupId: backup.status.backupId };
  }
  return { kind: "ok", backupId: reference?.id ?? "latest" };
}

/** Writes the final status, emits the outcome event, releases the finalizer. */
async function finish(
  context: ReconcilerContext,
  restore: Restore,
  phase: "Succeeded" | "Failed",
  reason: string,
  message: string,
  fields: Partial<RestoreStatus>,
): Promise<undefined> {
  const failed = phase === "Failed";
  const updated = await writeStatus(
    context,
    restore,
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
  context.metrics.runsFinished.inc({ kind: "restore", phase });
  if (hasFinalizer(updated, FINALIZERS.restore)) {
    await removeFinalizer(context.client, RESOURCES.restores, updated, FINALIZERS.restore);
  }
  return undefined;
}

/** Merges fields and conditions into the status and writes it if it changed. */
async function writeStatus(
  context: ReconcilerContext,
  restore: Restore,
  fields: Partial<RestoreStatus>,
  conditions: readonly ConditionInput[],
): Promise<Restore> {
  const status: RestoreStatus = {
    ...restore.status,
    ...fields,
    observedGeneration: restore.metadata.generation ?? 0,
    conditions: setConditions(
      restore.status?.conditions,
      conditions,
      restore.metadata.generation,
      context.now(),
    ),
  };
  return updateStatus(context.client, RESOURCES.restores, restore, status);
}
