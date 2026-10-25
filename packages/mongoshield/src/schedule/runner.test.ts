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
import {
  idAt,
  makeManifest,
  putCheckpoint,
  putCompleteBackup,
  putIncompleteBackup,
} from "../catalog/test-fixtures.ts";
import { validateConfig } from "../config/load.ts";
import type { MongoShieldConfig } from "../config/schema.ts";
import { type BackupShapeInput, withShapeLabel } from "../engine/backup-guard.ts";
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
  /** Back up no namespaces (a manifest without data files, which replicates as is). */
  readonly empty?: boolean;
  /** The source deployment's `clusterId` recorded in manifests. Defaults to `"cluster-a"`. */
  readonly clusterId?: string;
  /** Record no `clusterId` at all (as old writers did). */
  readonly noClusterId?: boolean;
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
  const clusterId = behaviour.noClusterId ? {} : { clusterId: behaviour.clusterId ?? CLUSTER };
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
      // Like the engine: a data file and a checkpoint that records the run's origin.
      await putIncompleteBackup(storage, id);
      await putCheckpoint(storage, id, { ...clusterId, labels: { ...options.labels } });
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
        source: { topology: "replicaSet", serverVersion: "8.0.0", ...clusterId },
        namespaces: behaviour.empty ? [] : [entry("app.users", behaviour.documents ?? 100)],
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

/** The deployment fake backups come from unless a test says otherwise. */
const CLUSTER = "cluster-a";

/**
 * An earlier backup of a job: complete, labelled with its selection's shape and
 * recorded as coming from `clusterId`, like the backups the runner writes.
 */
async function putJobBackup(
  storage: MemoryStorage,
  id: string,
  options: {
    selection?: BackupShapeInput;
    clusterId?: string;
    labels?: Record<string, string>;
  } = {},
): Promise<void> {
  await putCompleteBackup(storage, id, {
    labels: withShapeLabel(options.labels, options.selection ?? {}),
    source: {
      topology: "replicaSet",
      serverVersion: "8.0.0",
      clusterId: options.clusterId ?? CLUSTER,
    },
  });
}

