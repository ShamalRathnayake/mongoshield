// Unit tests for verifyBackup on in-memory storage: fast and deep modes on good,
// truncated, tampered, missing-file and inconsistent backups.

import { describe, expect, it } from "vitest";
import {
  flipByte,
  replaceStoredFile,
  writeTestBackup,
} from "../../test/helpers/backup-fixtures.ts";
import { generateIdentity } from "../crypto/index.ts";
import { isMongoShieldError } from "../errors.ts";
import { resolveBackupKey } from "../format/layout.ts";
import type { Manifest } from "../format/manifest.ts";
import { writeManifest } from "../format/manifest-io.ts";
import { silentLogger } from "../logger.ts";
import { type MemoryStorage, memoryStorage } from "../storage/memory.ts";
import type { ProgressEvent } from "../types.ts";
import { verifyBackup } from "./verify.ts";

const documents = Array.from({ length: 20 }, (_, index) => ({ _id: index, value: index * 1.5 }));

async function goodBackup(
  storage: MemoryStorage,
  encryption: { recipients?: string[]; passphrase?: string } = {},
): Promise<Manifest> {
  return writeTestBackup(storage, {
    namespaces: [
      { ns: "app.items", documents, documentsPerPart: 8 },
      { ns: "app.empty" },
      { ns: "app.recent", type: "view", options: { viewOn: "items", pipeline: [] } },
    ],
    ...encryption,
  });
}

function firstDataKey(manifest: Manifest): string {
  const key = manifest.namespaces[0]?.files[0]?.key;
  if (key === undefined) throw new Error("no data file");
  return key;
}

const context = (storage: MemoryStorage) => ({ storage, logger: silentLogger });

