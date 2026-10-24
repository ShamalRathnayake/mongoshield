/**
 * Desired-state builders: the ConfigMap, CronJob and Jobs the operator creates.
 *
 * Pure functions from custom resources to Kubernetes objects. The reconcilers
 * compare their output with what exists (by hash, see hash.ts) and create or update
 * accordingly; tests check the builders directly.
 */

import { ANNOTATIONS, CONFIG_FILE_NAME, KINDS, LABELS, MANAGED_BY } from "../api/constants.ts";
import {
  type Backup,
  type BackupPlan,
  type Drill,
  OVERWRITE_MODES,
  type Restore,
} from "../api/types.ts";
import { boundedName, CRONJOB_NAME_MAX, labelValue } from "../controller/names.ts";
import { controllerReference } from "../controller/ownership.ts";
import type { ConfigMap, CronJob, Job } from "../kube/objects.ts";
import { hashOf } from "./hash.ts";
import { buildJobSpec, buildPodTemplate, CONFIG_PATH, type JobDefaults } from "./pod.ts";

/** Name of a plan's ConfigMap. */
export function configMapNameOf(plan: BackupPlan): string {
  return boundedName(`${plan.metadata.name}-mongoshield-config`);
}

/** Name of a plan's CronJob (short enough for the suffix its Jobs get). */
export function cronJobNameOf(plan: BackupPlan): string {
  return boundedName(plan.metadata.name ?? "", CRONJOB_NAME_MAX);
}

/** Name of a manual backup's Job: the backup's own name, shortened if needed. */
export function backupJobNameOf(backup: Backup): string {
  return boundedName(backup.metadata.name ?? "");
}

/** Name of a drill's Job. */
export function drillJobNameOf(drill: Drill): string {
  return boundedName(`${drill.metadata.name}-drill`);
}

/** Name of the Job that deletes a backup's data (`deletionPolicy: Delete`). */
export function dataDeletionJobNameOf(backup: Backup): string {
  return boundedName(`${backup.metadata.name}-delete`);
}

/** Name of a restore's Job. */
export function restoreJobNameOf(restore: Restore): string {
  return boundedName(`${restore.metadata.name}-restore`);
}

/** Labels shared by everything created for a plan. */
function planLabels(plan: BackupPlan): Record<string, string> {
  return {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.plan]: labelValue(plan.metadata.name ?? ""),
  };
}

/** The ConfigMap with the plan's mongoshield.config.json. */
export function buildConfigMap(plan: BackupPlan, config: Record<string, unknown>): ConfigMap {
  const data = { [CONFIG_FILE_NAME]: `${JSON.stringify(config, null, 2)}\n` };
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: configMapNameOf(plan),
      namespace: plan.metadata.namespace ?? "",
      labels: planLabels(plan),
      annotations: { [ANNOTATIONS.specHash]: hashOf(data) },
      ownerReferences: [controllerReference(plan)],
    },
    data,
  };
}

/** The hash a ConfigMap built from this config carries (also put on pod templates). */
export function configHashOf(config: Record<string, unknown>): string {
  return hashOf({ [CONFIG_FILE_NAME]: `${JSON.stringify(config, null, 2)}\n` });
}

/**
 * The CronJob of a scheduled plan. Each run is `mongoshield run --json`: lock, back
 * up, verify, prune and notify, as configured in the plan's config.
 */
