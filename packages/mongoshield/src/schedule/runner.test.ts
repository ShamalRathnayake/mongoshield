/**
 * The scheduled-job runner with a fake shield over memory storage, so every
 * branch (skip, retry, guard, verify failure, timeout, redaction) is fast and
 * deterministic. The real end-to-end run is in test/integration/schedule.test.ts.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listBackups } from "../catalog/catalog.ts";
import { pruneBackups } from "../catalog/prune.ts";
import { idAt, makeManifest, putCompleteBackup } from "../catalog/test-fixtures.ts";
import { validateConfig } from "../config/load.ts";
import type { MongoShieldConfig } from "../config/schema.ts";
import type { DrillReport, ShieldDrillOptions } from "../engine/drill.ts";
import { MongoShieldError } from "../errors.ts";
import { newBackupId } from "../format/layout.ts";
import type { Manifest, NamespaceEntry } from "../format/manifest.ts";
import { writeManifest } from "../format/manifest-io.ts";
import { type MemoryStorage, memoryStorage } from "../storage/memory.ts";
import type { BackupOptions, BackupResult, VerifyReport } from "../types.ts";
import { createLockOwner } from "./lock.ts";
import { storageLock } from "./lock-storage.ts";
import { runScheduledJob, type ScheduledJobOptions, type ScheduledShield } from "./runner.ts";

const SHA = "0".repeat(64);
const FAST: ScheduledJobOptions = { retryDelays: { baseDelayMs: 1, maxDelayMs: 2 } };

function entry(ns: string, documents: number): NamespaceEntry {
  const [db = "", collection = ""] = ns.split(".");
  return {
    ns,
    db,
    collection,
    type: "collection",
    documents,
    bytesRaw: documents * 100,
    files: [],
    metadata: { key: `${db}/${collection}.metadata.json`, size: 1, sha256: SHA },
  };
}

function withTotals(manifest: Manifest): Manifest {
  return {
    ...manifest,
    totals: {
      namespaces: manifest.namespaces.length,
      documents: manifest.namespaces.reduce((sum, item) => sum + item.documents, 0),
      bytesRaw: manifest.namespaces.reduce((sum, item) => sum + item.bytesRaw, 0),
      bytesStored: 0,
    },
  };
}

interface FakeBehaviour {
  /** Documents in `app.users` for each backup. Defaults to 100. */
  readonly documents?: number;
  /** Errors thrown by the first backup attempts, in order. */
  readonly backupErrors?: Error[];
  /** The verify result. Defaults to ok. */
  readonly verifyOk?: boolean;
  /** Makes backup wait until aborted. */
  readonly hang?: boolean;
  /** Makes backup run out of its time budget (`status: "checkpointed"`). */
  readonly checkpointed?: boolean;
  /** The drill result. Defaults to ok. */
  readonly drillOk?: boolean;
}

/**
 * Start times of fake backups, one minute apart, so the guard can always tell
 * which backup came first (real backups seldom start in the same second).
 */
let clock = Date.parse("2026-10-20T03:00:00Z");
function nextStart(): Date {
  clock += 60_000;
  return new Date(clock);
}

/** A shield whose backup writes a manifest to memory storage, honouring the hook like the engine. */
function fakeShield(storage: MemoryStorage, behaviour: FakeBehaviour = {}) {
  const errors = [...(behaviour.backupErrors ?? [])];
  const backup = vi.fn(async (options: BackupOptions = {}): Promise<BackupResult> => {
    const error = errors.shift();
    if (error) throw error;
    if (behaviour.hang) {
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    }
    if (behaviour.checkpointed) {
      const id = newBackupId(nextStart());
      return {
        status: "checkpointed",
        id,
        durationMs: 5,
        checkpoint: {
          key: `_state/checkpoints/${id}.json`,
          partsDone: 3,
          partsTotal: 10,
          documents: 30,
          bytesRaw: 300,
        },
      };
    }
    const manifest = withTotals(
      makeManifest(newBackupId(nextStart()), {
        labels: { ...options.labels },
        namespaces: [entry("app.users", behaviour.documents ?? 100)],
      }),
    );
    await options.beforeCommit?.(manifest, {});
    await writeManifest(storage, manifest);
    return { status: "complete", id: manifest.id, manifest, durationMs: 5 };
  });
  const verify = vi.fn(
    async (options: { backup: unknown; mode?: "fast" | "deep" }): Promise<VerifyReport> => ({
      backupId: String(options.backup),
      mode: options.mode ?? "fast",
      ok: behaviour.verifyOk ?? true,
      filesChecked: 1,
      bytesChecked: 1,
      documentsChecked: 0,
      problems:
        behaviour.verifyOk === false
          ? [{ subject: "app/users.bson", problem: "sha mismatch" }]
          : [],
      durationMs: 1,
    }),
  );
  const drill = vi.fn(
    async (options: ShieldDrillOptions): Promise<DrillReport> => ({
      backupId: String(options.backup),
      ok: behaviour.drillOk ?? true,
      startedAt: new Date().toISOString(),
      durationMs: 50_000,
      restoreDurationMs: 42_000.4,
      restored: true,
      documentsRestored: 100,
      databases: [{ source: "app", target: "msdrill_test_app" }],
      kept: false,
      namespaces: [],
      problems:
        behaviour.drillOk === false
          ? [{ subject: "app.users", problem: "restored 99 documents, expected 100" }]
          : [],
      warnings: [],
    }),
  );
  const shield: ScheduledShield = {
    storage,
    backup,
    verify,
    drill,
    prune: (policy, options = {}) => pruneBackups(storage, policy, options),
  };
  return { shield, backup, verify, drill };
}

