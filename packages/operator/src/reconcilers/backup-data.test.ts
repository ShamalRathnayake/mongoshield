/** Tests for `deletionPolicy: Delete`: the data finalizer, the delete Job, refusals. */

import { describe, expect, it } from "vitest";
import type { FakeKubeClient } from "../../test/helpers/fake-client.ts";
import {
  apply,
  cliLog,
  finishJob,
  makeBackup,
  makePlan,
  NAMESPACE,
  testContext,
} from "../../test/helpers/fixtures.ts";
import { FINALIZERS, LABELS } from "../api/constants.ts";
import type { Backup, BackupPlan } from "../api/types.ts";
import { findCondition } from "../controller/conditions.ts";
import { RESOURCES } from "../kube/client.ts";
import type { Job } from "../kube/objects.ts";
import { reconcileBackup } from "./backup.ts";
import { reconcilePlan } from "./plan.ts";

const ref = { namespace: NAMESPACE, name: "manual-1" };
const planRef = { namespace: NAMESPACE, name: "nightly" };

async function withReadyPlan() {
  const setup = testContext();
  await apply(setup.client, RESOURCES.plans, makePlan());
  await reconcilePlan(setup.context, planRef);
  return setup;
}

/** A finished backup with a backup id, as the backup reconciler leaves it. */
function finishedBackup(
  client: FakeKubeClient,
  deletionPolicy: "Retain" | "Delete",
  name = "manual-1",
): Backup {
  return client.setObject<Backup>(RESOURCES.backups, {
    ...makeBackup(name, "nightly", { deletionPolicy }),
    status: { phase: "Succeeded", backupId: "2026-10-24T11-59-02Z_ab12cd" },
  });
}

function stored(client: FakeKubeClient, name = "manual-1"): Backup | undefined {
  return client.object<Backup>(RESOURCES.backups, NAMESPACE, name);
}

const deleteJob = (client: FakeKubeClient) =>
  client.object<Job>(RESOURCES.jobs, NAMESPACE, "manual-1-delete");