describe("verifyBackup", () => {
  it("passes a good backup in fast and deep mode", async () => {
    const storage = memoryStorage();
    const manifest = await goodBackup(storage);
    const fast = await verifyBackup(context(storage), { backup: "latest" });
    expect(fast).toMatchObject({ ok: true, mode: "fast", backupId: manifest.id, problems: [] });
    // 3 parts + 1 empty part + 3 metadata files.
    expect(fast.filesChecked).toBe(7);
    expect(fast.documentsChecked).toBe(0);
    expect(fast.bytesChecked).toBe(manifest.totals.bytesStored);

    const deep = await verifyBackup(context(storage), { backup: manifest.id, mode: "deep" });
    expect(deep).toMatchObject({ ok: true, mode: "deep", documentsChecked: 20 });
  });

  it("checks an encrypted backup in fast mode without any key", async () => {
    const storage = memoryStorage();
    await goodBackup(storage, { passphrase: "secret" });
    expect((await verifyBackup(context(storage), { backup: "latest" })).ok).toBe(true);
  });

  it("decrypts every file in deep mode with the identity", async () => {
    const { identity, recipient } = generateIdentity();
    const storage = memoryStorage();
    await goodBackup(storage, { recipients: [recipient] });
    const report = await verifyBackup(context(storage), {
      backup: "latest",
      mode: "deep",
      decryption: { identities: [identity] },
    });
    expect(report).toMatchObject({ ok: true, documentsChecked: 20 });
  });

  it("throws MS_NO_IDENTITY in deep mode without a key or with the wrong key", async () => {
    const storage = memoryStorage();
    await goodBackup(storage, { recipients: [generateIdentity().recipient] });
    await expect(
      verifyBackup(context(storage), { backup: "latest", mode: "deep" }),
    ).rejects.toMatchObject({ code: "MS_NO_IDENTITY" });
    await expect(
      verifyBackup(context(storage), {
        backup: "latest",
        mode: "deep",
        decryption: { identities: [generateIdentity().identity] },
      }),
    ).rejects.toMatchObject({ code: "MS_NO_IDENTITY" });
  });

  it("throws MS_DECRYPTION_FAILED in deep mode for a wrong passphrase", async () => {
    const storage = memoryStorage();
    await goodBackup(storage, { passphrase: "right" });
    await expect(
      verifyBackup(context(storage), {
        backup: "latest",
        mode: "deep",
        decryption: { passphrase: "wrong" },
      }),
    ).rejects.toMatchObject({ code: "MS_DECRYPTION_FAILED" });
  });

  it.each(["fast", "deep"] as const)("reports a tampered data file in %s mode", async (mode) => {
    const storage = memoryStorage();
    const manifest = await goodBackup(storage);
    const key = firstDataKey(manifest);
    await replaceStoredFile(storage, manifest, key, (bytes) => flipByte(bytes, 20));
    const report = await verifyBackup(context(storage), { backup: "latest", mode });
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      { subject: key, problem: expect.stringMatching(/SHA-256|integrity/) },
    ]);
  });

  it.each(["fast", "deep"] as const)("reports a truncated data file in %s mode", async (mode) => {
    const storage = memoryStorage();
    const manifest = await goodBackup(storage);
    const key = firstDataKey(manifest);
    await replaceStoredFile(storage, manifest, key, (bytes) => bytes.subarray(0, 10));
    const report = await verifyBackup(context(storage), { backup: "latest", mode });
    expect(report.problems).toEqual([{ subject: key, problem: expect.stringMatching(/size/) }]);
  });

  it.each(["fast", "deep"] as const)("reports missing files in %s mode", async (mode) => {
    const storage = memoryStorage();
    const manifest = await goodBackup(storage);
    const metadataKey = manifest.namespaces[2]?.metadata.key ?? "";
    await storage.delete([
      resolveBackupKey(manifest.id, firstDataKey(manifest)),
      resolveBackupKey(manifest.id, metadataKey),
    ]);
    const report = await verifyBackup(context(storage), { backup: "latest", mode });
    expect(report.problems.map((problem) => problem.subject).sort()).toEqual(
      [firstDataKey(manifest), metadataKey].sort(),
    );
    expect(report.problems.every((problem) => /missing/.test(problem.problem))).toBe(true);
  });

  it("finds a document count that differs from the manifest only in deep mode", async () => {
    const storage = memoryStorage();
    const original = await goodBackup(storage);
    // Rewrite the manifest (under a new id) claiming one more document.
    const namespaces = original.namespaces.map((entry, index) =>
      index === 0 ? { ...entry, documents: entry.documents + 1 } : entry,
    );
    const id = original.id.replace(/_[0-9a-f]{6}$/, "_abcdef");
    for (const key of storage.keys()) {
      if (!key.endsWith("manifest.json")) {
        const stream = await storage.get(key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        await storage.put(key.replace(original.id, id), Buffer.concat(chunks));
      }
    }
    await writeManifest(storage, {
      ...original,
      id,
      namespaces,
      totals: { ...original.totals, documents: original.totals.documents + 1 },
    });

    expect((await verifyBackup(context(storage), { backup: id })).ok).toBe(true);
    const deep = await verifyBackup(context(storage), { backup: id, mode: "deep" });
    expect(deep.problems).toEqual([
      { subject: "app.items", problem: expect.stringMatching(/hold 20 documents.*records 21/) },
    ]);
  });

  it("throws MS_BACKUP_NOT_FOUND for an unknown backup", async () => {
    const storage = memoryStorage();
    await goodBackup(storage);
    const error = await verifyBackup(context(storage), {
      backup: "2020-01-01T00-00-00Z_000000",
    }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_BACKUP_NOT_FOUND")).toBe(true);
  });

  it("reports progress per namespace", async () => {
    const storage = memoryStorage();
    await goodBackup(storage);
    const events: ProgressEvent[] = [];
    await verifyBackup(context(storage), {
      backup: "latest",
      mode: "deep",
      onProgress: (event) => events.push(event),
    });
    const done = events.filter((event) => event.type === "namespace:done");
    expect(done.map((event) => event.ns).sort()).toEqual(["app.empty", "app.items", "app.recent"]);
    expect(events.at(-1)).toMatchObject({ type: "overall", documents: 20 });
  });
});
