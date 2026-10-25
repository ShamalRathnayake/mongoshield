// Unit tests for the Google Cloud KMS adapter against a fake
// `KeyManagementServiceClient`: request shapes, byte handling, error mapping and
// client ownership. No network.

import { describe, expect, it } from "vitest";
import { FakeKms, fakeGcpSdkClient, GCP_KEY } from "../../../test/helpers/fake-kms.ts";
import { isMongoShieldError, type MongoShieldError } from "../../errors.ts";
import {
  assertValidGcpKmsKey,
  classifyGcpError,
  createGcpKmsClient,
  GCP_KMS_ALGORITHM,
  type GcpKmsSdkClient,
} from "./gcp.ts";
import { KMS_DATA_KEY_CONTEXT } from "./types.ts";

const DATA_KEY = new Uint8Array(16).fill(3);

async function failure(promise: Promise<unknown>): Promise<MongoShieldError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isMongoShieldError(error))
    throw new Error(`expected a MongoShieldError, got ${String(error)}`);
  return error;
}

describe("createGcpKmsClient", () => {
  it("round-trips a data key bound to MongoShield's additional authenticated data", async () => {
    const requests: unknown[] = [];
    const fake = fakeGcpSdkClient(new FakeKms());
    const client: GcpKmsSdkClient = {
      encrypt: (request) => {
        requests.push(request);
        return fake.encrypt(request);
      },
      decrypt: (request) => fake.decrypt(request),
    };
    const kms = createGcpKmsClient(GCP_KEY, { client });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    expect(wrapped.key).toBe(GCP_KEY);
    expect(wrapped.algorithm).toBe(GCP_KMS_ALGORITHM);
    expect(Buffer.from(await kms.decryptDataKey(wrapped))).toEqual(Buffer.from(DATA_KEY));
    expect(requests[0]).toMatchObject({
      name: GCP_KEY,
      additionalAuthenticatedData: Buffer.from(KMS_DATA_KEY_CONTEXT.gcp),
    });
  });

  it("accepts base64 text where the REST transport returns strings", async () => {
    const client: GcpKmsSdkClient = {
      encrypt: async () => [{ ciphertext: Buffer.from("wrapped").toString("base64") }],
      decrypt: async () => [{ plaintext: Buffer.from(DATA_KEY).toString("base64") }],
    };
    const kms = createGcpKmsClient(GCP_KEY, { client });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    expect(Buffer.from(wrapped.ciphertext).toString()).toBe("wrapped");
    expect(Buffer.from(await kms.decryptDataKey(wrapped))).toEqual(Buffer.from(DATA_KEY));
  });

  it("treats empty responses as failures", async () => {
    const client: GcpKmsSdkClient = {
      encrypt: async () => [{ ciphertext: null }],
      decrypt: async () => [{}],
    };
    const kms = createGcpKmsClient(GCP_KEY, { client });
    expect((await failure(kms.encryptDataKey(DATA_KEY))).code).toBe("MS_ENCRYPTION_FAILED");
    const wrapped = { key: GCP_KEY, algorithm: GCP_KMS_ALGORITHM, ciphertext: new Uint8Array([1]) };
    expect((await failure(kms.decryptDataKey(wrapped))).code).toBe("MS_DECRYPTION_FAILED");
  });

  it("maps PERMISSION_DENIED to an error naming cloudkms.cryptoKeyVersions.useToDecrypt", async () => {
    const fake = new FakeKms();
    const kms = createGcpKmsClient(GCP_KEY, { client: fakeGcpSdkClient(fake) });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    fake.denied.add(GCP_KEY);
    const error = await failure(kms.decryptDataKey(wrapped));
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
    expect(error.hint).toContain("cloudkms.cryptoKeyVersions.useToDecrypt");
  });

  it("maps a ciphertext GCP cannot decrypt to invalid-ciphertext", async () => {
    const kms = createGcpKmsClient(GCP_KEY, { client: fakeGcpSdkClient(new FakeKms()) });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    // Flip every bit of one byte: zeroing it would change nothing when the (random)
    // ciphertext already has a 0 there, about once in 256 runs.
    const ciphertext = Uint8Array.from(wrapped.ciphertext);
    ciphertext[14] = (ciphertext[14] ?? 0) ^ 0xff;
    const tampered = { ...wrapped, ciphertext };
    const error = await failure(kms.decryptDataKey(tampered));
    expect(error.details?.kmsFailure).toBe("invalid-ciphertext");
  });

  it("refuses another algorithm without calling GCP", async () => {
    const fake = new FakeKms();
    const kms = createGcpKmsClient(GCP_KEY, { client: fakeGcpSdkClient(fake) });
    const wrapped = {
      key: GCP_KEY,
      algorithm: "RSA_DECRYPT_OAEP_2048_SHA256",
      ciphertext: new Uint8Array([1]),
    };
    expect((await failure(kms.decryptDataKey(wrapped))).code).toBe("MS_DECRYPTION_FAILED");
    expect(fake.calls).toEqual([]);
  });

  it("stops waiting with MS_ABORTED when the signal fires, though gax cannot cancel", async () => {
    const never = new Promise<never>(() => {});
    const client: GcpKmsSdkClient = { encrypt: () => never, decrypt: () => never };
    const kms = createGcpKmsClient(GCP_KEY, { client });
    const controller = new AbortController();
    const pending = kms.encryptDataKey(DATA_KEY, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect((await failure(pending)).code).toBe("MS_ABORTED");
    const wrapped = { key: GCP_KEY, algorithm: GCP_KMS_ALGORITHM, ciphertext: DATA_KEY };
    const signal = AbortSignal.abort();
    expect((await failure(kms.decryptDataKey(wrapped, { signal }))).code).toBe("MS_ABORTED");
  });

  it("still maps failures normally when a signal is given but never fires", async () => {
    const fake = new FakeKms();
    fake.denied.add(GCP_KEY);
    const kms = createGcpKmsClient(GCP_KEY, { client: fakeGcpSdkClient(fake) });
    const error = await failure(
      kms.encryptDataKey(DATA_KEY, { signal: new AbortController().signal }),
    );
    expect(error.code).toBe("MS_ENCRYPTION_FAILED");
  });

  it("never closes a client it was given", async () => {
    const client = fakeGcpSdkClient(new FakeKms());
    const kms = createGcpKmsClient(GCP_KEY, { client });
    await kms.encryptDataKey(DATA_KEY);
    await kms.close?.();
    expect(client.closed).toBe(false);
  });
});

describe("GCP key names", () => {
  it("accepts a CryptoKey resource name", () => {
    expect(() => assertValidGcpKmsKey(GCP_KEY)).not.toThrow();
  });

  it.each([
    `${GCP_KEY}/cryptoKeyVersions/1`,
    "projects/acme/keyRings/backups/cryptoKeys/k",
    "mongoshield",
    "",
  ])("rejects %j", (key) => {
    expect(() => assertValidGcpKmsKey(key)).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
  });
});

describe("classifyGcpError", () => {
  it.each([
    [7, "access-denied"],
    [16, "access-denied"],
    [5, "not-found"],
    [3, "invalid-ciphertext"],
    [9, "key-unusable"],
    [14, "other"],
  ])("classifies gRPC code %i as %s", (code, kind) => {
    expect(classifyGcpError(Object.assign(new Error("x"), { code }))).toBe(kind);
  });
});
