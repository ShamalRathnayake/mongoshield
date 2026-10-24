/** Tests for the controller loop: outcomes, retries, metrics and shutdown. */

import { describe, expect, it } from "vitest";
import { KubeApiError } from "../kube/client.ts";
import { silentLogger } from "../logger.ts";
import { OperatorMetrics } from "../operator-metrics.ts";
import { Controller, type ObjectRef, parseKey, type ReconcileFunction } from "./controller.ts";

function metrics(): OperatorMetrics {
  return new OperatorMetrics({
    backups: () => [],
    restores: () => [],
    drills: () => [],
    queueDepths: () => [],
    isLeader: () => true,
  });
}

function controllerWith(reconcile: ReconcileFunction, registry = metrics()) {
  const controller = new Controller({
    name: "test",
    reconcile,
    workers: 2,
    logger: silentLogger,
    metrics: registry,
    rateLimit: { baseDelayMs: 1, maxDelayMs: 5 },
  });
  return { controller, registry };
}

/** Waits until `condition` holds (polling the event loop). */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!condition()) throw new Error("condition never became true");
}

describe("Controller", () => {
  it("calls reconcile with the object reference and counts successes", async () => {
    const seen: ObjectRef[] = [];
    const { controller, registry } = controllerWith(async (ref) => {
      seen.push(ref);
      return undefined;
    });
    const running = controller.run();
    controller.enqueue({ namespace: "prod", name: "nightly" });
    await until(() => seen.length === 1);
    controller.stop();
    await running;

    expect(seen).toEqual([{ namespace: "prod", name: "nightly" }]);
    expect(registry.reconciles.value({ controller: "test", result: "success" })).toBe(1);
    expect(registry.reconcileDuration.count({ controller: "test" })).toBe(1);
  });

  it("retries errors with backoff until reconcile succeeds", async () => {
    let calls = 0;
    const { controller, registry } = controllerWith(async () => {
      calls += 1;
      if (calls < 3) throw new Error("boom");
      return undefined;
    });
    const running = controller.run();
    controller.enqueue({ namespace: "a", name: "b" });
    await until(() => calls === 3);
    controller.stop();
    await running;

    expect(registry.reconciles.value({ controller: "test", result: "error" })).toBe(2);
    expect(registry.reconciles.value({ controller: "test", result: "success" })).toBe(1);
    expect(controller.queue.failures("a/b")).toBe(0);
  });

  it("counts conflicts separately (they are expected)", async () => {
    let calls = 0;
    const { controller, registry } = controllerWith(async () => {
      calls += 1;
      if (calls === 1) throw new KubeApiError(409, "Conflict", "modified");
      return undefined;
    });
    const running = controller.run();
    controller.enqueue({ namespace: "a", name: "b" });
    await until(() => calls === 2);
    controller.stop();
    await running;

    expect(registry.reconciles.value({ controller: "test", result: "conflict" })).toBe(1);
  });

  it("requeues after the delay a reconcile asks for", async () => {
    let calls = 0;
    const { controller, registry } = controllerWith(async () => {
      calls += 1;
      return calls === 1 ? { requeueAfterMs: 5 } : undefined;
    });
    const running = controller.run();
    controller.enqueue({ namespace: "a", name: "b" });
    await until(() => calls === 2);
    controller.stop();
    await running;

    expect(registry.reconciles.value({ controller: "test", result: "requeue" })).toBe(1);
  });

  it("never reconciles one object on two workers at once", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const { controller } = controllerWith(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      calls += 1;
      return undefined;
    });
    const running = controller.run();
    controller.enqueue({ namespace: "a", name: "b" });
    await until(() => active === 1);
    controller.enqueue({ namespace: "a", name: "b" });
    controller.enqueue({ namespace: "a", name: "b" });
    await until(() => calls === 2);
    controller.stop();
    await running;

    expect(maxActive).toBe(1);
  });
});

describe("parseKey", () => {
  it("splits namespace and name at the first slash", () => {
    expect(parseKey("prod/nightly")).toEqual({ namespace: "prod", name: "nightly" });
  });
});
