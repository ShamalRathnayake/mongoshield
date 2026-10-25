/**
 * The whole operator against the in-memory API server: informers, controllers and
 * leader election working together, from a new plan to a restored backup.
 */

import { afterEach, describe, expect, it } from "vitest";
import { FakeKubeClient } from "../test/helpers/fake-client.ts";
import {
  apply,
  cliLog,
  finishJob,
  makeBackup,
  makeDrill,
  makePlan,
  makeRestore,
  NAMESPACE,
  successReport,
} from "../test/helpers/fixtures.ts";
import type { Backup, BackupPlan, Drill, Restore } from "./api/types.ts";
import { isConditionTrue } from "./controller/conditions.ts";
import { KubeApiError, RESOURCES } from "./kube/client.ts";
import type { CronJob, Job, Lease } from "./kube/objects.ts";
import { silentLogger } from "./logger.ts";
import { Operator } from "./operator.ts";
import type { OperatorSettings } from "./settings.ts";

const settings: OperatorSettings = {
  watchNamespaces: undefined,
  operatorNamespace: "mongoshield-system",
  identity: "op-1",
  image: "ghcr.io/shamalrathnayake/mongoshield:2.0.0",
  imagePullPolicy: undefined,
  leaderElection: false,
  leaseName: "mongoshield-operator",
  httpPort: 0,
  workers: 2,
  resyncMs: 60_000,
  logLevel: "info",
};

const running: Operator[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((operator) => operator.stop()));
});

function startOperator(client: FakeKubeClient, overrides: Partial<OperatorSettings> = {}) {
  const operator = new Operator({
    client,
    settings: { ...settings, ...overrides },
    logger: silentLogger,
    informerBackoff: { initialMs: 1, maxMs: 5 },
    leaderTiming: { leaseDurationMs: 1000, renewDeadlineMs: 500, retryPeriodMs: 10 },
  });
  running.push(operator);
  return operator;
}

async function until(condition: () => boolean, what = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 1000 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!condition()) throw new Error(`${what} never became true`);
}

const plan = (client: FakeKubeClient) =>
  client.object<BackupPlan>(RESOURCES.plans, NAMESPACE, "nightly");
const backup = (client: FakeKubeClient, name: string) =>
  client.object<Backup>(RESOURCES.backups, NAMESPACE, name);