describe("runScheduledJob", () => {
  it("backs up, verifies, prunes, and releases the lock", async () => {
    const storage = memoryStorage();
    await putJobBackup(storage, idAt("2026-10-18T03:00:00Z"));
    await putJobBackup(storage, idAt("2026-10-19T03:00:00Z"));
    const { shield, verify } = fakeShield(storage);

    const report = await runScheduledJob(shield, { ...BASE_CONFIG, retention: { last: 1 } }, FAST);

    expect(report.status).toBe("success");
    expect(report.backup).toMatchObject({ documents: 100, attempts: 1 });
    expect(report.verify).toMatchObject({ mode: "fast", ok: true });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ backup: report.backup?.id }));
    expect(report.prune).toEqual({
      deletedBackups: 2,
      deletedBytes: expect.any(Number),
      kept: 1,
      outOfScope: 0,
    });
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
    await putJobBackup(storage, idAt("2026-10-18T03:00:00Z"));
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

describe("runScheduledJob options and edge cases", () => {
  /** A logger whose calls the test can inspect. */
  function spyLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it("waits the jitter first when asked to, using the given random source", async () => {
    const logger = spyLogger();
    const { shield } = fakeShield(memoryStorage());
    const report = await runScheduledJob(
      shield,
      { ...BASE_CONFIG, schedule: { cron: "0 3 * * *", jitterSeconds: 1 } },
      { ...FAST, applyJitter: true, random: () => 0.01, logger },
    );
    expect(report.status).toBe("success");
    expect(logger.info).toHaveBeenCalledWith("Waiting before the run (jitter)", { delayMs: 10 });
  });

  it("passes the backup section's exclude, consistency and parallelism to the backup", async () => {
    const { shield, backup } = fakeShield(memoryStorage());
    const onProgress = vi.fn();
    await runScheduledJob(
      shield,
      {
        ...BASE_CONFIG,
        backup: { exclude: ["app.cache"], consistency: "none", parallelism: 2 },
      },
      { ...FAST, onProgress },
    );
    expect(backup.mock.calls[0]?.[0]).toMatchObject({
      exclude: ["app.cache"],
      consistency: "none",
      parallelism: 2,
      onProgress,
    });
  });

  it("passes the decryption keys to verify and to the drill", async () => {
    const decryption = { passphrase: "a-long-passphrase-for-tests" };
    const fast = fakeShield(memoryStorage());
    await runScheduledJob(fast.shield, BASE_CONFIG, { ...FAST, decryption });
    expect(fast.verify.mock.calls[0]?.[0]).toMatchObject({ decryption });

    const drilled = fakeShield(memoryStorage());
    await runScheduledJob(
      drilled.shield,
      { ...BASE_CONFIG, drill: { targetUri: "mongodb://scratch" } },
      { ...FAST, verify: "drill", decryption },
    );
    expect(drilled.drill.mock.calls[0]?.[0]).toMatchObject({ decryption });
  });

  it("applies every guard setting of the config", async () => {
    const storage = memoryStorage();
    await runScheduledJob(fakeShield(storage, { documents: 1000 }).shield, BASE_CONFIG, FAST);
    const report = await runScheduledJob(
      fakeShield(storage, { documents: 1000 }).shield,
      {
        ...BASE_CONFIG,
        guard: {
          maxDocumentDropPercent: 50,
          maxSizeDropPercent: 50,
          failOnMissingCollection: true,
        },
      },
      FAST,
    );
    expect(report.status).toBe("success");
    expect(report.guard).toMatchObject({ ok: true, findings: [] });
    expect(report.guard?.baselineId).toEqual(expect.any(String));
  });

  it("does not prune when the retention section keeps no counts", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, idAt("2026-10-18T03:00:00Z"));
    const logger = spyLogger();
    const report = await runScheduledJob(
      fakeShield(storage).shield,
      { ...BASE_CONFIG, retention: {} },
      { ...FAST, logger },
    );
    expect(report.status).toBe("success");
    expect(report.prune).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith("Not pruning: no retention policy is configured");
    expect(await listBackups(storage)).toHaveLength(2);
  });

  it("reports the attempts of a step that failed after retries", async () => {
    const transient = () => new MongoShieldError("MS_STORAGE_IO", "storage hiccup");
    const { shield, backup } = fakeShield(memoryStorage(), {
      backupErrors: [transient(), transient()],
    });
    const report = await runScheduledJob(
      shield,
      { ...BASE_CONFIG, schedule: { cron: "0 3 * * *", retries: 1 } },
      { ...FAST, random: () => 0 },
    );
    expect(backup).toHaveBeenCalledTimes(2);
    expect(report.error).toEqual({
      step: "backup",
      code: "MS_STORAGE_IO",
      message: "storage hiccup",
      attempts: 2,
    });
  });

  it("reports errors that are not MongoShield errors as internal ones", async () => {
    const plain = fakeShield(memoryStorage(), { backupErrors: [new TypeError("x is undefined")] });
    const report = await runScheduledJob(plain.shield, BASE_CONFIG, FAST);
    expect(report.error).toEqual({
      step: "backup",
      code: "MS_INTERNAL",
      message: "x is undefined",
    });

    const { shield, backup } = fakeShield(memoryStorage());
    backup.mockRejectedValueOnce("a thrown string");
    const thrown = await runScheduledJob(shield, BASE_CONFIG, FAST);
    expect(thrown.error).toMatchObject({ code: "MS_INTERNAL", message: "a thrown string" });
  });

  it("keeps passphrases, identities and the webhook secret out of the report", async () => {
    const secrets = [
      "encryption-passphrase-1",
      "decryption-passphrase-2",
      "AGE-SECRET-KEY-1CONFIGIDENTITY",
      "option-passphrase-3",
      "AGE-SECRET-KEY-1OPTIONIDENTITY",
      "webhook-secret-4",
    ];
    const { shield } = fakeShield(memoryStorage(), {
      backupErrors: [new MongoShieldError("MS_INTERNAL", `leaked: ${secrets.join(" ")}`)],
    });
    const report = await runScheduledJob(
      shield,
      {
        ...BASE_CONFIG,
        encryption: { passphrase: "encryption-passphrase-1" },
        decryption: {
          passphrase: "decryption-passphrase-2",
          identities: ["AGE-SECRET-KEY-1CONFIGIDENTITY"],
        },
      },
      {
        ...FAST,
        decryption: {
          passphrase: "option-passphrase-3",
          identities: ["AGE-SECRET-KEY-1OPTIONIDENTITY"],
        },
        webhookSecret: "webhook-secret-4",
        notifyTimeoutMs: 100,
        notifyRetryDelayMs: 1,
      },
    );
    expect(report.status).toBe("failure");
    for (const secret of secrets) expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("refuses the MongoDB lock without a source connection string", async () => {
    const { shield, backup } = fakeShield(memoryStorage());
    const report = await runScheduledJob(
      shield,
      { ...BASE_CONFIG, schedule: { cron: "0 3 * * *", lock: "mongo" } },
      FAST,
    );
    expect(report.error).toMatchObject({ step: "lock", code: "MS_CONFIG_INVALID" });
    expect(report.error?.message).toMatch(/source connection string/);
    expect(backup).not.toHaveBeenCalled();
  });

  it("skips without naming a holder when the lock winner cannot be read", async () => {
    // Another runner wins the write of the next lock generation, and its object is
    // gone again before this runner can read it: busy, holder unknown.
    const base = memoryStorage();
    const storage: MemoryStorage = {
      ...base,
      async put(key, body, options) {
        if (key.startsWith("locks/") && options?.ifNoneMatch === "*") {
          throw new MongoShieldError("MS_STORAGE_PRECONDITION_FAILED", "exists");
        }
        return base.put(key, body, options);
      },
    };
    const { shield, backup } = fakeShield(storage);
    const report = await runScheduledJob(shield, BASE_CONFIG, FAST);
    expect(report.status).toBe("skipped");
    expect(report.lock).toEqual({ kind: "storage" });
    expect(backup).not.toHaveBeenCalled();
  });

  it("only warns when the lock cannot be released", async () => {
    const base = memoryStorage();
    const storage: MemoryStorage = {
      ...base,
      async put(key, body, options) {
        if (key.startsWith("locks/") && body.toString().includes('"released":true')) {
          throw new MongoShieldError("MS_STORAGE_IO", "storage went away");
        }
        return base.put(key, body, options);
      },
    };
    const logger = spyLogger();
    const report = await runScheduledJob(fakeShield(storage).shield, BASE_CONFIG, {
      ...FAST,
      logger,
    });
    expect(report.status).toBe("success");
    expect(logger.warn).toHaveBeenCalledWith(
      "Could not release the backup lock; it expires on its own",
      expect.objectContaining({ error: "storage went away" }),
    );
  });

  it("stops at once when the caller's signal has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const { shield, backup } = fakeShield(memoryStorage());
    const report = await runScheduledJob(shield, BASE_CONFIG, {
      ...FAST,
      signal: controller.signal,
    });
    expect(report.status).toBe("failure");
    expect(report.error?.code).toBe("MS_ABORTED");
    expect(backup).not.toHaveBeenCalled();
  });
});

