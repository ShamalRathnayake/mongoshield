/**
 * Shared building blocks for the opt-in cloud tests (`pnpm test:cloud`).
 *
 * Each provider's test file (aws.test.ts, gcp.test.ts, …) combines three things:
 *
 * 1. `cloudFixture`: turns an adapter into a storage conformance fixture whose
 *    cleanup deletes everything the test wrote, so the real bucket is left empty.
 * 2. `describeEncryptedRoundTrip`: a full encrypted backup → deep verify → restore
 *    through the adapter, against the real mongod from the global setup, checking
 *    every restored document byte for byte.
 * 3. `describeKmsRoundTrip`: a real KMS key wrapping and unwrapping a data key, and
 *    a KMS-protected backup restored through the KMS and through the offline
 *    recovery identity.
 *
 * Everything a run writes lives under `CLOUD_RUN_PREFIX` (see env.ts). Objects that
 * cannot be deleted yet (locked by object retention in the immutable-bucket tests)
 * are left for the bucket's lifecycle rule; the docs describe that rule.
 */

import { randomBytes } from "node:crypto";
import { Binary, Decimal128, Double, Int32, Long, MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { resolveKmsClient } from "../../src/crypto/kms/index.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { MongoShield } from "../../src/shield.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import type { KmsKeyRef } from "../../src/types.ts";
import { mongoUri, uniqueDb } from "../helpers/mongo.ts";
import type { StorageConformanceFixture } from "../helpers/storage-conformance.ts";

/** Network round trips to real services are slow; one full round trip can take minutes. */
export const CLOUD_TEST_TIMEOUT_MS = 10 * 60_000;

/** How many deletes run at once while emptying a prefix (keeps request bursts polite). */
const DELETE_CONCURRENCY = 16;

/**
 * Deletes every object the adapter can see (everything under its prefix).
 *
 * One delete per key rather than one batch: on an immutable bucket some objects are
 * still locked, and one locked key must not stop the others from being removed.
 * Locked objects are skipped silently (the lifecycle rule removes them once their
 * retention ends); any other failure is reported, because a real cleanup error
 * would otherwise leave objects behind unnoticed.
 */
export async function emptyStorage(storage: StorageAdapter): Promise<void> {
  const keys: string[] = [];
  for await (const info of storage.list("")) keys.push(info.key);
  const failures: unknown[] = [];
  for (let start = 0; start < keys.length; start += DELETE_CONCURRENCY) {
    const batch = keys.slice(start, start + DELETE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((key) => storage.delete([key])));
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      if (isObjectLockedError(result.reason)) continue;
      failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `cleanup failed for ${failures.length} object(s)`);
  }
}

/** True for the error adapters raise when retention forbids deleting an object. */
function isObjectLockedError(error: unknown): boolean {
  return isMongoShieldError(error, "MS_STORAGE_FORBIDDEN") && error.details?.objectLocked === true;
}

/**
 * A conformance fixture for a real service: `storage` must already point at a
 * fresh, unique prefix. Cleanup empties that prefix and closes the adapter.
 * `extras` carries the per-service flags (`objectLockConfigured`, `lockedDeletes`).
 * Real services never get `emulatorGaps`: they must pass every test.
 */
export function cloudFixture(
  storage: StorageAdapter,
  extras: Omit<StorageConformanceFixture, "storage" | "cleanup" | "emulatorGaps"> = {},
): StorageConformanceFixture {
  return {
    storage,
    cleanup: async () => {
      try {
        await emptyStorage(storage);
      } finally {
        await storage.close?.();
      }
    },
    ...extras,
  };
}

/** A `n`-byte buffer of random bytes (incompressible, so uploads stay large). */
function randomPayload(bytes: number): Buffer {
  return randomBytes(bytes);
}

/** Documents in the `users` collection: many small documents of many BSON types. */
const USER_COUNT = 2_000;
/** Documents in the `blobs` collection: few, large and incompressible. */
const BLOB_COUNT = 3;
/**
 * 4 MiB each, so the blobs' data file is about 12 MiB after (non-)compression:
 * larger than one S3 part, one GCS resumable chunk and one Azure block, which makes
 * every adapter take its multipart / chunked upload path against the real service.
 */
const BLOB_BYTES = 4 * 1024 * 1024;

/**
 * Seeds a small but varied database: BSON types that must survive exactly, a unique
 * and a compound index, and a few large documents.
 */
