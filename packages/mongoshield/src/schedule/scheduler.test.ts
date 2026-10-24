import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { BackupScheduler, parseCron } from "./scheduler.ts";

/** 02:59:00 UTC; the test schedules use 03:00. */
const START = new Date("2026-10-20T02:59:00Z");
const MINUTE = 60_000;

function spyLogger() {
  return {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BackupScheduler", () => {
  it("runs the job at each cron slot", async () => {
    const job = vi.fn(async () => {});
    const scheduler = new BackupScheduler({ cron: "0 3 * * *", job });
    scheduler.start();
    expect(scheduler.nextRun()?.toISOString()).toBe("2026-10-20T03:00:00.000Z");

    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(job).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(job).toHaveBeenCalledTimes(1);
    expect(scheduler.nextRun()?.toISOString()).toBe("2026-10-21T03:00:00.000Z");

    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(job).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("interprets the expression in the configured time zone", () => {
    const scheduler = new BackupScheduler({
      cron: "0 3 * * *",
      timezone: "America/New_York",
      job: async () => {},
    });
    // 03:00 in New York (EDT, UTC-4) on 20 October is 07:00 UTC.
    expect(scheduler.nextRun()?.toISOString()).toBe("2026-10-20T07:00:00.000Z");
    expect(scheduler.upcoming(2).map((date) => date.toISOString())).toEqual([
      "2026-10-20T07:00:00.000Z",
      "2026-10-21T07:00:00.000Z",
    ]);
  });

  it("delays each run by the jitter", async () => {
    const job = vi.fn(async () => {});
    const scheduler = new BackupScheduler({
      cron: "0 3 * * *",
      jitterSeconds: 100,
      random: () => 0.5,
      job,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(MINUTE + 49_999);
    expect(job).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(job).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("never overlaps runs: slots during a busy run are skipped and logged", async () => {
    const logger = spyLogger();
    let finish: () => void = () => {};
    const job = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const scheduler = new BackupScheduler({ cron: "* * * * *", job, logger });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(MINUTE); // first run starts at 03:00
    expect(job).toHaveBeenCalledTimes(1);
    expect(scheduler.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * MINUTE); // 03:01–03:05 pass while busy
    expect(job).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipped scheduled runs"),
      expect.anything(),
    );
    await vi.advanceTimersByTimeAsync(MINUTE); // next slot after the run: 03:06
    expect(job).toHaveBeenCalledTimes(2);
    finish();
    await scheduler.stop();
  });

  it("keeps the schedule going when a job throws", async () => {
    const logger = spyLogger();
    const job = vi.fn(async () => {
      throw new Error("boom");
    });
    const scheduler = new BackupScheduler({ cron: "* * * * *", job, logger });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(job).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
    await scheduler.stop();
  });

  it("lets a running job finish within the grace period when stopped", async () => {
    let jobSignal: AbortSignal | undefined;
    const job = vi.fn(async (signal: AbortSignal) => {
      jobSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    });
    const scheduler = new BackupScheduler({ cron: "* * * * *", job });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(MINUTE);

    const stopping = scheduler.stop({ graceMs: 30_000 });
    expect(scheduler.nextRun()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
    expect(jobSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("aborts a running job that outlives the grace period", async () => {
    const job = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const scheduler = new BackupScheduler({ cron: "* * * * *", job });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(MINUTE);

    let stopped = false;
    void scheduler.stopped.then(() => {
      stopped = true;
    });
    void scheduler.stop({ graceMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    const signal = job.mock.calls[0]?.[0];
    expect(isMongoShieldError(signal?.reason, "MS_ABORTED")).toBe(true);
  });

  it("stops on SIGTERM when asked to", async () => {
    const scheduler = new BackupScheduler({ cron: "0 3 * * *", job: async () => {} });
    scheduler.start();
    const remove = scheduler.stopOnSignals(["SIGTERM"]);
    process.emit("SIGTERM");
    await scheduler.stopped;
    expect(scheduler.nextRun()).toBeUndefined();
    remove();
  });
});

describe("BackupScheduler edge cases", () => {
  it("waits in chunks for a slot further away than one timer can wait", async () => {
    // From 20 October, 1 January 03:00 is about 73 days away: more than 2^31 ms.
    const job = vi.fn(async () => {});
    const scheduler = new BackupScheduler({ cron: "0 3 1 1 *", job });
    scheduler.start();
    expect(scheduler.nextRun()?.toISOString()).toBe("2027-01-01T03:00:00.000Z");
    await vi.advanceTimersByTimeAsync(Date.parse("2027-01-01T03:00:00Z") - START.getTime() - 1);
    expect(job).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(job).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("idles with a warning when the expression has no future slot", async () => {
    // 30 February never comes.
    const logger = spyLogger();
    const scheduler = new BackupScheduler({ cron: "0 3 30 2 *", job: async () => {}, logger });
    expect(scheduler.nextRun()).toBeUndefined();
    scheduler.start();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no future runs"));
    expect(scheduler.nextRun()).toBeUndefined();
    await scheduler.stop();
  });

  it("ignores a second start, and a stop of a stopping or stopped scheduler", async () => {
    const job = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const scheduler = new BackupScheduler({ cron: "* * * * *", job });
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(job).toHaveBeenCalledTimes(1);

    const first = scheduler.stop({ graceMs: 1000 });
    const second = scheduler.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, second]);
    await scheduler.stop();
    expect(scheduler.nextRun()).toBeUndefined();
    // A stopped scheduler does not start again.
    scheduler.start();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("logs a job that throws something other than an Error", async () => {
    const logger = spyLogger();
    const scheduler = new BackupScheduler({
      cron: "* * * * *",
      job: () => Promise.reject("plain text"),
      logger,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(logger.error).toHaveBeenCalledWith("The scheduled job threw", { error: "plain text" });
    await scheduler.stop();
  });
});

describe("parseCron", () => {
  it("rejects invalid expressions and time zones with a config error", () => {
    for (const [expression, timezone] of [
      ["not a cron", undefined],
      ["0 3 * * * * *", undefined],
      ["0 3 * * *", "Europe/Berln"],
    ] as const) {
      let caught: unknown;
      try {
        parseCron(expression, timezone);
      } catch (error) {
        caught = error;
      }
      expect(isMongoShieldError(caught, "MS_CONFIG_INVALID"), `${expression} ${timezone}`).toBe(
        true,
      );
    }
  });
});
