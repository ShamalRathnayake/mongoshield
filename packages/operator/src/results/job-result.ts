/**
 * Looking at a Job the operator started: is it still running, and if it finished,
 * what did MongoShield report?
 *
 * The result comes from three places, most to least informative:
 *   1. the JSON document MongoShield printed (parse.ts), read from the pod log,
 *   2. the container's exit code (MongoShield's exit codes map to error codes,
 *      see docs/errors.md),
 *   3. the termination message: with `FallbackToLogsOnError`, the kubelet copies the
 *      last log lines there when the container fails, so some text survives even
 *      when the log itself is gone.
 *
 * The operator reads this once, right after the Job finishes, and stores it in the
 * resource's status; after that the Job and its pods may disappear (TTL) without
 * losing anything.
 */

import { JOB_CONTAINER } from "../api/constants.ts";
import { type KubeClient, RESOURCES } from "../kube/client.ts";
import { errorMessage } from "../kube/informer.ts";
import type { Job, Pod } from "../kube/objects.ts";
import { type CommandOutput, parseCommandOutput } from "./parse.ts";

/** Log lines read from the end of a pod log. The JSON document is at the very end. */
const LOG_TAIL_LINES = 5000;

/** Upper bound on log bytes read (a run report with many problems is still far smaller). */
const LOG_LIMIT_BYTES = 4 * 1024 * 1024;

/** Where a Job is. */
export type JobState =
  | { readonly phase: "running"; readonly startTime?: string }
  | {
      readonly phase: "succeeded" | "failed";
      readonly startTime?: string;
      readonly completionTime?: string;
      /** Why the Job failed, from its Failed condition (BackoffLimitExceeded, DeadlineExceeded, …). */
      readonly reason?: string;
      readonly message?: string;
    };

/**
 * The state of a Job from its conditions. Only the final `Complete` and `Failed`
 * conditions count: on Kubernetes 1.31+ `SuccessCriteriaMet`/`FailureTarget` appear
 * earlier, while pods may still be terminating and their logs incomplete.
 */
export function jobState(job: Job): JobState {
  const conditions = job.status?.conditions ?? [];
  const startTime = job.status?.startTime;
  const withStart = startTime ? { startTime } : {};
  const complete = conditions.find(
    (condition) => condition.type === "Complete" && condition.status === "True",
  );
  if (complete) {
    const completionTime = job.status?.completionTime ?? complete.lastTransitionTime;
    return { phase: "succeeded", ...withStart, ...(completionTime ? { completionTime } : {}) };
  }
  const failed = conditions.find(
    (condition) => condition.type === "Failed" && condition.status === "True",
  );
  if (failed) {
    return {
      phase: "failed",
      ...withStart,
      ...(failed.lastTransitionTime ? { completionTime: failed.lastTransitionTime } : {}),
      ...(failed.reason ? { reason: failed.reason } : {}),
      ...(failed.message ? { message: failed.message } : {}),
    };
  }
  return { phase: "running", ...withStart };
}

/** What a finished Job's (last) pod reported. */
export interface JobResult {
  readonly output: CommandOutput;
  readonly podName?: string;
  readonly exitCode?: number;
  /** The container's termination message (the log tail, on failure). */
  readonly terminationMessage?: string;
  /** Set when the log could not be read (pod already gone, …). */
  readonly logError?: string;
}

/** The pods of a Job, newest first. */
export async function podsOfJob(client: KubeClient, job: Job): Promise<Pod[]> {
  const namespace = job.metadata.namespace ?? "";
  // The Job controller labels its pods with the Job's uid (Kubernetes 1.27+), which
  // also tells apart two Jobs that had the same name at different times.
  const selector = `batch.kubernetes.io/controller-uid=${job.metadata.uid ?? ""}`;
  const pods = await client.list<Pod>(RESOURCES.pods, namespace, { labelSelector: selector });
  return pods.items.sort((a, b) =>
    (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""),
  );
}

/** Reads the result of a finished Job from its newest pod. */
export async function readJobResult(client: KubeClient, job: Job): Promise<JobResult> {
  const [pod] = await podsOfJob(client, job);
  if (!pod?.metadata.name) {
    return { output: { kind: "none" }, logError: "the Job has no pods left to read a result from" };
  }
  const terminated = pod.status?.containerStatuses?.find((status) => status.name === JOB_CONTAINER)
    ?.state?.terminated;
  const base = {
    podName: pod.metadata.name,
    ...(terminated ? { exitCode: terminated.exitCode } : {}),
    ...(terminated?.message ? { terminationMessage: terminated.message.trim() } : {}),
  };
  try {
    const log = await client.podLogs(job.metadata.namespace ?? "", pod.metadata.name, {
      container: JOB_CONTAINER,
      tailLines: LOG_TAIL_LINES,
      limitBytes: LOG_LIMIT_BYTES,
    });
    const output = parseCommandOutput(log);
    // The termination message can hold the JSON too (it is the log tail on failure).
    if (output.kind === "none" && terminated?.message) {
      return { ...base, output: parseCommandOutput(terminated.message) };
    }
    return { ...base, output };
  } catch (error) {
    const output = terminated?.message
      ? parseCommandOutput(terminated.message)
      : { kind: "none" as const };
    return { ...base, output, logError: errorMessage(error) };
  }
}

/**
 * Why a running Job's pod is stuck, if it is: a missing Secret
 * (CreateContainerConfigError), an image that cannot be pulled (ImagePullBackOff),
 * an unschedulable pod. Undefined when nothing looks wrong.
 */
export async function stuckReason(client: KubeClient, job: Job): Promise<string | undefined> {
  const [pod] = await podsOfJob(client, job);
  if (!pod) return undefined;
  const waiting = pod.status?.containerStatuses?.find((status) => status.name === JOB_CONTAINER)
    ?.state?.waiting;
  const stuckReasons = [
    "CreateContainerConfigError",
    "ImagePullBackOff",
    "ErrImagePull",
    "InvalidImageName",
    "CreateContainerError",
  ];
  if (waiting?.reason && stuckReasons.includes(waiting.reason)) {
    return `${waiting.reason}: ${waiting.message ?? "the container cannot start"}`;
  }
  const scheduling = pod.status?.conditions?.find((condition) => condition.type === "PodScheduled");
  if (scheduling?.status === "False" && scheduling.reason === "Unschedulable") {
    return `Unschedulable: ${scheduling.message ?? "no node fits the pod"}`;
  }
  return undefined;
}
