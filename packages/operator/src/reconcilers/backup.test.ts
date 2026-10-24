/** Tests for the MongoShieldBackup reconciler: manual and scheduled runs, results, deletion. */

import { describe, expect, it } from "vitest";
import type { FakeKubeClient } from "../../test/helpers/fake-client.ts";
import {
  apply,
  cliLog,
  finishJob,
  makeBackup,
  makePlan,
  NAMESPACE,
  stickPod,
  successReport,
  testContext,
} from "../../test/helpers/fixtures.ts";
import { ANNOTATIONS, FINALIZERS } from "../api/constants.ts";
import type { Backup } from "../api/types.ts";
import { findCondition } from "../controller/conditions.ts";
import { KubeApiError, RESOURCES } from "../kube/client.ts";
import type { Job } from "../kube/objects.ts";
import { reconcileBackup } from "./backup.ts";
import { reconcilePlan } from "./plan.ts";

const ref = { namespace: NAMESPACE, name: "manual-1" };

/** A context with a reconciled (Ready) plan named "nightly". */
async function withReadyPlan(overrides: Parameters<typeof makePlan>[1] = {}) {
  const setup = testContext();
  await apply(setup.client, RESOURCES.plans, makePlan("nightly", overrides));
  await reconcilePlan(setup.context, { namespace: NAMESPACE, name: "nightly" });
  return setup;
}

function storedBackup(client: FakeKubeClient, name = "manual-1"): Backup {
  const backup = client.object<Backup>(RESOURCES.backups, NAMESPACE, name);
  if (!backup) throw new Error(`backup ${name} missing`);
  return backup;
}

