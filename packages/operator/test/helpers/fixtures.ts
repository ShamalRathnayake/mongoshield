/**
 * Test fixtures: example custom resources, a reconciler context over the fake API
 * server, and helpers that play the parts of the Job controller and the kubelet
 * (finishing a Job, writing its pod's log).
 */

import { API_GROUP_VERSION, KINDS } from "../../src/api/constants.ts";
import type {
  Backup,
  BackupPlan,
  BackupPlanSpec,
  Drill,
  DrillSpec,
  Restore,
  RestoreSpec,
} from "../../src/api/types.ts";
import type { EventRecorder, EventType } from "../../src/controller/events.ts";
import { RESOURCES, type ResourceType } from "../../src/kube/client.ts";
import type { CronJob, Job, KubeObject, Pod } from "../../src/kube/objects.ts";
import { silentLogger } from "../../src/logger.ts";
import { OperatorMetrics } from "../../src/operator-metrics.ts";
import type { Cache, ReconcilerContext } from "../../src/reconcilers/context.ts";
import { FakeKubeClient } from "./fake-client.ts";

/** The namespace every fixture lives in. */
export const NAMESPACE = "prod";

/** A fixed clock: 2026-10-24 12:00:00 UTC. */
export const NOW = new Date("2026-10-24T12:00:00.000Z");

/** A plan spec with the fields most tests need. */
export function planSpec(overrides: Partial<BackupPlanSpec> = {}): BackupPlanSpec {
  return {
    source: { uriSecretRef: { name: "prod-mongodb" } },
    storage: {
      url: "s3://acme-backups/prod?region=eu-west-1",
      credentialsSecretRef: { name: "s3-credentials" },
    },
    schedule: { cron: "15 3 * * *", timeZone: "Etc/UTC" },
    retention: { last: 3, daily: 7 },
    ...overrides,
  };
}

/** A MongoShieldBackupPlan object (not yet stored). */
export function makePlan(name = "nightly", overrides: Partial<BackupPlanSpec> = {}): BackupPlan {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: KINDS.plan,
    metadata: { name, namespace: NAMESPACE },
    spec: planSpec(overrides),
  };
}

/** A manual MongoShieldBackup object (not yet stored). */
export function makeBackup(
  name = "manual-1",
  planName = "nightly",
  spec: Partial<Backup["spec"]> = {},
): Backup {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: KINDS.backup,
    metadata: { name, namespace: NAMESPACE },
    spec: { planRef: { name: planName }, ...spec },
  };
}

/** A MongoShieldRestore object (not yet stored). */
export function makeRestore(name = "restore-1", spec: Partial<RestoreSpec> = {}): Restore {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: KINDS.restore,
    metadata: { name, namespace: NAMESPACE },
    spec: {
      planRef: { name: "nightly" },
      target: { uriSecretRef: { name: "staging-mongodb" } },
      ...spec,
    },
  };
}

/** A MongoShieldDrill object (not yet stored). */
export function makeDrill(name = "drill-1", spec: Partial<DrillSpec> = {}): Drill {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: KINDS.drill,
    metadata: { name, namespace: NAMESPACE },
    spec: {
      planRef: { name: "nightly" },
      target: { uriSecretRef: { name: "scratch-mongodb" } },
      ...spec,
    },
  };
}

/** One recorded event. */
export interface RecordedEvent {
  readonly name: string;
  readonly kind: string;
  readonly type: EventType;
  readonly reason: string;
  readonly message: string;
}

/** An event recorder that keeps events in an array. */
export class MemoryEventRecorder implements EventRecorder {
  readonly events: RecordedEvent[] = [];

  async record(
    object: KubeObject,
    type: EventType,
    reason: string,
    message: string,
  ): Promise<void> {
    this.events.push({
      name: object.metadata.name ?? "",
      kind: object.kind ?? "",
      type,
      reason,
      message,
    });
  }

  /** The reasons recorded, in order. */
  reasons(): string[] {
    return this.events.map((event) => event.reason);
  }
}

/** A cache that reads straight from the fake API server (never stale). */
export function liveCache<T extends KubeObject>(
  client: FakeKubeClient,
  type: ResourceType,
): Cache<T> {
  return {
    get: (namespace, name) => client.object<T>(type, namespace, name),
    list: (namespace) => client.objects<T>(type, namespace),
  };
}

/** A reconciler context over a fake API server, with a fixed clock. */
export function testContext(client = new FakeKubeClient()): {
  context: ReconcilerContext;
  client: FakeKubeClient;
  events: MemoryEventRecorder;
} {
  client.now = () => NOW;
  const events = new MemoryEventRecorder();
  const backups = liveCache<Backup>(client, RESOURCES.backups);
  const restores = liveCache<Restore>(client, RESOURCES.restores);
  const drills = liveCache<Drill>(client, RESOURCES.drills);
  const context: ReconcilerContext = {
    client,
    plans: liveCache<BackupPlan>(client, RESOURCES.plans),
    backups,
    restores,
    drills,
    jobs: liveCache<Job>(client, RESOURCES.jobs),
    cronJobs: liveCache<CronJob>(client, RESOURCES.cronJobs),
    events,
    metrics: new OperatorMetrics({
      backups: () => backups.list(),
      restores: () => restores.list(),
      drills: () => drills.list(),
      queueDepths: () => [],
      isLeader: () => true,
    }),
    logger: silentLogger,
    defaults: { image: "ghcr.io/shamalrathnayake/mongoshield:2.0.0" },
    now: () => NOW,
  };
  return { context, client, events };
}

