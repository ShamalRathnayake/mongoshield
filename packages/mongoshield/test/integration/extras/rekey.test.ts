/**
 * Rekeying real backups (src/extras/rekey.ts): recipient, passphrase and KMS backups
 * are made with the real backup engine, rekeyed, then verified and restored with the
 * new keys only. Optionally cross-checked with the official `age` CLI.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAnnotations } from "../../../src/catalog/annotations.ts";
import { rekeyBackups } from "../../../src/extras/rekey.ts";
import { resolveBackupKey } from "../../../src/format/layout.ts";
import { generateIdentity, isMongoShieldError, MongoShield } from "../../../src/index.ts";
import { memoryStorage } from "../../../src/storage/memory.ts";
import type { PutOptions, StorageAdapter } from "../../../src/storage/types.ts";
import { AWS_KEY, FakeKms, installFakeKms, otherAwsKey } from "../../helpers/fake-kms.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../../helpers/mongo.ts";

const client = useMongoClient();
const sourceDb = uniqueDb("rekey");

beforeAll(async () => {
  const db = client().db(sourceDb);
  await db
    .collection<{ _id: number; name: string }>("users")
    .insertMany(Array.from({ length: 300 }, (_, index) => ({ _id: index, name: `user ${index}` })));
  await db.collection("orders").insertMany([{ total: 1 }, { total: 2 }]);
});

afterAll(async () => {
  await client().db(sourceDb).dropDatabase();
});

/** A shield backing up the test database into `storage`. */
function shieldFor(
  storage: StorageAdapter,
  encryption: ConstructorParameters<typeof MongoShield>[0]["encryption"],
) {
  return new MongoShield({
    source: { uri: mongoUri() },
    storage,
    ...(encryption ? { encryption } : {}),
  });
}

async function restoreCount(
  shield: MongoShield,
  backup: string,
  decryption: object,
): Promise<number> {
  const target = uniqueDb("rekey_restored");
  try {
    const result = await shield.restore({
      backup,
      rename: { [`${sourceDb}.*`]: `${target}.*` },
      decryption,
    });
    return result.documentsRestored;
  } finally {
    await client().db(target).dropDatabase();
  }
}