describe("runScheduledJob with replicate targets", () => {
  it("copies the new backup to every target and reports each", async () => {
    const offsite = memoryStorage({ name: "offsite" });
    const { shield } = fakeShield(memoryStorage(), { empty: true });
    const report = await runScheduledJob(
      shield,
      { ...BASE_CONFIG, replicate: [{ storage: offsite }] },
      FAST,
    );
    expect(report.replicate).toEqual([{ location: offsite.location, ok: true }]);
    expect(report.status).toBe("success");
    expect((await listBackups(offsite)).map((backup) => backup.id)).toEqual([report.backup?.id]);
  });

  it("fails the run after trying every target when one copy failed, keeping the backup", async () => {
    const working = memoryStorage({ name: "working" });
    const brokenBase = memoryStorage({ name: "broken" });
    const broken: MemoryStorage = {
      ...brokenBase,
      async put() {
        throw new MongoShieldError("MS_STORAGE_IO", "disk full");
      },
    };
    const storage = memoryStorage();
    const { shield } = fakeShield(storage, { empty: true });
    const report = await runScheduledJob(
      shield,
      { ...BASE_CONFIG, replicate: [{ storage: broken }, { storage: working }] },
      FAST,
    );
    expect(report.status).toBe("failure");
    expect(report.error).toMatchObject({ step: "replicate", code: "MS_STORAGE_IO" });
    expect(report.replicate).toEqual([
      { location: broken.location, ok: false, error: expect.stringContaining("disk full") },
      { location: working.location, ok: true },
    ]);
    expect(await listBackups(storage)).toHaveLength(1);
    expect(await listBackups(working)).toHaveLength(1);
  });
});

