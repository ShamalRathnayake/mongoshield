/** Tests for the MongoShieldDrill reconciler: the Job, backup choice, results, deletion. */

import { describe, expect, it } from "vitest";
import type { FakeKubeClient } from "../../test/helpers/fake-client.ts";
import {
  apply,
  cliLog,
  finishJob,
  makeBackup,
  makeDrill,
  makePlan,
  NAMESPACE,
  stickPod,
  testContext,
} from "../../test/helpers/fixtures.ts";
import { FINALIZERS } from "../api/constants.ts";
import type { Backup, Drill } from "../api/types.ts";
import { findCondition } from "../controller/conditions.ts";
import { KubeApiError, RESOURCES } from "../kube/client.ts";
import type { Job } from "../kube/objects.ts";
import { reconcileDrill } from "./drill.ts";
import { reconcilePlan } from "./plan.ts";

const ref = { namespace: NAMESPACE, name: "drill-1" };

async function withReadyPlan() {
  const setup = testContext();
  await apply(setup.client, RESOURCES.plans, makePlan());
  await reconcilePlan(setup.context, { namespace: NAMESPACE, name: "nightly" });
  return setup;
}

function storedDrill(client: FakeKubeClient): Drill {
  const drill = client.object<Drill>(RESOURCES.drills, NAMESPACE, "drill-1");
  if (!drill) throw new Error("drill missing");
  return drill;
}

const drillJob = (client: FakeKubeClient) =>
  client.object<Job>(RESOURCES.jobs, NAMESPACE, "drill-1-drill");

/** `mongoshield drill --json` output. */
function drillReport(ok: boolean) {
  return {
    backupId: "id-9",
    ok,
    startedAt: "2026-10-24T11:59:00Z",
    durationMs: 9000,
    restoreDurationMs: 4200,
    restored: true,
    documentsRestored: 120,
    databases: [],
    kept: false,
    namespaces: [{}, {}],
    problems: ok
      ? []
      : Array.from({ length: 6 }, (_, index) => ({
          subject: `app.c${index}`,
          problem: "count differs",
        })),
    warnings: [],
  };
}