describe("rekeyBackups", () => {
  it("hands a recipient backup to a new key without re-encrypting the data", async () => {
    const storage = memoryStorage();
    const oldKey = generateIdentity();
    const newKey = generateIdentity();
    const shield = shieldFor(storage, { recipients: [oldKey.recipient] });
    const backup = await shield.backup({ include: [`${sourceDb}.*`], consistency: "none" });

    const result = await rekeyBackups(storage, {
      backups: [backup.id],
      addRecipients: [newKey.recipient],
      removeRecipients: [oldKey.recipient],
      decryption: { identities: [oldKey.identity] },
    });
    expect(result.backups[0]).toMatchObject({ action: "rekeyed", recipients: [newKey.recipient] });

    // The catalog (and so verify, restore, list) sees the new digests and recipients.
    const [entry] = await shield.list();
    expect(entry?.manifest?.encryption?.recipients).toEqual([newKey.recipient]);
    expect((await shield.verify({ backup: backup.id })).ok).toBe(true);
    const deep = await shield.verify({
      backup: backup.id,
      mode: "deep",
      decryption: { identities: [newKey.identity] },
    });
    expect(deep.ok).toBe(true);
    expect(deep.documentsChecked).toBe(302);
    await expect(
      shield.verify({
        backup: backup.id,
        mode: "deep",
        decryption: { identities: [oldKey.identity] },
      }),
    ).rejects.toSatisfy((error) => isMongoShieldError(error, "MS_NO_IDENTITY"));
    expect(await restoreCount(shield, backup.id, { identities: [newKey.identity] })).toBe(302);

    // The complete record keeps digests, not the prepared headers.
    const { rekeys } = await readAnnotations(storage, backup.id);
    expect(rekeys).toHaveLength(1);
    expect(rekeys[0]?.status).toBe("complete");
    expect(rekeys[0]?.files.every((file) => file.header === undefined)).toBe(true);
  });

  it("reports unchanged and would-rekey without writing in a dry run", async () => {
    const storage = memoryStorage();
    const key = generateIdentity();
    const shield = shieldFor(storage, { recipients: [key.recipient] });
    const backup = await shield.backup({ include: [`${sourceDb}.*`], consistency: "none" });
    const before = storage.keys();

    const dry = await rekeyBackups(storage, {
      backups: "all",
      addRecipients: [generateIdentity().recipient],
      dryRun: true,
    });
    expect(dry.backups[0]?.action).toBe("would-rekey");
    const same = await rekeyBackups(storage, {
      backups: "latest",
      addRecipients: [key.recipient],
      decryption: { identities: [key.identity] },
    });
    expect(same.backups[0]?.action).toBe("unchanged");
    expect(storage.keys()).toEqual(before);
    expect(backup.id).toBeDefined();
  });

  it("changes the passphrase of a passphrase backup by rewriting only its key file", async () => {
    const storage = memoryStorage();
    const shield = shieldFor(storage, { passphrase: "old passphrase" });
    const backup = await shield.backup({ include: [`${sourceDb}.users`], consistency: "none" });

    const result = await rekeyBackups(storage, {
      backups: [backup.id],
      newPassphrase: "new passphrase",
      decryption: { passphrase: "old passphrase" },
    });
    expect(result.backups[0]).toMatchObject({ action: "rekeyed", files: 1 });
    expect(
      (
        await shield.verify({
          backup: backup.id,
          mode: "deep",
          decryption: { passphrase: "new passphrase" },
        })
      ).ok,
    ).toBe(true);
    await expect(
      shield.verify({
        backup: backup.id,
        mode: "deep",
        decryption: { passphrase: "old passphrase" },
      }),
    ).rejects.toSatisfy((error) => isMongoShieldError(error, "MS_DECRYPTION_FAILED"));
  });

  it("skips changes that do not fit the backup's protection", async () => {
    const storage = memoryStorage();
    const shield = shieldFor(storage, { passphrase: "a passphrase" });
    await shield.backup({ include: [`${sourceDb}.users`], consistency: "none" });
    const result = await rekeyBackups(storage, {
      backups: "all",
      addRecipients: [generateIdentity().recipient],
    });
    expect(result.backups[0]?.action).toBe("skipped");
    expect(result.backups[0]?.reason).toMatch(/only the passphrase/);
  });

  it("rotates KMS keys and adds a recovery recipient on a KMS backup", async () => {
    const kms = new FakeKms();
    const uninstall = installFakeKms(kms);
    try {
      const storage = memoryStorage();
      const shield = shieldFor(storage, { kms: [{ provider: "aws", key: AWS_KEY }] });
      const backup = await shield.backup({ include: [`${sourceDb}.*`], consistency: "none" });
      const recovery = generateIdentity();
      const newKmsKey = otherAwsKey();

      const result = await rekeyBackups(storage, {
        backups: [backup.id],
        addRecipients: [recovery.recipient],
        addKms: [{ provider: "aws", key: newKmsKey }],
        removeKms: [{ provider: "aws", key: AWS_KEY }],
      });
      expect(result.backups[0]?.recipients).toEqual([`kms:aws:${newKmsKey}`, recovery.recipient]);

      // The recovery identity opens every file directly, without the KMS.
      kms.denied.add(AWS_KEY);
      kms.denied.add(newKmsKey);
      expect(await restoreCount(shield, backup.id, { identities: [recovery.identity] })).toBe(302);

      // The new KMS key unlocks the key file; the removed one is no longer in it.
      kms.denied.delete(newKmsKey);
      const deep = await shield.verify({ backup: backup.id, mode: "deep" });
      expect(deep.ok).toBe(true);
      kms.denied.add(newKmsKey);
      kms.denied.delete(AWS_KEY);
      await expect(shield.verify({ backup: backup.id, mode: "deep" })).rejects.toThrow();
    } finally {
      uninstall();
    }
  });

  it("refuses object-locked backups", async () => {
    const storage = memoryStorage({ objectLock: true });
    const key = generateIdentity();
    const shield = shieldFor(storage, { recipients: [key.recipient] });
    const backup = await shield.backup({
      include: [`${sourceDb}.users`],
      consistency: "none",
      retainDays: 1,
    });
    await expect(
      rekeyBackups(storage, {
        backups: [backup.id],
        addRecipients: [generateIdentity().recipient],
        decryption: { identities: [key.identity] },
      }),
    ).rejects.toThrow(/object-locked/);
    const all = await rekeyBackups(storage, {
      backups: "all",
      addRecipients: [generateIdentity().recipient],
      decryption: { identities: [key.identity] },
    });
    expect(all.backups[0]?.action).toBe("skipped");
  });

  it("finishes an interrupted rekey on the next run, without keys", async () => {
    const memory = memoryStorage();
    const key = generateIdentity();
    const newKey = generateIdentity();
    const shield = shieldFor(memory, { recipients: [key.recipient] });
    const backup = await shield.backup({ include: [`${sourceDb}.*`], consistency: "none" });

    // A storage that fails the third data-file rewrite, like a crash half-way.
    let rewrites = 0;
    const flaky: StorageAdapter = {
      kind: memory.kind,
      location: memory.location,
      capabilities: memory.capabilities,
      get: (objectKey, options) => memory.get(objectKey, options),
      head: (objectKey, options) => memory.head(objectKey, options),
      list: (prefix, options) => memory.list(prefix, options),
      listPrefixes: (prefix, options) => memory.listPrefixes(prefix, options),
      delete: (keys, options) => memory.delete(keys, options),
      async put(objectKey, body, options?: PutOptions) {
        if (objectKey.startsWith("backups/") && ++rewrites === 3) {
          throw new Error("simulated crash");
        }
        return memory.put(objectKey, body, options);
      },
    };
    await expect(
      rekeyBackups(flaky, {
        backups: [backup.id],
        addRecipients: [newKey.recipient],
        decryption: { identities: [key.identity] },
      }),
    ).rejects.toThrow(/simulated crash/);
    expect((await readAnnotations(memory, backup.id)).rekeys[0]?.status).toBe("pending");

    const resumed = await rekeyBackups(memory, { backups: [backup.id] });
    expect(resumed.backups[0]).toMatchObject({ action: "unchanged", resumed: true });
    expect((await shield.verify({ backup: backup.id })).ok).toBe(true);
    const deep = await shield.verify({
      backup: backup.id,
      mode: "deep",
      decryption: { identities: [newKey.identity] },
    });
    expect(deep.ok).toBe(true);
  });
});