describe("reconcileBackup: manual runs", () => {
  it("creates its Job once the plan is ready, holding a finalizer while it runs", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());

    const result = await reconcileBackup(context, ref);

    const job = client.object<Job>(RESOURCES.jobs, NAMESPACE, "manual-1");
    expect(job?.metadata.ownerReferences?.[0]).toMatchObject({
      kind: "MongoShieldBackup",
      name: "manual-1",
    });
    const container = job?.spec?.template.spec?.containers[0];
    expect(container?.args).toEqual([
      "run",
      "--json",
      "--config",
      "/etc/mongoshield/config/mongoshield.config.json",
      "--verify",
      "fast",
      "--no-prune",
    ]);
    const backup = storedBackup(client);
    expect(backup.metadata.finalizers).toEqual([FINALIZERS.backup]);
    expect(backup.status).toMatchObject({
      phase: "Running",
      jobName: "manual-1",
      startTime: "2026-10-24T12:00:00.000Z",
    });
    expect(findCondition(backup.status?.conditions, "Complete")).toMatchObject({
      status: "False",
      reason: "Running",
    });
    expect(events.reasons()).toContain("Started");
    expect(result?.requeueAfterMs).toBe(30_000);
  });

  it("passes its verify override and prune choice to the run", async () => {
    const { context, client } = await withReadyPlan({ verify: "none" });
    await apply(
      client,
      RESOURCES.backups,
      makeBackup("manual-1", "nightly", { verify: "deep", prune: true }),
    );

    await reconcileBackup(context, ref);

    const args = client.object<Job>(RESOURCES.jobs, NAMESPACE, "manual-1")?.spec?.template.spec
      ?.containers[0]?.args;
    expect(args).toContain("deep");
    expect(args).not.toContain("--no-prune");
  });

  it("waits (Pending) while its plan does not exist or is not Ready", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.backups, makeBackup());

    const missing = await reconcileBackup(context, ref);
    expect(storedBackup(client).status?.phase).toBe("Pending");
    expect(findCondition(storedBackup(client).status?.conditions, "Complete")?.reason).toBe(
      "PlanNotFound",
    );
    expect(missing?.requeueAfterMs).toBe(15_000);

    // The plan exists but was never reconciled: not Ready yet.
    await apply(client, RESOURCES.plans, makePlan());
    await reconcileBackup(context, ref);
    expect(findCondition(storedBackup(client).status?.conditions, "Complete")?.reason).toBe(
      "PlanNotReady",
    );
    expect(client.objects(RESOURCES.jobs)).toHaveLength(0);
  });

  it("waits while its plan is being deleted", async () => {
    const { context, client } = await withReadyPlan();
    await client.delete(RESOURCES.plans, NAMESPACE, "nightly");
    await apply(client, RESOURCES.backups, makeBackup());

    await reconcileBackup(context, ref);

    expect(findCondition(storedBackup(client).status?.conditions, "Complete")?.reason).toBe(
      "PlanDeleting",
    );
  });

  it("records a successful run report: id, sizes, verification, prune", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    finishJob(client, NAMESPACE, "manual-1", { succeeded: true, log: cliLog(successReport()) });

    expect(await reconcileBackup(context, ref)).toBeUndefined();

    const backup = storedBackup(client);
    expect(backup.status).toMatchObject({
      phase: "Succeeded",
      backupId: "2026-10-24T11-59-02Z_ab12cd",
      runId: "run-1",
      storage: "s3://acme-backups/prod",
      namespaces: 12,
      documents: 34_567,
      bytesRaw: 10_485_760,
      bytesStored: 2_097_152,
      durationMs: 31_000,
      verification: { mode: "fast", ok: true, problemCount: 0 },
      prune: { deletedBackups: 1, kept: 3 },
      jobName: "manual-1",
      startTime: "2026-10-24T11:59:00Z",
      completionTime: "2026-10-24T11:59:42Z",
    });
    expect(findCondition(backup.status?.conditions, "Complete")).toMatchObject({
      status: "True",
      reason: "BackupSucceeded",
    });
    expect(findCondition(backup.status?.conditions, "Failed")?.status).toBe("False");
    expect(findCondition(backup.status?.conditions, "Verified")?.status).toBe("True");
    // Finished: the finalizer is released, so deleting it later is instant.
    expect(backup.metadata.finalizers).toEqual([]);
    expect(events.reasons()).toContain("BackupSucceeded");
    expect(context.metrics.runsFinished.value({ kind: "backup", phase: "Succeeded" })).toBe(1);
  });

  it("records whether a run took an incremental or a full backup, and why", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    const base = successReport("incr-2");
    const report = {
      ...base,
      backup: { ...(base.backup as object), kind: "incremental", parent: "full-1", changes: 321 },
    };
    finishJob(client, NAMESPACE, "manual-1", { succeeded: true, log: cliLog(report) });

    await reconcileBackup(context, ref);

    expect(storedBackup(client).status).toMatchObject({
      kind: "incremental",
      parentBackupId: "full-1",
      changes: 321,
    });

    const second = await withReadyPlan();
    await apply(second.client, RESOURCES.backups, makeBackup());
    await reconcileBackup(second.context, ref);
    const full = {
      ...base,
      backup: {
        ...(base.backup as object),
        kind: "full",
        fullBackupReason: "the chain is 7 days old",
      },
    };
    finishJob(second.client, NAMESPACE, "manual-1", { succeeded: true, log: cliLog(full) });
    await reconcileBackup(second.context, ref);
    expect(storedBackup(second.client).status).toMatchObject({
      kind: "full",
      fullBackupReason: "the chain is 7 days old",
    });
  });

  it("records a failed run report with MongoShield's error code, step and hint", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    const report = {
      ...successReport(),
      status: "failure",
      backup: undefined,
      verify: undefined,
      prune: undefined,
      error: {
        step: "backup",
        code: "MS_CONNECT_FAILED",
        message: "connection refused",
        hint: "Check the URI",
      },
    };
    finishJob(client, NAMESPACE, "manual-1", {
      succeeded: false,
      exitCode: 20,
      log: cliLog(report),
    });

    await reconcileBackup(context, ref);

    const backup = storedBackup(client);
    expect(backup.status?.phase).toBe("Failed");
    expect(backup.status?.error).toEqual({
      code: "MS_CONNECT_FAILED",
      message: "connection refused",
      hint: "Check the URI",
      step: "backup",
      exitCode: 20,
    });
    expect(findCondition(backup.status?.conditions, "Failed")).toMatchObject({
      status: "True",
      reason: "BackupFailed",
    });
    expect(events.events.find((event) => event.reason === "BackupFailed")?.type).toBe("Warning");
  });

  it("flags a backup whose verification found problems", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    const problems = Array.from({ length: 7 }, (_, index) => ({
      subject: `app.c${index}`,
      problem: "sha256 mismatch",
    }));
    const report = {
      ...successReport(),
      verify: { mode: "fast", ok: false, problems, attempts: 1 },
    };
    finishJob(client, NAMESPACE, "manual-1", { succeeded: true, log: cliLog(report) });

    await reconcileBackup(context, ref);

    const status = storedBackup(client).status;
    expect(status?.verification?.problemCount).toBe(7);
    expect(status?.verification?.problems).toHaveLength(5);
    expect(findCondition(status?.conditions, "Verified")).toMatchObject({
      status: "False",
      reason: "VerifyFailed",
    });
    expect(findCondition(status?.conditions, "Complete")?.reason).toBe("VerificationFailed");
  });

  it("records a skipped run (the lock was held) as Skipped, not as a failure", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    const report = {
      ...successReport(),
      status: "skipped",
      backup: undefined,
      verify: undefined,
      prune: undefined,
      lock: {
        kind: "storage",
        heldBy: { owner: "x", host: "other-pod", expiresAt: "2026-10-24T12:05:00Z" },
      },
    };
    finishJob(client, NAMESPACE, "manual-1", { succeeded: true, log: cliLog(report) });

    await reconcileBackup(context, ref);

    const status = storedBackup(client).status;
    expect(status?.phase).toBe("Skipped");
    expect(findCondition(status?.conditions, "Complete")).toMatchObject({
      status: "True",
      reason: "LockHeld",
    });
    expect(findCondition(status?.conditions, "Complete")?.message).toContain("other-pod");
  });

  it("records a checkpointed run with its progress", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    const base = successReport();
    const report = {
      ...base,
      status: "checkpointed",
      verify: undefined,
      backup: { ...(base.backup as object), status: "checkpointed", parts: { done: 3, total: 9 } },
    };
    finishJob(client, NAMESPACE, "manual-1", { succeeded: true, log: cliLog(report) });

    await reconcileBackup(context, ref);

    const status = storedBackup(client).status;
    expect(status?.phase).toBe("Checkpointed");
    expect(findCondition(status?.conditions, "Complete")?.message).toContain("3/9 parts");
  });

  it("records a setup error printed as { error } before any report", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    const log = cliLog({
      error: { code: "MS_CONFIG_INVALID", message: "bad config", docsUrl: "x", exitCode: 2 },
    });
    finishJob(client, NAMESPACE, "manual-1", { succeeded: false, exitCode: 2, log });

    await reconcileBackup(context, ref);

    expect(storedBackup(client).status?.error).toEqual({
      code: "MS_CONFIG_INVALID",
      message: "bad config",
      exitCode: 2,
    });
  });

  it("falls back to the Job's failure reason and termination message without a report", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    finishJob(client, NAMESPACE, "manual-1", {
      succeeded: false,
      exitCode: 137,
      reason: "DeadlineExceeded",
      terminationMessage: "OOMKilled",
    });

    await reconcileBackup(context, ref);

    const status = storedBackup(client).status;
    expect(status?.phase).toBe("Failed");
    expect(status?.error).toMatchObject({ code: "JOB_FAILED", exitCode: 137 });
    expect(status?.error?.message).toBe("DeadlineExceeded: OOMKilled");
    expect(findCondition(status?.conditions, "Failed")?.reason).toBe("JobFailed");
  });

  it("marks a succeeded Job whose log is gone as Succeeded with ResultUnavailable", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    finishJob(client, NAMESPACE, "manual-1", { succeeded: true });

    await reconcileBackup(context, ref);

    const status = storedBackup(client).status;
    expect(status?.phase).toBe("Succeeded");
    expect(findCondition(status?.conditions, "Complete")?.reason).toBe("ResultUnavailable");
    expect(status?.backupId).toBeUndefined();
  });

  it("reports a pod that cannot start (missing Secret) while the Job runs", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    stickPod(
      client,
      NAMESPACE,
      "manual-1",
      "CreateContainerConfigError",
      'secret "prod-mongodb" not found',
    );

    const result = await reconcileBackup(context, ref);

    const complete = findCondition(storedBackup(client).status?.conditions, "Complete");
    expect(complete).toMatchObject({ status: "False", reason: "PodStuck" });
    expect(complete?.message).toContain('secret "prod-mongodb" not found');
    expect(events.reasons()).toContain("PodStuck");
    expect(result?.requeueAfterMs).toBe(30_000);

    // The warning event is not repeated on every re-check.
    await reconcileBackup(context, ref);
    expect(events.reasons().filter((reason) => reason === "PodStuck")).toHaveLength(1);
  });

  it("never changes a finished backup again", async () => {
    const { context, client } = await withReadyPlan();
    client.setObject<Backup>(RESOURCES.backups, {
      ...makeBackup(),
      metadata: { name: "manual-1", namespace: NAMESPACE, finalizers: [FINALIZERS.backup] },
      status: { phase: "Succeeded", backupId: "x" },
    });

    expect(await reconcileBackup(context, ref)).toBeUndefined();

    expect(client.objects(RESOURCES.jobs)).toHaveLength(0);
    expect(storedBackup(client).metadata.finalizers).toEqual([]);
  });

  it("refuses to adopt a Job with its name that it does not own", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    client.setObject<Job>(RESOURCES.jobs, { metadata: { name: "manual-1", namespace: NAMESPACE } });

    await reconcileBackup(context, ref);

    expect(storedBackup(client).status).toMatchObject({
      phase: "Failed",
      error: { code: "NAME_CONFLICT" },
    });
  });

  it("carries on when its Job already exists from an attempt whose status write failed", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    client.failNext("patch", new KubeApiError(500, "InternalError", "etcd"), "mongoshieldbackups");
    // First attempt: the finalizer patch fails before anything else happens.
    await expect(reconcileBackup(context, ref)).rejects.toThrow("etcd");
    expect(client.objects(RESOURCES.jobs)).toHaveLength(0);

    // A Job create that races with an earlier one is not an error.
    client.failNext("create", new KubeApiError(409, "AlreadyExists", "exists"), "jobs");
    await expect(reconcileBackup(context, ref)).resolves.toEqual({ requeueAfterMs: 30_000 });
  });

  it("stops a running Job when deleted, and lets go once the Job is gone", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    // Keep the Job around after the delete call, as foreground deletion does.
    const job = client.object<Job>(RESOURCES.jobs, NAMESPACE, "manual-1");
    if (!job) throw new Error("no Job");
    client.setObject<Job>(RESOURCES.jobs, {
      ...job,
      metadata: { ...job.metadata, finalizers: ["foregroundDeletion"] },
    });
    await client.delete(RESOURCES.backups, NAMESPACE, "manual-1");

    const first = await reconcileBackup(context, ref);
    expect(first?.requeueAfterMs).toBe(2000);
    expect(client.calls.some((call) => call.verb === "delete" && call.plural === "jobs")).toBe(
      true,
    );
    expect(events.reasons()).toContain("Cancelled");

    const deleting = client.object<Job>(RESOURCES.jobs, NAMESPACE, "manual-1");
    if (!deleting) throw new Error("Job vanished early");
    await client.replace(RESOURCES.jobs, NAMESPACE, {
      ...deleting,
      metadata: { ...deleting.metadata, finalizers: [] },
    });
    expect(await reconcileBackup(context, ref)).toBeUndefined();
    expect(client.object(RESOURCES.backups, NAMESPACE, "manual-1")).toBeUndefined();
  });

  it("is deleted at once when its Job already finished", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup());
    await reconcileBackup(context, ref);
    finishJob(client, NAMESPACE, "manual-1", { succeeded: true, log: cliLog(successReport()) });
    // Deleted before the result was recorded: no need to wait for anything.
    await client.delete(RESOURCES.backups, NAMESPACE, "manual-1");

    expect(await reconcileBackup(context, ref)).toBeUndefined();
    expect(client.object(RESOURCES.backups, NAMESPACE, "manual-1")).toBeUndefined();
  });

  it("does nothing for a backup that no longer exists", async () => {
    const { context } = testContext();
    expect(await reconcileBackup(context, ref)).toBeUndefined();
  });
});

