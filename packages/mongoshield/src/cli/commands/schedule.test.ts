// `mongoshield run` and `mongoshield schedule` without a database: the failure,
// skipped and JSON reports, the exit codes, flag errors, SIGTERM and Ctrl-C handling,
// and a scheduled job firing (with fake timers). The full backup → verify → prune run
// against a real deployment is in test/integration/cli-run.test.ts.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { generateIdentity } from "../../crypto/index.ts";
import { createLockOwner } from "../../schedule/lock.ts";
import { storageLock } from "../../schedule/lock-storage.ts";
import { resolveStorage } from "../../storage/resolve.ts";

/** A fresh, uniquely named memory store URL. */
function memoryUrl(): string {
  return `memory://sched-${randomBytes(4).toString("hex")}`;
}

/** Waits until `predicate` holds, polling the event loop (real timers only). */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Like `until`, but polls with setImmediate, which the fake timers below leave real. */
async function untilImmediate(predicate: () => boolean): Promise<void> {
  for (let round = 0; round < 100_000 && !predicate(); round++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!predicate()) throw new Error("condition not met in time");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("mongoshield run", () => {
  it("prints a failed run on stdout with its hint, and exits with the error's code", async () => {
    // No connection string: the run fails at the backup step with MS_CONFIG_INVALID.
    const run = await runTestCli(["run", "--to", memoryUrl()]);
    expect(run.code).toBe(2);
    expect(run.stdout).toMatch(/^✖ Backup failed during backup: /);
    expect(run.stdout).toContain("  Hint: ");
    expect(run.stderr).toContain("Scheduled run failed");
  });

  it("prints the failed run as the JSON report with --json", async () => {
    const run = await runTestCli(["run", "--to", memoryUrl(), "--json"]);
    expect(run.code).toBe(2);
    expect(run.json()).toMatchObject({
      version: 1,
      status: "failure",
      lock: { kind: "storage" },
      error: { step: "backup", code: "MS_CONFIG_INVALID" },
    });
  });

  it("skips the run and exits 0 when another runner holds the lock", async () => {
    const url = memoryUrl();
    const lock = storageLock({
      storage: await resolveStorage(url),
      owner: createLockOwner(),
      leaseMs: 60_000,
    });
    const held = await lock.tryAcquire();
    expect(held.acquired).toBe(true);

    const run = await runTestCli(["run", "--to", url, "--uri", "mongodb://127.0.0.1:1"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.toLowerCase()).toContain("skipped");

    const json = await runTestCli(["run", "--to", url, "--json"]);
    expect(json.code).toBe(0);
    expect(json.json()).toMatchObject({ status: "skipped", lock: { kind: "storage" } });
  });

  it("never prints the password in --uri or the webhook secret", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mongoshield-run-secret-"));
    try {
      // No retries, and a short server selection timeout: the connection fails fast.
      await writeFile(
        join(cwd, "mongoshield.config.json"),
        JSON.stringify({ storage: memoryUrl(), schedule: { cron: "15 3 * * *", retries: 0 } }),
      );
      const run = await runTestCli(
        [
          "run",
          "--uri",
          "mongodb://app:hunter2secret@127.0.0.1:1/?serverSelectionTimeoutMS=200",
          "--verbose",
        ],
        { cwd, env: { MONGOSHIELD_WEBHOOK_SECRET: "whsec-topsecret" } },
      );
      expect(run.code).toBe(10);
      expect(run.stdout).toContain("✖");
      expect(run.stdout + run.stderr).not.toContain("hunter2secret");
      expect(run.stdout + run.stderr).not.toContain("whsec-topsecret");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an unknown --verify mode (exit 2)", async () => {
    const run = await runTestCli(["run", "--verify", "full"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--verify must be one of none, fast, deep, drill");
  });

  it("needs the variable named by --passphrase-env", async () => {
    const run = await runTestCli(["run", "--to", memoryUrl(), "--passphrase-env", "NOPE"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("NOPE (from --passphrase-env) is not set or empty");
  });

  it("reads identity files and the passphrase variable before running, and never prints them", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mongoshield-run-"));
    try {
      const { identity } = generateIdentity();
      await writeFile(join(cwd, "id.key"), `${identity}\n`, { mode: 0o600 });
      const run = await runTestCli(
        ["run", "--to", memoryUrl(), "--passphrase-env", "PASS", "--identity-file", "id.key"],
        { cwd, env: { PASS: "pass-phrase-value" } },
      );
      // The keys are loaded; the run itself then fails for want of a connection string.
      expect(run.code).toBe(2);
      expect(run.stdout).toContain("✖ Backup failed during backup");
      expect(run.stdout + run.stderr).not.toContain("pass-phrase-value");
      expect(run.stdout + run.stderr).not.toContain(identity);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an identity file that holds no identity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mongoshield-run-"));
    try {
      const keyFile = join(cwd, "id.key");
      await writeFile(keyFile, "AGE-SECRET-KEY-1NOTAKEY\n", { mode: 0o600 });
      const run = await runTestCli(["run", "--to", memoryUrl(), "--identity-file", "id.key"], {
        cwd,
      });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(keyFile);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stops a run on SIGTERM and removes its SIGTERM handler afterwards", async () => {
    const before = process.listenerCount("SIGTERM");
    const url = memoryUrl();
    // With jitter of an hour the run waits; SIGTERM must cut the wait short.
    const cwd = await mkdtemp(join(tmpdir(), "mongoshield-run-term-"));
    try {
      await writeFile(
        join(cwd, "mongoshield.config.json"),
        JSON.stringify({ storage: url, schedule: { cron: "15 3 * * *", jitterSeconds: 3600 } }),
      );
      const running = runTestCli(["run", "--jitter", "--json"], { cwd });
      await until(() => process.listenerCount("SIGTERM") > before);
      process.emit("SIGTERM");
      const run = await running;
      expect(run.code).toBe(60);
      expect(run.json()).toMatchObject({ status: "failure", error: { code: "MS_ABORTED" } });
      expect(process.listenerCount("SIGTERM")).toBe(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stops a run on Ctrl-C (the CLI's abort signal)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mongoshield-run-int-"));
    try {
      await writeFile(
        join(cwd, "mongoshield.config.json"),
        JSON.stringify({
          storage: memoryUrl(),
          schedule: { cron: "15 3 * * *", jitterSeconds: 3600 },
        }),
      );
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const run = await runTestCli(["run", "--jitter"], { cwd, signal: controller.signal });
      expect(run.code).toBe(60);
      expect(run.stdout).toMatch(/^✖ /);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("mongoshield schedule", () => {
  it("prints the schedule in UTC by default and stops at once when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runTestCli(["schedule", "--to", memoryUrl(), "--cron", "0 4 * * 1"], {
      signal: controller.signal,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("Schedule: 0 4 * * 1 (UTC). Next runs:");
    // Three upcoming slots, each with its ISO time.
    expect(run.stderr.match(/\(\d{4}-\d{2}-\d{2}T04:00:00\.000Z\)/g)).toHaveLength(3);
    expect(run.stderr).toContain("Stopping (a running backup gets up to 60 s to finish)");
    expect(run.stderr).toContain("Scheduler stopped.");
    expect(run.stdout).toBe("");
  });

  it("stops gracefully on SIGTERM with the given grace period", async () => {
    const before = process.listenerCount("SIGTERM");
    const running = runTestCli([
      "schedule",
      "--to",
      memoryUrl(),
      "--cron",
      "15 3 * * *",
      "--grace-seconds",
      "5",
    ]);
    await until(() => process.listenerCount("SIGTERM") > before);
    process.emit("SIGTERM");
    const run = await running;
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("gets up to 5 s to finish");
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it.each([
    ["=-1", "--grace-seconds must be a whole number 0–86400"],
    [" 90000", "--grace-seconds must be a whole number 0–86400"],
    [" soon", "--grace-seconds must be a whole number"],
  ])("rejects --grace-seconds %s (exit 2)", async (value, message) => {
    const run = await runTestCli([
      "schedule",
      "--to",
      memoryUrl(),
      "--cron",
      "15 3 * * *",
      ...(value.startsWith("=") ? [`--grace-seconds${value}`] : ["--grace-seconds", value.trim()]),
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
  });

  it("rejects an invalid cron expression or time zone (exit 2)", async () => {
    const cron = await runTestCli(["schedule", "--to", memoryUrl(), "--cron", "every day"]);
    expect(cron.code).toBe(2);
    expect(cron.stderr).toContain("Use 5 fields");

    const zone = await runTestCli([
      "schedule",
      "--to",
      memoryUrl(),
      "--cron",
      "15 3 * * *",
      "--timezone",
      "Mars/Olympus",
    ]);
    expect(zone.code).toBe(2);
  });

  it("runs the job at each slot, reports a failed run, and shows the next run", async () => {
    vi.useFakeTimers({
      now: new Date("2026-03-02T10:00:30Z"),
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
    const controller = new AbortController();
    const running = runTestCli(["schedule", "--to", memoryUrl(), "--cron", "* * * * *"], {
      signal: controller.signal,
    });
    // Config loading does real I/O: wait (without timers) until the scheduler runs.
    await untilImmediate(() => process.listenerCount("SIGTERM") > 0);
    // The first slot is 10:01:00; the job fails fast (no connection string).
    await vi.advanceTimersByTimeAsync(31_000);
    for (let tick = 0; tick < 50; tick++) await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    const run = await running;

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("Starting scheduled backup → memory://");
    expect(run.stdout).toMatch(/✖ Backup failed during backup/);
    expect(run.stderr).toMatch(/▲ Backup failed during backup/);
    expect(run.stderr).toContain("Next run: 2026-03-02");
    expect(run.stderr).toContain("(2026-03-02T10:02:00.000Z)");
  });

  it("prints each run as one JSON report with --json, and nothing else on stdout", async () => {
    vi.useFakeTimers({
      now: new Date("2026-03-02T10:00:30Z"),
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
    const controller = new AbortController();
    const running = runTestCli(["schedule", "--to", memoryUrl(), "--cron", "* * * * *", "--json"], {
      signal: controller.signal,
    });
    await untilImmediate(() => process.listenerCount("SIGTERM") > 0);
    await vi.advanceTimersByTimeAsync(31_000);
    for (let tick = 0; tick < 50; tick++) await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    const run = await running;

    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({ status: "failure", error: { step: "backup" } });
    expect(run.stderr).not.toContain("▲ Backup failed");
  });
});
