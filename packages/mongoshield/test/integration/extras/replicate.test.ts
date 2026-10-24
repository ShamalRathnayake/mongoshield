/**
 * Replicating backups between storage locations (src/extras/replicate.ts), with real
 * backups of the test replica set and in-memory storage on both sides.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordErasure } from "../../../src/extras/erasure.ts";
import { rekeyBackups } from "../../../src/extras/rekey.ts";
import { replicateBackups, replicateToTargets } from "../../../src/extras/replicate.ts";
import { manifestKey, resolveBackupKey } from "../../../src/format/layout.ts";
import { generateIdentity, isMongoShieldError, MongoShield } from "../../../src/index.ts";
import { type MemoryStorage, memoryStorage } from "../../../src/storage/memory.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../../helpers/mongo.ts";

const client = useMongoClient();
const sourceDb = uniqueDb("replicate");
const key = generateIdentity();

beforeAll(async () => {
  await client()
    .db(sourceDb)
    .collection<{ _id: number; value: string }>("items")
    .insertMany(
      Array.from({ length: 200 }, (_, index) => ({ _id: index, value: `item ${index}` })),
    );
});

afterAll(async () => {
  await client().db(sourceDb).dropDatabase();
});

function shieldOn(storage: MemoryStorage): MongoShield {
  return new MongoShield({
    source: { uri: mongoUri() },
    storage,
    encryption: { recipients: [key.recipient] },
  });
}

async function backupInto(storage: MemoryStorage): Promise<string> {
  const result = await shieldOn(storage).backup({
    include: [`${sourceDb}.*`],
    consistency: "none",
  });
  return result.id;
}

describe("replicateBackups", () => {
  it("copies every backup with its annotations and ledger, manifest last, and verifies it", async () => {
    const primary = memoryStorage({ name: "primary" });
    const offsite = memoryStorage({ name: "offsite" });
    const first = await backupInto(primary);
    const second = await backupInto(primary);
    await shieldOn(primary).verify({ backup: second });
    await recordErasure(primary, {
      namespace: `${sourceDb}.items`,
      filter: { _id: 3 },
      reason: "test erasure",
    });

    // Record the order of writes at the destination.
    const order: string[] = [];
    const originalPut = offsite.put.bind(offsite);
    offsite.put = (objectKey, body, options) => {
      order.push(objectKey);
      return originalPut(objectKey, body, options);
    };
    const result = await replicateBackups(primary, offsite, { backups: "all" });
    expect(result.backups.map((backup) => backup.action)).toEqual(["copied", "copied"]);
    expect(result.erasuresCopied).toBe(1);
    // The manifest of each backup is its last object written.
    for (const id of [first, second]) {
      const own = order.filter((objectKey) => objectKey.startsWith(`backups/${id}/`));
      expect(own.at(-1)).toBe(manifestKey(id));
    }

    const replica = shieldOn(offsite);
    const [newest] = await replica.list();
    expect(newest?.id).toBe(second);
    expect(newest?.verification?.ok).toBe(true);
    expect((await replica.verify({ backup: first })).ok).toBe(true);
    const deep = await replica.verify({
      backup: second,
      mode: "deep",
      decryption: { identities: [key.identity] },
    });
    expect(deep.documentsChecked).toBe(200);
    expect(offsite.keys().filter((objectKey) => objectKey.startsWith("erasures/"))).toHaveLength(1);

    // Nothing to do the second time.
    const again = await replicateBackups(primary, offsite, { backups: "all" });
    expect(again.backups.map((backup) => backup.action)).toEqual(["skipped", "skipped"]);
    expect(again.erasuresCopied).toBe(0);
  });

  it("copies only the rewritten files of a backup rekeyed since it was copied", async () => {
    const primary = memoryStorage({ name: "primary" });
    const offsite = memoryStorage({ name: "offsite" });
    const id = await backupInto(primary);
    await replicateBackups(primary, offsite, { backups: "latest" });

    const newKey = generateIdentity();
    await rekeyBackups(primary, {
      backups: [id],
      addRecipients: [newKey.recipient],
      decryption: { identities: [key.identity] },
    });
    const dry = await replicateBackups(primary, offsite, { backups: [id], dryRun: true });
    expect(dry.backups[0]?.action).toBe("would-update");

    const result = await replicateBackups(primary, offsite, { backups: [id] });
    expect(result.backups[0]?.action).toBe("updated");
    const deep = await shieldOn(offsite).verify({
      backup: id,
      mode: "deep",
      decryption: { identities: [newKey.identity] },
    });
    expect(deep.ok).toBe(true);
  });

  it("refuses to copy a damaged source file and never commits the copy", async () => {
    const primary = memoryStorage({ name: "primary" });
    const offsite = memoryStorage({ name: "offsite" });
    const id = await backupInto(primary);
    const manifest = (await shieldOn(primary).list())[0]?.manifest;
    const dataKey = manifest?.namespaces[0]?.files[0]?.key ?? "";
    await primary.put(resolveBackupKey(id, dataKey), Buffer.from("not the original bytes"));

    await expect(replicateBackups(primary, offsite, { backups: [id] })).rejects.toSatisfy((error) =>
      isMongoShieldError(error, "MS_INTEGRITY_FAILED"),
    );
    expect(await offsite.head(manifestKey(id))).toBeUndefined();
  });

  it("makes copies write-once only on storage that supports it", async () => {
    const primary = memoryStorage({ name: "primary" });
    const id = await backupInto(primary);
    await expect(
      replicateBackups(primary, memoryStorage({ name: "plain" }), { retainDays: 7 }),
    ).rejects.toThrow(/object lock/);

    const now = new Date();
    const locked = memoryStorage({ name: "locked", objectLock: true });
    await replicateBackups(primary, locked, { retainDays: 7, now: () => now });
    const until = locked.retainUntilOf(manifestKey(id));
    expect(until?.getTime()).toBe(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  it("refuses to replicate a location onto itself", async () => {
    const storage = memoryStorage({ name: "same" });
    await expect(replicateBackups(storage, storage)).rejects.toThrow(/onto itself/);
  });
});

describe("replicateToTargets", () => {
  it("copies one backup to every target and reports a failing target without stopping", async () => {
    const primary = memoryStorage({ name: "primary" });
    const id = await backupInto(primary);
    const good = memoryStorage({ name: "good" });
    const outcomes = await replicateToTargets(
      primary,
      [{ storage: "memory://broken" }, { storage: good }],
      id,
      {
        resolve: async () => {
          throw new Error("cannot open");
        },
      },
    );
    expect(outcomes[0]?.error).toBeDefined();
    expect(outcomes[1]?.result?.backups[0]?.action).toBe("copied");
    expect(await good.head(manifestKey(id))).toBeDefined();
  });
});