describe("runScheduledJob retention scopes (jobs sharing one storage location)", () => {
  /** The ids in storage, oldest first. */
  async function idsIn(storage: MemoryStorage): Promise<string[]> {
    return (await listBackups(storage)).map((backup) => backup.id).reverse();
  }

  it("never prunes another selection's backups: two jobs, different databases, one storage", async () => {
    const storage = memoryStorage();
    const appJob: MongoShieldConfig = {
      ...BASE_CONFIG,
      backup: { include: ["app.*"] },
      retention: { last: 2 },
    };
    const analyticsJob: MongoShieldConfig = {
      ...BASE_CONFIG,
      backup: { include: ["analytics.*"] },
      retention: { last: 2 },
    };
    const appIds: string[] = [];
    const analyticsIds: string[] = [];
    for (let run = 0; run < 3; run++) {
      const app = await runScheduledJob(fakeShield(storage).shield, appJob, FAST);
      appIds.push(app.backup?.id ?? "");
      const analytics = await runScheduledJob(fakeShield(storage).shield, analyticsJob, FAST);
      analyticsIds.push(analytics.backup?.id ?? "");
      expect(analytics.status).toBe("success");
    }

    // Each job kept its own two newest backups; neither deleted the other's.
    expect(await idsIn(storage)).toEqual(
      [appIds[1], analyticsIds[1], appIds[2], analyticsIds[2]].map(String),
    );
  });

  it("reports how many backups of other sources/selections it left alone", async () => {
    const storage = memoryStorage();
    await putJobBackup(storage, idAt("2026-10-17T03:00:00Z"), { selection: { include: ["x.*"] } });
    await putJobBackup(storage, idAt("2026-10-18T03:00:00Z"), { clusterId: "cluster-b" });
    await putJobBackup(storage, idAt("2026-10-19T03:00:00Z"));
    const report = await runScheduledJob(
      fakeShield(storage).shield,
      { ...BASE_CONFIG, retention: { last: 1 } },
      FAST,
    );
    expect(report.prune).toMatchObject({ deletedBackups: 1, kept: 1, outOfScope: 2 });
    expect(await listBackups(storage)).toHaveLength(3);
  });

  it("never prunes another cluster's backups with the same selection", async () => {
    const storage = memoryStorage();
    const config: MongoShieldConfig = { ...BASE_CONFIG, retention: { last: 1 } };
    const first = await runScheduledJob(
      fakeShield(storage, { clusterId: "a" }).shield,
      config,
      FAST,
    );
    await runScheduledJob(fakeShield(storage, { clusterId: "b" }).shield, config, FAST);
    const third = await runScheduledJob(
      fakeShield(storage, { clusterId: "b" }).shield,
      config,
      FAST,
    );
    expect(await idsIn(storage)).toEqual([first.backup?.id, third.backup?.id]);
  });

  it("scopes by scopeLabels instead of the shape, and labels every backup with them", async () => {
    const storage = memoryStorage();
    // Two console-style plans with the same selection: only the plan label tells them apart.
    const config: MongoShieldConfig = { ...BASE_CONFIG, retention: { last: 1 } };
    const nightly = { ...FAST, scopeLabels: { "mongoshield.plan": "nightly" } };
    const hourly = { ...FAST, scopeLabels: { "mongoshield.plan": "hourly" } };
    const { shield, backup } = fakeShield(storage);
    const keptNightly = await runScheduledJob(shield, config, nightly);
    await runScheduledJob(shield, config, hourly);
    const keptHourly = await runScheduledJob(shield, config, hourly);

    expect(backup.mock.calls[0]?.[0]?.labels).toEqual({
      "mongoshield.plan": "nightly",
      "mongoshield.shape": expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    expect((await idsIn(storage)).sort()).toEqual(
      [keptNightly.backup?.id, keptHourly.backup?.id].sort(),
    );
  });

  it("takes the scope labels from the config's retention.scopeLabels", async () => {
    const storage = memoryStorage();
    // How `mongoshield run` (and the Kubernetes operator) give two jobs that share a
    // source, a selection and a storage location separate retention.
    const forPlan = (plan: string): MongoShieldConfig => ({
      ...BASE_CONFIG,
      retention: { last: 1, scopeLabels: { "mongoshield.plan": plan } },
    });
    const { shield, backup } = fakeShield(storage);
    const keptA = await runScheduledJob(shield, forPlan("a"), FAST);
    await runScheduledJob(shield, forPlan("b"), FAST);
    const keptB = await runScheduledJob(shield, forPlan("b"), FAST);

    expect(backup.mock.calls[0]?.[0]?.labels).toMatchObject({ "mongoshield.plan": "a" });
    expect((await idsIn(storage)).sort()).toEqual([keptA.backup?.id, keptB.backup?.id].sort());
    // The option still wins over the config (the console passes its plan id).
    await runScheduledJob(shield, forPlan("b"), {
      ...FAST,
      scopeLabels: { "mongoshield.plan": "c" },
    });
    expect(backup.mock.calls.at(-1)?.[0]?.labels).toMatchObject({ "mongoshield.plan": "c" });
  });

  it("prunes after a checkpointed run with the cluster its checkpoint records", async () => {
    const storage = memoryStorage();
    await putJobBackup(storage, idAt("2026-10-17T03:00:00Z"));
    await putJobBackup(storage, idAt("2026-10-18T03:00:00Z"));
    await putJobBackup(storage, idAt("2026-10-19T03:00:00Z"), { clusterId: "cluster-b" });
    const report = await runScheduledJob(
      fakeShield(storage, { checkpointed: true }).shield,
      { ...BASE_CONFIG, backup: { maxDurationMs: 60_000 }, retention: { last: 1 } },
      FAST,
    );
    expect(report.status).toBe("checkpointed");
    // The fresh checkpointed run is kept (grace period), as is the newest complete
    // backup of this cluster; cluster-b's backup is left alone.
    expect(report.prune).toMatchObject({ deletedBackups: 1, outOfScope: 1 });
  });

  it("does not prune when the backup does not record its deployment", async () => {
    const storage = memoryStorage();
    await putJobBackup(storage, idAt("2026-10-18T03:00:00Z"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const report = await runScheduledJob(
      fakeShield(storage, { noClusterId: true }).shield,
      { ...BASE_CONFIG, retention: { last: 1 } },
      { ...FAST, logger },
    );
    expect(report.status).toBe("success");
    expect(report.prune).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "Not pruning: the backup does not record which deployment it came from",
      { id: report.backup?.id },
    );
    expect(await listBackups(storage)).toHaveLength(2);
  });
});