describe("deletionPolicy", () => {
  it("puts the data finalizer on finished Delete backups only, following policy changes", async () => {
    const { context, client } = await withReadyPlan();
    finishedBackup(client, "Retain");
    await reconcileBackup(context, ref);
    expect(stored(client)?.metadata.finalizers ?? []).toEqual([]);

    const backup = stored(client) as Backup;
    await client.replace(RESOURCES.backups, NAMESPACE, {
      ...backup,
      spec: { ...backup.spec, deletionPolicy: "Delete" },
    });
    await reconcileBackup(context, ref);
    expect(stored(client)?.metadata.finalizers).toEqual([FINALIZERS.backupData]);

    const withFinalizer = stored(client) as Backup;
    await client.replace(RESOURCES.backups, NAMESPACE, {
      ...withFinalizer,
      spec: { ...withFinalizer.spec, deletionPolicy: "Retain" },
    });
    await reconcileBackup(context, ref);
    expect(stored(client)?.metadata.finalizers).toEqual([]);
  });

  it("adds the data finalizer when a Delete backup finishes", async () => {
    const { context, client } = await withReadyPlan();
    await apply(
      client,
      RESOURCES.backups,
      makeBackup("manual-1", "nightly", { deletionPolicy: "Delete" }),
    );
    await reconcileBackup(context, ref);
    const log = cliLog({
      runId: "r",
      status: "success",
      durationMs: 1,
      backup: {
        id: "id-1",
        namespaces: 1,
        documents: 1,
        bytesRaw: 1,
        bytesStored: 1,
        durationMs: 1,
      },
    });
    finishJob(client, NAMESPACE, "manual-1", { succeeded: true, log });
    await reconcileBackup(context, ref);
    expect(stored(client)?.metadata.finalizers).toEqual([FINALIZERS.backupData]);
  });

  it("deletes the data with `mongoshield delete` before letting the object go", async () => {
    const { context, client, events } = await withReadyPlan();
    finishedBackup(client, "Delete");
    await reconcileBackup(context, ref);
    await client.delete(RESOURCES.backups, NAMESPACE, "manual-1");

    expect(await reconcileBackup(context, ref)).toEqual({ requeueAfterMs: 5000 });
    const job = deleteJob(client);
    expect(job?.spec?.template.spec?.containers[0]?.args).toEqual([
      "delete",
      "2026-10-24T11-59-02Z_ab12cd",
      "--yes",
      "--json",
      "--config",
      "/etc/mongoshield/config/mongoshield.config.json",
      "--by",
      "kubernetes:prod/manual-1",
    ]);
    expect(job?.metadata.ownerReferences?.[0]).toMatchObject({
      kind: "MongoShieldBackup",
      name: "manual-1",
    });
    expect(job?.metadata.labels?.[LABELS.component]).toBe("delete");
    expect(findCondition(stored(client)?.status?.conditions, "DataDeleted")).toMatchObject({
      status: "False",
      reason: "Deleting",
    });
    expect(events.reasons()).toContain("DeletingBackupData");

    // Still running: wait.
    expect(await reconcileBackup(context, ref)).toEqual({ requeueAfterMs: 5000 });

    const result = {
      id: "2026-10-24T11-59-02Z_ab12cd",
      status: "complete",
      deletedObjects: 4,
      deletedBytes: 900,
      deletedAt: "t",
    };
    finishJob(client, NAMESPACE, "manual-1-delete", { succeeded: true, log: cliLog(result) });
    expect(await reconcileBackup(context, ref)).toBeUndefined();
    expect(stored(client)).toBeUndefined();
    expect(events.events.find((event) => event.reason === "BackupDataDeleted")?.message).toContain(
      "4 object(s)",
    );
  });

  it("counts a backup that is already gone as deleted", async () => {
    const { context, client, events } = await withReadyPlan();
    finishedBackup(client, "Delete");
    await reconcileBackup(context, ref);
    await client.delete(RESOURCES.backups, NAMESPACE, "manual-1");
    await reconcileBackup(context, ref);
    const log = cliLog({
      error: { code: "MS_BACKUP_NOT_FOUND", message: "no backup", exitCode: 30 },
    });
    finishJob(client, NAMESPACE, "manual-1-delete", { succeeded: false, exitCode: 30, log });

    await reconcileBackup(context, ref);

    expect(stored(client)).toBeUndefined();
    expect(events.events.find((event) => event.reason === "BackupDataDeleted")?.message).toContain(
      "already gone",
    );
  });

  it("keeps the object when MongoShield refuses, says why, and tries again later", async () => {
    const { context, client, events } = await withReadyPlan();
    finishedBackup(client, "Delete");
    await reconcileBackup(context, ref);
    await client.delete(RESOURCES.backups, NAMESPACE, "manual-1");
    await reconcileBackup(context, ref);
    const log = cliLog({
      error: {
        code: "MS_BACKUP_PROTECTED",
        message: "Backup x cannot be deleted: it is on hold (audit).",
        exitCode: 35,
      },
    });
    finishJob(client, NAMESPACE, "manual-1-delete", { succeeded: false, exitCode: 35, log });

    expect(await reconcileBackup(context, ref)).toEqual({ requeueAfterMs: 300_000 });

    const backup = stored(client);
    expect(backup?.metadata.finalizers).toEqual([FINALIZERS.backupData]);
    const condition = findCondition(backup?.status?.conditions, "DataDeleted");
    expect(condition).toMatchObject({ status: "False", reason: "Refused" });
    expect(condition?.message).toContain("MS_BACKUP_PROTECTED");
    expect(events.events.find((event) => event.reason === "BackupDataDeletionRefused")?.type).toBe(
      "Warning",
    );
    // The failed Job is removed so the next attempt starts fresh.
    expect(deleteJob(client)).toBeUndefined();
    await reconcileBackup(context, ref);
    expect(deleteJob(client)).toBeDefined();

    // Giving up on the data: Retain releases the object at once.
    const current = stored(client) as Backup;
    await client.replace(RESOURCES.backups, NAMESPACE, {
      ...current,
      spec: { ...current.spec, deletionPolicy: "Retain" },
    });
    await reconcileBackup(context, ref);
    expect(stored(client)).toBeUndefined();
  });

  it("treats a failed Job without a result as refused, and a succeeded one as done", async () => {
    const { context, client } = await withReadyPlan();
    finishedBackup(client, "Delete");
    await reconcileBackup(context, ref);
    await client.delete(RESOURCES.backups, NAMESPACE, "manual-1");
    await reconcileBackup(context, ref);
    finishJob(client, NAMESPACE, "manual-1-delete", {
      succeeded: false,
      reason: "DeadlineExceeded",
    });
    await reconcileBackup(context, ref);
    expect(findCondition(stored(client)?.status?.conditions, "DataDeleted")?.message).toContain(
      "JOB_FAILED",
    );

    await reconcileBackup(context, ref);
    finishJob(client, NAMESPACE, "manual-1-delete", { succeeded: true });
    await reconcileBackup(context, ref);
    expect(stored(client)).toBeUndefined();
  });

  it("reports when the plan (and so the storage settings) is gone", async () => {
    const { context, client } = testContext();
    client.setObject<Backup>(RESOURCES.backups, {
      ...makeBackup("manual-1", "nightly", { deletionPolicy: "Delete" }),
      metadata: { name: "manual-1", namespace: NAMESPACE, finalizers: [FINALIZERS.backupData] },
      status: { phase: "Succeeded", backupId: "id-1" },
    });
    await client.delete(RESOURCES.backups, NAMESPACE, "manual-1");

    expect(await reconcileBackup(context, ref)).toEqual({ requeueAfterMs: 300_000 });
    expect(findCondition(stored(client)?.status?.conditions, "DataDeleted")?.reason).toBe(
      "PlanNotFound",
    );
  });

  it("lets the plan go only after its Delete records deleted their data", async () => {
    const { context, client } = await withReadyPlan();
    const plan = client.object<BackupPlan>(RESOURCES.plans, NAMESPACE, "nightly") as BackupPlan;
    // A scheduled record (owned by the plan) with deletionPolicy Delete.
    client.setObject<Backup>(RESOURCES.backups, {
      ...makeBackup("nightly-1", "nightly", { deletionPolicy: "Delete" }),
      metadata: {
        name: "nightly-1",
        namespace: NAMESPACE,
        finalizers: [FINALIZERS.backupData],
        ownerReferences: [
          {
            apiVersion: "mongoshield.io/v1alpha1",
            kind: "MongoShieldBackupPlan",
            name: "nightly",
            uid: plan.metadata.uid ?? "",
          },
        ],
      },
      status: { phase: "Succeeded", backupId: "id-1" },
    });
    await client.delete(RESOURCES.cronJobs, NAMESPACE, "nightly");
    await client.delete(RESOURCES.plans, NAMESPACE, "nightly");

    expect(await reconcilePlan(context, planRef)).toEqual({ requeueAfterMs: 2000 });
    // The record is being deleted (its data first); the plan waits.
    expect(stored(client, "nightly-1")?.metadata.deletionTimestamp).toBeDefined();
    expect(client.object(RESOURCES.plans, NAMESPACE, "nightly")).toBeDefined();

    await reconcileBackup(context, { namespace: NAMESPACE, name: "nightly-1" });
    finishJob(client, NAMESPACE, "nightly-1-delete", {
      succeeded: true,
      log: cliLog({
        id: "id-1",
        status: "complete",
        deletedObjects: 1,
        deletedBytes: 1,
        deletedAt: "t",
      }),
    });
    await reconcileBackup(context, { namespace: NAMESPACE, name: "nightly-1" });
    expect(stored(client, "nightly-1")).toBeUndefined();

    expect(await reconcilePlan(context, planRef)).toBeUndefined();
    expect(client.object(RESOURCES.plans, NAMESPACE, "nightly")).toBeUndefined();
  });
});
