// Integration tests for passphrase backups and their per-backup key envelope
// (`backup-key.age`): one scrypt per backup, files encrypted to a one-off X25519
// identity, and every reader (restore, verify) unlocking the envelope correctly.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateIdentity,
  identityToRecipient,
  parseIdentityFile,
} from "../../src/crypto/index.ts";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { verifyBackup } from "../../src/engine/verify.ts";
import { isMongoShieldError, type MongoShieldError } from "../../src/errors.ts";
import { resolveBackupKey } from "../../src/format/layout.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { DecryptionOptions } from "../../src/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import {
  backupContext,
  decodeDataFile,
  decryptKeyFile,
  expectFilesMatchManifest,
  readObject,
  sourceDocuments,
} from "./backup-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("bkpass");
const PASSPHRASE = "correct horse battery staple";
const COLLECTIONS = ["alpha", "beta", "gamma", "delta"];
/**
 * Files verify checks: metadata and data per collection, the key envelope, and the
 * changes file (consistency "auto" is "converge" on the test replica set).
 */
const FILES_PER_BACKUP = COLLECTIONS.length * 2 + 2;
const targets: string[] = [];

beforeAll(async () => {
  const db = client().db(database);
  for (const [index, name] of COLLECTIONS.entries()) {
    await db
      .collection(name)
      .insertMany(Array.from({ length: 200 * (index + 1) }, (_, n) => ({ n, name })));
  }
  await db.collection("alpha").createIndex({ n: -1 }, { name: "n_desc" });
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  for (const target of targets) await client().db(target).dropDatabase();
});

/** A fresh passphrase backup of this file's database, in its own storage. */
async function passphraseBackup(): Promise<{ storage: MemoryStorage; manifest: Manifest }> {
  const storage = memoryStorage();
  const { manifest } = await runBackup(
    backupContext(client(), storage, { encryption: { passphrase: PASSPHRASE } }),
    { include: [`${database}.*`] },
  );
  return { storage, manifest };
}

/** The stanza types (`X25519`, `scrypt`, …) in a stored age file's header. */
async function stanzaTypes(storage: MemoryStorage, key: string): Promise<string[]> {
  const header = (await readObject(storage, key)).subarray(0, 1024).toString("latin1");
  return [...header.matchAll(/^-> (\S+)/gm)].map((match) => match[1] ?? "");
}

function restore(storage: MemoryStorage, manifest: Manifest, decryption: DecryptionOptions) {
  const target = uniqueDb("bkpass_rs");
  targets.push(target);
  return {
    target,
    result: runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: manifest.id, rename: { [`${database}.*`]: `${target}.*` }, decryption },
    ),
  };
}

async function failure(promise: Promise<unknown>): Promise<MongoShieldError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isMongoShieldError(error))
    throw new Error(`expected a MongoShieldError, got ${String(error)}`);
  return error;
}

/** Overwrites a stored object with one byte changed. */
async function tamper(storage: MemoryStorage, key: string): Promise<void> {
  const bytes = Buffer.from(await readObject(storage, key));
  const last = bytes.length - 1;
  bytes[last] = (bytes[last] ?? 0) ^ 0xff;
  await storage.put(key, bytes);
}

