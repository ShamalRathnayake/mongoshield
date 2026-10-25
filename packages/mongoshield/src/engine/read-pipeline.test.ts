// Unit tests for the read pipeline: stored data files back to raw BSON documents,
// for every compression and encryption, and every way a stored file can be damaged.

import { BSON, Int32 } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  flipByte,
  replaceStoredFile,
  writeTestBackup,
} from "../../test/helpers/backup-fixtures.ts";
import { generateIdentity } from "../crypto/index.ts";
import { type ErrorCode, isMongoShieldError } from "../errors.ts";
import type { Manifest, NamespaceEntry } from "../format/manifest.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { DecryptionOptions } from "../types.ts";
import {
  assertCanDecrypt,
  checkStoredFile,
  isKmsBackup,
  openDocumentStream,
  readMetadataFile,
  sourceFromManifest,
} from "./read-pipeline.ts";

const documents = Array.from({ length: 50 }, (_, index) => ({
  _id: index,
  text: "x".repeat(index),
}));

function onlyNamespace(manifest: Manifest): NamespaceEntry {
  const entry = manifest.namespaces[0];
  if (entry === undefined) throw new Error("no namespace");
  return entry;
}

async function readAll(
  storage: StorageAdapter,
  manifest: Manifest,
  decryption?: DecryptionOptions,
  signal?: AbortSignal,
): Promise<Buffer[]> {
  const source = sourceFromManifest(storage, manifest, decryption);
  const result: Buffer[] = [];
  for (const file of onlyNamespace(manifest).files) {
    for await (const document of openDocumentStream(source, file, { signal })) {
      result.push(document as Buffer);
    }
  }
  return result;
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isMongoShieldError(error, code)) {
    throw new Error(`expected ${code}, got ${String(error)}`, { cause: error });
  }
}

describe("openDocumentStream", () => {
  it.each(["zstd", "gzip", "none"] as const)(
    "reads back every document of a %s backup byte for byte",
    async (compression) => {
      const storage = memoryStorage();
      const manifest = await writeTestBackup(storage, {
        namespaces: [{ ns: "app.items", documents }],
        compression,
      });
      const read = await readAll(storage, manifest);
      expect(read.map((raw) => BSON.deserialize(raw))).toEqual(documents);
    },
  );

  it("reads a collection split into several parts in order", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items", documents, documentsPerPart: 7 }],
    });
    expect(onlyNamespace(manifest).files.length).toBe(8);
    expect((await readAll(storage, manifest)).length).toBe(50);
  });

  it("decrypts with an identity and with a passphrase", async () => {
    const { identity, recipient } = generateIdentity();
    const storage = memoryStorage();
    const withKey = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items", documents }],
      recipients: [recipient],
    });
    expect((await readAll(storage, withKey, { identities: [identity] })).length).toBe(50);

    const withPassphrase = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items", documents }],
      passphrase: "correct horse",
    });
    expect((await readAll(storage, withPassphrase, { passphrase: "correct horse" })).length).toBe(
      50,
    );
  });

  it("fails with MS_NO_IDENTITY for an identity that does not match", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items", documents }],
      recipients: [generateIdentity().recipient],
    });
    await expectCode(
      readAll(storage, manifest, { identities: [generateIdentity().identity] }),
      "MS_NO_IDENTITY",
    );
  });

  it("fails with MS_DECRYPTION_FAILED for a wrong passphrase", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items", documents }],
      passphrase: "right",
    });
    await expectCode(readAll(storage, manifest, { passphrase: "wrong" }), "MS_DECRYPTION_FAILED");
  });

  it.each([
    ["zstd", undefined],
    ["gzip", undefined],
    ["none", undefined],
    ["zstd", "passphrase"],
  ] as const)(
    "reports a flipped byte in a %s file (encryption: %s) as MS_INTEGRITY_FAILED",
    async (compression, encryption) => {
      const storage = memoryStorage();
      const manifest = await writeTestBackup(storage, {
        namespaces: [{ ns: "app.items", documents }],
        compression,
        ...(encryption ? { passphrase: "secret" } : {}),
      });
      const file = onlyNamespace(manifest).files[0];
      if (file === undefined) throw new Error("no file");
      await replaceStoredFile(storage, manifest, file.key, (bytes) =>
        flipByte(bytes, Math.floor(bytes.length / 2)),
      );
      await expectCode(
        readAll(storage, manifest, encryption ? { passphrase: "secret" } : undefined),
        "MS_INTEGRITY_FAILED",
      );
    },
  );

  it("reports a truncated file as MS_INTEGRITY_FAILED", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items", documents }],
      compression: "none",
    });
    const file = onlyNamespace(manifest).files[0];
    if (file === undefined) throw new Error("no file");
    // Cut at a document boundary, so only the checksum can notice.
    const firstDocumentSize = BSON.serialize(documents[0] ?? {}).length;
    await replaceStoredFile(storage, manifest, file.key, (bytes) =>
      bytes.subarray(0, firstDocumentSize),
    );
    await expectCode(readAll(storage, manifest), "MS_INTEGRITY_FAILED");
  });

  it("reports a missing file as MS_STORAGE_NOT_FOUND", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items", documents }],
    });
    const file = onlyNamespace(manifest).files[0];
    if (file === undefined) throw new Error("no file");
    await storage.delete([`backups/${manifest.id}/${file.key}`]);
    await expectCode(readAll(storage, manifest), "MS_STORAGE_NOT_FOUND");
  });

  it("stops with MS_ABORTED when the signal fires", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items", documents }],
    });
    const controller = new AbortController();
    controller.abort();
    await expectCode(readAll(storage, manifest, undefined, controller.signal), "MS_ABORTED");
  });
});

