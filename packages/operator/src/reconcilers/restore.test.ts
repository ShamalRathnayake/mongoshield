/** Tests for the MongoShieldRestore reconciler: safety checks, backup resolution, results. */

import { describe, expect, it } from "vitest";
import type { FakeKubeClient } from "../../test/helpers/fake-client.ts";
import {
  apply,
  cliLog,
  finishJob,
  makeBackup,
  makePlan,
  makeRestore,
  NAMESPACE,
  stickPod,
  testContext,
} from "../../test/helpers/fixtures.ts";
import { FINALIZERS } from "../api/constants.ts";
import type { Backup, Restore } from "../api/types.ts";
import { findCondition } from "../controller/conditions.ts";
import { KubeApiError, RESOURCES } from "../kube/client.ts";
import type { Job } from "../kube/objects.ts";
import { reconcilePlan } from "./plan.ts";
import { confirmationProblem, reconcileRestore } from "./restore.ts";

const ref = { namespace: NAMESPACE, name: "restore-1" };

async function withReadyPlan() {
  const setup = testContext();
  await apply(
    setup.client,
    RESOURCES.plans,
    makePlan("nightly", { encryption: { identitySecretRef: { name: "age-key" } } }),
  );
  await reconcilePlan(setup.context, { namespace: NAMESPACE, name: "nightly" });
  return setup;
}

function storedRestore(client: FakeKubeClient): Restore {
  const restore = client.object<Restore>(RESOURCES.restores, NAMESPACE, "restore-1");
  if (!restore) throw new Error("restore missing");
  return restore;
}

function restoreJob(client: FakeKubeClient): Job | undefined {
  return client.object<Job>(RESOURCES.jobs, NAMESPACE, "restore-1-restore");
}

const restoreResult = {
  plan: { backupId: "id-7", mode: "fail-if-exists", entries: [{}, {}, {}] },
  dryRun: false,
  documentsRestored: 1234,
  durationMs: 5600,
};

