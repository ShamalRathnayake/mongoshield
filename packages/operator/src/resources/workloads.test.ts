/** Tests for the desired-state builders: pod template, CronJob, Jobs, names. */

import { describe, expect, it } from "vitest";
import { makeBackup, makeDrill, makePlan, makeRestore } from "../../test/helpers/fixtures.ts";
import { ANNOTATIONS, LABELS } from "../api/constants.ts";
import { hashOf, stableStringify } from "./hash.ts";
import { buildJobSpec, buildPodTemplate } from "./pod.ts";
import {
  backupJobNameOf,
  buildBackupJob,
  buildConfigMap,
  buildCronJob,
  buildDataDeletionJob,
  buildDrillJob,
  buildRestoreJob,
  buildScheduledBackup,
  configHashOf,
  configMapNameOf,
  cronJobNameOf,
  dataDeletionJobNameOf,
  drillArgs,
  drillJobNameOf,
  restoreArgs,
  restoreJobNameOf,
} from "./workloads.ts";

const defaults = { image: "ghcr.io/shamalrathnayake/mongoshield:2.0.0" };

/** A plan with a uid, as stored objects have (owner references need one). */
function storedPlan(overrides: Parameters<typeof makePlan>[1] = {}) {
  const plan = makePlan("nightly", overrides);
  return { ...plan, metadata: { ...plan.metadata, uid: "plan-uid" } };
}

describe("pod template", () => {
  it("runs hardened, non-root, read-only, without the API token", () => {
    const template = buildPodTemplate({
      plan: storedPlan(),
      defaults,
      args: ["run"],
      uriSecret: { name: "prod-mongodb" },
      configMapName: "cm",
      labels: { a: "b" },
      configHash: "h1",
    });
    const pod = template.spec;
    expect(pod?.automountServiceAccountToken).toBe(false);
    expect(pod?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 65532,
      seccompProfile: { type: "RuntimeDefault" },
    });
    const container = pod?.containers[0];
    expect(container?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(container?.terminationMessagePolicy).toBe("FallbackToLogsOnError");
    expect(container?.image).toBe(defaults.image);
    expect(container?.envFrom).toEqual([{ secretRef: { name: "s3-credentials" } }]);
    expect(container?.env).toEqual([
      {
        name: "MONGODB_URI",
        valueFrom: { secretKeyRef: { name: "prod-mongodb", key: "MONGODB_URI" } },
      },
      { name: "NO_COLOR", value: "1" },
    ]);
    expect(pod?.volumes?.map((volume) => volume.name)).toEqual(["config", "tmp"]);
    expect(template.metadata?.annotations?.["mongoshield.io/config-hash"]).toBe("h1");
  });

  it("mounts keys, the volume claim and the user's pod settings", () => {
    const template = buildPodTemplate({
      plan: storedPlan({
        storage: {
          url: "/data/backups",
          persistentVolumeClaim: { claimName: "backups", mountPath: "/data/backups" },
        },
        encryption: {
          passphraseSecretRef: { name: "pass" },
          identitySecretRef: { name: "age", key: "me.txt" },
        },
        job: {
          image: "my/mongoshield:custom",
          imagePullPolicy: "Always",
          imagePullSecrets: [{ name: "regcred" }],
          serviceAccountName: "irsa-backups",
          resources: { limits: { memory: "2Gi" } },
          nodeSelector: { pool: "backup" },
          tolerations: [{ key: "dedicated", operator: "Exists" }],
          affinity: { nodeAffinity: {} },
          podLabels: { team: "data" },
          podAnnotations: { "x/y": "z" },
          env: [{ name: "AWS_REGION", value: "eu-west-1" }],
          envFrom: [{ configMapRef: { name: "extra" } }],
        },
      }),
      defaults: { ...defaults, imagePullPolicy: "IfNotPresent" },
      args: ["run"],
      uriSecret: { name: "prod-mongodb", key: "uri" },
      configMapName: "cm",
      labels: {},
      configHash: "h",
    });
    const pod = template.spec;
    const container = pod?.containers[0];
    expect(container?.image).toBe("my/mongoshield:custom");
    expect(container?.imagePullPolicy).toBe("Always");
    expect(container?.env?.map((variable) => variable.name)).toEqual([
      "MONGODB_URI",
      "NO_COLOR",
      "MONGOSHIELD_PASSPHRASE",
      "MONGOSHIELD_IDENTITY_FILE",
      "AWS_REGION",
    ]);
    expect(container?.env?.[0]?.valueFrom?.secretKeyRef?.key).toBe("uri");
    expect(container?.env?.[3]?.value).toBe("/etc/mongoshield/identity/me.txt");
    expect(container?.envFrom).toEqual([{ configMapRef: { name: "extra" } }]);
    expect(container?.volumeMounts?.map((mount) => mount.mountPath)).toEqual([
      "/etc/mongoshield/config",
      "/tmp",
      "/etc/mongoshield/identity",
      "/data/backups",
    ]);
    expect(pod?.volumes?.find((volume) => volume.name === "identity")?.secret).toEqual({
      secretName: "age",
      items: [{ key: "me.txt", path: "me.txt" }],
      defaultMode: 0o440,
    });
    expect(pod?.serviceAccountName).toBe("irsa-backups");
    expect(pod?.imagePullSecrets).toEqual([{ name: "regcred" }]);
    expect(pod?.nodeSelector).toEqual({ pool: "backup" });
    expect(pod?.tolerations).toHaveLength(1);
    expect(pod?.affinity).toEqual({ nodeAffinity: {} });
    expect(container?.resources).toEqual({ limits: { memory: "2Gi" } });
    expect(template.metadata?.labels).toEqual({ team: "data" });
    expect(template.metadata?.annotations?.["x/y"]).toBe("z");
  });

  it("applies the plan's Job limits, with defaults", () => {
    const template = { spec: { containers: [] } };
    expect(buildJobSpec(storedPlan(), template)).toEqual({
      backoffLimit: 0,
      activeDeadlineSeconds: 21_600,
      ttlSecondsAfterFinished: 86_400,
      template,
    });
    expect(
      buildJobSpec(
        storedPlan({
          job: { backoffLimit: 2, activeDeadlineSeconds: 60, ttlSecondsAfterFinished: 5 },
        }),
        template,
      ),
    ).toMatchObject({ backoffLimit: 2, activeDeadlineSeconds: 60, ttlSecondsAfterFinished: 5 });
  });
});

