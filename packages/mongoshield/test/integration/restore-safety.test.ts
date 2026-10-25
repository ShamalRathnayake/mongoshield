// Integration tests for restore safety: encrypted backups (identity, passphrase,
// missing and wrong keys), damaged files, aborts and missing backups. Every failure
// before the data phase must leave the target untouched; failures during it must
// never be reported as success.

import { describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { type ErrorCode, isMongoShieldError } from "../../src/errors.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { RestoreOptions } from "../../src/types.ts";
import {
  flipByte,
  replaceStoredFile,
  type WriteTestBackupOptions,
  writeTestBackup,
} from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

const documents = Array.from({ length: 3000 }, (_, index) => ({ _id: index, value: `v${index}` }));

async function backup(
  options: Partial<WriteTestBackupOptions> = {},
): Promise<{ storage: MemoryStorage; manifest: Manifest }> {
  const storage = memoryStorage();
  const manifest = await writeTestBackup(storage, {
    namespaces: [
      { ns: "app.a", documents, documentsPerPart: 1000 },
      { ns: "app.b", documents: documents.slice(0, 10) },
    ],
    ...options,
  });
  return { storage, manifest };
}

function restore(storage: MemoryStorage, target: string, options: Partial<RestoreOptions> = {}) {
  return runRestore(
    { client: client(), storage, logger: silentLogger },
    { backup: "latest", rename: { "app.*": `${target}.*` }, ...options },
  );
}

async function expectFailure(promise: Promise<unknown>, code: ErrorCode): Promise<Error> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${code}, but the restore succeeded`);
    },
    (caught: unknown) => caught,
  );
  if (!isMongoShieldError(error, code)) {
    throw new Error(`expected ${code}, got ${String(error)}`, { cause: error });
  }
  return error;
}

async function collectionNames(database: string): Promise<string[]> {
  const infos = await client().db(database).listCollections().toArray();
  return infos.map((info) => info.name).sort();
}

describe("encrypted backups", () => {
  it("restores with the matching identity", async () => {
    const { identity, recipient } = generateIdentity();
    const { storage } = await backup({ recipients: [recipient] });
    const target = uniqueDb("rs");
    const result = await restore(storage, target, { decryption: { identities: [identity] } });
    expect(result.documentsRestored).toBe(3010);
  });

  it("restores with the passphrase", async () => {
    const { storage } = await backup({ passphrase: "open sesame" });
    const target = uniqueDb("rs");
    const result = await restore(storage, target, { decryption: { passphrase: "open sesame" } });
    expect(result.documentsRestored).toBe(3010);
  });

  it("fails with MS_NO_IDENTITY before writing anything when no key is given", async () => {
    const { storage } = await backup({ passphrase: "p" });
    const target = uniqueDb("rs");
    const error = await expectFailure(restore(storage, target), "MS_NO_IDENTITY");
    expect(error.message).toMatch(/encrypted/);
    expect(await collectionNames(target)).toEqual([]);
  });

  it("fails with MS_NO_IDENTITY before writing anything for a wrong identity", async () => {
    const { storage } = await backup({ recipients: [generateIdentity().recipient] });
    const target = uniqueDb("rs");
    await expectFailure(
      restore(storage, target, { decryption: { identities: [generateIdentity().identity] } }),
      "MS_NO_IDENTITY",
    );
    expect(await collectionNames(target)).toEqual([]);
  });

  it("fails with MS_DECRYPTION_FAILED before writing anything for a wrong passphrase", async () => {
    const { storage } = await backup({ passphrase: "right" });
    const target = uniqueDb("rs");
    await expectFailure(
      restore(storage, target, { decryption: { passphrase: "wrong" } }),
      "MS_DECRYPTION_FAILED",
    );
    expect(await collectionNames(target)).toEqual([]);
  });

  it("validates the key in a dry run too", async () => {
    const { storage } = await backup({ passphrase: "right" });
    await expectFailure(restore(storage, uniqueDb("rs"), { dryRun: true }), "MS_NO_IDENTITY");
  });
});

describe("damaged backups", () => {
  it.each([
    ["an unencrypted", {}],
    ["an encrypted", { passphrase: "p" }],
  ] as const)(
    "fails with MS_INTEGRITY_FAILED for a flipped byte in %s data file",
    async (_label, encryption) => {
      const { storage, manifest } = await backup(encryption);
      const lastPart = manifest.namespaces[0]?.files[2];
      if (lastPart === undefined) throw new Error("no third part");
      await replaceStoredFile(storage, manifest, lastPart.key, (bytes) =>
        flipByte(bytes, Math.floor(bytes.length / 2)),
      );
      const target = uniqueDb("rs");
      const error = await expectFailure(
        restore(storage, target, {
          ...("passphrase" in encryption ? { decryption: { passphrase: "p" } } : {}),
        }),
        "MS_INTEGRITY_FAILED",
      );
      // The error says what may be partial, so nobody mistakes it for a success.
      expect(error.message).toMatch(/possibly partial: .*\.a/);
      expect(error.message).toContain(lastPart.key);
    },
  );

  it("fails before writing anything when a metadata file is damaged", async () => {
    const { storage, manifest } = await backup();
    const metadata = manifest.namespaces[1]?.metadata;
    if (metadata === undefined) throw new Error("no metadata");
    await replaceStoredFile(storage, manifest, metadata.key, (bytes) => flipByte(bytes, 3));
    const target = uniqueDb("rs");
    await expectFailure(restore(storage, target), "MS_INTEGRITY_FAILED");
    expect(await collectionNames(target)).toEqual([]);
  });

  it("fails with MS_STORAGE_NOT_FOUND when a data file is missing", async () => {
    const { storage, manifest } = await backup();
    const file = manifest.namespaces[1]?.files[0];
    if (file === undefined) throw new Error("no file");
    await storage.delete([`backups/${manifest.id}/${file.key}`]);
    await expectFailure(restore(storage, uniqueDb("rs")), "MS_STORAGE_NOT_FOUND");
  });
});

describe("aborting and selection", () => {
  it("does nothing when the signal is already aborted", async () => {
    const { storage } = await backup();
    const target = uniqueDb("rs");
    const controller = new AbortController();
    controller.abort();
    await expectFailure(restore(storage, target, { signal: controller.signal }), "MS_ABORTED");
    expect(await collectionNames(target)).toEqual([]);
  });

  it("stops with MS_ABORTED when aborted while documents are loading", async () => {
    const { storage } = await backup();
    const target = uniqueDb("rs");
    const controller = new AbortController();
    const error = await expectFailure(
      restore(storage, target, {
        signal: controller.signal,
        parallelism: 1,
        onProgress: (event) => {
          if (event.type === "namespace:start") controller.abort();
        },
      }),
      "MS_ABORTED",
    );
    expect(error.message).toMatch(/Restore stopped/);
    expect(await client().db(target).collection("a").countDocuments()).toBeLessThan(3000);
  });

  it("fails with MS_BACKUP_NOT_FOUND for an unknown backup id", async () => {
    const { storage } = await backup();
    await expectFailure(
      restore(storage, uniqueDb("rs"), { backup: "2020-01-01T00-00-00Z_abcdef" }),
      "MS_BACKUP_NOT_FOUND",
    );
  });
});
