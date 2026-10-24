// Unit tests for the KMS client registry: custom factories, built-in adapters,
// key validation and manifest labels. No network.

import { afterEach, describe, expect, it } from "vitest";
import { AWS_KEY, AZURE_KEY, GCP_KEY } from "../../../test/helpers/fake-kms.ts";
import type { KmsKeyRef } from "../../types.ts";
import {
  assertValidKmsKeyRef,
  isKmsRecipientLabel,
  kmsRecipientLabel,
  resolveKmsClient,
  setKmsClientFactory,
} from "./registry.ts";
import type { KmsClient } from "./types.ts";

const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
});

function stubClient(provider: KmsClient["provider"], key: string): KmsClient {
  return {
    provider,
    key,
    encryptDataKey: async () => ({ key, algorithm: "X", ciphertext: new Uint8Array([1]) }),
    decryptDataKey: async () => new Uint8Array(16),
  };
}

describe("resolveKmsClient", () => {
  it("uses a registered factory, and the built-in adapter again once it is removed", async () => {
    const stub = stubClient("aws", AWS_KEY);
    restorers.push(setKmsClientFactory("aws", () => stub));
    expect(await resolveKmsClient({ provider: "aws", key: AWS_KEY })).toBe(stub);
    restorers.pop()?.();
    const builtIn = await resolveKmsClient({ provider: "aws", key: AWS_KEY });
    expect(builtIn).not.toBe(stub);
    expect(builtIn).toMatchObject({ provider: "aws", key: AWS_KEY });
  });

  it.each([
    ["aws", AWS_KEY],
    ["gcp", GCP_KEY],
    ["azure", AZURE_KEY],
  ] as const)(
    "creates the built-in %s adapter without loading or contacting anything",
    async (provider, key) => {
      const client = await resolveKmsClient({ provider, key });
      expect(client).toMatchObject({ provider, key });
      await client.close?.();
    },
  );

  it("refuses a factory that returns a client of another provider", async () => {
    restorers.push(setKmsClientFactory("gcp", () => stubClient("aws", AWS_KEY)));
    await expect(resolveKmsClient({ provider: "gcp", key: GCP_KEY })).rejects.toMatchObject({
      code: "MS_CONFIG_INVALID",
    });
  });

  it("validates the key before calling any factory", async () => {
    let called = false;
    restorers.push(
      setKmsClientFactory("aws", () => {
        called = true;
        return stubClient("aws", AWS_KEY);
      }),
    );
    await expect(resolveKmsClient({ provider: "aws", key: "not a key" })).rejects.toMatchObject({
      code: "MS_CONFIG_INVALID",
    });
    expect(called).toBe(false);
  });
});

describe("assertValidKmsKeyRef", () => {
  it("rejects an unknown provider", () => {
    const ref = { provider: "ibm", key: "k" } as unknown as KmsKeyRef;
    expect(() => assertValidKmsKeyRef(ref)).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
  });

  it("rejects a key of another provider's shape", () => {
    expect(() => assertValidKmsKeyRef({ provider: "gcp", key: AWS_KEY })).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
  });
});

describe("manifest labels", () => {
  it("are kms:<provider>:<key> and recognisable", () => {
    const label = kmsRecipientLabel({ provider: "aws", key: AWS_KEY });
    expect(label).toBe(`kms:aws:${AWS_KEY}`);
    expect(isKmsRecipientLabel(label)).toBe(true);
    expect(isKmsRecipientLabel("scrypt")).toBe(false);
    expect(isKmsRecipientLabel("age1qyqszqgpqyqszqgpqyqszqgpqyqszqgp")).toBe(false);
  });
});