function commandWorks(command: string): boolean {
  return spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0;
}

describe.skipIf(!commandWorks("age"))("rekeyed files and the age CLI", () => {
  it("can be decrypted by the age CLI with the new identity", async () => {
    const storage = memoryStorage();
    const oldKey = generateIdentity();
    const newKey = generateIdentity();
    const shield = shieldFor(storage, { recipients: [oldKey.recipient] });
    const backup = await shield.backup({
      include: [`${sourceDb}.users`],
      consistency: "none",
    });
    await rekeyBackups(storage, {
      backups: [backup.id],
      addRecipients: [newKey.recipient],
      removeRecipients: [oldKey.recipient],
      decryption: { identities: [oldKey.identity] },
    });
    const metadata = backup.manifest.namespaces[0]?.metadata.key ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(resolveBackupKey(backup.id, metadata))) {
      chunks.push(chunk as Buffer);
    }
    const directory = mkdtempSync(join(tmpdir(), "mongoshield-rekey-age-"));
    try {
      writeFileSync(join(directory, "key.txt"), `${newKey.identity}\n`, { mode: 0o600 });
      const result = spawnSync("age", ["-d", "-i", join(directory, "key.txt")], {
        input: Buffer.concat(chunks),
      });
      expect(result.status, String(result.stderr)).toBe(0);
      expect(String(result.stdout)).toContain("users");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
