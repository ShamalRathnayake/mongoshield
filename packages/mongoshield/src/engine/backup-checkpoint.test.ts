import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../storage/memory.ts";
import {
  backupFingerprint,
  checkCheckpointFiles,
  checkpointKey,
  fingerprintDifferences,
  listCheckpointIds,
  readCheckpoint,
  writeCheckpoint,
} from "./backup-checkpoint.ts";
import { buildCheckpoint } from "./backup-resume.ts";

const recipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

describe("backupFingerprint", () => {
  it("ignores pattern order and duplicates", () => {
    const a = backupFingerprint({ include: ["b.*", "a.*", "a.*"] }, "zstd", undefined);
    const b = backupFingerprint({ include: ["a.*", "b.*"] }, "zstd", undefined);
    expect(fingerprintDifferences(a, b)).toEqual([]);
  });

  it("names every option that differs", () => {
    const before = backupFingerprint({ include: ["a.*"] }, "zstd", undefined);
    const after = backupFingerprint(
      { include: ["a.*"], exclude: ["a.logs"], query: { "a.x": { n: 1 } }, retainDays: 7 },
      "gzip",
      { kind: "recipients", recipients: [recipient] },
    );
    expect(fingerprintDifferences(before, after)).toEqual([
      "exclude",
      "query",
      "compression",
      "encryption",
      "retainDays",
    ]);
  });

  it("stores a hash of the query, never the filter itself", () => {
    const fingerprint = backupFingerprint(
      { query: { "app.users": { email: "secret@example.com" } } },
      "zstd",
      undefined,
    );
    expect(JSON.stringify(fingerprint)).not.toContain("secret@example.com");
    expect(fingerprint.query).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never records a passphrase", () => {
    const fingerprint = backupFingerprint({}, "zstd", {
      kind: "passphrase",
      passphrase: "hunter2",
    });
    expect(JSON.stringify(fingerprint)).not.toContain("hunter2");
    expect(fingerprint.encryption.kind).toBe("passphrase");
  });

  it("tells KMS keys apart", () => {
    const one = backupFingerprint({}, "zstd", {
      kind: "kms",
      kms: [{ provider: "aws", key: "alias/one" }],
      recipients: [],
    });
    const two = backupFingerprint({}, "zstd", {
      kind: "kms",
      kms: [{ provider: "aws", key: "alias/two" }],
      recipients: [],
    });
    expect(fingerprintDifferences(one, two)).toEqual(["encryption"]);
  });
});

describe("checkpoint storage", () => {
  const id = "2026-10-20T10-00-00Z_abcdef";
  const checkpoint = buildCheckpoint({
    id,
    startedAt: new Date("2026-10-20T10:00:00Z"),
    invocations: 1,
    fingerprint: backupFingerprint({}, "zstd", undefined),
    labels: {},
    deployment: {
      topology: "replicaSet",
      serverVersion: "7.0.12",
      clusterId: "0".repeat(32),
      supportsChangeStreams: true,
      supportsSnapshotReads: true,
      maxBsonObjectSize: 16 * 1024 * 1024,
    },
    encryption: undefined,
    plans: [
      {
        ns: "app.orders",
        db: "app",
        collection: "orders",
        type: "collection",
        estimatedDocuments: 10,
        averageDocumentBytes: 100,
        metadata: { key: "app/orders.metadata.json", size: 3, sha256: "a".repeat(64) },
        boundaries: [5],
        parts: [
          {
            key: "app/orders.000.bson.zst",
            done: { size: 4, sha256: "b".repeat(64), documents: 5, bytesRaw: 500 },
          },
          { key: "app/orders.001.bson.zst", done: undefined },
        ],
      },
    ],
  });

  it("writes, lists and reads a checkpoint back", async () => {
    const storage = memoryStorage();
    await writeCheckpoint(storage, checkpoint, new AbortController().signal);
    expect(storage.keys()).toEqual([checkpointKey(id)]);
    expect(await listCheckpointIds(storage, undefined)).toEqual([id]);
    expect(await readCheckpoint(storage, id, undefined)).toEqual(checkpoint);
    expect(await readCheckpoint(storage, "2026-10-20T10-00-00Z_000000", undefined)).toBeUndefined();
  });

  it("rejects a checkpoint that is not valid", async () => {
    const storage = memoryStorage();
    await storage.put(checkpointKey(id), Buffer.from('{"formatVersion":1}'));
    await expect(readCheckpoint(storage, id, undefined)).rejects.toMatchObject({
      code: "MS_MANIFEST_INVALID",
    });
  });

  it("reports finished files that are missing or have another size", async () => {
    const storage = memoryStorage();
    await storage.put(
      `backups/${id}/app/orders.metadata.json`,
      Readable.from([Buffer.from("abc")]),
    );
    await storage.put(`backups/${id}/app/orders.000.bson.zst`, Readable.from([Buffer.from("xx")]));
    expect(await checkCheckpointFiles(storage, checkpoint, undefined)).toEqual([
      { key: "app/orders.000.bson.zst", problem: "its size is 2 bytes, not the recorded 4" },
    ]);
    await storage.delete([`backups/${id}/app/orders.metadata.json`]);
    const problems = await checkCheckpointFiles(storage, checkpoint, undefined);
    expect(problems[0]).toEqual({
      key: "app/orders.metadata.json",
      problem: "the file is missing",
    });
  });
});
