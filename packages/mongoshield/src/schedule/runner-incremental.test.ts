// The scheduled runner and `backup.incremental` (runner.ts): the options each run asks
// the engine for, and what the report says about the kind of backup taken. The real
// cadence (full, incremental, full again once the chain is due) runs against MongoDB in
// test/integration/incremental-features.test.ts.

import { describe, expect, it, vi } from "vitest";
import { idAt, makeChainBase, makeIncremental } from "../catalog/test-fixtures.ts";
import { validateConfig } from "../config/load.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { BackupOptions, BackupResult, VerifyOptions, VerifyReport } from "../types.ts";
import { DEFAULT_FULL_EVERY_DAYS, incrementalPolicyOf, runScheduledJob } from "./runner.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("incrementalPolicyOf", () => {
  it("is empty without backup.incremental", () => {
    expect(incrementalPolicyOf(undefined)).toEqual({});
    expect(incrementalPolicyOf({ include: ["app.*"] })).toEqual({});
  });

  it("continues the newest backup, falls back to a full one, and starts chains on time", () => {
    expect(incrementalPolicyOf({ incremental: {} })).toEqual({
      incremental: {
        from: "latest",
        fallbackToFull: true,
        fullAfterMs: DEFAULT_FULL_EVERY_DAYS * DAY,
      },
    });
    expect(
      incrementalPolicyOf({ incremental: { fullEveryDays: 0.5, maxChainLength: 24 } }),
    ).toEqual({
      incremental: {
        from: "latest",
        fallbackToFull: true,
        fullAfterMs: DAY / 2,
        maxChainLength: 24,
      },
    });
  });
});

describe("runScheduledJob with backup.incremental", () => {
  const config = validateConfig({
    storage: "memory://runner-incremental",
    backup: { include: ["app.*"], incremental: { fullEveryDays: 7 } },
    schedule: { cron: "0 * * * *" },
  });

  /** A shield whose backup returns `manifest`, recording the options it was given. */
  function shieldReturning(result: BackupResult) {
    const backup = vi.fn(async (_options?: BackupOptions) => result);
    const verify = vi.fn(
      async (options: VerifyOptions): Promise<VerifyReport> => ({
        backupId: String(options.backup),
        mode: options.mode ?? "fast",
        ok: true,
        filesChecked: 1,
        bytesChecked: 1,
        documentsChecked: 0,
        problems: [],
        durationMs: 1,
      }),
    );
    const shield = {
      storage: memoryStorage(),
      backup,
      verify,
      prune: vi.fn(),
      drill: vi.fn(),
    };
    return { shield, backup, verify };
  }

  it("reports an incremental with its parent and verifies only the chain's links", async () => {
    const base = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000);
    const incremental = makeIncremental(idAt("2026-10-20T01:00:00Z"), base, 2000, {
      changes: { key: "_changes/window.bson", size: 1, sha256: "0".repeat(64), events: 42 },
    });
    const { shield, backup, verify } = shieldReturning({
      status: "complete",
      id: incremental.id,
      manifest: incremental,
      durationMs: 5,
    });
    const report = await runScheduledJob(shield, config, { verify: "fast", prune: false });

    expect(report.status, JSON.stringify(report.error)).toBe("success");
    expect(backup.mock.calls[0]?.[0]?.incremental).toMatchObject({ fallbackToFull: true });
    expect(report.backup).toMatchObject({ kind: "incremental", parent: base.id, changes: 42 });
    expect(verify.mock.calls[0]?.[0]).toMatchObject({ backup: incremental.id, chain: "links" });
  });

  it("reports why a full backup was taken instead, and verifies it whole", async () => {
    const base = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000);
    const { shield, verify } = shieldReturning({
      status: "complete",
      id: base.id,
      manifest: base,
      durationMs: 5,
      fullBackupReason: "the chain's full backup … is older than 7 days (fullAfterMs)",
    });
    const report = await runScheduledJob(shield, config, { verify: "fast", prune: false });

    expect(report.backup).toMatchObject({
      kind: "full",
      fullBackupReason: expect.stringContaining("older than 7 days"),
    });
    expect(verify.mock.calls[0]?.[0]).not.toHaveProperty("chain");
  });
});
