// Integration tests for KMS-protected backups: the per-backup key envelope
// (`backup-key.age`) wrapped by cloud KMS keys, data files encrypted to the backup's
// own recipient plus offline recovery recipients, and every reader (restore, verify)
// unlocking it through the KMS or bypassing the KMS with a recovery identity.
// The KMS is the in-memory fake behind the real adapters: no network.

import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDecryptStream,
  generateIdentity,
  identityToRecipient,
  parseIdentityFile,
} from "../../src/crypto/index.ts";
import {
  createGcpKmsClient,
  createKmsKeyUnwrapper,
  type GcpKmsSdkClient,
  setKmsClientFactory,
} from "../../src/crypto/kms/index.ts";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { verifyBackup } from "../../src/engine/verify.ts";
import { isMongoShieldError, type MongoShieldError } from "../../src/errors.ts";
import { resolveBackupKey } from "../../src/format/layout.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { DecryptionOptions, EncryptionOptions, KmsKeyRef } from "../../src/types.ts";
import { readStreamToBuffer } from "../../src/util/streams.ts";
import {
  AWS_ALIAS,
  AWS_KEY,
  AZURE_KEY,
  FakeKms,
  fakeGcpSdkClient,
  GCP_KEY,
  installFakeKms,
} from "../helpers/fake-kms.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import {
  backupContext,
  decodeDataFile,
  expectFilesMatchManifest,
  readObject,
  sourceDocuments,
} from "./backup-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("bkkms");
const COLLECTIONS = ["alpha", "beta", "gamma"];
/**
 * Files verify checks: metadata and data per collection, the key envelope, and the
 * changes file (consistency "auto" is "converge" on the test replica set).
 */
const FILES_PER_BACKUP = COLLECTIONS.length * 2 + 2;
const DOCUMENTS = 150 + 300 + 450;
const targets: string[] = [];

const AWS: KmsKeyRef = { provider: "aws", key: AWS_ALIAS };
const GCP: KmsKeyRef = { provider: "gcp", key: GCP_KEY };
const AZURE: KmsKeyRef = { provider: "azure", key: AZURE_KEY };

let kms: FakeKms;
let uninstall: () => void;

beforeAll(async () => {
  const db = client().db(database);
  for (const [index, name] of COLLECTIONS.entries()) {
    await db
      .collection(name)
      .insertMany(Array.from({ length: 150 * (index + 1) }, (_, n) => ({ n, name })));
  }
  await db.collection("alpha").createIndex({ n: -1 }, { name: "n_desc" });
  // One fake KMS for the whole file: its master keys must outlive each test.
  kms = new FakeKms();
  uninstall = installFakeKms(kms);
});

afterAll(async () => {
  uninstall();
  await client().db(database).dropDatabase();
  for (const target of targets) await client().db(target).dropDatabase();
});

beforeEach(() => {
  kms.calls.length = 0;
});

// After each test (not before), so the next describe's beforeAll backup is not denied.
afterEach(() => {
  kms.denied.clear();
});

async function kmsBackup(
  encryption: EncryptionOptions,
): Promise<{ storage: MemoryStorage; manifest: Manifest }> {
  const storage = memoryStorage();
  const { manifest } = await runBackup(backupContext(client(), storage, { encryption }), {
    include: [`${database}.*`],
  });
  return { storage, manifest };
}

/** The stanza types (`X25519`, `mongoshield-kms`, …) in a stored age file's header. */
async function stanzaTypes(storage: MemoryStorage, key: string): Promise<string[]> {
  const header = (await readObject(storage, key)).subarray(0, 4096).toString("latin1");
  const end = header.indexOf("\n---");
  return [...header.slice(0, end).matchAll(/^-> (\S+)/gm)].map((match) => match[1] ?? "");
}