describe("reconcileRestore", () => {
  it("restores the latest backup into the target, never the plan's source", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(
      client,
      RESOURCES.restores,
      makeRestore("restore-1", { rename: [{ from: "app.*", to: "app_restored.*" }] }),
    );

    const result = await reconcileRestore(context, ref);

    const pod = restoreJob(client)?.spec?.template.spec;
    const container = pod?.containers[0];
    expect(container?.args).toEqual([
      "restore",
      "latest",
      "--json",
      "--config",
      "/etc/mongoshield/config/mongoshield.config.json",
      "--mode",
      "fail-if-exists",
      "--rename",
      "app.*=app_restored.*",
    ]);
    const uri = container?.env?.find((variable) => variable.name === "MONGODB_URI");
    expect(uri?.valueFrom?.secretKeyRef).toEqual({ name: "staging-mongodb", key: "MONGODB_URI" });
    // The plan's decryption key is mounted for encrypted backups.
    expect(
      container?.env?.find((variable) => variable.name === "MONGOSHIELD_IDENTITY_FILE")?.value,
    ).toBe("/etc/mongoshield/identity/identity.txt");
    const restore = storedRestore(client);
    expect(restore.metadata.finalizers).toEqual([FINALIZERS.restore]);
    expect(restore.status).toMatchObject({
      phase: "Running",
      backupId: "latest",
      jobName: "restore-1-restore",
    });
    expect(events.reasons()).toContain("Started");
    expect(result?.requeueAfterMs).toBe(30_000);
  });

  it("passes every option to mongoshield restore", async () => {
    const { context, client } = await withReadyPlan();
    await apply(
      client,
      RESOURCES.restores,
      makeRestore("restore-1", {
        backup: { id: "2026-10-20T03-00-04Z_7f3a9c" },
        include: ["app.users"],
        exclude: ["app.logs"],
        mode: "drop",
        confirm: "staging-mongodb",
        at: "2026-10-20T04:00:00Z",
        skipIndexes: true,
        usersAndRoles: "create",
      }),
    );

    await reconcileRestore(context, ref);

    expect(restoreJob(client)?.spec?.template.spec?.containers[0]?.args).toEqual([
      "restore",
      "2026-10-20T03-00-04Z_7f3a9c",
      "--json",
      "--config",
      "/etc/mongoshield/config/mongoshield.config.json",
      "--mode",
      "drop",
      "--yes",
      "--include",
      "app.users",
      "--exclude",
      "app.logs",
      "--at",
      "2026-10-20T04:00:00Z",
      "--skip-indexes",
      "--users-and-roles",
      "create",
    ]);
  });

  it("refuses an overwriting mode without the confirmation, and never creates a Job", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(
      client,
      RESOURCES.restores,
      makeRestore("restore-1", { mode: "drop", confirm: "prod-mongodb" }),
    );

    expect(await reconcileRestore(context, ref)).toBeUndefined();

    const restore = storedRestore(client);
    expect(restore.status?.phase).toBe("Failed");
    expect(findCondition(restore.status?.conditions, "Failed")).toMatchObject({
      status: "True",
      reason: "ConfirmationRequired",
    });
    expect(restore.status?.error?.message).toContain('"staging-mongodb"');
    expect(restoreJob(client)).toBeUndefined();
    expect(events.events.find((event) => event.reason === "ConfirmationRequired")?.type).toBe(
      "Warning",
    );
  });

  it("allows a dry run of an overwriting mode without confirmation, without --yes", async () => {
    const { context, client } = await withReadyPlan();
    await apply(
      client,
      RESOURCES.restores,
      makeRestore("restore-1", { mode: "upsert", dryRun: true }),
    );

    await reconcileRestore(context, ref);

    const args = restoreJob(client)?.spec?.template.spec?.containers[0]?.args ?? [];
    expect(args).toContain("--dry-run");
    expect(args).not.toContain("--yes");
  });

  it("restores the backup id of a referenced MongoShieldBackup once it succeeded", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup("nightly-1"));
    await apply(
      client,
      RESOURCES.restores,
      makeRestore("restore-1", { backup: { name: "nightly-1" } }),
    );

    const waiting = await reconcileRestore(context, ref);
    expect(waiting?.requeueAfterMs).toBe(15_000);
    expect(findCondition(storedRestore(client).status?.conditions, "Complete")?.reason).toBe(
      "BackupNotReady",
    );

    const backup = client.object<Backup>(RESOURCES.backups, NAMESPACE, "nightly-1");
    if (!backup) throw new Error("no backup");
    client.setObject<Backup>(RESOURCES.backups, {
      ...backup,
      status: { phase: "Succeeded", backupId: "id-42" },
    });
    await reconcileRestore(context, ref);
    expect(restoreJob(client)?.spec?.template.spec?.containers[0]?.args?.[1]).toBe("id-42");
  });

  it("waits for a referenced backup that does not exist yet, fails for an unusable one", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.restores, makeRestore("restore-1", { backup: { name: "nope" } }));
    await reconcileRestore(context, ref);
    expect(findCondition(storedRestore(client).status?.conditions, "Complete")?.reason).toBe(
      "BackupNotFound",
    );

    client.setObject<Backup>(RESOURCES.backups, {
      ...makeBackup("nope"),
      status: { phase: "Failed" },
    });
    await reconcileRestore(context, ref);
    const restore = storedRestore(client);
    expect(restore.status?.phase).toBe("Failed");
    expect(findCondition(restore.status?.conditions, "Failed")?.reason).toBe("BackupUnusable");
  });

  it("waits for its plan", async () => {
    const { context, client } = testContext();
    await apply(client, RESOURCES.restores, makeRestore());

    const result = await reconcileRestore(context, ref);

    expect(storedRestore(client).status?.phase).toBe("Pending");
    expect(findCondition(storedRestore(client).status?.conditions, "Complete")?.reason).toBe(
      "PlanNotFound",
    );
    expect(result?.requeueAfterMs).toBe(15_000);
  });

  it("records MongoShield's restore result", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(client, RESOURCES.restores, makeRestore());
    await reconcileRestore(context, ref);
    finishJob(client, NAMESPACE, "restore-1-restore", {
      succeeded: true,
      log: cliLog(restoreResult),
    });

    expect(await reconcileRestore(context, ref)).toBeUndefined();

    const restore = storedRestore(client);
    expect(restore.status).toMatchObject({
      phase: "Succeeded",
      backupId: "id-7",
      documentsRestored: 1234,
      durationMs: 5600,
      namespaces: 3,
      dryRun: false,
      completionTime: "2026-10-24T11:59:42Z",
    });
    expect(findCondition(restore.status?.conditions, "Complete")).toMatchObject({
      status: "True",
      reason: "RestoreSucceeded",
    });
    expect(restore.metadata.finalizers).toEqual([]);
    expect(events.reasons()).toContain("RestoreSucceeded");
    expect(context.metrics.runsFinished.value({ kind: "restore", phase: "Succeeded" })).toBe(1);
  });

  it("records a dry run's plan", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.restores, makeRestore("restore-1", { dryRun: true }));
    await reconcileRestore(context, ref);
    finishJob(client, NAMESPACE, "restore-1-restore", {
      succeeded: true,
      log: cliLog({ ...restoreResult, dryRun: true, documentsRestored: 0 }),
    });

    await reconcileRestore(context, ref);

    expect(findCondition(storedRestore(client).status?.conditions, "Complete")?.reason).toBe(
      "DryRunSucceeded",
    );
  });

  it("records a failed restore's error", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.restores, makeRestore());
    await reconcileRestore(context, ref);
    const log = cliLog({
      error: {
        code: "MS_RESTORE_CONFLICT",
        message: "app.users has documents",
        hint: "use --rename",
        exitCode: 41,
      },
    });
    finishJob(client, NAMESPACE, "restore-1-restore", { succeeded: false, exitCode: 41, log });

    await reconcileRestore(context, ref);

    const restore = storedRestore(client);
    expect(restore.status?.phase).toBe("Failed");
    expect(restore.status?.error).toEqual({
      code: "MS_RESTORE_CONFLICT",
      message: "app.users has documents",
      hint: "use --rename",
      exitCode: 41,
    });
  });

  it("falls back to the Job's state when there is no result", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.restores, makeRestore());
    await reconcileRestore(context, ref);
    finishJob(client, NAMESPACE, "restore-1-restore", {
      succeeded: false,
      reason: "DeadlineExceeded",
    });

    await reconcileRestore(context, ref);

    expect(storedRestore(client).status?.error?.code).toBe("JOB_FAILED");

    // …and a succeeded Job without a readable log still counts as succeeded.
    const second = await withReadyPlan();
    await apply(second.client, RESOURCES.restores, makeRestore());
    await reconcileRestore(second.context, ref);
    finishJob(second.client, NAMESPACE, "restore-1-restore", { succeeded: true });
    await reconcileRestore(second.context, ref);
    expect(findCondition(storedRestore(second.client).status?.conditions, "Complete")?.reason).toBe(
      "ResultUnavailable",
    );
  });

  it("reports a stuck restore pod", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.restores, makeRestore());
    await reconcileRestore(context, ref);
    stickPod(client, NAMESPACE, "restore-1-restore", "ImagePullBackOff", "not found");

    await reconcileRestore(context, ref);

    expect(findCondition(storedRestore(client).status?.conditions, "Complete")?.reason).toBe(
      "PodStuck",
    );
  });

  it("does not adopt a Job it does not own", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.restores, makeRestore());
    client.setObject<Job>(RESOURCES.jobs, {
      metadata: { name: "restore-1-restore", namespace: NAMESPACE },
    });

    await reconcileRestore(context, ref);

    expect(storedRestore(client).status?.error?.code).toBe("NAME_CONFLICT");
  });

  it("never runs a finished restore again", async () => {
    const { context, client } = await withReadyPlan();
    client.setObject<Restore>(RESOURCES.restores, {
      ...makeRestore(),
      metadata: { name: "restore-1", namespace: NAMESPACE, finalizers: [FINALIZERS.restore] },
      status: { phase: "Succeeded" },
    });

    await reconcileRestore(context, ref);

    expect(restoreJob(client)).toBeUndefined();
    expect(storedRestore(client).metadata.finalizers).toEqual([]);
  });

  it("stops a running restore when deleted", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(client, RESOURCES.restores, makeRestore());
    await reconcileRestore(context, ref);
    await client.delete(RESOURCES.restores, NAMESPACE, "restore-1");

    await reconcileRestore(context, ref);
    expect(restoreJob(client)).toBeUndefined();
    expect(events.reasons()).toContain("Cancelled");

    expect(await reconcileRestore(context, ref)).toBeUndefined();
    expect(client.object(RESOURCES.restores, NAMESPACE, "restore-1")).toBeUndefined();
  });

  it("does nothing for a restore that no longer exists, and surfaces API errors", async () => {
    const { context, client } = await withReadyPlan();
    expect(await reconcileRestore(context, ref)).toBeUndefined();

    await apply(client, RESOURCES.restores, makeRestore());
    client.failNext("create", new KubeApiError(403, "Forbidden", "jobs is forbidden"), "jobs");
    await expect(reconcileRestore(context, ref)).rejects.toThrow("forbidden");

    client.failNext("create", new KubeApiError(409, "AlreadyExists", "exists"), "jobs");
    await expect(reconcileRestore(context, ref)).resolves.toEqual({ requeueAfterMs: 30_000 });
  });
});

describe("confirmationProblem", () => {
  it("only asks for confirmation when data could be overwritten", () => {
    expect(confirmationProblem(makeRestore())).toBeUndefined();
    expect(confirmationProblem(makeRestore("r", { mode: "fail-if-exists" }))).toBeUndefined();
    expect(confirmationProblem(makeRestore("r", { mode: "insert", dryRun: true }))).toBeUndefined();
    expect(
      confirmationProblem(makeRestore("r", { mode: "insert", confirm: "staging-mongodb" })),
    ).toBeUndefined();
    expect(confirmationProblem(makeRestore("r", { mode: "insert" }))).toContain("spec.confirm");
    expect(confirmationProblem(makeRestore("r", { mode: "upsert", confirm: "wrong" }))).toContain(
      "upsert",
    );
  });
});
