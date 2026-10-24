/**
 * Turning cloud KMS failures into MongoShield errors.
 *
 * Every adapter classifies its SDK's errors into a few kinds (access denied, key not
 * found, ciphertext rejected, key unusable). This file turns a kind into a
 * `MongoShieldError` whose hint says what to do, most importantly *which permission*
 * is missing, because "AccessDenied" alone sends people searching through IAM docs.
 *
 * Messages may name the key (ARNs, resource names and key URLs are identifiers, not
 * secrets) but never include data keys or ciphertexts.
 */

import { type ErrorCode, MongoShieldError } from "../../errors.ts";
import type { DecryptionStage } from "../failures.ts";
import type { KmsProvider } from "./types.ts";

/** Which way the data key was going when the KMS call failed. */
export type KmsOperation = "encrypt" | "decrypt";

/** What went wrong at the KMS, as far as the adapter could tell. */
export type KmsFailureKind =
  /** Missing permission, or no / expired credentials. */
  | "access-denied"
  /** The key (or key version) does not exist, or is not visible to the caller. */
  | "not-found"
  /** The KMS refused the ciphertext: modified, or wrapped with another key or context. */
  | "invalid-ciphertext"
  /** The key exists but cannot be used now (disabled, pending deletion, wrong type). */
  | "key-unusable"
  /** Anything else (network, throttling, service errors). */
  | "other";

/** Human-readable provider names for messages. */
const PROVIDER_NAMES: Record<KmsProvider, string> = {
  aws: "AWS KMS",
  gcp: "Google Cloud KMS",
  azure: "Azure Key Vault",
};

/**
 * The permission each operation needs, per provider, as the provider's docs name it.
 * Restoring needs only the decrypt side; backing up only the encrypt side, so a
 * backup server can be given a role that cannot read backups.
 */
const REQUIRED_PERMISSIONS: Record<KmsProvider, Record<KmsOperation, string>> = {
  aws: { encrypt: "kms:Encrypt", decrypt: "kms:Decrypt" },
  gcp: {
    encrypt: "cloudkms.cryptoKeyVersions.useToEncrypt (role roles/cloudkms.cryptoKeyEncrypter)",
    decrypt: "cloudkms.cryptoKeyVersions.useToDecrypt (role roles/cloudkms.cryptoKeyDecrypter)",
  },
  azure: {
    encrypt: "keys/wrapKey (e.g. role Key Vault Crypto Service Encryption User)",
    decrypt: "keys/unwrapKey (e.g. role Key Vault Crypto Service Encryption User)",
  },
};

/** The npm packages each provider's adapter needs. */
const SDK_PACKAGES: Record<KmsProvider, string> = {
  aws: "@aws-sdk/client-kms",
  gcp: "@google-cloud/kms",
  azure: "@azure/keyvault-keys @azure/identity",
};

/** Builds the error for a failed KMS call. */
export function kmsCallError(
  provider: KmsProvider,
  operation: KmsOperation,
  key: string,
  kind: KmsFailureKind,
  cause: unknown,
): MongoShieldError {
  const code: ErrorCode = operation === "encrypt" ? "MS_ENCRYPTION_FAILED" : "MS_DECRYPTION_FAILED";
  const name = PROVIDER_NAMES[provider];
  const verb = operation === "encrypt" ? "protect" : "unlock";
  return new MongoShieldError(
    code,
    `${name} could not ${verb} the backup key with ${key}: ${describeKind(kind)}`,
    {
      cause,
      hint: hintFor(provider, operation, kind),
      details: {
        provider,
        key,
        kmsFailure: kind,
        // Decryption errors carry the age stage, so verify treats them as key problems
        // (thrown) rather than as damage to one file (see engine/verify.ts).
        ...(operation === "decrypt" ? { stage: "unwrap" satisfies DecryptionStage } : {}),
      },
    },
  );
}

function describeKind(kind: KmsFailureKind): string {
  switch (kind) {
    case "access-denied":
      return "access denied (missing permission or credentials).";
    case "not-found":
      return "the key was not found.";
    case "invalid-ciphertext":
      return "the KMS rejected the wrapped key (modified, or wrapped with a different key).";
    case "key-unusable":
      return "the key cannot be used (disabled, scheduled for deletion or of the wrong type).";
    case "other":
      return "the request failed.";
  }
}

function hintFor(provider: KmsProvider, operation: KmsOperation, kind: KmsFailureKind): string {
  const permission = REQUIRED_PERMISSIONS[provider][operation];
  switch (kind) {
    case "access-denied":
      return `Grant ${permission} on this key to the identity running MongoShield, and check that its credentials are available (environment, instance role or workload identity).`;
    case "not-found":
      return "Check the key identifier and region/project, and that the identity running MongoShield can see the key.";
    case "invalid-ciphertext":
      return operation === "decrypt"
        ? "The backup's key file may be damaged. Run `mongoshield verify`, or restore with an offline recovery identity (encryption.recipients)."
        : "Check that the key is a symmetric encryption key (or an RSA key for Azure).";
    case "key-unusable":
      return "Enable the key (or cancel its deletion) in the provider's console. Without it, use an offline recovery identity.";
    case "other":
      return `Check network access to ${PROVIDER_NAMES[provider]} and retry. The cause has the provider's error.`;
  }
}

/** The SDK for a provider is not installed. */
export function missingSdkError(provider: KmsProvider, cause: unknown): MongoShieldError {
  return new MongoShieldError(
    "MS_CONFIG_INVALID",
    `${PROVIDER_NAMES[provider]} encryption needs the optional package(s) ${SDK_PACKAGES[provider]}.`,
    { hint: `npm install ${SDK_PACKAGES[provider]}`, cause },
  );
}

/**
 * Loads an optional SDK module. A missing package becomes `missingSdkError`; any
 * other import failure is rethrown unchanged.
 */
export async function loadSdk<Module>(
  provider: KmsProvider,
  load: () => Promise<Module>,
): Promise<Module> {
  try {
    return await load();
  } catch (error) {
    if (isModuleNotFound(error)) throw missingSdkError(provider, error);
    throw error;
  }
}

/**
 * True if an import failed because a package is not installed. Loaders and bundlers
 * sometimes wrap the original error, so the `cause` chain is checked too.
 */
export function isModuleNotFound(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    const code = propertyOf(current, "code");
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
    const message = current instanceof Error ? current.message : "";
    if (/Cannot find (module|package)/.test(message)) return true;
    current = propertyOf(current, "cause");
  }
  return false;
}

/** Reads a property of an unknown value without trusting its shape. */
export function propertyOf(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}
