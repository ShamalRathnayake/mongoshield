/** Tests for Lease-based leader election. */

import { describe, expect, it } from "vitest";
import { FakeKubeClient } from "../../test/helpers/fake-client.ts";
import { KubeApiError, RESOURCES } from "../kube/client.ts";
import type { Lease } from "../kube/objects.ts";
import { silentLogger } from "../logger.ts";
import { LeaderElector, microTime } from "./lease.ts";

/** A controllable clock. */
function clock(start = Date.parse("2026-10-24T12:00:00Z")) {
  let now = start;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

function elector(client: FakeKubeClient, identity: string, time = clock()) {
  return new LeaderElector({
    client,
    namespace: "mongoshield-system",
    name: "mongoshield-operator",
    identity,
    logger: silentLogger,
    leaseDurationMs: 15_000,
    renewDeadlineMs: 10_000,
    retryPeriodMs: 1,
    now: time.now,
  });
}

function lease(client: FakeKubeClient): Lease | undefined {
  return client.object<Lease>(RESOURCES.leases, "mongoshield-system", "mongoshield-operator");
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!condition()) throw new Error("condition never became true");
}

describe("microTime", () => {
  it("formats with microsecond precision", () => {
    expect(microTime(new Date("2026-10-24T12:00:00.123Z"))).toBe("2026-10-24T12:00:00.123000Z");
  });
});

describe("LeaderElector", () => {
  it("creates the Lease and leads, renews it, and releases it on shutdown", async () => {
    const client = new FakeKubeClient();
    const one = elector(client, "pod-1");
    const stop = new AbortController();
    const events: string[] = [];
    const done = one.run(stop.signal, {
      onStartedLeading: () => events.push("started"),
      onStoppedLeading: (reason) => events.push(`stopped:${reason}`),
    });

    await until(() => one.isLeader());
    expect(lease(client)?.spec).toMatchObject({
      holderIdentity: "pod-1",
      leaseDurationSeconds: 15,
      leaseTransitions: 0,
    });
    const version = lease(client)?.metadata.resourceVersion;
    await until(() => lease(client)?.metadata.resourceVersion !== version);

    stop.abort();
    await done;
    expect(events).toEqual(["started", "stopped:released"]);
    expect(one.isLeader()).toBe(false);
    expect(lease(client)?.spec).toMatchObject({ holderIdentity: "", leaseDurationSeconds: 1 });
  });

  it("waits while another replica holds a live Lease, and takes over once it expires", async () => {
    const client = new FakeKubeClient();
    const time = clock();
    await client.create<Lease>(RESOURCES.leases, "mongoshield-system", {
      metadata: { name: "mongoshield-operator", namespace: "mongoshield-system" },
      spec: {
        holderIdentity: "pod-0",
        leaseDurationSeconds: 15,
        renewTime: microTime(time.now()),
        leaseTransitions: 2,
      },
    });
    const two = elector(client, "pod-2", time);
    const stop = new AbortController();
    const done = two.run(stop.signal, { onStartedLeading: () => {}, onStoppedLeading: () => {} });

    // Several attempts within the lease duration: still standing by.
    await until(
      () =>
        client.calls.filter((call) => call.plural === "leases" && call.verb === "get").length >= 3,
    );
    expect(two.isLeader()).toBe(false);

    // pod-0 stopped renewing 16 s ago (by our clock): take over.
    time.advance(16_000);
    await until(() => two.isLeader());
    expect(lease(client)?.spec).toMatchObject({ holderIdentity: "pod-2", leaseTransitions: 3 });
    stop.abort();
    await done;
  });

  it("takes a released Lease at once", async () => {
    const client = new FakeKubeClient();
    await client.create<Lease>(RESOURCES.leases, "mongoshield-system", {
      metadata: { name: "mongoshield-operator", namespace: "mongoshield-system" },
      spec: { holderIdentity: "", leaseDurationSeconds: 1 },
    });
    const one = elector(client, "pod-1");
    const stop = new AbortController();
    const done = one.run(stop.signal, { onStartedLeading: () => {}, onStoppedLeading: () => {} });
    await until(() => one.isLeader());
    stop.abort();
    await done;
  });

  it("loses leadership when it cannot renew within the deadline", async () => {
    const client = new FakeKubeClient();
    const time = clock();
    const one = elector(client, "pod-1", time);
    let lost = false;
    let leadingSignal: AbortSignal | undefined;
    const done = one.run(new AbortController().signal, {
      onStartedLeading: (signal) => {
        leadingSignal = signal;
      },
      onStoppedLeading: (reason) => {
        lost = reason === "lost";
      },
    });
    await until(() => one.isLeader());

    // Every renewal fails from now on (API server unreachable), and time passes.
    for (let index = 0; index < 50; index += 1) {
      client.failNext("get", new KubeApiError(503, "ServiceUnavailable", "down"), "leases");
    }
    time.advance(11_000);
    await done;
    expect(lost).toBe(true);
    expect(one.isLeader()).toBe(false);
    expect(leadingSignal?.aborted).toBe(true);
  });

  it("loses a race to create the Lease without error", async () => {
    const client = new FakeKubeClient();
    client.failNext("create", new KubeApiError(409, "AlreadyExists", "exists"), "leases");
    const one = elector(client, "pod-1");
    const stop = new AbortController();
    const done = one.run(stop.signal, { onStartedLeading: () => {}, onStoppedLeading: () => {} });
    await until(() => one.isLeader());
    stop.abort();
    await done;
  });

  it("returns without leading when stopped before acquiring", async () => {
    const client = new FakeKubeClient();
    const stop = new AbortController();
    stop.abort();
    let started = false;
    await elector(client, "pod-1").run(stop.signal, {
      onStartedLeading: () => {
        started = true;
      },
      onStoppedLeading: () => {},
    });
    expect(started).toBe(false);
  });

  it("only one of two replicas leads", async () => {
    const client = new FakeKubeClient();
    const time = clock();
    const one = elector(client, "pod-1", time);
    const two = elector(client, "pod-2", time);
    const stop = new AbortController();
    const runs = [one, two].map((candidate) =>
      candidate.run(stop.signal, { onStartedLeading: () => {}, onStoppedLeading: () => {} }),
    );
    await until(() => one.isLeader() || two.isLeader());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([one.isLeader(), two.isLeader()].filter(Boolean)).toHaveLength(1);
    stop.abort();
    await Promise.all(runs);
  });
});