describe("reconcileBackup: scheduled runs", () => {
  /** A run record as the plan reconciler creates it, plus the CronJob's Job. */
  async function scheduledRun(client: FakeKubeClient, withJob = true): Promise<void> {
    if (withJob) {
      client.setObject<Job>(RESOURCES.jobs, {
        metadata: {
          name: "nightly-29330000",
          namespace: NAMESPACE,
          ownerReferences: [
            {
              apiVersion: "batch/v1",
              kind: "CronJob",
              name: "nightly",
              uid: "cron-uid",
              controller: true,
            },
          ],
        },
        status: { active: 1 },
      });
    }
    await apply(client, RESOURCES.backups, {
      ...makeBackup("nightly-29330000"),
      metadata: {
        name: "nightly-29330000",
        namespace: NAMESPACE,
        annotations: { [ANNOTATIONS.scheduledJob]: "nightly-29330000" },
      },
    });
  }
  const scheduledRef = { namespace: NAMESPACE, name: "nightly-29330000" };

  it("adopts the CronJob's Job instead of creating one, and records its result", async () => {
    const { context, client } = await withReadyPlan();
    await scheduledRun(client);

    await reconcileBackup(context, scheduledRef);
    expect(client.objects(RESOURCES.jobs)).toHaveLength(1);
    expect(storedBackup(client, "nightly-29330000").status?.phase).toBe("Running");

    finishJob(client, NAMESPACE, "nightly-29330000", {
      succeeded: true,
      log: cliLog(successReport("id-1")),
    });
    await reconcileBackup(context, scheduledRef);
    expect(storedBackup(client, "nightly-29330000").status?.backupId).toBe("id-1");
  });

  it("fails with JobNotFound when the CronJob's Job is already gone", async () => {
    const { context, client } = await withReadyPlan();
    await scheduledRun(client, false);

    await reconcileBackup(context, scheduledRef);

    const status = storedBackup(client, "nightly-29330000").status;
    expect(status?.phase).toBe("Failed");
    expect(findCondition(status?.conditions, "Failed")?.reason).toBe("JobNotFound");
  });

  it("cancels the CronJob's running Job when its record is deleted", async () => {
    const { context, client } = await withReadyPlan();
    await scheduledRun(client);
    await reconcileBackup(context, scheduledRef);
    await client.delete(RESOURCES.backups, NAMESPACE, "nightly-29330000");

    await reconcileBackup(context, scheduledRef);

    expect(client.object(RESOURCES.jobs, NAMESPACE, "nightly-29330000")).toBeUndefined();
  });
});