describe("plan workloads", () => {
  it("builds an owned ConfigMap with a content hash", () => {
    const configMap = buildConfigMap(storedPlan(), { storage: "s3://x" });
    expect(configMap.metadata.name).toBe("nightly-mongoshield-config");
    expect(configMap.metadata.ownerReferences?.[0]).toMatchObject({
      uid: "plan-uid",
      controller: true,
    });
    expect(configMap.data?.["mongoshield.config.json"]).toBe('{\n  "storage": "s3://x"\n}\n');
    expect(configMap.metadata.annotations?.[ANNOTATIONS.specHash]).toBe(
      configHashOf({ storage: "s3://x" }),
    );
  });

  it("builds a CronJob that runs `mongoshield run --json`, never two at once", () => {
    const cronJob = buildCronJob(
      storedPlan({ schedule: { cron: "0 * * * *", suspend: true, startingDeadlineSeconds: 60 } }),
      defaults,
      "h",
    );
    expect(cronJob.spec).toMatchObject({
      schedule: "0 * * * *",
      timeZone: "Etc/UTC",
      concurrencyPolicy: "Forbid",
      startingDeadlineSeconds: 60,
      suspend: true,
    });
    expect(cronJob.spec?.jobTemplate.spec?.template.spec?.containers[0]?.args).toEqual([
      "run",
      "--json",
      "--config",
      "/etc/mongoshield/config/mongoshield.config.json",
    ]);
    expect(cronJob.spec?.jobTemplate.metadata?.labels).toMatchObject({
      [LABELS.plan]: "nightly",
      [LABELS.trigger]: "schedule",
    });
    // The hash changes with the desired spec.
    const other = buildCronJob(storedPlan({ schedule: { cron: "1 * * * *" } }), defaults, "h");
    expect(other.metadata.annotations?.[ANNOTATIONS.specHash]).not.toBe(
      cronJob.metadata.annotations?.[ANNOTATIONS.specHash],
    );
  });

  it("refuses to build a CronJob without a schedule", () => {
    const { schedule: _schedule, ...spec } = storedPlan().spec;
    expect(() => buildCronJob({ ...storedPlan(), spec }, defaults, "h")).toThrow("schedule");
  });

  it("names long objects within Kubernetes limits", () => {
    const long = "p".repeat(80);
    const plan = { ...storedPlan(), metadata: { ...storedPlan().metadata, name: long } };
    expect(cronJobNameOf(plan).length).toBeLessThanOrEqual(52);
    expect(configMapNameOf(plan).length).toBeLessThanOrEqual(63);
    expect(backupJobNameOf(makeBackup(long)).length).toBeLessThanOrEqual(63);
    expect(restoreJobNameOf(makeRestore(long)).length).toBeLessThanOrEqual(63);
    expect(restoreJobNameOf(makeRestore("r"))).toBe("r-restore");
  });

  it("builds a manual backup Job owned by its backup", () => {
    const backup = { ...makeBackup(), metadata: { ...makeBackup().metadata, uid: "backup-uid" } };
    const job = buildBackupJob(backup, storedPlan(), defaults, "h");
    expect(job.metadata.ownerReferences?.[0]).toMatchObject({
      kind: "MongoShieldBackup",
      uid: "backup-uid",
    });
    expect(job.metadata.labels).toMatchObject({
      [LABELS.backup]: "manual-1",
      [LABELS.trigger]: "manual",
    });
  });

  it("builds a restore Job whose MONGODB_URI is the target", () => {
    const restore = {
      ...makeRestore(),
      metadata: { ...makeRestore().metadata, uid: "restore-uid" },
    };
    const job = buildRestoreJob(restore, storedPlan(), "id-1", defaults, "h");
    const env = job.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env[0]?.valueFrom?.secretKeyRef?.name).toBe("staging-mongodb");
    expect(job.metadata.labels).toMatchObject({
      [LABELS.restore]: "restore-1",
      [LABELS.component]: "restore",
    });
    expect(
      restoreArgs(makeRestore("r", { mode: "insert", confirm: "staging-mongodb" }), "id"),
    ).toContain("--yes");
    expect(restoreArgs(makeRestore("r", { mode: "insert", dryRun: true }), "id")).not.toContain(
      "--yes",
    );
  });

  it("builds the run record of a scheduled Job, owned by the plan", () => {
    const record = buildScheduledBackup(storedPlan(), { metadata: { name: "nightly-123" } });
    expect(record.metadata).toMatchObject({
      name: "nightly-123",
      annotations: { [ANNOTATIONS.scheduledJob]: "nightly-123" },
      labels: { [LABELS.trigger]: "schedule" },
    });
    expect(record.metadata.ownerReferences?.[0]?.uid).toBe("plan-uid");
  });
});