export function buildCronJob(plan: BackupPlan, defaults: JobDefaults, configHash: string): CronJob {
  const schedule = plan.spec.schedule;
  if (!schedule) throw new Error("buildCronJob needs a plan with a schedule");
  const labels = {
    ...planLabels(plan),
    [LABELS.trigger]: "schedule",
    [LABELS.component]: "backup",
  };
  const template = buildPodTemplate({
    plan,
    defaults,
    args: ["run", "--json", "--config", CONFIG_PATH],
    uriSecret: plan.spec.source.uriSecretRef,
    configMapName: configMapNameOf(plan),
    labels,
    configHash,
  });
  const spec: CronJob["spec"] = {
    schedule: schedule.cron,
    timeZone: schedule.timeZone ?? "Etc/UTC",
    // Never two runs at once: they would double the load for nothing (MongoShield's
    // lock would also stop the second one, but later and less visibly).
    concurrencyPolicy: "Forbid",
    startingDeadlineSeconds: schedule.startingDeadlineSeconds ?? 3600,
    suspend: schedule.suspend ?? false,
    // The operator records each run as a MongoShieldBackup, so a few Jobs suffice.
    successfulJobsHistoryLimit: 3,
    failedJobsHistoryLimit: 3,
    jobTemplate: { metadata: { labels }, spec: buildJobSpec(plan, template) },
  };
  return {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: {
      name: cronJobNameOf(plan),
      namespace: plan.metadata.namespace ?? "",
      labels,
      annotations: { [ANNOTATIONS.specHash]: hashOf(spec) },
      ownerReferences: [controllerReference(plan)],
    },
    spec,
  };
}

/** The Job of a manual (one-off) backup. */
export function buildBackupJob(
  backup: Backup,
  plan: BackupPlan,
  defaults: JobDefaults,
  configHash: string,
): Job {
  const labels = {
    ...planLabels(plan),
    [LABELS.backup]: labelValue(backup.metadata.name ?? ""),
    [LABELS.trigger]: "manual",
    [LABELS.component]: "backup",
  };
  const args = [
    "run",
    "--json",
    "--config",
    CONFIG_PATH,
    "--verify",
    backup.spec.verify ?? plan.spec.verify ?? "fast",
  ];
  // Retention is the schedule's job; a one-off backup only prunes when asked to.
  if (!backup.spec.prune) args.push("--no-prune");
  const template = buildPodTemplate({
    plan,
    defaults,
    args,
    uriSecret: plan.spec.source.uriSecretRef,
    configMapName: configMapNameOf(plan),
    labels,
    configHash,
  });
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: backupJobNameOf(backup),
      namespace: backup.metadata.namespace ?? "",
      labels,
      ownerReferences: [controllerReference(backup)],
    },
    spec: buildJobSpec(plan, template),
  };
}

/** The command line of a restore. */
export function restoreArgs(restore: Restore, backupId: string): string[] {
  const spec = restore.spec;
  const mode = spec.mode ?? "fail-if-exists";
  const args = ["restore", backupId, "--json", "--config", CONFIG_PATH, "--mode", mode];
  // --yes answers the CLI's "are you sure?". The question was already answered
  // declaratively: spec.confirm names the target (checked by the CRD and reconciler).
  if (OVERWRITE_MODES.includes(mode) && !spec.dryRun) args.push("--yes");
  for (const pattern of spec.include ?? []) args.push("--include", pattern);
  for (const pattern of spec.exclude ?? []) args.push("--exclude", pattern);
  for (const rule of spec.rename ?? []) args.push("--rename", `${rule.from}=${rule.to}`);
  if (spec.dryRun) args.push("--dry-run");
  if (spec.at) args.push("--at", spec.at);
  if (spec.skipIndexes) args.push("--skip-indexes");
  if (spec.usersAndRoles) args.push("--users-and-roles", spec.usersAndRoles);
  return args;
}

/** The Job of a restore. MONGODB_URI is the restore's target, not the plan's source. */
export function buildRestoreJob(
  restore: Restore,
  plan: BackupPlan,
  backupId: string,
  defaults: JobDefaults,
  configHash: string,
): Job {
  const labels = {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.plan]: labelValue(plan.metadata.name ?? ""),
    [LABELS.restore]: labelValue(restore.metadata.name ?? ""),
    [LABELS.component]: "restore",
  };
  const template = buildPodTemplate({
    plan,
    defaults,
    args: restoreArgs(restore, backupId),
    uriSecret: restore.spec.target.uriSecretRef,
    configMapName: configMapNameOf(plan),
    labels,
    configHash,
  });
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: restoreJobNameOf(restore),
      namespace: restore.metadata.namespace ?? "",
      labels,
      ownerReferences: [controllerReference(restore)],
    },
    spec: buildJobSpec(plan, template),
  };
}

