/**
 * Edge cases of the KMS layer not covered by the per-provider tests: clients the
 * adapters create (and therefore release) themselves, the shared error helpers,
 * stanzas of other types, unusable results from custom clients, and removing a
 * registered factory. No network: SDK clients are created but never send a request
 * (calls are made with an already-aborted signal, which stops them before sending).
 */

import { KMSClient } from "@aws-sdk/client-kms";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AWS_ALIAS, AWS_KEY, GCP_KEY } from "../../../test/helpers/fake-kms.ts";
import { isMongoShieldError } from "../../errors.ts";
import { createAwsKmsClient } from "./aws.ts";
import { isModuleNotFound, kmsCallError, loadSdk, propertyOf } from "./errors.ts";
import { createGcpKmsClient } from "./gcp.ts";
import { resolveKmsClient, setKmsClientFactory } from "./registry.ts";
import {
  createKmsKeyUnwrapper,
  createKmsKeyWrapper,
  decodeKeyId,
  describeKmsStanza,
  KMS_STANZA_TYPE,
} from "./stanza.ts";
import type { KmsClient } from "./types.ts";

const DATA_KEY = new Uint8Array(16).fill(4);

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs a call that must fail and returns its error. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

describe("clients the adapters create themselves", () => {
  it.each([
    ["an alias (SDK default region)", AWS_ALIAS, {}],
    ["a key ARN (its region)", AWS_KEY, {}],
    ["an explicit region", AWS_ALIAS, { region: "us-east-2" }],
  ])("AWS creates a KMSClient for %s and destroys it on close()", async (_label, key, options) => {
    const destroy = vi.spyOn(KMSClient.prototype, "destroy");
    const kms = createAwsKmsClient(key, options);
    const error = await failure(kms.encryptDataKey(DATA_KEY, { signal: AbortSignal.abort() }));
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    await kms.close?.();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("GCP creates a KeyManagementServiceClient and closes it on close()", async () => {
    const close = vi.spyOn(KeyManagementServiceClient.prototype, "close").mockResolvedValue();
    const kms = createGcpKmsClient(GCP_KEY);
    const error = await failure(kms.encryptDataKey(DATA_KEY, { signal: AbortSignal.abort() }));
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    await kms.close?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("GCP treats an empty ciphertext as a failed call", async () => {
    const kms = createGcpKmsClient(GCP_KEY, {
      client: {
        encrypt: async () => [{ ciphertext: new Uint8Array(0) }],
        decrypt: async () => [{ plaintext: DATA_KEY }],
      },
    });
    const error = await failure(kms.encryptDataKey(DATA_KEY));
    expect(isMongoShieldError(error, "MS_ENCRYPTION_FAILED")).toBe(true);
  });
});

describe("KMS error helpers", () => {
  it("hints at the key type when a KMS refuses to encrypt with it", () => {
    const error = kmsCallError("aws", "encrypt", AWS_KEY, "invalid-ciphertext", "refused");
    expect(error.code).toBe("MS_ENCRYPTION_FAILED");
    expect(error.hint).toContain("symmetric encryption key");
  });

  it("rethrows import failures other than a missing package unchanged", async () => {
    const broken = new SyntaxError("Unexpected token in the SDK");
    expect(await failure(loadSdk("aws", () => Promise.reject(broken)))).toBe(broken);
  });

  it("recognises a missing package anywhere in the cause chain, and nothing else", () => {
    const wrapped = new Error("bundler failure", {
      cause: { cause: new Error("Cannot find package '@aws-sdk/client-kms'") },
    });
    expect(isModuleNotFound(wrapped)).toBe(true);
    expect(isModuleNotFound({ cause: "Cannot find module" })).toBe(false);
    expect(isModuleNotFound("Cannot find module")).toBe(false);
  });

  it("reads properties of objects only", () => {
    expect(propertyOf({ code: 7 }, "code")).toBe(7);
    expect(propertyOf(null, "code")).toBeUndefined();
    expect(propertyOf("text", "length")).toBeUndefined();
  });
});

describe("mongoshield-kms stanzas", () => {
  /** A client returning whatever the test wants as its wrapped key. */
  function returning(result: Awaited<ReturnType<KmsClient["encryptDataKey"]>>): KmsClient {
    return {
      provider: "aws",
      key: AWS_KEY,
      encryptDataKey: async () => result,
      decryptDataKey: async () => DATA_KEY,
    };
  }

  it.each([
    [
      "an algorithm name with spaces",
      { key: AWS_KEY, algorithm: "bad name", ciphertext: DATA_KEY },
    ],
    ["an empty ciphertext", { key: AWS_KEY, algorithm: "X", ciphertext: new Uint8Array(0) }],
  ])("refuses a custom client's result with %s", async (_label, result) => {
    const wrap = createKmsKeyWrapper({ provider: "aws", key: AWS_KEY }, async () =>
      returning(result),
    );
    const error = await failure(wrap(Buffer.from(DATA_KEY)));
    expect(isMongoShieldError(error, "MS_ENCRYPTION_FAILED")).toBe(true);
  });

  it("leaves stanzas of other types to other unwrappers", async () => {
    const other = { args: ["X25519", "share"], body: Buffer.alloc(32) };
    expect(await createKmsKeyUnwrapper()(other)).toBeUndefined();
    expect(describeKmsStanza(other)).toBeUndefined();
  });

  it("refuses a stanza without a key id", () => {
    expect(() =>
      describeKmsStanza({ args: [KMS_STANZA_TYPE, "aws"], body: Buffer.alloc(1) }),
    ).toThrow(expect.objectContaining({ code: "MS_DECRYPTION_FAILED" }));
  });

  it("refuses a key id that is not valid UTF-8", () => {
    expect(decodeKeyId(Buffer.from([0xff, 0xfe]).toString("base64url"))).toBeUndefined();
  });
});

describe("setKmsClientFactory", () => {
  it("removes a factory when given undefined, and its restorer puts it back", async () => {
    const custom: KmsClient = {
      provider: "gcp",
      key: GCP_KEY,
      encryptDataKey: async () => ({ key: GCP_KEY, algorithm: "X", ciphertext: DATA_KEY }),
      decryptDataKey: async () => DATA_KEY,
    };
    const restoreCustom = setKmsClientFactory("gcp", () => custom);
    try {
      const restoreRemoved = setKmsClientFactory("gcp", undefined);
      expect(await resolveKmsClient({ provider: "gcp", key: GCP_KEY })).not.toBe(custom);
      restoreRemoved();
      expect(await resolveKmsClient({ provider: "gcp", key: GCP_KEY })).toBe(custom);
    } finally {
      restoreCustom();
    }
  });
});
