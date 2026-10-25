/**
 * How the built-in Azure KMS factory uses the real SDK's shape: a
 * `CryptographyClient` for the key, plus a `KeyClient` for the key's vault that
 * reads the key type to pick the algorithm (Managed HSM `oct-HSM` keys → A256KW).
 * `@azure/keyvault-keys` and `@azure/identity` are replaced by recording stubs (in
 * this file's own module registry), so no network or credentials are involved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the stubs saw, reset before each test. */
const recorded = vi.hoisted(() => ({
  keyClients: [] as { vaultUrl: string; credential: unknown }[],
  getKey: [] as { name: string; options: unknown }[],
  wraps: [] as { algorithm: string; options: unknown }[],
  keyType: "oct-HSM",
}));

vi.mock("@azure/keyvault-keys", () => ({
  CryptographyClient: class {
    constructor(readonly keyId: string) {}
    async wrapKey(algorithm: string, _key: Uint8Array, options: unknown) {
      recorded.wraps.push({ algorithm, options });
      return { result: new Uint8Array([1, 2, 3]), keyID: `${this.keyId}/0123456789abcdef` };
    }
  },
  KeyClient: class {
    constructor(vaultUrl: string, credential: unknown) {
      recorded.keyClients.push({ vaultUrl, credential });
    }
    async getKey(name: string, options: unknown) {
      recorded.getKey.push({ name, options });
      return { keyType: recorded.keyType };
    }
  },
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    readonly kind = "default-azure-credential";
  },
}));

const { resolveKmsClient } = await import("./registry.ts");
const { createAzureKmsClient } = await import("./azure.ts");

const HSM_KEY = "https://acme.managedhsm.azure.net/keys/backups";
const DATA_KEY = new Uint8Array(16).fill(1);

describe("the built-in Azure KMS factory", () => {
  beforeEach(() => {
    recorded.keyClients.length = 0;
    recorded.getKey.length = 0;
    recorded.wraps.length = 0;
  });

  it("wraps a Managed HSM oct-HSM key with A256KW, read from the key type", async () => {
    recorded.keyType = "oct-HSM";
    const kms = await resolveKmsClient({ provider: "azure", key: HSM_KEY });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    expect(wrapped.algorithm).toBe("A256KW");
    expect(wrapped.key).toBe(`${HSM_KEY}/0123456789abcdef`);
    expect(recorded.keyClients).toEqual([
      {
        vaultUrl: "https://acme.managedhsm.azure.net",
        credential: expect.objectContaining({ kind: "default-azure-credential" }),
      },
    ]);
    expect(recorded.getKey).toEqual([{ name: "backups", options: {} }]);
    expect(recorded.wraps).toEqual([{ algorithm: "A256KW", options: {} }]);
  });

  it("creates no KeyClient when the algorithm is configured", async () => {
    const kms = createAzureKmsClient(HSM_KEY, { algorithm: "A128KW" });
    expect((await kms.encryptDataKey(DATA_KEY)).algorithm).toBe("A128KW");
    expect(recorded.keyClients).toEqual([]);
    expect(recorded.getKey).toEqual([]);
  });

  it("keeps RSA-OAEP-256 for RSA keys and passes the signal to every request", async () => {
    recorded.keyType = "RSA-HSM";
    const kms = await resolveKmsClient({ provider: "azure", key: HSM_KEY });
    const { signal } = new AbortController();
    expect((await kms.encryptDataKey(DATA_KEY, { signal })).algorithm).toBe("RSA-OAEP-256");
    expect(recorded.getKey[0]?.options).toEqual({ abortSignal: signal });
    expect(recorded.wraps[0]?.options).toEqual({ abortSignal: signal });
  });
});