describe("passphrase backups", () => {
  let storage: MemoryStorage;
  let manifest: Manifest;

  beforeAll(async () => {
    ({ storage, manifest } = await passphraseBackup());
  });

  it("records a key file and only the scrypt label in the manifest", async () => {
    expect(manifest.encryption).toMatchObject({ scheme: "age-v1", recipients: ["scrypt"] });
    expect(manifest.encryption?.keyFile?.key).toBe("backup-key.age");
    expect(JSON.stringify(manifest)).not.toContain("horse");
    await expectFilesMatchManifest(storage, manifest);
    const keyFile = manifest.encryption?.keyFile;
    if (keyFile === undefined) throw new Error("no key file");
    const stored = await storage.head(resolveBackupKey(manifest.id, keyFile.key));
    expect(stored?.size).toBe(keyFile.size);
  });

  it("runs scrypt once: only the key file has a passphrase stanza", async () => {
    const keyFileKey = resolveBackupKey(manifest.id, "backup-key.age");
    expect(await stanzaTypes(storage, keyFileKey)).toEqual(["scrypt"]);

    const files = manifest.namespaces.flatMap((entry) => [entry.metadata, ...entry.files]);
    expect(files).toHaveLength(COLLECTIONS.length * 2);
    for (const file of files) {
      expect(await stanzaTypes(storage, resolveBackupKey(manifest.id, file.key))).toEqual([
        "X25519",
      ]);
    }
  });

  it("stores the identity as an age-keygen key file, never in plaintext", async () => {
    const text = await decryptKeyFile(storage, manifest, PASSPHRASE);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^# created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const [identity] = parseIdentityFile(text);
    if (identity === undefined) throw new Error("no identity");
    expect(lines[1]).toBe(`# public key: ${identityToRecipient(identity)}`);

    for (const key of storage.keys()) {
      expect((await readObject(storage, key)).toString("latin1")).not.toContain("AGE-SECRET-KEY-");
    }
  });

  it("decrypts every data file with the identity from the key file", async () => {
    for (const name of COLLECTIONS) {
      const ns = `${database}.${name}`;
      const stored = await decodeDataFile(storage, manifest, ns, { passphrase: PASSPHRASE });
      const source = await sourceDocuments(client(), ns);
      expect(Buffer.concat(stored).equals(Buffer.concat(source))).toBe(true);
    }
  });

  it("restores with the passphrase", async () => {
    const { target, result } = restore(storage, manifest, { passphrase: PASSPHRASE });
    expect((await result).documentsRestored).toBe(200 + 400 + 600 + 800);
    const indexes = await client().db(target).collection("alpha").indexes();
    expect(indexes.map((index) => index.name)).toContain("n_desc");
    expect(await client().db(target).collection("delta").countDocuments()).toBe(800);
  });

  it("refuses a wrong passphrase with MS_DECRYPTION_FAILED before writing", async () => {
    const { target, result } = restore(storage, manifest, { passphrase: "wrong" });
    expect((await failure(result)).code).toBe("MS_DECRYPTION_FAILED");
    expect(await client().db(target).listCollections().toArray()).toEqual([]);
  });

  it("refuses identities alone, explaining that a passphrase is needed", async () => {
    const { result } = restore(storage, manifest, {
      identities: [generateIdentity().identity],
    });
    const error = await failure(result);
    expect(error.code).toBe("MS_NO_IDENTITY");
    expect(error.hint).toContain("protected with a passphrase");
  });

  it("passes fast verification (key file included) and deep verification", async () => {
    const context = { storage, logger: silentLogger };
    const fast = await verifyBackup(context, { backup: manifest.id });
    expect(fast).toMatchObject({ ok: true, filesChecked: FILES_PER_BACKUP });
    const deep = await verifyBackup(context, {
      backup: manifest.id,
      mode: "deep",
      decryption: { passphrase: PASSPHRASE },
    });
    expect(deep).toMatchObject({ ok: true, documentsChecked: 2000, problems: [] });
    expect(deep.filesChecked).toBe(FILES_PER_BACKUP);
  });

  it("makes deep verification with a wrong passphrase fail like any key problem", async () => {
    const error = await failure(
      verifyBackup(
        { storage, logger: silentLogger },
        { backup: manifest.id, mode: "deep", decryption: { passphrase: "wrong" } },
      ),
    );
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
  });
});

describe("a tampered key file", () => {
  let storage: MemoryStorage;
  let manifest: Manifest;

  beforeAll(async () => {
    ({ storage, manifest } = await passphraseBackup());
    await tamper(storage, resolveBackupKey(manifest.id, "backup-key.age"));
  });

  it("makes restore fail with MS_INTEGRITY_FAILED", async () => {
    const { result } = restore(storage, manifest, { passphrase: PASSPHRASE });
    expect((await failure(result)).code).toBe("MS_INTEGRITY_FAILED");
  });

  it("is reported by fast verification", async () => {
    const report = await verifyBackup({ storage, logger: silentLogger }, { backup: manifest.id });
    expect(report.ok).toBe(false);
    expect(report.problems.map((problem) => problem.subject)).toEqual(["backup-key.age"]);
  });

  it("is reported by deep verification, which still checksums the other files", async () => {
    const report = await verifyBackup(
      { storage, logger: silentLogger },
      { backup: manifest.id, mode: "deep", decryption: { passphrase: PASSPHRASE } },
    );
    expect(report.ok).toBe(false);
    expect(report.problems.every((problem) => problem.subject === "backup-key.age")).toBe(true);
    expect(report.problems[0]?.problem).toContain("integrity");
    expect(report.filesChecked).toBe(FILES_PER_BACKUP);
  });
});