describe("reconcileDrill", () => {
  it("runs `mongoshield drill` with the target only as MONGOSHIELD_DRILL_URI, no source URI", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(
      client,
      RESOURCES.drills,
      makeDrill("drill-1", {
        sample: 25,
        prefix: "k8s_",
        include: ["app.*"],
        exclude: ["app.logs"],
      }),
    );

    expect(await reconcileDrill(context, ref)).toEqual({ requeueAfterMs: 30_000 });

    const container = drillJob(client)?.spec?.template.spec?.containers[0];
    expect(container?.args).toEqual([
      "drill",
      "latest",
      "--json",
      "--config",
      "/etc/mongoshield/config/mongoshield.config.json",
      "--sample",
      "25",
      "--prefix",
      "k8s_",
      "--include",
      "app.*",
      "--exclude",
      "app.logs",
    ]);
    const names = container?.env?.map((variable) => variable.name) ?? [];
    expect(names).toContain("MONGOSHIELD_DRILL_URI");
    expect(names).not.toContain("MONGODB_URI");
    expect(
      container?.env?.find((variable) => variable.name === "MONGOSHIELD_DRILL_URI")?.valueFrom
        ?.secretKeyRef,
    ).toEqual({
      name: "scratch-mongodb",
      key: "MONGODB_URI",
    });
    expect(storedDrill(client).status).toMatchObject({ phase: "Running", backupId: "latest" });
    expect(storedDrill(client).metadata.finalizers).toEqual([FINALIZERS.drill]);
    expect(events.reasons()).toContain("Started");
  });

  it("records a passed drill with its RTO", async () => {
    const { context, client, events } = await withReadyPlan();
    await apply(client, RESOURCES.drills, makeDrill());
    await reconcileDrill(context, ref);
    finishJob(client, NAMESPACE, "drill-1-drill", {
      succeeded: true,
      log: cliLog(drillReport(true)),
    });

    expect(await reconcileDrill(context, ref)).toBeUndefined();

    const drill = storedDrill(client);
    expect(drill.status).toMatchObject({
      phase: "Succeeded",
      ok: true,
      backupId: "id-9",
      rtoMs: 4200,
      durationMs: 9000,
      documentsRestored: 120,
      namespaces: 2,
      problemCount: 0,
    });
    expect(findCondition(drill.status?.conditions, "Complete")).toMatchObject({
      status: "True",
      reason: "DrillPassed",
    });
    expect(drill.metadata.finalizers).toEqual([]);
    expect(events.reasons()).toContain("DrillPassed");
    expect(context.metrics.runsFinished.value({ kind: "drill", phase: "Succeeded" })).toBe(1);
  });

  it("fails a drill that found problems, keeping the first few", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.drills, makeDrill());
    await reconcileDrill(context, ref);
    finishJob(client, NAMESPACE, "drill-1-drill", {
      succeeded: false,
      exitCode: 33,
      log: cliLog(drillReport(false)),
    });

    await reconcileDrill(context, ref);

    const status = storedDrill(client).status;
    expect(status).toMatchObject({ phase: "Failed", ok: false, problemCount: 6 });
    expect(status?.problems).toHaveLength(5);
    expect(findCondition(status?.conditions, "Failed")).toMatchObject({
      status: "True",
      reason: "DrillFoundProblems",
    });
  });

  it("records an error document, or the Job's failure without one", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.drills, makeDrill());
    await reconcileDrill(context, ref);
    const log = cliLog({
      error: { code: "MS_CONFIG_INVALID", message: "target is the source", exitCode: 2 },
    });
    finishJob(client, NAMESPACE, "drill-1-drill", { succeeded: false, exitCode: 2, log });
    await reconcileDrill(context, ref);
    expect(storedDrill(client).status?.error).toMatchObject({ code: "MS_CONFIG_INVALID" });
    expect(findCondition(storedDrill(client).status?.conditions, "Failed")?.reason).toBe(
      "DrillFailed",
    );

    const second = await withReadyPlan();
    await apply(second.client, RESOURCES.drills, makeDrill());
    await reconcileDrill(second.context, ref);
    finishJob(second.client, NAMESPACE, "drill-1-drill", {
      succeeded: false,
      reason: "DeadlineExceeded",
    });
    await reconcileDrill(second.context, ref);
    expect(storedDrill(second.client).status?.error?.code).toBe("JOB_FAILED");
  });

  it("drills the backup id of a referenced MongoShieldBackup once it succeeded", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.backups, makeBackup("nightly-1"));
    await apply(client, RESOURCES.drills, makeDrill("drill-1", { backup: { name: "nightly-1" } }));

    expect(await reconcileDrill(context, ref)).toEqual({ requeueAfterMs: 15_000 });
    expect(findCondition(storedDrill(client).status?.conditions, "Complete")?.reason).toBe(
      "BackupNotReady",
    );

    const backup = client.object<Backup>(RESOURCES.backups, NAMESPACE, "nightly-1");
    client.setObject<Backup>(RESOURCES.backups, {
      ...(backup as Backup),
      status: { phase: "Succeeded", backupId: "id-3" },
    });
    await reconcileDrill(context, ref);
    expect(drillJob(client)?.spec?.template.spec?.containers[0]?.args?.[1]).toBe("id-3");
  });

  it("fails for an unusable backup and waits for its plan", async () => {
    const { context, client } = await withReadyPlan();
    client.setObject<Backup>(RESOURCES.backups, {
      ...makeBackup("bad"),
      status: { phase: "Failed" },
    });
    await apply(client, RESOURCES.drills, makeDrill("drill-1", { backup: { name: "bad" } }));
    await reconcileDrill(context, ref);
    expect(findCondition(storedDrill(client).status?.conditions, "Failed")?.reason).toBe(
      "BackupUnusable",
    );

    const empty = testContext();
    await apply(empty.client, RESOURCES.drills, makeDrill());
    expect(await reconcileDrill(empty.context, ref)).toEqual({ requeueAfterMs: 15_000 });
    expect(findCondition(storedDrill(empty.client).status?.conditions, "Complete")?.reason).toBe(
      "PlanNotFound",
    );
  });

  it("reports a stuck pod, refuses a stranger's Job, and never runs twice", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.drills, makeDrill());
    await reconcileDrill(context, ref);
    stickPod(
      client,
      NAMESPACE,
      "drill-1-drill",
      "CreateContainerConfigError",
      'secret "scratch-mongodb" not found',
    );
    await reconcileDrill(context, ref);
    expect(findCondition(storedDrill(client).status?.conditions, "Complete")?.reason).toBe(
      "PodStuck",
    );

    const other = await withReadyPlan();
    await apply(other.client, RESOURCES.drills, makeDrill());
    other.client.setObject<Job>(RESOURCES.jobs, {
      metadata: { name: "drill-1-drill", namespace: NAMESPACE },
    });
    await reconcileDrill(other.context, ref);
    expect(storedDrill(other.client).status?.error?.code).toBe("NAME_CONFLICT");
    // Finished: nothing happens any more.
    expect(await reconcileDrill(other.context, ref)).toBeUndefined();
  });

  it("stops a running drill when deleted, and does nothing for one that is gone", async () => {
    const { context, client, events } = await withReadyPlan();
    expect(await reconcileDrill(context, ref)).toBeUndefined();
    await apply(client, RESOURCES.drills, makeDrill());
    await reconcileDrill(context, ref);
    await client.delete(RESOURCES.drills, NAMESPACE, "drill-1");

    await reconcileDrill(context, ref);
    expect(drillJob(client)).toBeUndefined();
    expect(events.reasons()).toContain("Cancelled");
    await reconcileDrill(context, ref);
    expect(client.object(RESOURCES.drills, NAMESPACE, "drill-1")).toBeUndefined();
  });

  it("tolerates a Job that already exists from an earlier attempt", async () => {
    const { context, client } = await withReadyPlan();
    await apply(client, RESOURCES.drills, makeDrill());
    client.failNext("create", new KubeApiError(409, "AlreadyExists", "exists"), "jobs");
    await expect(reconcileDrill(context, ref)).resolves.toEqual({ requeueAfterMs: 30_000 });
    client.failNext("create", new KubeApiError(500, "InternalError", "boom"), "jobs");
    const again = await withReadyPlan();
    await apply(again.client, RESOURCES.drills, makeDrill());
    again.client.failNext("create", new KubeApiError(500, "InternalError", "boom"), "jobs");
    await expect(reconcileDrill(again.context, ref)).rejects.toThrow("boom");
  });
});