/** How a simulated Job ends. */
export interface JobEnding {
  readonly succeeded: boolean;
  /** The pod's log (MongoShield's output). Omit to simulate a pod whose log is gone. */
  readonly log?: string;
  readonly exitCode?: number;
  readonly terminationMessage?: string;
  /** Job condition reason for failures (BackoffLimitExceeded, DeadlineExceeded, …). */
  readonly reason?: string;
}

/**
 * Plays the Job controller and kubelet: gives the Job a terminated pod (with a log)
 * and sets the Job's final condition.
 */
export function finishJob(
  client: FakeKubeClient,
  namespace: string,
  name: string,
  ending: JobEnding,
): Job {
  const job = client.object<Job>(RESOURCES.jobs, namespace, name);
  if (!job) throw new Error(`no Job ${name}`);
  const podName = `${name}-abcde`;
  client.setObject<Pod>(RESOURCES.pods, {
    metadata: {
      name: podName,
      namespace,
      creationTimestamp: "2026-10-24T11:59:00.000Z",
      labels: { "batch.kubernetes.io/controller-uid": job.metadata.uid ?? "" },
    },
    status: {
      phase: ending.succeeded ? "Succeeded" : "Failed",
      containerStatuses: [
        {
          name: "mongoshield",
          state: {
            terminated: {
              exitCode: ending.exitCode ?? (ending.succeeded ? 0 : 1),
              ...(ending.terminationMessage ? { message: ending.terminationMessage } : {}),
            },
          },
        },
      ],
    },
  });
  if (ending.log !== undefined) client.setPodLogs(namespace, podName, ending.log);
  return client.setObject<Job>(RESOURCES.jobs, {
    ...job,
    status: {
      startTime: "2026-10-24T11:59:00Z",
      ...(ending.succeeded
        ? { completionTime: "2026-10-24T11:59:42Z", succeeded: 1 }
        : { failed: 1 }),
      conditions: [
        ending.succeeded
          ? { type: "Complete", status: "True", lastTransitionTime: "2026-10-24T11:59:42Z" }
          : {
              type: "Failed",
              status: "True",
              reason: ending.reason ?? "BackoffLimitExceeded",
              message: "Job has reached the specified backoff limit",
              lastTransitionTime: "2026-10-24T11:59:42Z",
            },
      ],
    },
  });
}

/** Plays the kubelet for a pod that cannot start (missing Secret, image pull error). */
export function stickPod(
  client: FakeKubeClient,
  namespace: string,
  jobName: string,
  reason: string,
  message: string,
): void {
  const job = client.object<Job>(RESOURCES.jobs, namespace, jobName);
  client.setObject<Pod>(RESOURCES.pods, {
    metadata: {
      name: `${jobName}-stuck`,
      namespace,
      labels: { "batch.kubernetes.io/controller-uid": job?.metadata.uid ?? "" },
    },
    status: {
      phase: "Pending",
      containerStatuses: [{ name: "mongoshield", state: { waiting: { reason, message } } }],
    },
  });
}

/** MongoShield's pretty-printed --json output, with some stderr lines around it. */
export function cliLog(
  document: unknown,
  stderrBefore = ["Connecting to mongodb://***@db:27017 …"],
): string {
  return [...stderrBefore, JSON.stringify(document, null, 2), ""].join("\n");
}

/** A successful run report, as `mongoshield run --json` prints it. */
export function successReport(id = "2026-10-24T11-59-02Z_ab12cd"): Record<string, unknown> {
  return {
    version: 1,
    runId: "run-1",
    status: "success",
    startedAt: "2026-10-24T11:59:00.000Z",
    finishedAt: "2026-10-24T11:59:40.000Z",
    durationMs: 40_000,
    host: "nightly-abcde",
    storage: "s3://acme-backups/prod",
    lock: { kind: "storage" },
    backup: {
      id,
      status: "complete",
      namespaces: 12,
      documents: 34_567,
      bytesRaw: 10_485_760,
      bytesStored: 2_097_152,
      durationMs: 31_000,
      attempts: 1,
    },
    verify: { mode: "fast", ok: true, problems: [], attempts: 1 },
    prune: { deletedBackups: 1, deletedBytes: 1000, kept: 3 },
  };
}

/** Stores an object through the fake API (as `kubectl apply` would). */
export async function apply<T extends KubeObject>(
  client: FakeKubeClient,
  type: ResourceType,
  object: T,
): Promise<T> {
  return client.create(type, object.metadata.namespace ?? NAMESPACE, object);
}
