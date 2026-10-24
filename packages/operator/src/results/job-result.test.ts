/** Tests for reading Job states and results. */

import { describe, expect, it } from "vitest";
import { FakeKubeClient } from "../../test/helpers/fake-client.ts";
import { cliLog, finishJob, NAMESPACE, successReport } from "../../test/helpers/fixtures.ts";
import { KubeApiError, RESOURCES } from "../kube/client.ts";
import type { Job, Pod } from "../kube/objects.ts";
import { jobState, readJobResult, stuckReason } from "./job-result.ts";

function storedJob(client: FakeKubeClient, name = "j"): Job {
  return client.setObject<Job>(RESOURCES.jobs, { metadata: { name, namespace: NAMESPACE } });
}

describe("jobState", () => {
  it("only trusts the final Complete and Failed conditions", () => {
    expect(jobState({ metadata: {}, status: { startTime: "t0" } })).toEqual({
      phase: "running",
      startTime: "t0",
    });
    expect(
      jobState({
        metadata: {},
        status: { conditions: [{ type: "SuccessCriteriaMet", status: "True" }] },
      }).phase,
    ).toBe("running");
    expect(
      jobState({
        metadata: {},
        status: { conditions: [{ type: "Complete", status: "True", lastTransitionTime: "t1" }] },
      }),
    ).toEqual({ phase: "succeeded", completionTime: "t1" });
    expect(
      jobState({
        metadata: {},
        status: {
          conditions: [
            { type: "Failed", status: "True", reason: "DeadlineExceeded", message: "too slow" },
          ],
        },
      }),
    ).toEqual({ phase: "failed", reason: "DeadlineExceeded", message: "too slow" });
    expect(jobState({ metadata: {} })).toEqual({ phase: "running" });
  });
});

describe("readJobResult", () => {
  it("reads the newest pod's log and exit code", async () => {
    const client = new FakeKubeClient();
    storedJob(client);
    finishJob(client, NAMESPACE, "j", { succeeded: true, log: cliLog(successReport()) });
    const job = client.object<Job>(RESOURCES.jobs, NAMESPACE, "j") as Job;

    const result = await readJobResult(client, job);

    expect(result).toMatchObject({ podName: "j-abcde", exitCode: 0 });
    expect(result.output.kind).toBe("run");
  });

  it("falls back to the termination message when the log has no document or is gone", async () => {
    const client = new FakeKubeClient();
    storedJob(client);
    const message = cliLog({ error: { code: "MS_Z", message: "from termination message" } });
    finishJob(client, NAMESPACE, "j", {
      succeeded: false,
      log: "nothing useful",
      terminationMessage: message,
    });
    const job = client.object<Job>(RESOURCES.jobs, NAMESPACE, "j") as Job;
    expect((await readJobResult(client, job)).output.kind).toBe("error");

    client.failNext("logs", new KubeApiError(404, "NotFound", "pod gone"));
    const gone = await readJobResult(client, job);
    expect(gone.output.kind).toBe("error");
    expect(gone.logError).toBe("pod gone");

    client.failNext("logs", new KubeApiError(500, "InternalError", "kubelet down"));
    const noFallback = await readJobResult(client, storedJobWithoutMessage(client));
    expect(noFallback.output.kind).toBe("none");
  });

  it("says so when the Job has no pods left", async () => {
    const client = new FakeKubeClient();
    const result = await readJobResult(client, storedJob(client));
    expect(result.output).toEqual({ kind: "none" });
    expect(result.logError).toContain("no pods");
  });
});

/** A finished Job whose pod has no termination message. */
function storedJobWithoutMessage(client: FakeKubeClient): Job {
  storedJob(client, "k");
  return finishJob(client, NAMESPACE, "k", { succeeded: false, log: "x" });
}

describe("stuckReason", () => {
  it("reports pods that cannot start or be scheduled", async () => {
    const client = new FakeKubeClient();
    const job = storedJob(client);
    expect(await stuckReason(client, job)).toBeUndefined();

    const pod = (status: NonNullable<Pod["status"]>): void => {
      client.setObject<Pod>(RESOURCES.pods, {
        metadata: {
          name: "p",
          namespace: NAMESPACE,
          labels: { "batch.kubernetes.io/controller-uid": job.metadata.uid ?? "" },
        },
        status,
      });
    };
    pod({
      containerStatuses: [
        { name: "mongoshield", state: { waiting: { reason: "ContainerCreating" } } },
      ],
    });
    expect(await stuckReason(client, job)).toBeUndefined();

    pod({
      containerStatuses: [{ name: "mongoshield", state: { waiting: { reason: "ErrImagePull" } } }],
    });
    expect(await stuckReason(client, job)).toBe("ErrImagePull: the container cannot start");

    pod({
      phase: "Pending",
      conditions: [
        { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes" },
      ],
    });
    expect(await stuckReason(client, job)).toBe("Unschedulable: 0/3 nodes");
    pod({
      phase: "Pending",
      conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }],
    });
    expect(await stuckReason(client, job)).toBe("Unschedulable: no node fits the pod");
  });
});
