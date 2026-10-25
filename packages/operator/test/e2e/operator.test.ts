/**
 * End-to-end: the operator in a real cluster backs up and restores a real MongoDB.
 *
 * Run through scripts/e2e.ts (`pnpm --filter @mongoshield/operator test:e2e`), which
 * provides the cluster, the images and the installed chart, and sets
 * MONGOSHIELD_E2E_CONTEXT. Without it, the suite is skipped.
 *
 * The test drives the cluster with kubectl, the way a user would:
 *   1. a namespace with a single mongod, 200 seeded documents, a Secret with its URI
 *      and a PersistentVolumeClaim for backups,
 *   2. a MongoShieldBackupPlan that runs every minute,
 *   3. a manual MongoShieldBackup → Complete, with the backup id and counts in status,
 *   4. a MongoShieldRestore of that backup under new names → the data is there,
 *   5. a drop-mode restore without confirmation → refused by the API server (CEL),
 *   6. a scheduled run recorded as a MongoShieldBackup → Complete,
 *   7. the operator's /metrics reports the plan's last success,
 *   8. deleting the plan removes its CronJob.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const context = process.env.MONGOSHIELD_E2E_CONTEXT;
const operatorNamespace = process.env.MONGOSHIELD_E2E_OPERATOR_NAMESPACE ?? "mongoshield-system";
const release = process.env.MONGOSHIELD_E2E_RELEASE ?? "mongoshield-operator";
const mongoImage = process.env.MONGOSHIELD_E2E_MONGO_IMAGE ?? "mongo:8.0";
const namespace = `ms-e2e-${randomBytes(3).toString("hex")}`;

/** Runs kubectl against the e2e cluster; returns stdout. */
function kubectl(args: readonly string[], input?: string): string {
  return execFileSync("kubectl", ["--context", context ?? "", ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** kubectl apply of a JSON object in the test namespace. */
function apply(object: Record<string, unknown>): string {
  return kubectl(["apply", "-n", namespace, "-f", "-"], JSON.stringify(object));
}

/** Reads an object (or a list: `getJson("msbackup", "-l", "a=b")`) as JSON. */
function getJson<T>(...resource: string[]): T {
  return JSON.parse(kubectl(["get", "-n", namespace, ...resource, "-o", "json"])) as T;
}

/** Runs a mongosh script in a mongod pod (the source by default) and returns its output. */
function mongosh(script: string, deployment = "mongo"): string {
  return kubectl([
    "exec",
    "-n",
    namespace,
    `deploy/${deployment}`,
    "--",
    "mongosh",
    "--quiet",
    "--eval",
    script,
  ]).trim();
}

/** A single mongod Deployment and Service with this name. */
function deployMongo(name: string): void {
  apply({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name },
    spec: {
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [
            {
              name: "mongo",
              image: mongoImage,
              imagePullPolicy: "IfNotPresent",
              args: ["--bind_ip_all"],
              ports: [{ containerPort: 27017 }],
              readinessProbe: { tcpSocket: { port: 27017 }, periodSeconds: 2 },
            },
          ],
        },
      },
    },
  });
  apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name },
    spec: { selector: { app: name }, ports: [{ port: 27017 }] },
  });
}

/** Waits for a run-to-completion object to reach a final phase and returns its status. */
async function finished<T extends { phase?: string }>(resource: string, what: string): Promise<T> {
  return eventually(what, 300_000, () => {
    const current = getJson<{ status?: T }>(resource).status;
    return current?.phase === "Succeeded" || current?.phase === "Failed" ? current : undefined;
  });
}