async function seedDatabase(client: MongoClient, database: string): Promise<void> {
  const db = client.db(database);
  await db.collection("users").insertMany(
    Array.from({ length: USER_COUNT }, (_, index) => ({
      _id: new ObjectId(),
      email: `user${index}@example.test`,
      index: new Int32(index),
      balance: new Decimal128(`${index}.25`),
      score: new Double(index), // an integral double must stay a double
      visits: Long.fromNumber(index * 1_000_000_000),
      tags: index % 2 === 0 ? ["even"] : ["odd", { nested: [index, "deep"] }],
      avatar: new Binary(randomPayload(32)),
      createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000),
    })),
  );
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("users").createIndex({ createdAt: -1, index: 1 });
  await db.collection<{ _id: number; payload: Binary }>("blobs").insertMany(
    Array.from({ length: BLOB_COUNT }, (_, index) => ({
      _id: index,
      payload: new Binary(randomPayload(BLOB_BYTES)),
    })),
  );
}

/**
 * Asserts that every collection of `restored` holds exactly the documents of
 * `original`. Raw BSON bytes are compared, so any type change (int vs double, …)
 * or field-order change fails the test, not just a value change.
 */
async function expectSameDocuments(
  client: MongoClient,
  original: string,
  restored: string,
): Promise<void> {
  for (const name of ["users", "blobs"]) {
    const read = (database: string) =>
      client
        .db(database)
        .collection(name)
        .find({}, { sort: { _id: 1 }, raw: true })
        .toArray();
    const [originalDocuments, restoredDocuments] = await Promise.all([
      read(original),
      read(restored),
    ]);
    expect(restoredDocuments.length, name).toBe(originalDocuments.length);
    expect(restoredDocuments, name).toEqual(originalDocuments);
  }
}

/** Options for {@link describeEncryptedRoundTrip}. */
export interface RoundTripOptions {
  /**
   * Back up with `retainDays` (immutable backups): the store must accept retained
   * files and the manifest must record `immutableUntil`. Use 1 on test buckets.
   */
  readonly retainDays?: number;
}

/**
 * Registers an end-to-end test: back up a seeded database through `makeStorage()`
 * with zstd and age encryption, verify fast and deep, list it, restore it under a
 * new name and compare every document. `makeStorage` is called once, inside
 * `beforeAll`, and must point at a unique, empty prefix.
 */
export function describeEncryptedRoundTrip(
  name: string,
  makeStorage: () => StorageAdapter,
  options: RoundTripOptions = {},
): void {
  describe(`${name} encrypted backup and restore`, () => {
    const sourceDb = uniqueDb("cloud");
    const restoredDb = `${sourceDb}_restored`;
    let client: MongoClient | undefined;
    let storage: StorageAdapter | undefined;

    beforeAll(async () => {
      // Created here, not at collection time: when the suite is skipped there is no
      // mongod (see global-setup.ts) and this never runs.
      client = await MongoClient.connect(mongoUri());
      storage = makeStorage();
      await seedDatabase(client, sourceDb);
    }, CLOUD_TEST_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (storage) await emptyStorage(storage);
      } finally {
        await storage?.close?.();
        await client?.db(sourceDb).dropDatabase();
        await client?.db(restoredDb).dropDatabase();
        await client?.close();
      }
    }, CLOUD_TEST_TIMEOUT_MS);

    it(
      "backs up with zstd and age, verifies deeply, and restores every document byte for byte",
      async () => {
        if (!client || !storage) throw new Error("beforeAll did not finish");
        const { identity, recipient } = generateIdentity();
        // `source.client` reuses our connection; the caller (we) keeps ownership.
        const shield = new MongoShield({
          source: { client },
          storage,
          compression: "zstd",
          encryption: { recipients: [recipient] },
        });

        const backup = await shield.backup({
          include: [`${sourceDb}.*`],
          labels: { suite: "cloud" },
          ...(options.retainDays === undefined ? {} : { retainDays: options.retainDays }),
        });
        expect(backup.manifest.totals.documents).toBe(USER_COUNT + BLOB_COUNT);
        expect(backup.manifest.encryption?.scheme).toBe("age-v1");
        if (options.retainDays !== undefined) {
          expect(backup.manifest.immutableUntil).toBeDefined();
        }

        // A fast verification (sizes and checksums, no key) and a deep one (decrypts
        // and parses every document) both read the files back from the real store.
        expect((await shield.verify({ backup: backup.id, mode: "fast" })).ok).toBe(true);
        const deep = await shield.verify({
          backup: backup.id,
          mode: "deep",
          decryption: { identities: [identity] },
        });
        expect(deep.ok).toBe(true);
        expect(deep.documentsChecked).toBe(USER_COUNT + BLOB_COUNT);

        // The catalog lists it from the store.
        expect((await shield.list()).map((entry) => entry.id)).toContain(backup.id);

        // Restore next to the original and compare documents and indexes.
        const result = await shield.restore({
          backup: backup.id,
          rename: { [`${sourceDb}.*`]: `${restoredDb}.*` },
          decryption: { identities: [identity] },
        });
        expect(result.documentsRestored).toBe(USER_COUNT + BLOB_COUNT);
        await expectSameDocuments(client, sourceDb, restoredDb);
        const indexes = await client.db(restoredDb).collection("users").indexes();
        expect(indexes.some((index) => index.unique === true && index.key.email === 1)).toBe(true);
      },
      CLOUD_TEST_TIMEOUT_MS,
    );
  });
}

