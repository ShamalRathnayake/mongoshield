import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BackupConfig, StorageProvider } from "@mongoshield/core";
import { BackupEngine } from "@mongoshield/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupScheduler } from "../src/BackupScheduler";

// Mock BackupEngine
vi.mock("@mongoshield/core", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    BackupEngine: vi.fn(),
  };
});

describe("BackupScheduler", () => {
  const logPath = path.resolve(__dirname, "./test-scheduler-audit.json");

  const mockConfig: BackupConfig = {
    connection: { host: "localhost", port: 27017 },
    target: {
      dbName: "test",
      viewsAsCollections: false,
      dumpDbUsersAndRoles: false,
    },
    output: {
      outPath: "/tmp",
      gzip: false,
      numParallelCollections: 1,
      oplog: false,
    },
  };

  const mockStorage: StorageProvider = {
    initialize: vi.fn(),
    createBsonWriteStream: vi.fn(),
    createMetadataWriteStream: vi.fn(),
    createArchiveWriteStream: vi.fn(),
    finalize: vi.fn(),
    prune: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    try {
      await fs.unlink(logPath);
    } catch {}
  });

  afterEach(async () => {
    try {
      await fs.unlink(logPath);
    } catch {}
  });

  it("should prevent overlap if preventOverlap is true", async () => {
    const scheduler = new BackupScheduler(
      mockConfig,
      {
        cron: "* * * * * *",
        preventOverlap: true,
        auditLogPath: logPath,
      },
      mockStorage,
    );

    // Force state to running
    (scheduler as any).state = "running";

    let overlapEmitted = false;
    scheduler.on("scheduler:overlapPrevented", () => {
      overlapEmitted = true;
    });

    await (scheduler as any).executeJob();
    expect(overlapEmitted).toBe(true);
  });

  it("should retry on failure and apply exponential backoff", async () => {
    const scheduler = new BackupScheduler(
      mockConfig,
      {
        cron: "* * * * * *",
        retries: 2,
        retryDelayMs: 10, // Fast delay for testing
        backoffFactor: 2,
        auditLogPath: logPath,
      },
      mockStorage,
    );

    const mockRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error 1"))
      .mockRejectedValueOnce(new Error("Network error 2"))
      .mockResolvedValueOnce(undefined);

    vi.mocked(BackupEngine).mockImplementation(
      (() => ({ run: mockRun }) as any) as any,
    );

    await (scheduler as any).executeJob();

    expect(mockRun).toHaveBeenCalledTimes(3);

    const history = await scheduler.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("success");
  });

  it("should fail gracefully if all retries are exhausted", async () => {
    const scheduler = new BackupScheduler(
      mockConfig,
      {
        cron: "* * * * * *",
        retries: 1,
        retryDelayMs: 10,
        auditLogPath: logPath,
      },
      mockStorage,
    );

    const mockRun = vi.fn().mockRejectedValue(new Error("Fatal error"));

    vi.mocked(BackupEngine).mockImplementation(
      (() => ({ run: mockRun }) as any) as any,
    );

    let failedEmitted = false;
    scheduler.on("backup:failed", () => {
      failedEmitted = true;
    });

    await (scheduler as any).executeJob();

    expect(mockRun).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    expect(failedEmitted).toBe(true);

    const history = await scheduler.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("failed");
    expect(history[0].error?.message).toBe("Fatal error");
  });

  it("should enforce timeouts using AbortSignal", async () => {
    const scheduler = new BackupScheduler(
      mockConfig,
      {
        cron: "* * * * * *",
        timeoutMs: 50, // Very short timeout
        retries: 0, // No retries so it fails immediately
        auditLogPath: logPath,
      },
      mockStorage,
    );

    const mockRun = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 5000); // would take 5s
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error(signal.reason?.message || "Aborted"));
        });
      });
    });

    vi.mocked(BackupEngine).mockImplementation(
      (() => ({ run: mockRun }) as any) as any,
    );

    await (scheduler as any).executeJob();

    const history = await scheduler.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("failed");
    expect(history[0].error?.message).toMatch(/timed out/);
  });
});
