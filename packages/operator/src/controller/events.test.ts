/** Tests for the Kubernetes event recorder. */

import { describe, expect, it } from "vitest";
import { FakeKubeClient } from "../../test/helpers/fake-client.ts";
import { KubeApiError, RESOURCES } from "../kube/client.ts";
import type { KubeEvent, KubeObject } from "../kube/objects.ts";
import { silentLogger } from "../logger.ts";
import { ApiEventRecorder } from "./events.ts";

const subject: KubeObject = {
  apiVersion: "mongoshield.io/v1alpha1",
  kind: "MongoShieldBackup",
  metadata: { name: "nightly-1", namespace: "prod", uid: "uid-9", resourceVersion: "7" },
};

describe("ApiEventRecorder", () => {
  it("creates a core/v1 Event about the object", async () => {
    const client = new FakeKubeClient();
    const recorder = new ApiEventRecorder(
      client,
      silentLogger,
      "op-1",
      () => new Date("2026-10-24T12:00:00Z"),
    );

    await recorder.record(subject, "Normal", "Started", "Created Job nightly-1");

    const [event] = client.objects<KubeEvent>(RESOURCES.events, "prod");
    expect(event).toMatchObject({
      involvedObject: {
        kind: "MongoShieldBackup",
        name: "nightly-1",
        namespace: "prod",
        uid: "uid-9",
        resourceVersion: "7",
      },
      reason: "Started",
      message: "Created Job nightly-1",
      type: "Normal",
      source: { component: "mongoshield-operator" },
      reportingInstance: "op-1",
      count: 1,
    });
    expect(event?.metadata.name).toMatch(/^nightly-1\./);
  });

  it("folds repeats into one event with a count, within ten minutes", async () => {
    const client = new FakeKubeClient();
    let now = Date.parse("2026-10-24T12:00:00Z");
    const recorder = new ApiEventRecorder(client, silentLogger, "op-1", () => new Date(now));

    await recorder.record(subject, "Warning", "PodStuck", "secret missing");
    now += 60_000;
    await recorder.record(subject, "Warning", "PodStuck", "secret missing");
    expect(client.objects<KubeEvent>(RESOURCES.events)).toHaveLength(1);
    expect(client.objects<KubeEvent>(RESOURCES.events)[0]).toMatchObject({
      count: 2,
      lastTimestamp: "2026-10-24T12:01:00.000Z",
    });

    now += 11 * 60_000;
    await recorder.record(subject, "Warning", "PodStuck", "secret missing");
    expect(client.objects<KubeEvent>(RESOURCES.events)).toHaveLength(2);
  });

  it("never throws: a failed write is only logged", async () => {
    const client = new FakeKubeClient();
    client.failNext("create", new KubeApiError(403, "Forbidden", "events is forbidden"));
    const recorder = new ApiEventRecorder(client, silentLogger, "op-1");
    await expect(recorder.record(subject, "Normal", "X", "y")).resolves.toBeUndefined();
    // The failed one is not remembered for aggregation: the next one is created anew.
    await recorder.record(subject, "Normal", "X", "y");
    expect(client.objects(RESOURCES.events)).toHaveLength(1);
  });
});
