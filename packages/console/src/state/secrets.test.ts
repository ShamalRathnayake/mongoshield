/**
 * Tests for reading and writing the secrets inside console records: each kind
 * round-trips, is bound to its record (a ciphertext moved to another record
 * does not open), and records without a secret read as "none".
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openConnectionUri,
  openNotifyUrl,
  openPlanPassphrase,
  openStorageCredentials,
  sealConnectionUri,
  sealNotifyUrl,
  sealPlanPassphrase,
  sealStorageCredentials,
} from "./secrets.ts";
import { StateStore } from "./store.ts";
import type { ConnectionRecord, PlanRecord, StorageRecord } from "./types.ts";

let dataDir: string;
let store: StateStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ms-secrets-"));
  store = await StateStore.open({ dataDir, secret: "secrets-test-secret-0123456789abcdef" });
});

afterEach(async () => {
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

function storageRecord(id: string, credentials?: string): StorageRecord {
  return {
    id,
    name: id,
    url: "s3://bucket",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(credentials === undefined ? {} : { credentials }),
  };
}

function planRecord(id: string, encryption: PlanRecord["encryption"]): PlanRecord {
  return {
    id,
    name: id,
    connectionId: "c",
    storageId: "s",
    include: [],
    exclude: [],
    compression: "zstd",
    encryption,
    consistency: "auto",
    verify: "none",
    notify: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("secrets", () => {
  it("round-trips a connection URI bound to its connection", () => {
    const uri = "mongodb://app:hunter2@db.example.net/";
    const connection: ConnectionRecord = {
      id: "c1",
      name: "c1",
      uri: sealConnectionUri(store, "c1", uri),
      uriPreview: "mongodb://app:***@db.example.net/",
      production: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(connection.uri).not.toContain("hunter2");
    expect(openConnectionUri(store, connection)).toBe(uri);
    expect(() => openConnectionUri(store, { ...connection, id: "c2" })).toThrow();
  });

  it("reads storage without credentials as an empty set", () => {
    expect(openStorageCredentials(store, storageRecord("s1"))).toEqual({});
  });

  it("round-trips storage credentials bound to their location", () => {
    const sealed = sealStorageCredentials(store, "s1", { AWS_ACCESS_KEY_ID: "AKIA" });
    expect(openStorageCredentials(store, storageRecord("s1", sealed))).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA",
    });
    expect(() => openStorageCredentials(store, storageRecord("s2", sealed))).toThrow();
  });

  it("keeps only string values when stored credentials are not a flat string map", () => {
    // The same AES-GCM context sealStorageCredentials uses, with hand-made JSON.
    const mixed = store.encrypt(
      JSON.stringify({ AWS_ACCESS_KEY_ID: "AKIA", NUMBER: 7, NESTED: { a: 1 } }),
      "storage:s1:credentials",
    );
    expect(openStorageCredentials(store, storageRecord("s1", mixed))).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA",
    });
    const notAnObject = store.encrypt("null", "storage:s1:credentials");
    expect(openStorageCredentials(store, storageRecord("s1", notAnObject))).toEqual({});
  });

  it("opens a plan passphrase only for passphrase-encrypted plans", () => {
    const sealed = sealPlanPassphrase(store, "p1", "correct horse battery");
    expect(
      openPlanPassphrase(store, planRecord("p1", { kind: "passphrase", passphrase: sealed })),
    ).toBe("correct horse battery");
    expect(openPlanPassphrase(store, planRecord("p1", { kind: "none" }))).toBeUndefined();
    expect(
      openPlanPassphrase(store, planRecord("p1", { kind: "recipients", recipients: ["age1x"] })),
    ).toBeUndefined();
  });

  it("round-trips notification URLs bound to their plan", () => {
    const sealed = sealNotifyUrl(store, "p1", "https://hooks.slack.com/services/T/B/xyz");
    expect(openNotifyUrl(store, "p1", sealed)).toBe("https://hooks.slack.com/services/T/B/xyz");
    expect(() => openNotifyUrl(store, "p2", sealed)).toThrow();
  });
});
