/**
 * Edge cases of the job runner beyond the basic lifecycle (runner.test.ts):
 * unknown ids, cancelling in every state, lanes after a cancelled queued job,
 * replay limits (the last 500 log lines, the 50 most recent finished jobs),
 * progress throttling, broken subscribers and shutdown of queued jobs.
 */

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoShieldError } from "mongoshield";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobEvent, JobSummary } from "../shared/api.ts";
import { StateStore } from "../state/store.ts";
import { JobRunner, type JobSpec } from "./runner.ts";

let dataDir: string;
let store: StateStore;
let runner: JobRunner;
let finished: JobSummary[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ms-runner-limits-"));
  store = await StateStore.open({ dataDir, secret: "runner-limits-secret-0123456789abcdef" });
  finished = [];
  runner = new JobRunner({
    store,
    progressIntervalMs: 0,
    onFinished: (job) => finished.push(job),
  });
});

afterEach(async () => {
  await runner.shutdown(1000);
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A job that runs `work` (default: finish at once). */
function job(lane: string, work: JobSpec["run"] = async () => ({ summary: "ok" })): JobSpec {
  return { kind: "verify", lane, startedBy: "ada", run: work };
}

/** A job that waits until released or aborted. */
function waiting(lane: string) {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spec = job(lane, async (context) => {
    await Promise.race([
      released,
      new Promise((_, reject) =>
        context.signal.addEventListener("abort", () =>
          reject(new MongoShieldError("MS_ABORTED", "aborted")),
        ),
      ),
    ]);
    return { summary: "released" };
  });
  return { spec, release: () => release() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("JobRunner edge cases", () => {
  it("answers unknown job ids without throwing", async () => {
    expect(runner.get("nope")).toBeUndefined();
    expect(runner.isActive("nope")).toBe(false);
    expect(await runner.finished("nope")).toBeUndefined();
    expect(await runner.cancel("nope")).toBeUndefined();
    const events: JobEvent[] = [];
    runner.subscribe("nope", (event) => events.push(event))();
    expect(events).toEqual([]);
  });

  it("returns a finished job unchanged when it is cancelled and reports it to onFinished", async () => {
    const started = await runner.start(job("lane:a"));
    const done = await runner.finished(started.id);
    expect(done?.status).toBe("succeeded");
    expect(runner.isActive(started.id)).toBe(false);
    expect((await runner.cancel(started.id))?.status).toBe("succeeded");
    expect(finished.map((entry) => entry.id)).toEqual([started.id]);
  });

  it("starts the next job of a lane after a queued job in the middle was cancelled", async () => {
    const first = waiting("lane:a");
    const head = await runner.start(first.spec);
    const middle = await runner.start(waiting("lane:a").spec);
    const last = await runner.start(job("lane:a"));
    expect((await runner.cancel(middle.id))?.status).toBe("cancelled");
    // Cancelling the middle job must not start the last one early.
    await tick();
    expect(runner.get(last.id)?.status).toBe("queued");
    first.release();
    await runner.finished(head.id);
    expect((await runner.finished(last.id))?.status).toBe("succeeded");
  });

  it("counts any failure after a cancel request as the cancellation winding down", async () => {
    let fail: () => void = () => {};
    const failing = new Promise<never>((_, reject) => {
      fail = () => reject(new MongoShieldError("MS_STORAGE_IO", "disk full"));
    });
    let entered = false;
    // Ignores its signal, then fails with an unrelated error.
    const started = await runner.start(
      job("lane:a", () => {
        entered = true;
        return failing;
      }),
    );
    while (!entered) await tick();
    await runner.cancel(started.id);
    expect(runner.get(started.id)?.status).toBe("running");
    fail();
    const done = await runner.finished(started.id);
    expect(done?.status).toBe("cancelled");
    // The signal was aborted, so the failure counts as the cancellation winding down.
    expect(done?.error).toBeUndefined();
  });

  it("keeps only the last 500 log lines for replay", async () => {
    const started = await runner.start(
      job("lane:a", async (context) => {
        for (let line = 0; line < 520; line++) context.log("info", `line ${line}`);
        return { summary: "logged" };
      }),
    );
    await runner.finished(started.id);
    const events: JobEvent[] = [];
    runner.subscribe(started.id, (event) => events.push(event));
    const logs = events.filter((event) => event.type === "log");
    expect(logs).toHaveLength(500);
    expect(logs[0]).toMatchObject({ message: "line 20" });
    expect(logs.at(-1)).toMatchObject({ message: "line 519" });
  });

  it("replays logs of the 50 most recent finished jobs and only the status of older ones", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 51; index++) {
      const started = await runner.start(
        job("lane:a", async (context) => {
          context.log("warn", `job ${index}`);
          return { summary: `done ${index}` };
        }),
      );
      await runner.finished(started.id);
      ids.push(started.id);
    }
    const replay = (id: string): JobEvent[] => {
      const events: JobEvent[] = [];
      runner.subscribe(id, (event) => events.push(event));
      return events;
    };
    const oldest = replay(ids[0] ?? "");
    expect(oldest).toEqual([{ type: "status", job: expect.objectContaining({ id: ids[0] }) }]);
    const newest = replay(ids[50] ?? "");
    expect(newest).toContainEqual({ type: "log", level: "warn", message: "job 50" });
  });

  it("throttles progress to one event per interval and always delivers the latest", async () => {
    const throttled = new JobRunner({ store, progressIntervalMs: 40 });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await throttled.start(
      job("lane:t", async (context) => {
        for (let documents = 1; documents <= 5; documents++) {
          context.progress({
            type: "overall",
            documents,
            estimatedDocuments: 5,
            bytes: documents * 10,
            elapsedMs: documents,
            etaMs: undefined,
          });
        }
        // Events other than overall/namespace progress are ignored.
        context.progress({ type: "namespace:done", ns: "app.users", documents: 5 });
        await released;
        return { summary: "ok" };
      }),
    );
    const events: JobEvent[] = [];
    throttled.subscribe(started.id, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const progress = events.filter((event) => event.type === "progress");
    // The first event is sent at once (it may predate the subscription); the
    // pending latest one follows when the interval has passed.
    expect(progress.at(-1)).toMatchObject({ documents: 5 });
    expect(progress.length).toBeLessThanOrEqual(2);
    release();
    await throttled.finished(started.id);
    await throttled.shutdown(100);
  });

  it("keeps a job running when a subscriber throws", async () => {
    const work = waiting("lane:a");
    const started = await runner.start(work.spec);
    let calls = 0;
    // Fine for the replay, then broken for every live event (a closed connection).
    runner.subscribe(started.id, () => {
      calls += 1;
      if (calls > 1) throw new Error("closed connection");
    });
    const unsubscribe = runner.subscribe(started.id, () => {});
    unsubscribe();
    work.release();
    expect((await runner.finished(started.id))?.status).toBe("succeeded");
    expect(calls).toBeGreaterThan(1);
  });

  it("cancels queued jobs at shutdown and lets running ones finish within the grace period", async () => {
    const running = waiting("lane:a");
    const head = await runner.start(running.spec);
    const queued = await runner.start(job("lane:a"));
    setTimeout(() => running.release(), 10);
    await runner.shutdown(5_000);
    expect(runner.isActive(head.id)).toBe(false);
    expect(runner.get(head.id)?.status).toBe("succeeded");
    expect(runner.get(queued.id)?.status).toBe("cancelled");
  });

  it("finishes a job in memory when its status cannot be saved", async () => {
    const work = waiting("lane:a");
    const started = await runner.start(work.spec);
    await tick();
    expect(runner.running().map((entry) => entry.id)).toEqual([started.id]);
    // A read-only data directory: every later save of this job fails.
    await chmod(dataDir, 0o500);
    try {
      work.release();
      expect((await runner.finished(started.id))?.status).toBe("succeeded");
    } finally {
      await chmod(dataDir, 0o700);
    }
  });

  it("finishes shutdown at once when nothing runs", async () => {
    const idle = new JobRunner({ store });
    await idle.shutdown(60_000);
    expect(idle.running()).toEqual([]);
  });
});