const BASE_CONFIG: MongoShieldConfig = { storage: "memory://test" };

describe("runScheduledJob", () => {
  it("backs up, verifies, prunes, and releases the lock", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, idAt("2026-10-18T03:00:00Z"));
    await putCompleteBackup(storage, idAt("2026-10-19T03:00:00Z"));
    const { shield, verify } = fakeShield(storage);

    const report = await runScheduledJob(shield, { ...BASE_CONFIG, retention: { last: 1 } }, FAST);

    expect(report.status).toBe("success");
    expect(report.backup).toMatchObject({ documents: 100, attempts: 1 });
    expect(report.verify).toMatchObject({ mode: "fast", ok: true });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ backup: report.backup?.id }));
    expect(report.prune).toEqual({ deletedBackups: 2, deletedBytes: expect.any(Number), kept: 1 });
    expect((await listBackups(storage)).map((backup) => backup.id)).toEqual([report.backup?.id]);
    // The lock was released: another runner can take it at once.
    const next = await storageLock({
      storage,
      owner: createLockOwner(),
      leaseMs: 60_000,
    }).tryAcquire();
    expect(next.acquired).toBe(true);
  });

  it("labels backups with their include/exclude shape", async () => {
    const storage = memoryStorage();
    const { shield, backup } = fakeShield(storage);
    await runScheduledJob(
      shield,
      { ...BASE_CONFIG, backup: { include: ["app.*"], labels: { env: "prod" } } },
      FAST,
    );
    expect(backup.mock.calls[0]?.[0]?.labels).toEqual({
      env: "prod",
      "mongoshield.shape": expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it("resumes with a time budget and reports a checkpointed run as such, without verifying", async () => {
    const storage = memoryStorage();
    const { shield, backup, verify } = fakeShield(storage, { checkpointed: true });
    const report = await runScheduledJob(
      shield,
      { ...BASE_CONFIG, backup: { maxDurationMs: 840_000, partSizeBytes: 1024 } },
      FAST,
    );
    expect(report.status).toBe("checkpointed");
    expect(report.error).toBeUndefined();
    expect(report.backup).toMatchObject({ status: "checkpointed", parts: { done: 3, total: 10 } });
    expect(backup.mock.calls[0]?.[0]).toMatchObject({
      maxDurationMs: 840_000,
      partSizeBytes: 1024,
      resume: "auto",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not resume (or force consistency none) without a time budget", async () => {
    const { shield, backup } = fakeShield(memoryStorage());
    await runScheduledJob(shield, BASE_CONFIG, FAST);
    expect(backup.mock.calls[0]?.[0]?.resume).toBeUndefined();
  });

  it("skips (without failing) when another runner holds the lock", async () => {
    const storage = memoryStorage();
    await storageLock({ storage, owner: createLockOwner(), leaseMs: 60_000 }).tryAcquire();
    const { shield, backup } = fakeShield(storage);
    const report = await runScheduledJob(shield, BASE_CONFIG, FAST);
    expect(report.status).toBe("skipped");
    expect(report.lock.heldBy?.host).toBeTruthy();
    expect(backup).not.toHaveBeenCalled();
  });

  it("retries a transient backup failure", async () => {
    const { shield, backup } = fakeShield(memoryStorage(), {
      backupErrors: [new MongoShieldError("MS_CONNECTION_FAILED", "lost connection")],
    });
    const report = await runScheduledJob(shield, BASE_CONFIG, FAST);
    expect(report.status).toBe("success");
    expect(report.backup?.attempts).toBe(2);
    expect(backup).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient failure, and reports the step", async () => {
    const { shield, backup } = fakeShield(memoryStorage(), {
      backupErrors: [
        new MongoShieldError("MS_PERMISSION_DENIED", "no privilege", { hint: "grant backup" }),
      ],
    });
    const report = await runScheduledJob(
      shield,
      { ...BASE_CONFIG, schedule: { cron: "0 3 * * *", retries: 5 } },
      FAST,
    );
    expect(backup).toHaveBeenCalledTimes(1);
    expect(report.status).toBe("failure");
    expect(report.error).toEqual({
      step: "backup",
      code: "MS_PERMISSION_DENIED",
      message: "no privilege",
      hint: "grant backup",
    });
  });

  it("refuses to commit a backup that fails the guard", async () => {
    const storage = memoryStorage();
    const { shield: first } = fakeShield(storage, { documents: 1000 });
    await runScheduledJob(first, BASE_CONFIG, FAST);

    const { shield } = fakeShield(storage, { documents: 10 });
    const report = await runScheduledJob(
      shield,
      { ...BASE_CONFIG, guard: { maxDocumentDropPercent: 50 } },
      FAST,
    );

    expect(report.status).toBe("failure");
    expect(report.error).toMatchObject({ step: "backup", code: "MS_GUARD_FAILED" });
    expect(report.guard).toMatchObject({
      ok: false,
      action: "fail",
      findings: [{ ns: "app.users" }],
    });
    expect(await listBackups(storage)).toHaveLength(1);
  });

  it("only warns when the guard action is warn", async () => {
    const storage = memoryStorage();
    await runScheduledJob(fakeShield(storage, { documents: 1000 }).shield, BASE_CONFIG, FAST);
    const report = await runScheduledJob(
      fakeShield(storage, { documents: 10 }).shield,
      { ...BASE_CONFIG, guard: { maxDocumentDropPercent: 50, action: "warn" } },
      FAST,
    );
    expect(report.status).toBe("success");
    expect(report.guard).toMatchObject({ ok: false, action: "warn" });
  });

  it("fails on a verification problem and does not prune afterwards", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, idAt("2026-10-18T03:00:00Z"));
    const { shield } = fakeShield(storage, { verifyOk: false });
    const report = await runScheduledJob(shield, { ...BASE_CONFIG, retention: { last: 1 } }, FAST);
    expect(report.status).toBe("failure");
    expect(report.error).toMatchObject({ step: "verify", code: "MS_INTEGRITY_FAILED" });
    expect(report.prune).toBeUndefined();
    expect(await listBackups(storage)).toHaveLength(2);
  });

  it("skips verify and prune when switched off", async () => {
    const storage = memoryStorage();
    const { shield, verify } = fakeShield(storage);
    const report = await runScheduledJob(
      shield,
      {
        ...BASE_CONFIG,
        retention: { last: 1 },
        schedule: { cron: "0 3 * * *", verify: "none", prune: false },
      },
      FAST,
    );
    expect(report.status).toBe("success");
    expect(verify).not.toHaveBeenCalled();
    expect(report.verify).toBeUndefined();
    expect(report.prune).toBeUndefined();
  });

  it("aborts a run that exceeds the timeout", async () => {
    const { shield } = fakeShield(memoryStorage(), { hang: true });
    const report = await runScheduledJob(
      shield,
      // 0.0005 minutes = 30 ms.
      { ...BASE_CONFIG, schedule: { cron: "0 3 * * *", timeoutMinutes: 0.0005 } },
      FAST,
    );
    expect(report.status).toBe("failure");
    expect(report.error?.code).toBe("MS_TIMEOUT");
  });

  it("keeps passwords out of the report", async () => {
    const { shield } = fakeShield(memoryStorage(), {
      backupErrors: [
        new MongoShieldError(
          "MS_INTERNAL",
          "failed for mongodb://admin:hunter22@db.example:27017/app",
        ),
      ],
    });
    const report = await runScheduledJob(
      shield,
      { ...BASE_CONFIG, source: { uri: "mongodb://admin:hunter22@db.example:27017/app" } },
      FAST,
    );
    expect(JSON.stringify(report)).not.toContain("hunter22");
    expect(report.error?.message).toContain("mongodb://admin:***@db.example");
  });

  it("reports a storage lock on an adapter without conditional writes as a lock failure", async () => {
    const storage = {
      ...memoryStorage(),
      capabilities: { conditionalWrites: false, rangeReads: true, objectLock: false },
    };
    const { shield } = fakeShield(storage as MemoryStorage);
    const report = await runScheduledJob(shield, BASE_CONFIG, FAST);
    expect(report.error).toMatchObject({ step: "lock", code: "MS_CONFIG_INVALID" });
  });

  it("runs without a lock when lock is none", async () => {
    const storage = memoryStorage();
    const { shield } = fakeShield(storage);
    const report = await runScheduledJob(
      shield,
      { ...BASE_CONFIG, schedule: { cron: "0 3 * * *", lock: "none" } },
      FAST,
    );
    expect(report.status).toBe("success");
    expect(storage.keys().some((key) => key.startsWith("locks/"))).toBe(false);
  });
});

describe("runScheduledJob with verify: drill", () => {
  const DRILL_CONFIG: MongoShieldConfig = {
    ...BASE_CONFIG,
    schedule: { cron: "0 3 * * *", verify: "drill" },
    drill: { targetUri: "mongodb://drill:s3cret@scratch.example:27017", sample: 5, prefix: "x_" },
  };

  it("drills the new backup into the scratch deployment and reports the RTO", async () => {
    const { shield, drill, verify } = fakeShield(memoryStorage());
    const report = await runScheduledJob(shield, DRILL_CONFIG, FAST);
    expect(report.status).toBe("success");
    expect(verify).not.toHaveBeenCalled();
    expect(drill).toHaveBeenCalledWith(
      expect.objectContaining({
        backup: report.backup?.id,
        target: { uri: "mongodb://drill:s3cret@scratch.example:27017" },
        sample: 5,
        prefix: "x_",
      }),
    );
    expect(report.verify).toEqual({
      mode: "drill",
      ok: true,
      problems: [],
      attempts: 1,
      rtoMs: 42_000,
    });
  });

  it("fails the run with MS_INTEGRITY_FAILED when the drill finds problems", async () => {
    const { shield } = fakeShield(memoryStorage(), { drillOk: false });
    const report = await runScheduledJob(shield, DRILL_CONFIG, FAST);
    expect(report.status).toBe("failure");
    expect(report.error).toMatchObject({ step: "verify", code: "MS_INTEGRITY_FAILED" });
    expect(report.verify).toMatchObject({ mode: "drill", ok: false, rtoMs: 42_000 });
    expect(report.error?.message).toContain("restore drill");
  });

  it("loads the assertions file relative to cwd and passes its functions to the drill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mongoshield-runner-"));
    try {
      await writeFile(
        join(directory, "checks.ts"),
        "export default { app: async () => {} };\n",
        "utf8",
      );
      const { shield, drill } = fakeShield(memoryStorage());
      const report = await runScheduledJob(
        shield,
        { ...DRILL_CONFIG, drill: { targetUri: "mongodb://scratch", assertions: "checks.ts" } },
        { ...FAST, cwd: directory },
      );
      expect(report.status).toBe("success");
      const assertions = drill.mock.calls[0]?.[0].assertions;
      expect(typeof assertions === "object" && typeof assertions.app).toBe("function");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a missing assertions file as a configuration error", async () => {
    const { shield, drill } = fakeShield(memoryStorage());
    const report = await runScheduledJob(
      shield,
      { ...DRILL_CONFIG, drill: { targetUri: "mongodb://scratch", assertions: "nope.ts" } },
      { ...FAST, cwd: tmpdir() },
    );
    expect(report.error).toMatchObject({ step: "verify", code: "MS_CONFIG_INVALID" });
    expect(drill).not.toHaveBeenCalled();
  });

  it("refuses a drill override without a drill section before backing up", async () => {
    const { shield, backup } = fakeShield(memoryStorage());
    const report = await runScheduledJob(shield, BASE_CONFIG, { ...FAST, verify: "drill" });
    expect(report.error).toMatchObject({ step: "setup", code: "MS_CONFIG_INVALID" });
    expect(backup).not.toHaveBeenCalled();
  });

  it("keeps the scratch deployment's password out of the report", async () => {
    const { shield } = fakeShield(memoryStorage(), {
      backupErrors: [new MongoShieldError("MS_INTERNAL", "drill user s3cret was refused")],
    });
    const report = await runScheduledJob(shield, DRILL_CONFIG, FAST);
    expect(report.status).toBe("failure");
    expect(JSON.stringify(report)).not.toContain("s3cret");
  });

  it("is refused by config validation when the drill section is missing", () => {
    expect(() =>
      validateConfig({ storage: "./backups", schedule: { cron: "0 3 * * *", verify: "drill" } }),
    ).toThrow(expect.objectContaining({ code: "MS_CONFIG_INVALID" }));
    expect(() =>
      validateConfig({
        storage: "./backups",
        schedule: { cron: "0 3 * * *", verify: "drill" },
        drill: {},
      }),
    ).toThrow(/targetUri/);
  });
});
