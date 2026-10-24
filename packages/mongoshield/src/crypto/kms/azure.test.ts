// Unit tests for the Azure Key Vault adapter against a fake `CryptographyClient`:
// algorithms, versioned key ids, the host allow-list and error mapping. No network.

import { describe, expect, it } from "vitest";
import { AZURE_KEY, FakeKms, fakeAzureSdkClient } from "../../../test/helpers/fake-kms.ts";
import { isMongoShieldError, type MongoShieldError } from "../../errors.ts";
import {
  type AzureKeyWrapSdkClient,
  assertValidAzureKmsKey,
  classifyAzureError,
  createAzureKmsClient,
} from "./azure.ts";

const DATA_KEY = new Uint8Array(16).fill(5);

async function failure(promise: Promise<unknown>): Promise<MongoShieldError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isMongoShieldError(error))
    throw new Error(`expected a MongoShieldError, got ${String(error)}`);
  return error;
}

describe("createAzureKmsClient", () => {
  it("wraps with RSA-OAEP-256 and records the versioned key id Key Vault reports", async () => {
    const fake = new FakeKms();
    const kms = createAzureKmsClient(AZURE_KEY, { client: fakeAzureSdkClient(fake, AZURE_KEY) });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    expect(wrapped.algorithm).toBe("RSA-OAEP-256");
    expect(wrapped.key).toBe(`${AZURE_KEY}/0123456789abcdef`);

    // Restores build the client for the recorded (versioned) key.
    const restoreKms = createAzureKmsClient(wrapped.key, {
      client: fakeAzureSdkClient(fake, wrapped.key),
    });
    expect(Buffer.from(await restoreKms.decryptDataKey(wrapped))).toEqual(Buffer.from(DATA_KEY));
  });

  it("uses AES key wrap for Managed HSM keys when asked, and unwraps with the recorded algorithm", async () => {
    const fake = new FakeKms();
    const hsmKey = "https://acme.managedhsm.azure.net/keys/backups";
    const client = fakeAzureSdkClient(fake, hsmKey);
    const wrapped = await createAzureKmsClient(hsmKey, {
      client,
      algorithm: "A256KW",
    }).encryptDataKey(DATA_KEY);
    expect(wrapped.algorithm).toBe("A256KW");
    // A restore client with default settings still uses the algorithm from the backup.
    const restored = await createAzureKmsClient(hsmKey, { client }).decryptDataKey(wrapped);
    expect(Buffer.from(restored)).toEqual(Buffer.from(DATA_KEY));
  });

  it("keeps the configured key when Key Vault reports no usable key id", async () => {
    const client: AzureKeyWrapSdkClient = {
      wrapKey: async () => ({
        result: new Uint8Array([1]),
        keyID: "https://evil.example.com/keys/k/1",
      }),
      unwrapKey: async () => ({ result: DATA_KEY }),
    };
    expect((await createAzureKmsClient(AZURE_KEY, { client }).encryptDataKey(DATA_KEY)).key).toBe(
      AZURE_KEY,
    );
  });

  it("maps 403 on unwrap to MS_DECRYPTION_FAILED naming keys/unwrapKey", async () => {
    const fake = new FakeKms();
    const kms = createAzureKmsClient(AZURE_KEY, { client: fakeAzureSdkClient(fake, AZURE_KEY) });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    fake.denied.add(AZURE_KEY);
    const error = await failure(kms.decryptDataKey(wrapped));
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
    expect(error.hint).toContain("keys/unwrapKey");
  });

  it("maps 403 on wrap to MS_ENCRYPTION_FAILED naming keys/wrapKey", async () => {
    const fake = new FakeKms();
    fake.denied.add(AZURE_KEY);
    const kms = createAzureKmsClient(AZURE_KEY, { client: fakeAzureSdkClient(fake, AZURE_KEY) });
    const error = await failure(kms.encryptDataKey(DATA_KEY));
    expect(error.code).toBe("MS_ENCRYPTION_FAILED");
    expect(error.hint).toContain("keys/wrapKey");
  });

  it("refuses an unknown algorithm without calling Key Vault", async () => {
    const fake = new FakeKms();
    const kms = createAzureKmsClient(AZURE_KEY, { client: fakeAzureSdkClient(fake, AZURE_KEY) });
    const error = await failure(
      kms.decryptDataKey({ key: AZURE_KEY, algorithm: "RSA1_5", ciphertext: new Uint8Array([1]) }),
    );
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
    expect(fake.calls).toEqual([]);
  });
});

describe("Azure key URLs", () => {
  it.each([
    AZURE_KEY,
    `${AZURE_KEY}/0123456789abcdef0123456789abcdef`,
    "https://acme.managedhsm.azure.net/keys/backups",
    "https://acme.vault.usgovcloudapi.net/keys/backups",
  ])("accepts %s", (key) => {
    expect(() => assertValidAzureKmsKey(key)).not.toThrow();
  });

  it.each([
    "http://acme.vault.azure.net/keys/backups",
    "https://evil.example.com/keys/backups",
    "https://acme.vault.azure.net.evil.example.com/keys/backups",
    "https://acme.vault.azure.net:8443/keys/backups",
    "https://user@acme.vault.azure.net/keys/backups",
    "https://acme.vault.azure.net/secrets/backups",
    "https://acme.vault.azure.net/keys/backups?x=1",
    "not a url",
  ])("rejects %s", (key) => {
    expect(() => assertValidAzureKmsKey(key)).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
  });
});

describe("classifyAzureError", () => {
  it.each([
    [{ statusCode: 401 }, "access-denied"],
    [{ statusCode: 403 }, "access-denied"],
    [{ name: "CredentialUnavailableError" }, "access-denied"],
    [{ statusCode: 404 }, "not-found"],
    [{ statusCode: 400 }, "invalid-ciphertext"],
    [{ statusCode: 409 }, "key-unusable"],
    [{ statusCode: 503 }, "other"],
  ])("classifies %j as %s", (fields, kind) => {
    expect(classifyAzureError(Object.assign(new Error("x"), fields))).toBe(kind);
  });
});