function restore(storage: MemoryStorage, manifest: Manifest, decryption?: DecryptionOptions) {
  const target = uniqueDb("bkkms_rs");
  targets.push(target);
  return {
    target,
    result: runRestore(
      { client: client(), storage, logger: silentLogger },
      {
        backup: manifest.id,
        rename: { [`${database}.*`]: `${target}.*` },
        ...(decryption ? { decryption } : {}),
      },
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

/** Decrypts a stored file with the given options (no engine involved). */
async function decryptStored(
  storage: MemoryStorage,
  key: string,
  options: Parameters<typeof createDecryptStream>[0],
): Promise<Buffer> {
  const stored = await readObject(storage, key);
  return readStreamToBuffer(Readable.from([stored]).pipe(createDecryptStream(options)), {
    maxBytes: 1024 * 1024 * 1024,
  });
}

/** Overwrites a stored object with one byte changed. */
async function tamper(storage: MemoryStorage, key: string): Promise<void> {
  const bytes = Buffer.from(await readObject(storage, key));
  const middle = Math.floor(bytes.length / 2);
  bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
  await storage.put(key, bytes);
}

describe("a KMS-only backup", () => {
  let storage: MemoryStorage;
  let manifest: Manifest;

  beforeAll(async () => {
    ({ storage, manifest } = await kmsBackup({ kms: [AWS] }));
  });

  it("records the KMS key and the key file in the manifest", async () => {
    expect(manifest.encryption).toMatchObject({
      scheme: "age-v1",
      recipients: [`kms:aws:${AWS_ALIAS}`],
      keyFile: { key: "backup-key.age" },
    });
    await expectFilesMatchManifest(storage, manifest);
  });

  it("wraps only the key file with the KMS; data files use the backup's own recipient", async () => {
    expect(await stanzaTypes(storage, resolveBackupKey(manifest.id, "backup-key.age"))).toEqual([
      "mongoshield-kms",
    ]);
    for (const entry of manifest.namespaces) {
      for (const file of [entry.metadata, ...entry.files]) {
        expect(await stanzaTypes(storage, resolveBackupKey(manifest.id, file.key))).toEqual([
          "X25519",
        ]);
      }
    }
  });

  it("keeps no plaintext identity in storage", async () => {
    for (const key of storage.keys()) {
      expect((await readObject(storage, key)).toString("latin1")).not.toContain("AGE-SECRET-KEY-");
    }
  });

  it("restores with no keys at all, with one KMS call for the whole run", async () => {
    const { target, result } = restore(storage, manifest);
    expect((await result).documentsRestored).toBe(DOCUMENTS);
    const indexes = await client().db(target).collection("alpha").indexes();
    expect(indexes.map((index) => index.name)).toContain("n_desc");
    expect(kms.calls).toEqual([{ provider: "aws", operation: "decrypt", key: AWS_KEY }]);
  });

  it("refuses access denied with MS_DECRYPTION_FAILED naming kms:Decrypt, before writing", async () => {
    kms.denied.add(AWS_KEY);
    const { target, result } = restore(storage, manifest);
    const error = await failure(result);
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
    expect(error.hint).toContain("kms:Decrypt");
    expect(await client().db(target).listCollections().toArray()).toEqual([]);
  });

  it("passes fast verification without any KMS call, and deep verification with one", async () => {
    const context = { storage, logger: silentLogger };
    const fast = await verifyBackup(context, { backup: manifest.id });
    expect(fast).toMatchObject({ ok: true, filesChecked: FILES_PER_BACKUP });
    expect(kms.calls).toEqual([]);
    const deep = await verifyBackup(context, { backup: manifest.id, mode: "deep" });
    expect(deep).toMatchObject({ ok: true, documentsChecked: DOCUMENTS, problems: [] });
    expect(kms.calls).toHaveLength(1);
  });

  it("makes deep verification fail like any key problem when access is denied", async () => {
    kms.denied.add(AWS_KEY);
    const error = await failure(
      verifyBackup({ storage, logger: silentLogger }, { backup: manifest.id, mode: "deep" }),
    );
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
  });

  it("ignores identities that are not recovery recipients and still uses the KMS", async () => {
    const { result } = restore(storage, manifest, { identities: [generateIdentity().identity] });
    expect((await result).documentsRestored).toBe(DOCUMENTS);
    expect(kms.calls).toHaveLength(1);
  });
});

describe("a KMS backup with an offline recovery recipient", () => {
  const recovery = generateIdentity();
  let storage: MemoryStorage;
  let manifest: Manifest;

  beforeAll(async () => {
    ({ storage, manifest } = await kmsBackup({ kms: [GCP], recipients: [recovery.recipient] }));
  });

  it("lists the KMS key and the recovery recipient in the manifest", () => {
    expect(manifest.encryption?.recipients).toEqual([`kms:gcp:${GCP_KEY}`, recovery.recipient]);
  });

  it("encrypts every data file to the backup's recipient and the recovery recipient", async () => {
    for (const entry of manifest.namespaces) {
      for (const file of [entry.metadata, ...entry.files]) {
        expect(await stanzaTypes(storage, resolveBackupKey(manifest.id, file.key))).toEqual([
          "X25519",
          "X25519",
        ]);
      }
    }
  });

  it("restores with only the recovery identity, without contacting the KMS", async () => {
    // Make any KMS use fail loudly: the recovery path must not need the cloud.
    const restoreFactory = setKmsClientFactory("gcp", () => {
      throw new Error("the KMS must not be contacted");
    });
    try {
      const { result } = restore(storage, manifest, { identities: [recovery.identity] });
      expect((await result).documentsRestored).toBe(DOCUMENTS);
    } finally {
      restoreFactory();
    }
    expect(kms.calls).toEqual([]);
  });

  it("lets the recovery identity decrypt data files directly, as the age CLI would", async () => {
    for (const name of COLLECTIONS) {
      const ns = `${database}.${name}`;
      const stored = await decodeDataFile(storage, manifest, ns, {
        identities: [recovery.identity],
      });
      const source = await sourceDocuments(client(), ns);
      expect(Buffer.concat(stored).equals(Buffer.concat(source))).toBe(true);
    }
  });

  it("stores the backup identity in the key file, openable through the stanza-aware path", async () => {
    const keyFile = resolveBackupKey(manifest.id, "backup-key.age");
    // The recovery identity cannot open the key file: it holds only KMS stanzas.
    const refused = await failure(
      decryptStored(storage, keyFile, { identities: [recovery.identity] }),
    );
    expect(refused.code).toBe("MS_NO_IDENTITY");

    const text = (
      await decryptStored(storage, keyFile, { keyUnwrappers: [createKmsKeyUnwrapper()] })
    ).toString("utf8");
    const [identity] = parseIdentityFile(text);
    if (identity === undefined) throw new Error("no identity");
    expect(text).toContain(`# public key: ${identityToRecipient(identity)}`);

    // ... and that identity opens a data file, next to the recovery stanza.
    const metadata = manifest.namespaces[0]?.metadata.key ?? "";
    const plaintext = await decryptStored(storage, resolveBackupKey(manifest.id, metadata), {
      identities: [identity],
    });
    expect(plaintext.toString("utf8")).toContain("indexes");
  });

  it("restores through the KMS when no identity is given", async () => {
    const { result } = restore(storage, manifest);
    expect((await result).documentsRestored).toBe(DOCUMENTS);
    expect(kms.calls).toEqual([{ provider: "gcp", operation: "decrypt", key: GCP_KEY }]);
  });
});

describe("a backup protected by several KMS providers", () => {
  let storage: MemoryStorage;
  let manifest: Manifest;

  beforeAll(async () => {
    ({ storage, manifest } = await kmsBackup({ kms: [AWS, GCP, AZURE] }));
  });

  it("wraps the key file once per KMS key", async () => {
    expect(await stanzaTypes(storage, resolveBackupKey(manifest.id, "backup-key.age"))).toEqual([
      "mongoshield-kms",
      "mongoshield-kms",
      "mongoshield-kms",
    ]);
  });

  it("restores through Azure when AWS and GCP deny access", async () => {
    kms.denied.add(AWS_KEY);
    kms.denied.add(GCP_KEY);
    const { result } = restore(storage, manifest);
    expect((await result).documentsRestored).toBe(DOCUMENTS);
    // Azure was asked for the versioned key it reported when wrapping.
    expect(kms.calls.at(-1)).toEqual({
      provider: "azure",
      operation: "decrypt",
      key: `${AZURE_KEY}/0123456789abcdef`,
    });
  });

  it("reports the first refusal when every KMS denies access", async () => {
    for (const key of [AWS_KEY, GCP_KEY, AZURE_KEY]) kms.denied.add(key);
    const error = await failure(restore(storage, manifest).result);
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
    expect(error.hint).toContain("kms:Decrypt");
  });
});

describe("a tampered KMS key file", () => {
  let storage: MemoryStorage;
  let manifest: Manifest;

  beforeAll(async () => {
    ({ storage, manifest } = await kmsBackup({ kms: [AWS] }));
    await tamper(storage, resolveBackupKey(manifest.id, "backup-key.age"));
  });

  it("makes restore fail with MS_INTEGRITY_FAILED", async () => {
    const { result } = restore(storage, manifest);
    expect((await failure(result)).code).toBe("MS_INTEGRITY_FAILED");
  });

  it("is reported by fast and deep verification", async () => {
    const context = { storage, logger: silentLogger };
    const fast = await verifyBackup(context, { backup: manifest.id });
    expect(fast.problems.map((problem) => problem.subject)).toEqual(["backup-key.age"]);
    const deep = await verifyBackup(context, { backup: manifest.id, mode: "deep" });
    expect(deep.ok).toBe(false);
    expect(deep.problems.every((problem) => problem.subject === "backup-key.age")).toBe(true);
  });
});

describe("KMS backups that cannot be written", () => {
  it("fail before any data is stored when the KMS denies encryption", async () => {
    kms.denied.add(AWS_KEY);
    const storage = memoryStorage();
    const error = await failure(
      runBackup(backupContext(client(), storage, { encryption: { kms: [AWS] } }), {
        include: [`${database}.*`],
      }),
    );
    expect(error.code).toBe("MS_ENCRYPTION_FAILED");
    expect(error.hint).toContain("kms:Encrypt");
    expect(storage.keys()).toEqual([]);
  });

  it("refuse a passphrase combined with KMS keys", async () => {
    const error = await failure(
      runBackup(
        backupContext(client(), memoryStorage(), {
          encryption: { passphrase: "p", kms: [AWS] },
        }),
        { include: [`${database}.*`] },
      ),
    );
    expect(error.code).toBe("MS_CONFIG_INVALID");
  });
});

describe("KMS calls are cancelled with the run", () => {
  /** A GCP client whose requests never answer, behind the real adapter. */
  function hangGcp(operation: "encrypt" | "decrypt"): () => void {
    const never = new Promise<never>(() => {});
    return setKmsClientFactory("gcp", (ref) => {
      const answering = fakeGcpSdkClient(kms);
      const client: GcpKmsSdkClient = {
        encrypt: (request) => (operation === "encrypt" ? never : answering.encrypt(request)),
        decrypt: (request) => (operation === "decrypt" ? never : answering.decrypt(request)),
      };
      return createGcpKmsClient(ref.key, { client });
    });
  }

  it("a backup aborted while the KMS wraps the key fails with MS_ABORTED", async () => {
    const restoreFactory = hangGcp("encrypt");
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const error = await failure(
        runBackup(backupContext(client(), memoryStorage(), { encryption: { kms: [GCP] } }), {
          include: [`${database}.*`],
          signal: controller.signal,
        }),
      );
      expect(error.code).toBe("MS_ABORTED");
    } finally {
      restoreFactory();
    }
  });

  it("a restore aborted while the KMS unwraps the key fails with MS_ABORTED", async () => {
    const { storage, manifest } = await kmsBackup({ kms: [GCP] });
    const restoreFactory = hangGcp("decrypt");
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const target = uniqueDb("bkkms_rs");
      targets.push(target);
      const error = await failure(
        runRestore(
          { client: client(), storage, logger: silentLogger },
          {
            backup: manifest.id,
            rename: { [`${database}.*`]: `${target}.*` },
            signal: controller.signal,
          },
        ),
      );
      expect(error.code).toBe("MS_ABORTED");
    } finally {
      restoreFactory();
    }
  });
});
