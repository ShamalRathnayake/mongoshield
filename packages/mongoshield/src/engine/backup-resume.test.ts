// Unit tests for choosing and checking a checkpoint to resume (backup-resume.ts), and
// for reading checkpoints back (backup-checkpoint.ts), against memory storage. Resuming
// a real backup end to end is tested in test/integration/resume.test.ts.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { manifestKey } from "../format/layout.ts";
import type { Logger } from "../logger.ts";
import { silentLogger } from "../logger.ts";
import type { DeploymentInfo } from "../mongo/index.ts";
import { type MemoryStorage, memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import {
  backupFingerprint,
  type Checkpoint,
  checkCheckpointFiles,
  checkpointKey,
  listCheckpointIds,
  readCheckpoint,
  writeCheckpoint,
} from "./backup-checkpoint.ts";
import {
  buildCheckpoint,
  CheckpointSaver,
  type CheckpointState,
  findCheckpointToResume,
  type ResumeRequest,
  resumeFileEncryption,
} from "./backup-resume.ts";

const recipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
const OLDER = "2026-10-20T10-00-00Z_aaaaaa";
const NEWER = "2026-10-21T10-00-00Z_bbbbbb";

const deployment: DeploymentInfo = {
  topology: "replicaSet",
  serverVersion: "7.0.12",
  clusterId: "0".repeat(32),
  supportsChangeStreams: true,
  supportsSnapshotReads: true,
  maxBsonObjectSize: 16 * 1024 * 1024,
};

const fingerprint = backupFingerprint({ include: ["app.*"] }, "zstd", undefined);

function state(id: string, overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    id,
    startedAt: new Date("2026-10-20T10:00:00Z"),
    invocations: 1,
    fingerprint,
    labels: {},
    deployment,
    encryption: undefined,
    plans: [],
    ...overrides,
  };
}

async function saveCheckpoint(storage: StorageAdapter, checkpoint: Checkpoint): Promise<void> {
  await writeCheckpoint(storage, checkpoint, new AbortController().signal);
}

function request(
  storage: StorageAdapter,
  resume: string,
  logger: Logger = silentLogger,
  labels: Record<string, string> = {},
) {
  const resumeRequest: ResumeRequest = {
    storage,
    logger,
    resume,
    fingerprint,
    labels,
    deployment,
    signal: undefined,
  };
  return resumeRequest;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  const noop = (): void => {};
  return {
    warnings,
    debug: noop,
    info: noop,
    error: noop,
    warn: (message) => warnings.push(message),
  };
}

describe("findCheckpointToResume with a named or the latest checkpoint", () => {
  it("explains when there is no checkpoint at all, or none for the named backup", async () => {
    const storage = memoryStorage();
    const latest = await errorOf(findCheckpointToResume(request(storage, "latest")));
    expect(isMongoShieldError(latest, "MS_BACKUP_NOT_FOUND")).toBe(true);
    const named = await errorOf(findCheckpointToResume(request(storage, OLDER)));
    expect(isMongoShieldError(named, "MS_BACKUP_NOT_FOUND")).toBe(true);
  });

  it("resumes the newest checkpoint for latest", async () => {
    const storage = memoryStorage();
    await saveCheckpoint(storage, buildCheckpoint(state(OLDER)));
    await saveCheckpoint(storage, buildCheckpoint(state(NEWER)));
    expect((await findCheckpointToResume(request(storage, "latest")))?.id).toBe(NEWER);
  });

  it("refuses a backup that is already complete", async () => {
    const storage = memoryStorage();
    await saveCheckpoint(storage, buildCheckpoint(state(OLDER)));
    await storage.put(manifestKey(OLDER), Buffer.from("{}"));
    const error = await errorOf(findCheckpointToResume(request(storage, OLDER)));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(error)).toMatch(/already complete/);
  });

  it("refuses different options and another deployment", async () => {
    const storage = memoryStorage();
    const other = backupFingerprint({ include: ["other.*"] }, "gzip", undefined);
    await saveCheckpoint(storage, buildCheckpoint(state(OLDER, { fingerprint: other })));
    const options = await errorOf(findCheckpointToResume(request(storage, OLDER)));
    expect(isMongoShieldError(options, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(options)).toMatch(/different options \(include, compression\)/);

    const moved = { ...deployment, clusterId: "1".repeat(32) };
    await saveCheckpoint(storage, buildCheckpoint(state(NEWER, { deployment: moved })));
    const elsewhere = await errorOf(findCheckpointToResume(request(storage, NEWER)));
    expect(String(elsewhere)).toMatch(/different MongoDB deployment/);
  });

  it("accepts a checkpoint of an older writer that recorded no cluster id", async () => {
    const storage = memoryStorage();
    const checkpoint = buildCheckpoint(state(OLDER));
    const { clusterId: _clusterId, ...source } = checkpoint.source;
    await saveCheckpoint(storage, { ...checkpoint, source });
    expect((await findCheckpointToResume(request(storage, OLDER)))?.id).toBe(OLDER);
  });

  it("refuses a checkpoint whose finished files changed", async () => {
    const storage = memoryStorage();
    const checkpoint = buildCheckpoint(
      state(OLDER, {
        plans: [
          {
            ns: "app.orders",
            db: "app",
            collection: "orders",
            type: "collection",
            estimatedDocuments: 1,
            averageDocumentBytes: 10,
            metadata: { key: "app/orders.metadata.json", size: 3, sha256: "a".repeat(64) },
            boundaries: [],
            parts: [],
          },
        ],
      }),
    );
    await saveCheckpoint(storage, checkpoint);
    const error = await errorOf(findCheckpointToResume(request(storage, OLDER)));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect(String(error)).toMatch(/1 finished file\(s\) changed/);
  });
});

