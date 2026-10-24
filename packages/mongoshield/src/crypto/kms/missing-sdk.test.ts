/**
 * The KMS SDKs are optional peer dependencies. This file simulates all of them being
 * absent (in its own module registry, so other tests keep the real SDKs) and checks
 * that users get MS_CONFIG_INVALID with the install command as the hint.
 */

import { describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../../errors.ts";

function notInstalled(name: string): never {
  throw Object.assign(new Error(`Cannot find package '${name}'`), { code: "ERR_MODULE_NOT_FOUND" });
}

vi.mock("@aws-sdk/client-kms", () => notInstalled("@aws-sdk/client-kms"));
vi.mock("@google-cloud/kms", () => notInstalled("@google-cloud/kms"));
vi.mock("@azure/keyvault-keys", () => notInstalled("@azure/keyvault-keys"));

describe("KMS adapters without their SDKs installed", () => {
  it.each([
    [
      "aws",
      "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
      "npm install @aws-sdk/client-kms",
    ],
    ["gcp", "projects/p/locations/l/keyRings/r/cryptoKeys/k", "npm install @google-cloud/kms"],
    [
      "azure",
      "https://v.vault.azure.net/keys/k",
      "npm install @azure/keyvault-keys @azure/identity",
    ],
  ] as const)(
    "fails the first %s call with MS_CONFIG_INVALID and an install hint",
    async (provider, key, hint) => {
      const { resolveKmsClient } = await import("./registry.ts");
      const client = await resolveKmsClient({ provider, key });
      const error = await client
        .encryptDataKey(new Uint8Array(16))
        .catch((reason: unknown) => reason);
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toBe(hint);
    },
  );
});
