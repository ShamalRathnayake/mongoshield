// Unit tests for the Azure Key Vault adapter against a fake `CryptographyClient`:
// algorithms, versioned key ids, the host allow-list and error mapping. No network.

import { describe, expect, it } from "vitest";
import { AZURE_KEY, FakeKms, fakeAzureSdkClient } from "../../../test/helpers/fake-kms.ts";
import { isMongoShieldError, type MongoShieldError } from "../../errors.ts";
import {
  type AzureKeyReaderSdkClient,
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

  it("uses AES key wrap for Managed HSM oct keys when asked, and unwraps with the recorded algorithm", async () => {
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

describe("createAzureKmsClient: choosing the algorithm from the key type", () => {
  const HSM_KEY = "https://acme.managedhsm.azure.net/keys/backups";

  /** A `KeyClient` look-alike that reports one key type and records its requests. */
  function keyReader(answer: { keyType?: string } | Error) {
    const requests: { name: string; options: unknown }[] = [];
    const reader: AzureKeyReaderSdkClient & { requests: typeof requests } = {
      requests,
      async getKey(name, options) {
        requests.push({ name, options });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return reader;
  }

  it.each([
    ["oct-HSM", "A256KW"],
    ["oct", "A256KW"],
    ["RSA-HSM", "RSA-OAEP-256"],
    ["RSA", "RSA-OAEP-256"],
  ])("wraps a %s key with %s", async (keyType, expected) => {
    const fake = new FakeKms();
    const kms = createAzureKmsClient(HSM_KEY, {
      client: fakeAzureSdkClient(fake, HSM_KEY),
      keyClient: keyReader({ keyType }),
    });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    expect(wrapped.algorithm).toBe(expected);
    // The fake binds the algorithm, so unwrapping proves the stanza records the right one.
    expect(Buffer.from(await kms.decryptDataKey(wrapped))).toEqual(Buffer.from(DATA_KEY));
  });

  it("reads the key (name and version) once per client", async () => {
    const reader = keyReader({ keyType: "oct-HSM" });
    const key = `${HSM_KEY}/0123456789abcdef`;
    const kms = createAzureKmsClient(key, {
      client: fakeAzureSdkClient(new FakeKms(), key),
      keyClient: reader,
    });
    await kms.encryptDataKey(DATA_KEY);
    await kms.encryptDataKey(DATA_KEY);
    expect(reader.requests).toEqual([
      { name: "backups", options: { version: "0123456789abcdef" } },
    ]);
  });

  it("falls back to RSA-OAEP-256 without permission to read the key", async () => {
    const denied = Object.assign(new Error("Forbidden"), { name: "RestError", statusCode: 403 });
    const kms = createAzureKmsClient(AZURE_KEY, {
      client: fakeAzureSdkClient(new FakeKms(), AZURE_KEY),
      keyClient: keyReader(denied),
    });
    expect((await kms.encryptDataKey(DATA_KEY)).algorithm).toBe("RSA-OAEP-256");
  });

  it("fails the wrap when the key cannot be found, and retries the lookup next time", async () => {
    const missing = Object.assign(new Error("Not found"), { name: "RestError", statusCode: 404 });
    const reader = keyReader(missing);
    const kms = createAzureKmsClient(AZURE_KEY, {
      client: fakeAzureSdkClient(new FakeKms(), AZURE_KEY),
      keyClient: reader,
    });
    const error = await failure(kms.encryptDataKey(DATA_KEY));
    expect(error.code).toBe("MS_ENCRYPTION_FAILED");
    expect(error.details?.kmsFailure).toBe("not-found");
    await failure(kms.encryptDataKey(DATA_KEY));
    expect(reader.requests).toHaveLength(2);
  });

  it("does not read the key when the algorithm is configured", async () => {
    const reader = keyReader({ keyType: "RSA" });
    const kms = createAzureKmsClient(HSM_KEY, {
      client: fakeAzureSdkClient(new FakeKms(), HSM_KEY),
      keyClient: reader,
      algorithm: "A128KW",
    });
    expect((await kms.encryptDataKey(DATA_KEY)).algorithm).toBe("A128KW");
    expect(reader.requests).toEqual([]);
  });
});

describe("createAzureKmsClient: cancellation", () => {
  it("passes the call's signal to getKey, wrapKey and unwrapKey as abortSignal", async () => {
    const seen: unknown[] = [];
    const client: AzureKeyWrapSdkClient = {
      async wrapKey(_algorithm, _key, options) {
        seen.push(options);
        return { result: new Uint8Array([1]) };
      },
      async unwrapKey(_algorithm, _encrypted, options) {
        seen.push(options);
        return { result: DATA_KEY };
      },
    };
    const keyClient: AzureKeyReaderSdkClient = {
      async getKey(_name, options) {
        seen.push(options);
        return { keyType: "RSA" };
      },
    };
    const { signal } = new AbortController();
    const kms = createAzureKmsClient(AZURE_KEY, { client, keyClient });
    const wrapped = await kms.encryptDataKey(DATA_KEY, { signal });
    await kms.decryptDataKey(wrapped, { signal });
    expect(seen).toEqual([
      { abortSignal: signal },
      { abortSignal: signal },
      { abortSignal: signal },
    ]);
  });

  it("rejects with MS_ABORTED when the signal fires during any of the calls", async () => {
    const never = new Promise<never>(() => {});
    const hanging: AzureKeyWrapSdkClient = { wrapKey: () => never, unwrapKey: () => never };
    const hangingReader: AzureKeyReaderSdkClient = { getKey: () => never };
    const abortSoon = () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      return controller.signal;
    };
    const lookup = createAzureKmsClient(AZURE_KEY, { client: hanging, keyClient: hangingReader });
    expect((await failure(lookup.encryptDataKey(DATA_KEY, { signal: abortSoon() }))).code).toBe(
      "MS_ABORTED",
    );
    const wrap = createAzureKmsClient(AZURE_KEY, { client: hanging });
    expect((await failure(wrap.encryptDataKey(DATA_KEY, { signal: abortSoon() }))).code).toBe(
      "MS_ABORTED",
    );
    const wrapped = { key: AZURE_KEY, algorithm: "RSA-OAEP-256", ciphertext: DATA_KEY };
    expect((await failure(wrap.decryptDataKey(wrapped, { signal: abortSoon() }))).code).toBe(
      "MS_ABORTED",
    );
    const already = AbortSignal.abort();
    expect((await failure(lookup.encryptDataKey(DATA_KEY, { signal: already }))).code).toBe(
      "MS_ABORTED",
    );
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