/**
 * Registers the tests for one real KMS key: a direct wrap/unwrap round trip, a
 * tampered ciphertext being refused, and a KMS-protected backup (kept in memory, so
 * only the KMS is remote) restored once through the KMS and once through the offline
 * recovery identity without calling the KMS.
 */
export function describeKmsRoundTrip(name: string, ref: () => KmsKeyRef): void {
  describe(`${name} key wrapping`, () => {
    it(
      "wraps and unwraps a 16-byte data key",
      async () => {
        const kms = await resolveKmsClient(ref());
        try {
          const dataKey = randomBytes(16);
          const wrapped = await kms.encryptDataKey(dataKey);
          // The provider's ciphertext is never the key itself.
          expect(Buffer.from(wrapped.ciphertext).includes(dataKey)).toBe(false);
          expect(wrapped.algorithm.length).toBeGreaterThan(0);
          expect(Buffer.from(await kms.decryptDataKey(wrapped))).toEqual(dataKey);
        } finally {
          await kms.close?.();
        }
      },
      CLOUD_TEST_TIMEOUT_MS,
    );

    it(
      "refuses a tampered ciphertext with MS_DECRYPTION_FAILED",
      async () => {
        const kms = await resolveKmsClient(ref());
        try {
          const wrapped = await kms.encryptDataKey(randomBytes(16));
          const tampered = Buffer.from(wrapped.ciphertext);
          // Flip one bit in the middle: authenticated ciphertexts must not unwrap.
          const middle = Math.floor(tampered.length / 2);
          tampered[middle] = (tampered[middle] ?? 0) ^ 0x01;
          const error = await kms
            .decryptDataKey({ ...wrapped, ciphertext: tampered })
            .catch((reason: unknown) => reason);
          expect(isMongoShieldError(error, "MS_DECRYPTION_FAILED"), String(error)).toBe(true);
        } finally {
          await kms.close?.();
        }
      },
      CLOUD_TEST_TIMEOUT_MS,
    );
  });

  describe(`${name} protected backup`, () => {
    const sourceDb = uniqueDb("cloudkms");
    let client: MongoClient | undefined;

    beforeAll(async () => {
      client = await MongoClient.connect(mongoUri());
      await seedDatabase(client, sourceDb);
    }, CLOUD_TEST_TIMEOUT_MS);

    afterAll(async () => {
      if (!client) return;
      // Drop the source and both restore targets, then disconnect.
      for (const suffix of ["", "_via_kms", "_via_recovery"]) {
        await client.db(`${sourceDb}${suffix}`).dropDatabase();
      }
      await client.close();
    }, CLOUD_TEST_TIMEOUT_MS);

    it(
      "restores through the KMS, and through the offline recovery identity",
      async () => {
        if (!client) throw new Error("beforeAll did not finish");
        const recovery = generateIdentity();
        const shield = new MongoShield({
          source: { client },
          storage: memoryStorage(),
          encryption: { kms: [ref()], recipients: [recovery.recipient] },
        });
        const backup = await shield.backup({ include: [`${sourceDb}.*`] });
        expect(backup.manifest.encryption?.scheme).toBe("age-v1");

        // No decryption options: the backup's key envelope is unwrapped by the KMS.
        const viaKms = `${sourceDb}_via_kms`;
        await shield.restore({ backup: backup.id, rename: { [`${sourceDb}.*`]: `${viaKms}.*` } });
        await expectSameDocuments(client, sourceDb, viaKms);

        // The recovery identity opens the same backup without any KMS call.
        const viaRecovery = `${sourceDb}_via_recovery`;
        await shield.restore({
          backup: backup.id,
          rename: { [`${sourceDb}.*`]: `${viaRecovery}.*` },
          decryption: { identities: [recovery.identity] },
        });
        await expectSameDocuments(client, sourceDb, viaRecovery);
      },
      CLOUD_TEST_TIMEOUT_MS,
    );
  });
}