describe("findCheckpointToResume with auto", () => {
  it("starts a new backup when nothing matches", async () => {
    const storage = memoryStorage();
    expect(await findCheckpointToResume(request(storage, "auto"))).toBeUndefined();
    // Different options, another deployment, and a committed backup are all skipped.
    const other = backupFingerprint({ include: ["other.*"] }, "zstd", undefined);
    await saveCheckpoint(storage, buildCheckpoint(state(OLDER, { fingerprint: other })));
    const moved = { ...deployment, clusterId: "1".repeat(32) };
    await saveCheckpoint(storage, buildCheckpoint(state(NEWER, { deployment: moved })));
    const committed = "2026-10-22T10-00-00Z_cccccc";
    await saveCheckpoint(storage, buildCheckpoint(state(committed)));
    await storage.put(manifestKey(committed), Buffer.from("{}"));
    expect(await findCheckpointToResume(request(storage, "auto"))).toBeUndefined();
  });

  it("only continues a checkpoint with exactly the same labels", async () => {
    const storage = memoryStorage();
    await saveCheckpoint(
      storage,
      buildCheckpoint(state(OLDER, { labels: { plan: "nightly", env: "prod" } })),
    );
    await saveCheckpoint(storage, buildCheckpoint(state(NEWER, { labels: { plan: "hourly" } })));
    const auto = (labels: Record<string, string>) =>
      findCheckpointToResume(request(storage, "auto", silentLogger, labels));

    // Same labels in another key order: the nightly checkpoint, not the newer hourly one.
    expect((await auto({ env: "prod", plan: "nightly" }))?.id).toBe(OLDER);
    expect((await auto({ plan: "hourly" }))?.id).toBe(NEWER);
    // A missing, extra or different label starts a new backup instead.
    expect(await auto({})).toBeUndefined();
    expect(await auto({ plan: "nightly" })).toBeUndefined();
    expect(await auto({ plan: "nightly", env: "prod", trigger: "manual" })).toBeUndefined();
    expect(await auto({ plan: "weekly" })).toBeUndefined();
  });

  it("keeps a named checkpoint's own labels whatever the run's labels are", async () => {
    const storage = memoryStorage();
    await saveCheckpoint(storage, buildCheckpoint(state(OLDER, { labels: { plan: "nightly" } })));
    const named = await findCheckpointToResume(
      request(storage, OLDER, silentLogger, { plan: "other" }),
    );
    expect(named?.labels).toEqual({ plan: "nightly" });
  });

  it("skips an unreadable checkpoint with a warning and takes the next matching one", async () => {
    const storage = memoryStorage();
    await saveCheckpoint(storage, buildCheckpoint(state(OLDER)));
    await storage.put(checkpointKey(NEWER), Buffer.from("not json"));
    const logger = recordingLogger();
    expect((await findCheckpointToResume(request(storage, "auto", logger)))?.id).toBe(OLDER);
    expect(logger.warnings).toEqual(["Ignoring an unreadable checkpoint"]);
  });
});

describe("readCheckpoint and listCheckpointIds", () => {
  it("refuses a checkpoint stored under another backup's id", async () => {
    const storage = memoryStorage();
    const checkpoint = buildCheckpoint(state(OLDER));
    await storage.put(checkpointKey(NEWER), Buffer.from(JSON.stringify(checkpoint)));
    const error = await errorOf(readCheckpoint(storage, NEWER, undefined));
    expect(isMongoShieldError(error, "MS_MANIFEST_INVALID")).toBe(true);
    expect(String(error)).toMatch(/describes backup/);
  });

  it("passes storage failures other than a missing file on", async () => {
    const failing: StorageAdapter = {
      ...memoryStorage(),
      async get() {
        throw new Error("disk on fire");
      },
    };
    await expect(readCheckpoint(failing, OLDER, undefined)).rejects.toThrow(/disk on fire/);
  });

  it("lists only checkpoint files named after backup ids", async () => {
    const storage = memoryStorage();
    await saveCheckpoint(storage, buildCheckpoint(state(OLDER)));
    await storage.put(checkpointKey(OLDER).replace(".json", ".tmp"), Buffer.from("x"));
    await storage.put(checkpointKey("not-a-backup-id"), Buffer.from("{}"));
    expect(await listCheckpointIds(storage, undefined)).toEqual([OLDER]);
  });
});