describe("Operator", () => {
  it("takes a plan from creation to a scheduled backup, a manual backup and a restore", async () => {
    const client = new FakeKubeClient();
    const operator = startOperator(client);
    await operator.start();
    expect(operator.isLeading()).toBe(true);

    // 1. A plan becomes Ready with its CronJob.
    await apply(client, RESOURCES.plans, makePlan());
    await until(() => isConditionTrue(plan(client)?.status?.conditions, "Ready"), "plan Ready");
    const cronJob = client.object<CronJob>(RESOURCES.cronJobs, NAMESPACE, "nightly");
    expect(cronJob).toBeDefined();
    await until(() => operator.isReady(), "operator ready");

    // 2. The CronJob starts a run: the operator records it and reads its result.
    client.setObject<Job>(RESOURCES.jobs, {
      metadata: {
        name: "nightly-29330000",
        namespace: NAMESPACE,
        labels: cronJob?.spec?.jobTemplate.metadata?.labels ?? {},
        ownerReferences: [
          {
            apiVersion: "batch/v1",
            kind: "CronJob",
            name: "nightly",
            uid: cronJob?.metadata.uid ?? "",
            controller: true,
          },
        ],
      },
      status: { active: 1 },
    });
    await until(
      () => backup(client, "nightly-29330000")?.status?.phase === "Running",
      "scheduled run recorded",
    );
    finishJob(client, NAMESPACE, "nightly-29330000", {
      succeeded: true,
      log: cliLog(successReport("sched-1")),
    });
    await until(
      () => backup(client, "nightly-29330000")?.status?.phase === "Succeeded",
      "scheduled run succeeded",
    );
    await until(
      () => plan(client)?.status?.lastSuccessfulBackup?.backupId === "sched-1",
      "plan summary",
    );

    // 3. A manual backup, then a restore of exactly that backup.
    await apply(client, RESOURCES.backups, makeBackup("manual-1"));
    await apply(
      client,
      RESOURCES.restores,
      makeRestore("restore-1", { backup: { name: "manual-1" } }),
    );
    await until(
      () => client.object(RESOURCES.jobs, NAMESPACE, "manual-1") !== undefined,
      "manual Job",
    );
    finishJob(client, NAMESPACE, "manual-1", {
      succeeded: true,
      log: cliLog(successReport("manual-id")),
    });
    await until(
      () => client.object(RESOURCES.jobs, NAMESPACE, "restore-1-restore") !== undefined,
      "restore Job",
    );
    const restoreJob = client.object<Job>(RESOURCES.jobs, NAMESPACE, "restore-1-restore");
    expect(restoreJob?.spec?.template.spec?.containers[0]?.args?.[1]).toBe("manual-id");
    finishJob(client, NAMESPACE, "restore-1-restore", {
      succeeded: true,
      log: cliLog({
        plan: { backupId: "manual-id", entries: [{}] },
        dryRun: false,
        documentsRestored: 9,
        durationMs: 10,
      }),
    });
    await until(
      () =>
        client.object<Restore>(RESOURCES.restores, NAMESPACE, "restore-1")?.status?.phase ===
        "Succeeded",
      "restore succeeded",
    );

    // 4. Metrics reflect all of it.
    const metrics = operator.metrics.render();
    expect(metrics).toContain(
      'mongoshield_backups{namespace="prod",phase="Succeeded",plan="nightly"} 2',
    );
    expect(metrics).toContain('mongoshield_restores{namespace="prod",phase="Succeeded"} 1');
    expect(metrics).toContain(
      'mongoshield_backup_last_size_bytes{namespace="prod",plan="nightly"} 2097152',
    );
    expect(metrics).toContain("mongoshield_backup_last_success_timestamp_seconds");
    expect(metrics).toContain("mongoshield_operator_leader 1");
    expect(metrics).toMatch(
      /mongoshield_operator_reconcile_total\{controller="plan",result="(success|requeue)"\} \d+/,
    );

    // 5. Deleting the CronJob by hand: the plan puts it back.
    await client.delete(RESOURCES.cronJobs, NAMESPACE, "nightly");
    await until(
      () => client.object(RESOURCES.cronJobs, NAMESPACE, "nightly") !== undefined,
      "CronJob restored",
    );

    // 6. Deleting the plan cleans up through its finalizer and owner references.
    await client.delete(RESOURCES.plans, NAMESPACE, "nightly");
    await until(() => plan(client) === undefined, "plan deleted");
    expect(client.object(RESOURCES.cronJobs, NAMESPACE, "nightly")).toBeUndefined();
    expect(
      client.object(RESOURCES.configMaps, NAMESPACE, "nightly-mongoshield-config"),
    ).toBeUndefined();
  });

  it("runs a drill and deletes a Delete-policy backup's data, with drill metrics", async () => {
    const client = new FakeKubeClient();
    const operator = startOperator(client);
    await operator.start();
    await apply(client, RESOURCES.plans, makePlan());
    await until(() => isConditionTrue(plan(client)?.status?.conditions, "Ready"), "plan Ready");

    // A manual backup with deletionPolicy Delete, and a drill of it.
    await apply(
      client,
      RESOURCES.backups,
      makeBackup("manual-1", "nightly", { deletionPolicy: "Delete" }),
    );
    await apply(client, RESOURCES.drills, makeDrill("drill-1", { backup: { name: "manual-1" } }));
    await until(
      () => client.object(RESOURCES.jobs, NAMESPACE, "manual-1") !== undefined,
      "backup Job",
    );
    finishJob(client, NAMESPACE, "manual-1", {
      succeeded: true,
      log: cliLog(successReport("data-1")),
    });
    await until(
      () => client.object(RESOURCES.jobs, NAMESPACE, "drill-1-drill") !== undefined,
      "drill Job",
    );
    finishJob(client, NAMESPACE, "drill-1-drill", {
      succeeded: true,
      log: cliLog({
        backupId: "data-1",
        ok: true,
        durationMs: 3000,
        restoreDurationMs: 1500,
        documentsRestored: 10,
        namespaces: [{}],
        problems: [],
      }),
    });
    await until(
      () =>
        client.object<Drill>(RESOURCES.drills, NAMESPACE, "drill-1")?.status?.phase === "Succeeded",
      "drill passed",
    );
    const metrics = operator.metrics.render();
    expect(metrics).toContain(
      'mongoshield_drills{namespace="prod",phase="Succeeded",plan="nightly"} 1',
    );
    expect(metrics).toContain(
      'mongoshield_drill_last_rto_seconds{namespace="prod",plan="nightly"} 1.5',
    );

    // Deleting the backup deletes its data first.
    await until(
      () => backup(client, "manual-1")?.metadata.finalizers?.length === 1,
      "data finalizer",
    );
    await client.delete(RESOURCES.backups, NAMESPACE, "manual-1");
    await until(
      () => client.object(RESOURCES.jobs, NAMESPACE, "manual-1-delete") !== undefined,
      "delete Job",
    );
    finishJob(client, NAMESPACE, "manual-1-delete", {
      succeeded: true,
      log: cliLog({
        id: "data-1",
        status: "complete",
        deletedObjects: 3,
        deletedBytes: 30,
        deletedAt: "t",
      }),
    });
    await until(() => backup(client, "manual-1") === undefined, "backup object gone");
  });

  it("starts runs that were waiting as soon as their plan becomes Ready", async () => {
    const client = new FakeKubeClient();
    await apply(client, RESOURCES.backups, makeBackup("early"));
    const operator = startOperator(client, { resyncMs: 3_600_000 });
    await operator.start();
    await until(() => backup(client, "early")?.status?.phase === "Pending", "pending");

    await apply(client, RESOURCES.plans, makePlan());
    await until(
      () => client.object(RESOURCES.jobs, NAMESPACE, "early") !== undefined,
      "Job created",
    );
  });

  it("with leader election, only the leader reconciles, and a standby takes over", async () => {
    const client = new FakeKubeClient();
    const first = startOperator(client, { leaderElection: true, identity: "op-1" });
    await first.start();
    await until(() => first.isLeading(), "first leads");
    const second = startOperator(client, { leaderElection: true, identity: "op-2" });
    await second.start();
    expect(second.isReady()).toBe(true);

    await apply(client, RESOURCES.plans, makePlan());
    await until(() => isConditionTrue(plan(client)?.status?.conditions, "Ready"), "plan Ready");
    expect(second.isLeading()).toBe(false);

    // The leader shuts down and releases the Lease: the standby takes over.
    await first.stop();
    expect(first.isReady()).toBe(false);
    const lease = client.object<Lease>(
      RESOURCES.leases,
      "mongoshield-system",
      "mongoshield-operator",
    );
    expect(lease?.spec?.holderIdentity).not.toBe("op-1");
    await until(() => second.isLeading(), "second leads");
    await apply(client, RESOURCES.backups, makeBackup("after-failover"));
    await until(
      () => client.object(RESOURCES.jobs, NAMESPACE, "after-failover") !== undefined,
      "standby reconciles",
    );
  }, 20_000);

  it("reports lost leadership as fatal", async () => {
    const client = new FakeKubeClient();
    let fatal = "";
    const operator = new Operator({
      client,
      settings: { ...settings, leaderElection: true },
      logger: silentLogger,
      leaderTiming: { leaseDurationMs: 300, renewDeadlineMs: 100, retryPeriodMs: 10 },
      onFatal: (reason) => {
        fatal = reason;
      },
    });
    running.push(operator);
    await operator.start();
    await until(() => operator.isLeading(), "leading");

    // The API server stops answering lease requests for longer than the renew deadline.
    const lease = client.object<Lease>(
      RESOURCES.leases,
      "mongoshield-system",
      "mongoshield-operator",
    );
    if (!lease) throw new Error("no lease");
    for (let index = 0; index < 100; index += 1) {
      client.failNext("get", new KubeApiError(503, "ServiceUnavailable", "down"), "leases");
    }
    await until(() => fatal !== "", "fatal reported");
    expect(fatal).toBe("lost leadership");
    expect(operator.isLeading()).toBe(false);
  }, 20_000);

  it("is not ready while stopping, and stops idempotently", async () => {
    const client = new FakeKubeClient();
    const operator = startOperator(client);
    await operator.start();
    await operator.stop();
    await operator.stop();
    expect(operator.isReady()).toBe(false);
  });
});
