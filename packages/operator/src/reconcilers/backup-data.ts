/**
 * `deletionPolicy: Delete` on a MongoShieldBackup: deleting the object deletes the
 * backup from storage too.
 *
 * While a finished backup with `deletionPolicy: Delete` has a backup id, it carries
 * the `mongoshield.io/delete-backup-data` finalizer (`wantsDataFinalizer`). When the
 * object is deleted, the API server only marks it; this code then:
 *
 *   1. creates a Job running `mongoshield delete <backupId> --yes --json` with the
 *      plan's storage settings (owned by the backup, so it is cleaned up with it),
 *   2. waits for it, and reads MongoShield's result:
 *        - deleted (or already gone): releases the finalizer; the object disappears,
 *        - refused (on hold, write-once, an incremental depends on it, storage error):
 *          keeps the finalizer, reports why in the `DataDeleted` condition and a
 *          Warning event, removes the failed Job and tries again in 5 minutes.
 *
 * So a backup object never disappears while its data is still there, and nothing
 * the library protects is deleted behind its back. To give up on deleting the data,
 * set `deletionPolicy: Retain`: the finalizer is released at once.
 */

import { FINALIZERS } from "../api/constants.ts";
import type { Backup, BackupStatus } from "../api/types.ts";
import { type ConditionInput, setConditions } from "../controller/conditions.ts";
import type { ReconcileResult } from "../controller/controller.ts";
import { removeFinalizer } from "../controller/finalizers.ts";
import { updateStatus } from "../controller/status.ts";
import { isAlreadyExists, RESOURCES } from "../kube/client.ts";
import type { Job } from "../kube/objects.ts";
import { buildMongoShieldConfig } from "../resources/config.ts";
import {
  buildDataDeletionJob,
  configHashOf,
  dataDeletionJobNameOf,
} from "../resources/workloads.ts";
import { jobState, readJobResult } from "../results/job-result.ts";
import { deletionOutcome } from "../results/to-status.ts";
import type { ReconcilerContext } from "./context.ts";

/** How often to look at a running deletion Job (its completion also arrives as an event). */
const DELETION_JOB_RECHECK_MS = 5_000;

/** How long to wait before trying again after MongoShield refused the deletion. */
const REFUSED_RETRY_MS = 5 * 60_000;

/** True when the backup's data should be deleted with the object. */
export function wantsDataFinalizer(backup: Backup): boolean {
  return backup.spec.deletionPolicy === "Delete" && backup.status?.backupId !== undefined;
}

/** Runs the data finalizer of a backup that is being deleted (see the file header). */
export async function finalizeBackupData(
  context: ReconcilerContext,
  backup: Backup,
): Promise<ReconcileResult | undefined> {
  const namespace = backup.metadata.namespace ?? "";
  if (!backup.metadata.finalizers?.includes(FINALIZERS.backupData)) return undefined;

  const backupId = backup.status?.backupId;
  if (backup.spec.deletionPolicy !== "Delete" || backupId === undefined) {
    // Switched to Retain (or there was never anything stored): just let it go.
    await removeFinalizer(context.client, RESOURCES.backups, backup, FINALIZERS.backupData);
    return undefined;
  }

  const plan = context.plans.get(namespace, backup.spec.planRef.name);
  if (!plan) {
    // The plan holds the storage settings; without it nothing can be deleted.
    await writeDataCondition(context, backup, {
      type: "DataDeleted",
      status: "False",
      reason: "PlanNotFound",
      message: `MongoShieldBackupPlan ${backup.spec.planRef.name} is gone, so backup ${backupId} cannot be deleted from storage. Set deletionPolicy: Retain to delete only this record.`,
    });
    return { requeueAfterMs: REFUSED_RETRY_MS };
  }

  const jobName = dataDeletionJobNameOf(backup);
  const job = await context.client.get<Job>(RESOURCES.jobs, namespace, jobName);
  if (!job) {
    const configHash = configHashOf(buildMongoShieldConfig(plan));
    try {
      await context.client.create(
        RESOURCES.jobs,
        namespace,
        buildDataDeletionJob(backup, plan, backupId, context.defaults, configHash),
      );
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await context.events.record(
      backup,
      "Normal",
      "DeletingBackupData",
      `Deleting backup ${backupId} from storage (Job ${jobName})`,
    );
    await writeDataCondition(context, backup, {
      type: "DataDeleted",
      status: "False",
      reason: "Deleting",
      message: `Job ${jobName} is deleting backup ${backupId}`,
    });
    return { requeueAfterMs: DELETION_JOB_RECHECK_MS };
  }

  const state = jobState(job);
  if (state.phase === "running") return { requeueAfterMs: DELETION_JOB_RECHECK_MS };

  const outcome = deletionOutcome(state, await readJobResult(context.client, job));
  if (outcome.kind === "deleted") {
    await context.events.record(backup, "Normal", "BackupDataDeleted", outcome.message);
    await removeFinalizer(context.client, RESOURCES.backups, backup, FINALIZERS.backupData);
    return undefined;
  }

  // Refused: say why, and try again later (a hold may be released, a lock may expire).
  await context.events.record(backup, "Warning", "BackupDataDeletionRefused", outcome.message);
  await writeDataCondition(context, backup, {
    type: "DataDeleted",
    status: "False",
    reason: "Refused",
    message: outcome.message,
  });
  await context.client.delete(RESOURCES.jobs, namespace, jobName, "Background");
  return { requeueAfterMs: REFUSED_RETRY_MS };
}

/** Writes the DataDeleted condition (and optional fields) to the backup's status. */
async function writeDataCondition(
  context: ReconcilerContext,
  backup: Backup,
  condition: ConditionInput,
): Promise<void> {
  const status: BackupStatus = {
    ...backup.status,
    conditions: setConditions(
      backup.status?.conditions,
      [condition],
      backup.metadata.generation,
      context.now(),
    ),
  };
  await updateStatus(context.client, RESOURCES.backups, backup, status);
}
