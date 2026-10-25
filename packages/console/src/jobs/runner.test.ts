import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoShieldError } from "mongoshield";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEvent } from "../shared/api.ts";
import { StateStore } from "../state/store.ts";
import { JobRunner, type JobSpec } from "./runner.ts";

let dataDir: string;
let store: StateStore;
let runner: JobRunner;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ms-runner-"));
  store = await StateStore.open({ dataDir, secret: "runner-test-secret-0123456789abcdef" });
  runner = new JobRunner({ store, progressIntervalMs: 0 });
});

afterEach(async () => {
  await runner.shutdown(1000);
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A job that waits until `release()` is called, or until it is aborted. */
function controllable(lane: string, startedBy = "ada") {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spec: JobSpec = {
    kind: "backup",
    lane,
    startedBy,
    run: async (context) => {
      context.progress({ type: "namespace:start", ns: "app.users", estimatedDocuments: 10 });
      context.progress({
        type: "overall",
        documents: 5,
        estimatedDocuments: 10,
        bytes: 100,
        elapsedMs: 1,
        etaMs: 1,
      });
      context.log("info", "halfway");
      await Promise.race([
        released,
        new Promise((_, reject) =>
          context.signal.addEventListener("abort", () =>
            reject(new MongoShieldError("MS_ABORTED")),
          ),
        ),
      ]);
      return { summary: "done", backupId: "b1" };
    },
  };
  return { spec, release: () => release() };
}

describe("JobRunner", () => {
  it("runs a job, saves its history and reports its outcome", async () => {
    const job = controllable("connection:a");
    const started = await runner.start(job.spec);
    expect(["queued", "running"]).toContain(started.status);
    job.release();
    const finished = await runner.finished(started.id);
    expect(finished).toMatchObject({ status: "succeeded", summary: "done", backupId: "b1" });
    expect(store.current.jobs[0]).toMatchObject({ id: started.id, status: "succeeded" });
  });

  it("runs jobs of one lane one at a time and other lanes in parallel", async () => {
    const first = controllable("connection:a");
    const second = controllable("connection:a");
    const other = controllable("connection:b");
    const a1 = await runner.start(first.spec);
    const a2 = await runner.start(second.spec);
    const b1 = await runner.start(other.spec);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.get(a1.id)?.status).toBe("running");
    expect(runner.get(a2.id)?.status).toBe("queued");
    expect(runner.get(b1.id)?.status).toBe("running");
    first.release();
    await runner.finished(a1.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.get(a2.id)?.status).toBe("running");
    second.release();
    other.release();
    await runner.finished(a2.id);
  });

  it("cancels queued and running jobs", async () => {
    const running = controllable("connection:a");
    const queued = controllable("connection:a");
    const r = await runner.start(running.spec);
    const q = await runner.start(queued.spec);
    expect((await runner.cancel(q.id))?.status).toBe("cancelled");
    await runner.cancel(r.id);
    expect((await runner.finished(r.id))?.status).toBe("cancelled");
  });

  it("describes failures safely, scrubbing secrets", async () => {
    const job = await runner.start({
      kind: "restore",
      lane: "connection:a",
      startedBy: "ada",
      secrets: ["hunter2"],
      run: async () => {
        throw new MongoShieldError("MS_RESTORE_FAILED", "write to mongodb://u:hunter2@db failed");
      },
    });
    const finished = await runner.finished(job.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error?.code).toBe("MS_RESTORE_FAILED");
    expect(JSON.stringify(finished)).not.toContain("hunter2");

    const crash = await runner.start({
      kind: "verify",
      lane: "storage:s",
      startedBy: "ada",
      run: async () => {
        throw new TypeError("internal detail /etc/passwd");
      },
    });
    expect((await runner.finished(crash.id))?.error).toEqual({
      code: "CONSOLE_INTERNAL",
      message: expect.not.stringContaining("passwd"),
    });
  });

  it("replays status, logs and progress to late subscribers and streams the rest", async () => {
    const job = controllable("connection:a");
    const started = await runner.start(job.spec);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const events: JobEvent[] = [];
    runner.subscribe(started.id, (event) => events.push(event));
    job.release();
    await runner.finished(started.id);
    expect(events[0]).toMatchObject({ type: "status", job: { status: "running" } });
    expect(events).toContainEqual({ type: "log", level: "info", message: "halfway" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "progress", documents: 5, namespace: "app.users" }),
    );
    expect(events.at(-1)).toMatchObject({ type: "status", job: { status: "succeeded" } });
  });

  it("reports every finished namespace with its count, live and to late subscribers", async () => {
    // Progress is throttled (1 s here), so the small collection never appears in a
    // progress event; its "namespace" event must still reach the page.
    const throttled = new JobRunner({ store, progressIntervalMs: 1_000 });
    const overall = (documents: number) =>
      ({
        type: "overall",
        documents,
        estimatedDocuments: 128,
        bytes: documents,
        elapsedMs: 1,
        etaMs: undefined,
      }) as const;
    const live: JobEvent[] = [];
    const started = await throttled.start({
      kind: "backup",
      lane: "connection:ns",
      startedBy: "ada",
      run: async (context) => {
        context.progress({ type: "namespace:start", ns: "shop.orders", estimatedDocuments: 120 });
        context.progress({
          type: "namespace:progress",
          ns: "shop.orders",
          documents: 60,
          bytes: 1,
        });
        context.progress(overall(60));
        context.progress({ type: "namespace:start", ns: "shop.customers", estimatedDocuments: 8 });
        context.progress({ type: "namespace:done", ns: "shop.customers", documents: 8 });
        context.progress({ type: "namespace:done", ns: "shop.orders", documents: 120 });
        context.progress(overall(128));
        return { summary: "done" };
      },
    });
    throttled.subscribe(started.id, (event) => live.push(event));
    await throttled.finished(started.id);
    const finished = (events: readonly JobEvent[]) =>
      events.filter((event) => event.type === "namespace");
    const expected = [
      { type: "namespace", ns: "shop.customers", documents: 8 },
      { type: "namespace", ns: "shop.orders", documents: 120 },
    ];
    expect(finished(live)).toEqual(expected);
    expect(live).toContainEqual(
      expect.objectContaining({
        type: "progress",
        namespace: "shop.orders",
        namespaceDocuments: 60,
      }),
    );

    const replayed: JobEvent[] = [];
    throttled.subscribe(started.id, (event) => replayed.push(event))();
    expect(finished(replayed)).toEqual(expected);
    await throttled.shutdown(1000);
  });

  it("marks jobs interrupted by a restart as failed", async () => {
    await store.update((state) => {
      state.jobs = [{ id: "old", kind: "backup", status: "running", startedBy: "ada" }];
    });
    await runner.recoverInterrupted();
    expect(store.current.jobs[0]).toMatchObject({
      status: "failed",
      error: { code: "CONSOLE_INTERRUPTED" },
    });
  });

  it("gives running jobs a grace period at shutdown, then aborts them", async () => {
    const job = controllable("connection:a");
    const started = await runner.start(job.spec);
    await runner.shutdown(20);
    expect(runner.get(started.id)?.status).toBe("failed");
    await expect(runner.start(controllable("connection:x").spec)).rejects.toThrow(/shutting down/);
  });
});