/** Polls `check` until it returns a value (not undefined), or fails after `timeoutMs`. */
async function eventually<T>(
  what: string,
  timeoutMs: number,
  check: () => T | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = check();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `timed out waiting for ${what}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

interface Status {
  phase?: string;
  backupId?: string;
  documents?: number;
  documentsRestored?: number;
  conditions?: { type: string; status: string; reason: string; message: string }[];
  error?: { code: string; message: string };
}

describe.skipIf(!context)("operator e2e", () => {
  beforeAll(async () => {
    kubectl(["create", "namespace", namespace]);
    // Two single mongods (no auth: the namespace is throwaway): the source, and a
    // scratch deployment for restore drills (a drill never restores into its source).
    deployMongo("mongo");
    deployMongo("scratch");
    apply({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "mongo-uri" },
      stringData: { MONGODB_URI: `mongodb://mongo.${namespace}.svc.cluster.local:27017/` },
    });
    apply({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "scratch-uri" },
      stringData: { MONGODB_URI: `mongodb://scratch.${namespace}.svc.cluster.local:27017/` },
    });
    apply({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "backups" },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } },
    });
    kubectl(["rollout", "status", "-n", namespace, "deploy/mongo", "--timeout", "240s"]);
    kubectl(["rollout", "status", "-n", namespace, "deploy/scratch", "--timeout", "240s"]);
    await eventually("mongod to answer", 120_000, () =>
      mongosh("db.runCommand({ ping: 1 }).ok") === "1" ? true : undefined,
    );
    mongosh(
      'db.getSiblingDB("app").users.insertMany(Array.from({ length: 200 }, (_, i) => ({ _id: i, name: "user" + i, tags: ["a", "b"] })))',
    );
  });

  afterAll(() => {
    if (process.env.E2E_KEEP_NAMESPACE === "1") return;
    try {
      kubectl(["delete", "namespace", namespace, "--wait=false"]);
    } catch {
      // Already gone.
    }
  });

  it("makes the plan Ready with a CronJob", async () => {
    apply({
      apiVersion: "mongoshield.io/v1alpha1",
      kind: "MongoShieldBackupPlan",
      metadata: { name: "nightly" },
      spec: {
        source: { uriSecretRef: { name: "mongo-uri" } },
        storage: { url: "/backups", persistentVolumeClaim: { claimName: "backups" } },
        // Every minute, so the test sees a scheduled run without waiting long.
        schedule: { cron: "* * * * *" },
        // Generous: the minutely runs must not prune manual-1, which later tests use.
        retention: { last: 20 },
        history: { successfulLimit: 3 },
        // The test's manual runs overlap the minutely scheduled ones; without a lock
        // none of them is skipped (each writes its own backup id anyway).
        lock: "none",
        drill: { targetUriSecretRef: { name: "scratch-uri" }, sample: 5 },
      },
    });
    kubectl(["wait", "-n", namespace, "--for=condition=Ready", "msplan/nightly", "--timeout=120s"]);
    const plan = getJson<{ status: { cronJobName: string; configMapName: string } }>(
      "msplan/nightly",
    );
    expect(plan.status.cronJobName).toBe("nightly");
    expect(
      kubectl(["get", "-n", namespace, "cronjob/nightly", "-o", "jsonpath={.spec.schedule}"]),
    ).toBe("* * * * *");
  });

  let backupId = "";

  it("runs a manual backup and records the result", async () => {
    apply({
      apiVersion: "mongoshield.io/v1alpha1",
      kind: "MongoShieldBackup",
      metadata: { name: "manual-1" },
      spec: { planRef: { name: "nightly" }, verify: "deep" },
    });
    const status = await eventually("manual backup to finish", 300_000, () => {
      const current = getJson<{ status?: Status }>("msbackup/manual-1").status;
      return current?.phase === "Succeeded" || current?.phase === "Failed" ? current : undefined;
    });
    expect(status.error).toBeUndefined();
    expect(status.phase).toBe("Succeeded");
    expect(status.documents).toBeGreaterThanOrEqual(200);
    expect(status.backupId).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    backupId = status.backupId ?? "";
    // The event history shows the run.
    const events = kubectl([
      "get",
      "events",
      "-n",
      namespace,
      "--field-selector",
      "involvedObject.name=manual-1",
      "-o",
      "jsonpath={.items[*].reason}",
    ]);
    expect(events).toContain("BackupSucceeded");
  });

  it("restores that backup under new names", async () => {
    apply({
      apiVersion: "mongoshield.io/v1alpha1",
      kind: "MongoShieldRestore",
      metadata: { name: "restore-1" },
      spec: {
        planRef: { name: "nightly" },
        backup: { name: "manual-1" },
        target: { uriSecretRef: { name: "mongo-uri" } },
        rename: [{ from: "app.*", to: "app_restored.*" }],
      },
    });
    const status = await eventually("restore to finish", 300_000, () => {
      const current = getJson<{ status?: Status }>("msrestore/restore-1").status;
      return current?.phase === "Succeeded" || current?.phase === "Failed" ? current : undefined;
    });
    expect(status.error).toBeUndefined();
    expect(status.backupId).toBe(backupId);
    expect(status.documentsRestored).toBe(200);
    expect(mongosh('db.getSiblingDB("app_restored").users.countDocuments()')).toBe("200");
    expect(mongosh('db.getSiblingDB("app_restored").users.findOne({ _id: 7 }).name')).toBe("user7");
  });

  it("keeps the retention of two plans with the same source and selection apart", async () => {
    // Same database, same selection, same volume; only the plan differs.
    apply({
      apiVersion: "mongoshield.io/v1alpha1",
      kind: "MongoShieldBackupPlan",
      metadata: { name: "second" },
      spec: {
        source: { uriSecretRef: { name: "mongo-uri" } },
        storage: { url: "/backups", persistentVolumeClaim: { claimName: "backups" } },
        retention: { last: 1 },
        lock: "none",
      },
    });
    kubectl(["wait", "-n", namespace, "--for=condition=Ready", "msplan/second", "--timeout=120s"]);
    for (const name of ["second-1", "second-2"]) {
      apply({
        apiVersion: "mongoshield.io/v1alpha1",
        kind: "MongoShieldBackup",
        metadata: { name },
        spec: { planRef: { name: "second" }, prune: true },
      });
      const status = await finished<Status & { prune?: { deletedBackups: number; kept: number } }>(
        `msbackup/${name}`,
        `${name} to finish`,
      );
      expect(status.phase, JSON.stringify(status.error)).toBe("Succeeded");
      if (name === "second-2") {
        // "last: 1" removed second-1 only: nightly's backups are not in its scope.
        expect(status.prune).toEqual({ deletedBackups: 1, kept: 1 });
      }
    }
  });

  it("verifies a backup with a restore drill (verify: drill)", async () => {
    apply({
      apiVersion: "mongoshield.io/v1alpha1",
      kind: "MongoShieldBackup",
      metadata: { name: "drilled" },
      spec: { planRef: { name: "nightly" }, verify: "drill" },
    });
    const status = await finished<
      Status & { verification?: { mode: string; ok: boolean; rtoMs?: number } }
    >("msbackup/drilled", "the drilled backup");
    expect(status.phase, JSON.stringify(status.error)).toBe("Succeeded");
    expect(status.verification).toMatchObject({ mode: "drill", ok: true });
    expect(status.verification?.rtoMs).toBeGreaterThan(0);
  });

  it("runs a MongoShieldDrill into the scratch deployment and cleans up", async () => {
    apply({
      apiVersion: "mongoshield.io/v1alpha1",
      kind: "MongoShieldDrill",
      metadata: { name: "drill-1" },
      spec: {
        planRef: { name: "nightly" },
        backup: { name: "manual-1" },
        target: { uriSecretRef: { name: "scratch-uri" } },
        sample: 10,
      },
    });
    const status = await finished<
      Status & { ok?: boolean; rtoMs?: number; backupId?: string; documentsRestored?: number }
    >("msdrill/drill-1", "the drill");
    expect(status.phase, JSON.stringify(status.error)).toBe("Succeeded");
    expect(status).toMatchObject({ ok: true, backupId, documentsRestored: 200 });
    expect(status.rtoMs).toBeGreaterThan(0);
    // The temporary databases are gone.
    expect(
      mongosh(
        "db.adminCommand({ listDatabases: 1 }).databases.filter((d) => d.name.startsWith('msdrill_')).length",
        "scratch",
      ),
    ).toBe("0");
    // The drill target never reached the ConfigMap.
    expect(
      kubectl(["get", "-n", namespace, "configmap/nightly-mongoshield-config", "-o", "json"]),
    ).not.toContain("scratch");
  });

  it("deletes a backup's data with deletionPolicy: Delete", async () => {
    apply({
      apiVersion: "mongoshield.io/v1alpha1",
      kind: "MongoShieldBackup",
      metadata: { name: "doomed" },
      spec: { planRef: { name: "nightly" }, deletionPolicy: "Delete" },
    });
    const status = await finished<Status>("msbackup/doomed", "the doomed backup");
    expect(status.phase).toBe("Succeeded");
    const doomedId = status.backupId ?? "";
    await eventually("the data finalizer", 60_000, () =>
      kubectl([
        "get",
        "-n",
        namespace,
        "msbackup/doomed",
        "-o",
        "jsonpath={.metadata.finalizers}",
      ]).includes("delete-backup-data")
        ? true
        : undefined,
    );

    kubectl(["delete", "-n", namespace, "msbackup/doomed", "--timeout=240s"]);

    // The backup is gone from storage: a dry-run restore of its id cannot find it.
    apply({
      apiVersion: "mongoshield.io/v1alpha1",
      kind: "MongoShieldRestore",
      metadata: { name: "ghost" },
      spec: {
        planRef: { name: "nightly" },
        backup: { id: doomedId },
        target: { uriSecretRef: { name: "mongo-uri" } },
        dryRun: true,
      },
    });
    const ghost = await finished<Status>("msrestore/ghost", "the ghost restore");
    expect(ghost.phase).toBe("Failed");
    expect(ghost.error?.code).toBe("MS_BACKUP_NOT_FOUND");
  });

  it("refuses an overwriting restore without confirmation (CEL rule)", () => {
    let message = "";
    try {
      apply({
        apiVersion: "mongoshield.io/v1alpha1",
        kind: "MongoShieldRestore",
        metadata: { name: "dangerous" },
        spec: {
          planRef: { name: "nightly" },
          target: { uriSecretRef: { name: "mongo-uri" } },
          mode: "drop",
        },
      });
    } catch (error) {
      message = String((error as { stderr?: string }).stderr ?? error);
    }
    expect(message).toContain("set confirm to the target Secret's name");
  });

  it("records a scheduled run as a MongoShieldBackup", async () => {
    const name = await eventually("a scheduled run to succeed", 240_000, () => {
      const list = getJson<{ items: { metadata: { name: string }; status?: Status }[] }>(
        "msbackup",
        "-l",
        "mongoshield.io/trigger=schedule",
      );
      return list.items.find((item) => item.status?.phase === "Succeeded")?.metadata.name;
    });
    expect(name).toMatch(/^nightly-\d+$/);
    await eventually("the plan's status to show it", 60_000, () => {
      const plan = getJson<{ status?: { lastSuccessfulBackup?: { name: string } } }>(
        "msplan/nightly",
      );
      return plan.status?.lastSuccessfulBackup ? true : undefined;
    });
  });

  it("exposes per-plan metrics", () => {
    const metrics = kubectl([
      "get",
      "--raw",
      `/api/v1/namespaces/${operatorNamespace}/services/${release}:8080/proxy/metrics`,
    ]);
    expect(metrics).toContain(
      `mongoshield_backup_last_success_timestamp_seconds{namespace="${namespace}",plan="nightly"}`,
    );
    expect(metrics).toContain("mongoshield_operator_leader 1");
  });

  it("removes the CronJob when the plan is deleted", async () => {
    kubectl(["delete", "-n", namespace, "msplan/nightly", "--timeout=120s"]);
    await eventually("the CronJob to go", 60_000, () =>
      kubectl(["get", "-n", namespace, "cronjobs", "-o", "name"]).trim() === "" ? true : undefined,
    );
  });
});