/** The MongoShieldBackup recording one run started by a plan's CronJob. */
export function buildScheduledBackup(plan: BackupPlan, job: Job): Backup {
  return {
    apiVersion: plan.apiVersion ?? "",
    kind: KINDS.backup,
    metadata: {
      // Same name as the Job: `kubectl get msbackup` and `kubectl get job` line up.
      name: job.metadata.name ?? "",
      namespace: plan.metadata.namespace ?? "",
      labels: { ...planLabels(plan), [LABELS.trigger]: "schedule" },
      annotations: { [ANNOTATIONS.scheduledJob]: job.metadata.name ?? "" },
      // Owned by the plan: deleting the plan deletes its run records (not the backups).
      ownerReferences: [controllerReference(plan)],
    },
    spec: { planRef: { name: plan.metadata.name ?? "" } },
  };
}

/** The command line of a drill. The target comes from MONGOSHIELD_DRILL_URI, not a flag. */
export function drillArgs(drill: Drill, backupId: string): string[] {
  const spec = drill.spec;
  const args = ["drill", backupId, "--json", "--config", CONFIG_PATH];
  if (spec.sample !== undefined) args.push("--sample", String(spec.sample));
  if (spec.prefix) args.push("--prefix", spec.prefix);
  for (const pattern of spec.include ?? []) args.push("--include", pattern);
  for (const pattern of spec.exclude ?? []) args.push("--exclude", pattern);
  return args;
}

/**
 * The Job of a drill: no MONGODB_URI at all (a drill never touches the source), the
 * scratch deployment as MONGOSHIELD_DRILL_URI from the drill's Secret.
 */
export function buildDrillJob(
  drill: Drill,
  plan: BackupPlan,
  backupId: string,
  defaults: JobDefaults,
  configHash: string,
): Job {
  const labels = {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.plan]: labelValue(plan.metadata.name ?? ""),
    [LABELS.drill]: labelValue(drill.metadata.name ?? ""),
    [LABELS.component]: "drill",
  };
  const template = buildPodTemplate({
    plan,
    defaults,
    args: drillArgs(drill, backupId),
    drillSecret: drill.spec.target.uriSecretRef,
    configMapName: configMapNameOf(plan),
    labels,
    configHash,
  });
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: drillJobNameOf(drill),
      namespace: drill.metadata.namespace ?? "",
      labels,
      ownerReferences: [controllerReference(drill)],
    },
    spec: buildJobSpec(plan, template),
  };
}

/**
 * The Job that deletes a backup's data from storage before its MongoShieldBackup goes
 * (`deletionPolicy: Delete`): `mongoshield delete <id> --yes --json`. --yes answers
 * the CLI's question; the decision was the deletionPolicy. MongoShield still refuses
 * held, write-once and depended-on backups.
 */
export function buildDataDeletionJob(
  backup: Backup,
  plan: BackupPlan,
  backupId: string,
  defaults: JobDefaults,
  configHash: string,
): Job {
  const labels = {
    ...planLabels(plan),
    [LABELS.backup]: labelValue(backup.metadata.name ?? ""),
    [LABELS.component]: "delete",
  };
  const requestedBy = `kubernetes:${backup.metadata.namespace}/${backup.metadata.name}`;
  const template = buildPodTemplate({
    plan,
    defaults,
    args: ["delete", backupId, "--yes", "--json", "--config", CONFIG_PATH, "--by", requestedBy],
    configMapName: configMapNameOf(plan),
    labels,
    configHash,
  });
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: dataDeletionJobNameOf(backup),
      namespace: backup.metadata.namespace ?? "",
      labels,
      ownerReferences: [controllerReference(backup)],
    },
    spec: buildJobSpec(plan, template),
  };
}