describe("checkCheckpointFiles and the key envelope", () => {
  const envelope = Buffer.from("age envelope bytes");
  const keyFile = {
    key: "key.age",
    size: envelope.length,
    sha256: createHash("sha256").update(envelope).digest("hex"),
  };
  const encrypted = buildCheckpoint(
    state(OLDER, {
      encryption: { recipients: [recipient], manifestRecipients: ["scrypt"], keyFile },
    }),
  );

  it("accepts an intact envelope and reports a modified or missing one", async () => {
    const storage: MemoryStorage = memoryStorage();
    await storage.put(`backups/${OLDER}/key.age`, envelope);
    expect(await checkCheckpointFiles(storage, encrypted, undefined)).toEqual([]);
    await storage.put(`backups/${OLDER}/key.age`, Buffer.from("tampered"));
    expect(await checkCheckpointFiles(storage, encrypted, undefined)).toEqual([
      { key: "key.age", problem: "the key envelope was modified" },
    ]);
    await storage.delete([`backups/${OLDER}/key.age`]);
    expect(await checkCheckpointFiles(storage, encrypted, undefined)).toEqual([
      { key: "key.age", problem: "the key envelope is missing" },
    ]);
  });

  it("passes other storage failures on", async () => {
    const failing: StorageAdapter = {
      ...memoryStorage(),
      async get() {
        throw new Error("timeout");
      },
    };
    await expect(checkCheckpointFiles(failing, encrypted, undefined)).rejects.toThrow(/timeout/);
  });
});

describe("resumeFileEncryption", () => {
  const storage = memoryStorage();

  it("encrypts nothing for an unencrypted backup", async () => {
    const plain = buildCheckpoint(state(OLDER));
    expect(await resumeFileEncryption(plain, undefined, storage, undefined)).toBeUndefined();
    expect(
      await resumeFileEncryption(
        plain,
        { kind: "recipients", recipients: [recipient] },
        storage,
        undefined,
      ),
    ).toBeUndefined();
  });

  it("uses the current recipients, or the recorded KMS recipients", async () => {
    const stored = buildCheckpoint(
      state(OLDER, {
        encryption: {
          recipients: [recipient],
          manifestRecipients: ["kms:aws:alias/x"],
          keyFile: { key: "key.age", size: 1, sha256: "c".repeat(64) },
        },
      }),
    );
    expect(
      await resumeFileEncryption(
        stored,
        { kind: "recipients", recipients: [recipient] },
        storage,
        undefined,
      ),
    ).toEqual({ recipients: [recipient], manifestRecipients: [recipient], keyFile: undefined });
    expect(
      await resumeFileEncryption(
        stored,
        { kind: "kms", kms: [{ provider: "aws", key: "alias/x" }], recipients: [] },
        storage,
        undefined,
      ),
    ).toMatchObject({ recipients: [recipient], manifestRecipients: ["kms:aws:alias/x"] });
  });

  it("refuses a passphrase or KMS checkpoint without a key envelope", async () => {
    const stored = buildCheckpoint(
      state(OLDER, {
        encryption: { recipients: [recipient], manifestRecipients: ["scrypt"], keyFile: undefined },
      }),
    );
    const error = await errorOf(
      resumeFileEncryption(stored, { kind: "passphrase", passphrase: "pw" }, storage, undefined),
    );
    expect(isMongoShieldError(error, "MS_MANIFEST_INVALID")).toBe(true);
  });
});

describe("CheckpointSaver", () => {
  it("logs a failed save without stopping later saves", async () => {
    const base = memoryStorage();
    let failures = 1;
    const flaky: StorageAdapter = {
      ...base,
      async put(key, body, options) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("throttled");
        }
        return base.put(key, body, options);
      },
    };
    const logger = recordingLogger();
    const saver = new CheckpointSaver(flaky, logger, () => state(OLDER));
    expect(saver.saved).toBe(false);
    await saver.saveQuietly();
    expect(logger.warnings).toEqual(["Could not save the backup checkpoint; continuing"]);
    expect(saver.saved).toBe(false);
    await saver.save();
    expect(saver.saved).toBe(true);
    expect(await listCheckpointIds(base, undefined)).toEqual([OLDER]);

    const resumed = new CheckpointSaver(flaky, logger, () => state(NEWER));
    resumed.markExisting();
    expect(resumed.saved).toBe(true);
  });
});
