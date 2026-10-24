/**
 * The job event stream (SSE): a client that connects while a job runs first
 * gets a replay (status, latest progress, log lines so far), then live events
 * until the final status. Finished jobs replay the same way.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobSpec } from "../../src/jobs/runner.ts";
import type { JobEvent } from "../../src/shared/api.ts";
import {
  removeDataDir,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
} from "../helpers/console.ts";

let testConsole: TestConsole;
let admin: TestClient;

beforeAll(async () => {
  testConsole = await startConsole();
  admin = await setupAdmin(testConsole);
});

afterAll(async () => {
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

/** A job that logs and reports progress, then waits for `release()`. */
function scriptedJob() {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const spec: JobSpec = {
    kind: "verify",
    lane: "storage:test",
    startedBy: "admin",
    run: async (context) => {
      context.log("info", "line 1");
      context.log("warn", "line 2");
      context.progress({
        type: "overall",
        documents: 40,
        estimatedDocuments: 100,
        bytes: 4000,
        elapsedMs: 10,
        etaMs: 15,
      });
      started();
      await released;
      context.log("info", "line 3 (live)");
      return { summary: "done" };
    },
  };
  return { spec, running, release: () => release() };
}

describe("job events", () => {
  it("replays status, latest progress and logs to a late subscriber, then streams live events", async () => {
    const job = scriptedJob();
    const started = await testConsole.services.runner.start(job.spec);
    await job.running;

    const collecting = admin.events(`/api/jobs/${started.id}/events`);
    // Let the stream connect and replay before the job continues.
    await new Promise((resolve) => setTimeout(resolve, 50));
    job.release();
    const events = (await collecting) as JobEvent[];

    expect(events.slice(0, 4)).toEqual([
      { type: "status", job: expect.objectContaining({ id: started.id, status: "running" }) },
      { type: "progress", documents: 40, estimatedDocuments: 100, bytes: 4000, etaMs: 15 },
      { type: "log", level: "info", message: "line 1" },
      { type: "log", level: "warn", message: "line 2" },
    ]);
    expect(events).toContainEqual({ type: "log", level: "info", message: "line 3 (live)" });
    expect(events.at(-1)).toMatchObject({ type: "status", job: { status: "succeeded" } });
  });

  it("replays a finished job and ends the stream", async () => {
    const job = scriptedJob();
    const started = await testConsole.services.runner.start(job.spec);
    job.release();
    await testConsole.services.runner.finished(started.id);

    const events = (await admin.events(`/api/jobs/${started.id}/events`)) as JobEvent[];
    expect(events[0]).toMatchObject({ type: "status", job: { status: "succeeded" } });
    expect(events[1]).toMatchObject({ type: "progress", documents: 40 });
    expect(events.filter((event) => event.type === "log")).toHaveLength(3);
  });

  it("answers 404 for an unknown job", async () => {
    const response = await admin.request("GET", "/api/jobs/unknown/events");
    expect(response.status).toBe(404);
  });
});
