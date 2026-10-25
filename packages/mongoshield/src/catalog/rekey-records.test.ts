import { describe, expect, it } from "vitest";
import type { Manifest } from "../format/manifest.ts";
import { applyRekeyRecords, type RekeyRecord, rekeyRecordKey } from "./rekey-records.ts";

const ID = "2026-10-01T03-00-00Z_abcdef";
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    formatVersion: 1,
    id: ID,
    tool: "mongoshield@test",
    status: "complete",
    startedAt: "2026-10-01T03:00:00.000Z",
    completedAt: "2026-10-01T03:00:05.000Z",
    source: { topology: "replicaSet", serverVersion: "8.0.0" },
    consistency: { mode: "none" },
    compression: "zstd",
    encryption: { scheme: "age-v1", recipients: ["age1old"] },
    labels: {},
    namespaces: [
      {
        ns: "app.users",
        db: "app",
        collection: "users",
        type: "collection",
        documents: 1,
        bytesRaw: 10,
        files: [{ key: "app/users.bson.zst.age", size: 100, sha256: OLD }],
        metadata: { key: "app/users.metadata.json.age", size: 50, sha256: OLD },
      },
    ],
    totals: { namespaces: 1, documents: 1, bytesRaw: 10, bytesStored: 150 },
    ...overrides,
  };
}

function record(overrides: Partial<RekeyRecord> = {}): RekeyRecord {
  return {
    backupId: ID,
    rekeyedAt: "2026-10-02T00:00:00.000Z",
    status: "complete",
    recipients: ["age1new"],
    files: [
      {
        key: "app/users.bson.zst.age",
        previousSize: 100,
        previousSha256: OLD,
        size: 101,
        sha256: NEW,
      },
    ],
    tool: "mongoshield@test",
    ...overrides,
  };
}

describe("applyRekeyRecords", () => {
  it("replaces the digests of rewritten files and the recipients", () => {
    const applied = applyRekeyRecords(manifest(), [record()]);
    expect(applied.encryption?.recipients).toEqual(["age1new"]);
    expect(applied.namespaces[0]?.files[0]).toEqual({
      key: "app/users.bson.zst.age",
      size: 101,
      sha256: NEW,
    });
    expect(applied.namespaces[0]?.metadata.sha256).toBe(OLD);
  });

  it("ignores pending records", () => {
    const original = manifest();
    expect(applyRekeyRecords(original, [record({ status: "pending" })])).toBe(original);
  });

  it("ignores every record while the backup is object-locked", () => {
    const locked = manifest({ immutableUntil: "2026-12-01T00:00:00.000Z" });
    expect(applyRekeyRecords(locked, [record()], new Date("2026-11-01T00:00:00Z"))).toBe(locked);
    const expired = applyRekeyRecords(locked, [record()], new Date("2026-12-02T00:00:00Z"));
    expect(expired.encryption?.recipients).toEqual(["age1new"]);
  });

  it("applies records oldest first, so the latest recipients win", () => {
    const later = record({ rekeyedAt: "2026-10-03T00:00:00.000Z", recipients: ["age1later"] });
    expect(applyRekeyRecords(manifest(), [later, record()]).encryption?.recipients).toEqual([
      "age1later",
    ]);
  });

  it("names record files by time so they list in order", () => {
    expect(rekeyRecordKey(ID, "2026-10-02T00:00:00.123Z")).toBe(
      `annotations/${ID}/rekey/2026-10-02T00-00-00-123Z.json`,
    );
  });
});
