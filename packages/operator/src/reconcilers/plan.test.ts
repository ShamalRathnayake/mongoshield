/** Tests for the BackupPlan reconciler, against the in-memory API server. */

import { describe, expect, it } from "vitest";
import {
  apply,
  makeBackup,
  makePlan,
  NAMESPACE,
  NOW,
  testContext,
} from "../../test/helpers/fixtures.ts";
import { ANNOTATIONS, FINALIZERS, LABELS } from "../api/constants.ts";
import type { Backup, BackupPlan } from "../api/types.ts";
import { findCondition } from "../controller/conditions.ts";
import { KubeApiError, RESOURCES } from "../kube/client.ts";
import type { ConfigMap, CronJob, Job } from "../kube/objects.ts";
import { nextScheduleTime, RECORDED_ANNOTATION, reconcilePlan, validateSchedule } from "./plan.ts";

const ref = { namespace: NAMESPACE, name: "nightly" };

function storedPlan(client: ReturnType<typeof testContext>["client"]): BackupPlan {
  const plan = client.object<BackupPlan>(RESOURCES.plans, NAMESPACE, "nightly");
  if (!plan) throw new Error("plan missing");
  return plan;
}

/** Starts a Job the way the CronJob controller would. */
function cronJobStartsRun(client: ReturnType<typeof testContext>["client"], jobName: string): Job {
  const cronJob = client.object<CronJob>(RESOURCES.cronJobs, NAMESPACE, "nightly");
  if (!cronJob) throw new Error("no CronJob");
  return client.setObject<Job>(RESOURCES.jobs, {
    metadata: {
      name: jobName,
      namespace: NAMESPACE,
      labels: cronJob.spec?.jobTemplate.metadata?.labels ?? {},
      ownerReferences: [
        {
          apiVersion: "batch/v1",
          kind: "CronJob",
          name: "nightly",
          uid: cronJob.metadata.uid ?? "",
          controller: true,
        },
      ],
    },
    spec: cronJob.spec?.jobTemplate.spec ?? { template: {} },
    status: { active: 1, startTime: "2026-10-24T11:59:00Z" },
  });
}

