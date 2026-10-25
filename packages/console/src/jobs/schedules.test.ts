/**
 * Tests for plan schedules: validating cron input, keeping one scheduler per
 * scheduled plan in sync with the state, and what a schedule tick does (start
 * the plan's backup job through the runner, cancel it when stopped).
 *
 * Timers and the clock are faked so a cron slot can be reached instantly; file
 * I/O of the state store stays real, so the tests wait for it with real
 * `setImmediate` turns (which fake timers leave alone).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Logger, MongoShieldError } from "mongoshield";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.ts";
import type { PlanRecord } from "../state/types.ts";
import { JobRunner, type JobSpec } from "./runner.ts";
import { checkSchedule, PlanSchedules } from "./schedules.ts";

let dataDir: string;
let store: StateStore;
let runner: JobRunner;
let errors: string[];
let started: string[];
/** When set, scheduled jobs wait for this promise (or their abort) before finishing. */
let hold: Promise<void> | undefined;

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (message) => errors.push(message),
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ms-schedules-"));
  store = await StateStore.open({ dataDir, secret: "schedules-test-secret-0123456789abcdef" });
  runner = new JobRunner({ store, progressIntervalMs: 0 });
  errors = [];
  started = [];
  hold = undefined;
});

afterEach(async () => {
  vi.useRealTimers();
  await runner.shutdown(1000);
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A plan with the given schedule (or none). */
function plan(id: string, schedule?: PlanRecord["schedule"]): PlanRecord {
  return {
    id,
    name: id,
    connectionId: "c",
    storageId: "s",
    include: [],
    exclude: [],
    compression: "zstd",
    encryption: { kind: "none" },
    consistency: "auto",
    verify: "none",
    notify: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(schedule === undefined ? {} : { schedule }),
  };
}

/** The job a tick starts: records the plan and finishes (or waits for `hold`). */
function backupJob(current: PlanRecord): JobSpec {
  return {
    kind: "backup",
    lane: `plan:${current.id}`,
    startedBy: "schedule",
    planId: current.id,
    run: async (context) => {
      started.push(current.id);
      if (hold !== undefined) {
        await Promise.race([
          hold,
          new Promise((_, reject) =>
            context.signal.addEventListener("abort", () =>
              reject(new MongoShieldError("MS_ABORTED", "stopped")),
            ),
          ),
        ]);
      }
      return { summary: "ok" };
    },
  };
}

function schedulesFor(): PlanSchedules {
  return new PlanSchedules({ store, runner, logger, backupJob });
}

/** Lets real I/O (state writes) and promise chains make progress. */
async function settle(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The real timer, captured before any test fakes it. */
const realSetTimeout = globalThis.setTimeout;

/** Waits (with real time, up to 10 s) until `condition` holds. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("checkSchedule", () => {
  it("accepts a valid cron expression and time zone", () => {
    expect(() => checkSchedule("15 3 * * *", "Europe/Berlin")).not.toThrow();
  });

  it("refuses an invalid expression or time zone", () => {
    expect(() => checkSchedule("not cron", "UTC")).toThrow();
    expect(() => checkSchedule("15 3 * * *", "Mars/Olympus")).toThrow();
  });
});

describe("PlanSchedules", () => {
  it("schedules nothing until started, then one scheduler per scheduled plan", async () => {
    await store.update((state) => {
      state.plans = [plan("nightly", { cron: "0 3 * * *", timezone: "UTC" }), plan("manual")];
    });
    const schedules = schedulesFor();
    schedules.sync();
    expect(schedules.nextRunOf("nightly")).toBeUndefined();

    schedules.start();
    expect(schedules.nextRunOf("nightly")?.getUTCHours()).toBe(3);
    expect(schedules.nextRunOf("manual")).toBeUndefined();
    await schedules.stop(0);
    expect(schedules.nextRunOf("nightly")).toBeUndefined();
  });

  it("replaces a scheduler when its plan's schedule changes and drops removed plans", async () => {
    await store.update((state) => {
      state.plans = [plan("a", { cron: "0 3 * * *", timezone: "UTC" })];
    });
    const schedules = schedulesFor();
    schedules.start();
    expect(schedules.nextRunOf("a")?.getUTCHours()).toBe(3);

    await store.update((state) => {
      state.plans = [plan("a", { cron: "0 5 * * *", timezone: "UTC" })];
    });
    schedules.sync();
    expect(schedules.nextRunOf("a")?.getUTCHours()).toBe(5);

    // An unchanged schedule keeps its scheduler.
    schedules.sync();
    expect(schedules.nextRunOf("a")?.getUTCHours()).toBe(5);

    await store.update((state) => {
      state.plans = [];
    });
    schedules.sync();
    expect(schedules.nextRunOf("a")).toBeUndefined();
    await schedules.stop(0);
  });

  it("skips a plan whose stored schedule cannot be parsed and logs why", async () => {
    await store.update((state) => {
      state.plans = [plan("broken", { cron: "every day", timezone: "UTC" })];
    });
    const schedules = schedulesFor();
    schedules.start();
    expect(schedules.nextRunOf("broken")).toBeUndefined();
    expect(errors).toEqual(["Cannot schedule plan"]);
    await schedules.stop(0);
  });

  it("starts the plan's backup job through the runner when its slot comes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-03-01T02:59:59.900Z"));
    await store.update((state) => {
      state.plans = [plan("tick", { cron: "0 3 * * *", timezone: "UTC" })];
    });
    const schedules = schedulesFor();
    schedules.start();
    await vi.advanceTimersByTimeAsync(200);
    await until(() => started.includes("tick"), "the scheduled job");
    await until(
      () => runner.list().some((job) => job.planId === "tick" && job.status === "succeeded"),
      "the job to finish",
    );
    await schedules.stop(0);
  });

  it("does nothing when the plan was deleted before its slot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-03-01T02:59:59.900Z"));
    await store.update((state) => {
      state.plans = [plan("gone", { cron: "0 3 * * *", timezone: "UTC" })];
    });
    const schedules = schedulesFor();
    schedules.start();
    // Removed from the state, but sync() not called yet: the scheduler still fires.
    await store.update((state) => {
      state.plans = [];
    });
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(started).toEqual([]);
    expect(runner.list()).toEqual([]);
    await schedules.stop(0);
  });

  it("cancels a running scheduled job when stopped without grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-03-01T02:59:59.900Z"));
    hold = new Promise(() => {});
    await store.update((state) => {
      state.plans = [plan("long", { cron: "0 3 * * *", timezone: "UTC" })];
    });
    const schedules = schedulesFor();
    schedules.start();
    await vi.advanceTimersByTimeAsync(200);
    await until(() => started.includes("long"), "the scheduled job");

    const stopping = schedules.stop(0);
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    await until(
      () => runner.list().some((job) => job.planId === "long" && job.status === "cancelled"),
      "the job to be cancelled",
    );
  });
});