describe("hashOf", () => {
  it("ignores key order and undefined values", () => {
    expect(hashOf({ a: 1, b: [1, { c: 2 }] })).toBe(
      hashOf({ b: [1, { c: 2 }], a: 1, d: undefined }),
    );
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
    expect(stableStringify(undefined)).toBe("null");
  });
});

describe("drill and deletion workloads", () => {
  it("passes the plan's drill target to runs that may verify with a drill", () => {
    const plan = storedPlan({
      verify: "drill",
      drill: { targetUriSecretRef: { name: "scratch", key: "uri" } },
    });
    const env =
      buildCronJob(plan, defaults, "h").spec?.jobTemplate.spec?.template.spec?.containers[0]?.env ??
      [];
    expect(
      env.find((variable) => variable.name === "MONGOSHIELD_DRILL_URI")?.valueFrom?.secretKeyRef,
    ).toEqual({
      name: "scratch",
      key: "uri",
    });
    const backup = { ...makeBackup(), metadata: { ...makeBackup().metadata, uid: "b" } };
    const backupEnv =
      buildBackupJob(backup, plan, defaults, "h").spec?.template.spec?.containers[0]?.env ?? [];
    expect(backupEnv.some((variable) => variable.name === "MONGOSHIELD_DRILL_URI")).toBe(true);
    // Restores and deletions too: MongoShield validates the whole config, drill section included.
    const restore = { ...makeRestore(), metadata: { ...makeRestore().metadata, uid: "r" } };
    const restoreEnv = buildRestoreJob(restore, plan, "id", defaults, "h").spec?.template.spec
      ?.containers[0]?.env;
    expect(restoreEnv?.some((variable) => variable.name === "MONGOSHIELD_DRILL_URI")).toBe(true);
    const deletion = buildDataDeletionJob(backup, plan, "id", defaults, "h").spec?.template.spec
      ?.containers[0]?.env;
    expect(deletion?.some((variable) => variable.name === "MONGOSHIELD_DRILL_URI")).toBe(true);
    // Without spec.drill, no drill variable at all.
    const plain = buildCronJob(storedPlan(), defaults, "h").spec?.jobTemplate.spec?.template.spec
      ?.containers[0]?.env;
    expect(plain?.some((variable) => variable.name === "MONGOSHIELD_DRILL_URI")).toBe(false);
  });

  it("builds a drill Job owned by its drill, with only the defaults it needs", () => {
    const drill = { ...makeDrill(), metadata: { ...makeDrill().metadata, uid: "d" } };
    const job = buildDrillJob(drill, storedPlan(), "id-1", defaults, "h");
    expect(job.metadata.name).toBe(drillJobNameOf(drill));
    expect(job.metadata.ownerReferences?.[0]).toMatchObject({ kind: "MongoShieldDrill", uid: "d" });
    expect(job.metadata.labels).toMatchObject({
      [LABELS.drill]: "drill-1",
      [LABELS.component]: "drill",
    });
    expect(drillArgs(makeDrill(), "id")).toEqual([
      "drill",
      "id",
      "--json",
      "--config",
      "/etc/mongoshield/config/mongoshield.config.json",
    ]);
  });

  it("builds the data deletion Job, owned by the backup", () => {
    const backup = { ...makeBackup(), metadata: { ...makeBackup().metadata, uid: "b" } };
    const job = buildDataDeletionJob(backup, storedPlan(), "id-1", defaults, "h");
    expect(job.metadata.name).toBe(dataDeletionJobNameOf(backup));
    expect(job.metadata.name).toBe("manual-1-delete");
    const env = job.spec?.template.spec?.containers[0]?.env ?? [];
    // Deleting needs only storage access: no database connection string.
    expect(env.some((variable) => variable.name === "MONGODB_URI")).toBe(false);
  });
});