describe("reconcilePlan", () => {
  it("creates the ConfigMap and CronJob, adds its finalizer and reports Ready", async () => {
    const { context, client, events } = testContext();
    await apply(client, RESOURCES.plans, makePlan());

    const result = await reconcilePlan(context, ref);

    const plan = storedPlan(client);
    expect(plan.metadata.finalizers).toEqual([FINALIZERS.plan]);
    const configMap = client.object<ConfigMap>(
      RESOURCES.configMaps,
      NAMESPACE,
      "nightly-mongoshield-config",
    );
    expect(JSON.parse(configMap?.data?.["mongoshield.config.json"] ?? "{}")).toMatchObject({
      storage: "s3://acme-backups/prod?region=eu-west-1",
      retention: { last: 3, daily: 7 },
      schedule: { cron: "15 3 * * *", verify: "fast", prune: true },
    });
    const cronJob = client.object<CronJob>(RESOURCES.cronJobs, NAMESPACE, "nightly");
    expect(cronJob?.spec?.schedule).toBe("15 3 * * *");
    expect(cronJob?.metadata.ownerReferences?.[0]).toMatchObject({
      kind: "MongoShieldBackupPlan",
      controller: true,
    });

    expect(plan.status?.observedGeneration).toBe(1);
    expect(findCondition(plan.status?.conditions, "Ready")).toMatchObject({
      status: "True",
      reason: "Reconciled",
    });
    expect(findCondition(plan.status?.conditions, "LastBackupSucceeded")?.status).toBe("Unknown");
    expect(plan.status?.cronJobName).toBe("nightly");
    expect(plan.status?.nextScheduleTime).toBe("2026-10-25T03:15:00.000Z");
    expect(events.reasons()).toContain("CronJobCreated");
    // Requeued shortly after the next run is due, capped at an hour.
    expect(result?.requeueAfterMs).toBe(60 * 60_000);
  });

  it("is a no-op the second time: nothing is rewritten when nothing changed", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    await reconcilePlan(context, ref);
    const writesBefore = client.calls.filter((call) =>
      ["create", "replace", "patch"].includes(call.verb),
    ).length;

    await reconcilePlan(context, ref);

    const writesAfter = client.calls.filter((call) =>
      ["create", "replace", "patch"].includes(call.verb),
    ).length;
    expect(writesAfter).toBe(writesBefore);
  });

  it("updates the CronJob and ConfigMap when the spec changes", async () => {
    const { context, client, events } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    await reconcilePlan(context, ref);
    const plan = storedPlan(client);
    await client.replace(RESOURCES.plans, NAMESPACE, {
      ...plan,
      spec: {
        ...plan.spec,
        schedule: { cron: "0 * * * *", suspend: true },
        retention: { last: 10 },
      },
    });

    await reconcilePlan(context, ref);

    expect(client.object<CronJob>(RESOURCES.cronJobs, NAMESPACE, "nightly")?.spec).toMatchObject({
      schedule: "0 * * * *",
      suspend: true,
    });
    const configMap = client.object<ConfigMap>(
      RESOURCES.configMaps,
      NAMESPACE,
      "nightly-mongoshield-config",
    );
    expect(configMap?.data?.["mongoshield.config.json"]).toContain('"last": 10');
    expect(events.reasons()).toEqual(expect.arrayContaining(["CronJobUpdated", "ConfigUpdated"]));
    const updated = storedPlan(client);
    expect(updated.status?.observedGeneration).toBe(2);
    // Suspended: no next run.
    expect(updated.status?.nextScheduleTime).toBeUndefined();
  });

  it("puts back a CronJob that was edited by hand (drift)", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    await reconcilePlan(context, ref);
    const cronJob = client.object<CronJob>(RESOURCES.cronJobs, NAMESPACE, "nightly");
    if (!cronJob?.spec) throw new Error("no CronJob");
    await client.replace(RESOURCES.cronJobs, NAMESPACE, {
      ...cronJob,
      metadata: { ...cronJob.metadata, annotations: { [ANNOTATIONS.specHash]: "edited" } },
      spec: { ...cronJob.spec, schedule: "* * * * *" },
    });

    await reconcilePlan(context, ref);

    expect(client.object<CronJob>(RESOURCES.cronJobs, NAMESPACE, "nightly")?.spec?.schedule).toBe(
      "15 3 * * *",
    );
  });

  it("deletes its CronJob when the schedule is removed, and keeps manual-only plans Ready", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    await reconcilePlan(context, ref);
    const plan = storedPlan(client);
    const { schedule: _schedule, ...withoutSchedule } = plan.spec;
    await client.replace(RESOURCES.plans, NAMESPACE, { ...plan, spec: withoutSchedule });

    const result = await reconcilePlan(context, ref);

    expect(client.object(RESOURCES.cronJobs, NAMESPACE, "nightly")).toBeUndefined();
    const updated = storedPlan(client);
    expect(findCondition(updated.status?.conditions, "Ready")?.message).toContain("No schedule");
    expect(updated.status?.cronJobName).toBeUndefined();
    expect(result).toBeUndefined();
  });

  it("reports an invalid config as Ready=False InvalidSpec, without creating anything", async () => {
    const { context, client, events } = testContext();
    // MongoShield's own schema refuses retention.last: 0 (must be positive).
    await apply(client, RESOURCES.plans, makePlan("nightly", { retention: { last: 0 } }));

    const result = await reconcilePlan(context, ref);

    const plan = storedPlan(client);
    expect(findCondition(plan.status?.conditions, "Ready")).toMatchObject({
      status: "False",
      reason: "InvalidSpec",
    });
    expect(findCondition(plan.status?.conditions, "Ready")?.message).toContain("retention");
    expect(client.object(RESOURCES.cronJobs, NAMESPACE, "nightly")).toBeUndefined();
    expect(events.reasons()).toContain("InvalidSpec");
    expect(result).toBeUndefined();
  });

  it("reports a bad cron expression or time zone as InvalidSpec", async () => {
    const { context, client } = testContext();
    await apply(
      client,
      RESOURCES.plans,
      makePlan("nightly", { schedule: { cron: "0 0 3 * * *" } }),
    );

    await reconcilePlan(context, ref);

    const ready = findCondition(storedPlan(client).status?.conditions, "Ready");
    expect(ready).toMatchObject({ status: "False", reason: "InvalidSpec" });
    expect(ready?.message).toContain("5 parts");
  });

  it("refuses to take over a CronJob it does not own", async () => {
    const { context, client, events } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    client.setObject<CronJob>(RESOURCES.cronJobs, {
      metadata: { name: "nightly", namespace: NAMESPACE },
      spec: { schedule: "1 1 * * *", jobTemplate: { spec: { template: {} } } },
    });

    await reconcilePlan(context, ref);

    expect(findCondition(storedPlan(client).status?.conditions, "Ready")).toMatchObject({
      status: "False",
      reason: "NameConflict",
    });
    expect(client.object<CronJob>(RESOURCES.cronJobs, NAMESPACE, "nightly")?.spec?.schedule).toBe(
      "1 1 * * *",
    );
    expect(events.reasons()).toContain("NameConflict");
  });

  it("records each run of its CronJob as a MongoShieldBackup, once", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    await reconcilePlan(context, ref);
    cronJobStartsRun(client, "nightly-29330000");

    await reconcilePlan(context, ref);

    const backup = client.object<Backup>(RESOURCES.backups, NAMESPACE, "nightly-29330000");
    expect(backup?.spec.planRef.name).toBe("nightly");
    expect(backup?.metadata.annotations?.[ANNOTATIONS.scheduledJob]).toBe("nightly-29330000");
    expect(backup?.metadata.labels?.[LABELS.trigger]).toBe("schedule");
    const job = client.object<Job>(RESOURCES.jobs, NAMESPACE, "nightly-29330000");
    expect(job?.metadata.annotations?.[RECORDED_ANNOTATION]).toBe("true");
    expect(storedPlan(client).status?.activeBackups).toBe(1);

    // Deleting the record (history pruning) never brings it back.
    await client.delete(RESOURCES.backups, NAMESPACE, "nightly-29330000");
    await reconcilePlan(context, ref);
    expect(client.object(RESOURCES.backups, NAMESPACE, "nightly-29330000")).toBeUndefined();
  });

  it("tolerates a run record that already exists (a stale cache)", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    await reconcilePlan(context, ref);
    cronJobStartsRun(client, "nightly-1");
    client.failNext(
      "create",
      new KubeApiError(409, "AlreadyExists", "exists"),
      "mongoshieldbackups",
    );

    await expect(reconcilePlan(context, ref)).resolves.toBeDefined();
  });

  it("ignores Jobs that its CronJob did not start", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    await reconcilePlan(context, ref);
    client.setObject<Job>(RESOURCES.jobs, {
      metadata: { name: "manual-1", namespace: NAMESPACE, labels: { [LABELS.plan]: "nightly" } },
    });

    await reconcilePlan(context, ref);

    expect(client.objects(RESOURCES.backups)).toHaveLength(0);
  });

  it("summarises the newest finished and successful runs in its status", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    await reconcilePlan(context, ref);
    const finished = (
      name: string,
      phase: "Succeeded" | "Failed",
      time: string,
      id?: string,
    ): void => {
      client.setObject<Backup>(RESOURCES.backups, {
        ...makeBackup(name),
        status: {
          phase,
          completionTime: time,
          ...(id ? { backupId: id, bytesStored: 2048 } : {}),
          ...(phase === "Failed"
            ? { error: { code: "MS_CONNECTION_FAILED", message: "no route" } }
            : {}),
        },
      });
    };
    finished("a", "Succeeded", "2026-10-22T03:16:00Z", "id-a");
    finished("b", "Succeeded", "2026-10-23T03:16:00Z", "id-b");
    finished("c", "Failed", "2026-10-24T03:16:00Z");

    await reconcilePlan(context, ref);

    const status = storedPlan(client).status;
    expect(status?.lastBackup).toMatchObject({ name: "c", phase: "Failed" });
    expect(status?.lastSuccessfulBackup).toEqual({
      name: "b",
      phase: "Succeeded",
      backupId: "id-b",
      completionTime: "2026-10-23T03:16:00Z",
      bytesStored: 2048,
    });
    expect(findCondition(status?.conditions, "LastBackupSucceeded")).toMatchObject({
      status: "False",
      reason: "BackupFailed",
    });
    expect(findCondition(status?.conditions, "LastBackupSucceeded")?.message).toContain(
      "MS_CONNECTION_FAILED",
    );
  });

  it("reports a skipped or successful newest run as LastBackupSucceeded=True", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    client.setObject<Backup>(RESOURCES.backups, {
      ...makeBackup("s"),
      status: { phase: "Skipped", completionTime: "2026-10-24T03:16:00Z" },
    });

    await reconcilePlan(context, ref);

    expect(
      findCondition(storedPlan(client).status?.conditions, "LastBackupSucceeded"),
    ).toMatchObject({
      status: "True",
      reason: "BackupSkipped",
    });
  });

  it("keeps only spec.history finished scheduled runs", async () => {
    const { context, client } = testContext();
    await apply(
      client,
      RESOURCES.plans,
      makePlan("nightly", { history: { successfulLimit: 2, failedLimit: 1 } }),
    );
    for (let day = 1; day <= 4; day += 1) {
      client.setObject<Backup>(RESOURCES.backups, {
        ...makeBackup(`ok-${day}`),
        metadata: {
          name: `ok-${day}`,
          namespace: NAMESPACE,
          labels: { [LABELS.trigger]: "schedule" },
        },
        status: { phase: "Succeeded", completionTime: `2026-10-0${day}T03:00:00Z` },
      });
      client.setObject<Backup>(RESOURCES.backups, {
        ...makeBackup(`bad-${day}`),
        metadata: {
          name: `bad-${day}`,
          namespace: NAMESPACE,
          labels: { [LABELS.trigger]: "schedule" },
        },
        status: { phase: "Failed", completionTime: `2026-10-0${day}T04:00:00Z` },
      });
    }
    // Manual runs are never pruned by the plan.
    client.setObject<Backup>(RESOURCES.backups, {
      ...makeBackup("manual-old"),
      status: { phase: "Succeeded", completionTime: "2026-09-01T00:00:00Z" },
    });

    await reconcilePlan(context, ref);

    const names = client
      .objects<Backup>(RESOURCES.backups)
      .map((backup) => backup.metadata.name)
      .sort();
    expect(names).toEqual(["bad-4", "manual-old", "ok-3", "ok-4"]);
  });

  it("on deletion, removes the CronJob in the foreground before releasing the plan", async () => {
    const { context, client, events } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    await reconcilePlan(context, ref);
    // Something else (the API server's foreground GC) keeps the CronJob around for a bit.
    const cronJob = client.object<CronJob>(RESOURCES.cronJobs, NAMESPACE, "nightly");
    if (!cronJob) throw new Error("no CronJob");
    client.setObject<CronJob>(RESOURCES.cronJobs, {
      ...cronJob,
      metadata: { ...cronJob.metadata, finalizers: ["foregroundDeletion"] },
    });
    await client.delete(RESOURCES.plans, NAMESPACE, "nightly");

    const first = await reconcilePlan(context, ref);
    expect(first?.requeueAfterMs).toBeGreaterThan(0);
    expect(
      client.object<CronJob>(RESOURCES.cronJobs, NAMESPACE, "nightly")?.metadata.deletionTimestamp,
    ).toBeDefined();
    expect(events.reasons()).toContain("Deleting");

    // Still deleting: wait, don't delete again.
    const deletesBefore = client.calls.filter((call) => call.verb === "delete").length;
    await reconcilePlan(context, ref);
    expect(client.calls.filter((call) => call.verb === "delete").length).toBe(deletesBefore);

    // The CronJob is gone: the finalizer is released and the plan disappears.
    const deleting = client.object<CronJob>(RESOURCES.cronJobs, NAMESPACE, "nightly");
    if (!deleting) throw new Error("CronJob vanished early");
    await client.replace(RESOURCES.cronJobs, NAMESPACE, {
      ...deleting,
      metadata: { ...deleting.metadata, finalizers: [] },
    });
    expect(await reconcilePlan(context, ref)).toBeUndefined();
    expect(client.object(RESOURCES.plans, NAMESPACE, "nightly")).toBeUndefined();
  });

  it("does nothing for a plan that is gone, or deleting without its finalizer", async () => {
    const { context, client } = testContext();
    expect(await reconcilePlan(context, ref)).toBeUndefined();
    client.setObject<BackupPlan>(RESOURCES.plans, {
      ...makePlan(),
      metadata: {
        name: "nightly",
        namespace: NAMESPACE,
        deletionTimestamp: NOW.toISOString(),
        finalizers: ["other"],
      },
    });
    expect(await reconcilePlan(context, ref)).toBeUndefined();
  });

  it("finishes deletion at once when the plan never had a CronJob", async () => {
    const { context, client } = testContext();
    const { schedule: _schedule, ...spec } = makePlan().spec;
    await apply(client, RESOURCES.plans, { ...makePlan(), spec });
    await reconcilePlan(context, ref);
    await client.delete(RESOURCES.plans, NAMESPACE, "nightly");

    expect(await reconcilePlan(context, ref)).toBeUndefined();
    expect(client.object(RESOURCES.plans, NAMESPACE, "nightly")).toBeUndefined();
  });

  it("surfaces API errors to the controller (which retries with backoff)", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.plans, makePlan());
    client.failNext("create", new KubeApiError(500, "InternalError", "etcd timeout"), "cronjobs");

    await expect(reconcilePlan(context, ref)).rejects.toThrow("etcd timeout");
  });
});

describe("schedule helpers", () => {
  it("accepts 5-field expressions and macros, rejects others", () => {
    expect(validateSchedule(makePlan("p", { schedule: { cron: "*/5 * * * *" } }))).toBeUndefined();
    expect(validateSchedule(makePlan("p", { schedule: { cron: "@daily" } }))).toBeUndefined();
    expect(validateSchedule(makePlan("p", { schedule: { cron: "every day" } }))).toContain(
      "Invalid cron",
    );
    expect(
      validateSchedule(
        makePlan("p", { schedule: { cron: "* * * * *", timeZone: "Mars/Olympus" } }),
      ),
    ).toContain("Unknown time zone");
  });

  it("computes the next run in the plan's time zone", () => {
    const plan = makePlan("p", { schedule: { cron: "0 3 * * *", timeZone: "Asia/Tokyo" } });
    // Tokyo is UTC+9 (no daylight saving): 03:00 on the 25th there is 18:00 UTC on the 24th.
    expect(nextScheduleTime(plan, NOW)?.toISOString()).toBe("2026-10-24T18:00:00.000Z");
    expect(
      nextScheduleTime(makePlan("p", { schedule: { cron: "0 3 * * *", suspend: true } }), NOW),
    ).toBeUndefined();
  });
});