describe("readMetadataFile", () => {
  it("reads encrypted metadata with options and indexes", async () => {
    const { identity, recipient } = generateIdentity();
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [
        {
          ns: "app.items",
          documents,
          options: { capped: true, size: 4096 },
          indexes: [{ v: 2, key: { _id: 1 }, name: "_id_" }],
        },
      ],
      recipients: [recipient],
    });
    const metadata = await readMetadataFile(
      sourceFromManifest(storage, manifest, { identities: [identity] }),
      onlyNamespace(manifest).metadata,
    );
    expect(metadata).toMatchObject({ collectionName: "items", type: "collection" });
    expect(metadata.options).toEqual({ capped: true, size: new Int32(4096) });
  });

  it("reports a modified metadata file as MS_INTEGRITY_FAILED", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, { namespaces: [{ ns: "app.items" }] });
    const entry = onlyNamespace(manifest);
    await replaceStoredFile(storage, manifest, entry.metadata.key, (bytes) => flipByte(bytes, 2));
    await expectCode(
      readMetadataFile(sourceFromManifest(storage, manifest, undefined), entry.metadata),
      "MS_INTEGRITY_FAILED",
    );
  });
});

describe("checkStoredFile", () => {
  it("accepts an intact file and describes a modified one", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items", documents }],
    });
    const file = onlyNamespace(manifest).files[0];
    if (file === undefined) throw new Error("no file");
    const source = { storage, backupId: manifest.id };
    expect(await checkStoredFile(source, file)).toEqual({ ok: true, size: file.size });

    await replaceStoredFile(storage, manifest, file.key, (bytes) => flipByte(bytes, -1));
    expect(await checkStoredFile(source, file)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/SHA-256/),
    });
  });
});

describe("assertCanDecrypt", () => {
  it("throws MS_NO_IDENTITY for an encrypted backup without keys, and accepts any key", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items" }],
      passphrase: "p",
    });
    expect(() => assertCanDecrypt(manifest, undefined)).toThrow(
      expect.objectContaining({ code: "MS_NO_IDENTITY" }),
    );
    expect(() => assertCanDecrypt(manifest, { passphrase: "p" })).not.toThrow();
  });

  it("requires the passphrase for a backup with a key file, even when identities are given", async () => {
    const storage = memoryStorage();
    const written = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items" }],
      passphrase: "p",
    });
    const keyFile = { key: "backup-key.age", size: 1, sha256: "0".repeat(64) };
    const manifest = {
      ...written,
      encryption: { scheme: "age-v1" as const, recipients: ["scrypt"], keyFile },
    };
    expect(() => assertCanDecrypt(manifest, { identities: [generateIdentity().identity] })).toThrow(
      expect.objectContaining({
        code: "MS_NO_IDENTITY",
        hint: expect.stringContaining("protected with a passphrase"),
      }),
    );
    expect(() => assertCanDecrypt(manifest, { passphrase: "p" })).not.toThrow();
  });

  it("needs no keys for a KMS backup: the KMS is asked when the key file is opened", async () => {
    const storage = memoryStorage();
    const written = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.items" }],
      passphrase: "p",
    });
    const keyFile = { key: "backup-key.age", size: 1, sha256: "0".repeat(64) };
    const manifest = {
      ...written,
      encryption: { scheme: "age-v1" as const, recipients: ["kms:aws:alias/backups"], keyFile },
    };
    expect(isKmsBackup(manifest)).toBe(true);
    expect(isKmsBackup(written)).toBe(false);
    expect(() => assertCanDecrypt(manifest, undefined)).not.toThrow();
  });
});
