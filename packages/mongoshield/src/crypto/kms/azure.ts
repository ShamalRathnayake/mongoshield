/**
 * Azure Key Vault / Managed HSM adapter: wraps data keys with `wrapKey` and unwraps
 * them with `unwrapKey`.
 *
 * Needs the optional packages `@azure/keyvault-keys` and `@azure/identity`, loaded on
 * first use. Credentials come from `DefaultAzureCredential` (environment, workload or
 * managed identity, Azure CLI) unless a credential is passed.
 *
 *   permissions: keys/wrapKey (backup), keys/unwrapKey (restore, deep verify)
 *
 * Key Vault keys are RSA, so the default algorithm is RSA-OAEP-256. Managed HSM
 * symmetric (`oct-HSM`) keys use AES key wrap: pass `algorithm: "A256KW"`. The
 * algorithm and the exact key *version* are recorded in the backup, so restores need
 * no extra settings and keep working after the key is rotated.
 */

import type { TokenCredential } from "@azure/identity";
import { MongoShieldError } from "../../errors.ts";
import { type KmsFailureKind, kmsCallError, loadSdk, propertyOf } from "./errors.ts";
import type { KmsCiphertext, KmsClient } from "./types.ts";

/** Key wrap algorithms MongoShield accepts for Azure keys. */
export type AzureKeyWrapAlgorithm = "RSA-OAEP-256" | "RSA-OAEP" | "A128KW" | "A192KW" | "A256KW";

const ALGORITHMS: readonly AzureKeyWrapAlgorithm[] = [
  "RSA-OAEP-256",
  "RSA-OAEP",
  "A128KW",
  "A192KW",
  "A256KW",
];

/** The credential type `CryptographyClient` takes (any `@azure/identity` credential). */
export type AzureTokenCredential = TokenCredential;

/**
 * The two methods MongoShield calls on a `CryptographyClient`, which is bound to one
 * key. A structural type, so tests can pass a small fake.
 */
export interface AzureKeyWrapSdkClient {
  wrapKey(
    algorithm: AzureKeyWrapAlgorithm,
    key: Uint8Array,
  ): Promise<{ readonly result: Uint8Array; readonly keyID?: string | undefined }>;
  unwrapKey(
    algorithm: AzureKeyWrapAlgorithm,
    encryptedKey: Uint8Array,
  ): Promise<{ readonly result: Uint8Array }>;
}

/** Options for `createAzureKmsClient`. */
export interface AzureKmsClientOptions {
  /** Credential for a new `CryptographyClient`. Default: `new DefaultAzureCredential()`. */
  readonly credential?: AzureTokenCredential;
  /**
   * An existing client for exactly this key. Note that on restore the key is the
   * versioned URL recorded in the backup; prefer `credential` unless you need more.
   */
  readonly client?: AzureKeyWrapSdkClient;
  /** Default `RSA-OAEP-256`. Use `A256KW` for Managed HSM symmetric keys. */
  readonly algorithm?: AzureKeyWrapAlgorithm;
}

/**
 * Hosts of Key Vault and Managed HSM in the public and sovereign clouds.
 *
 * Why an allow-list: on restore, the key URL comes from the backup's key file, and
 * the SDK sends a bearer token to that host. A key file swapped by someone with write
 * access to the bucket must not be able to point MongoShield at their own server.
 */
const AZURE_KEY_HOST_SUFFIXES = [
  ".vault.azure.net",
  ".managedhsm.azure.net",
  ".vault.azure.cn",
  ".managedhsm.azure.cn",
  ".vault.usgovcloudapi.net",
  ".managedhsm.usgovcloudapi.net",
  ".vault.microsoftazure.de",
];

/** `/keys/<name>` or `/keys/<name>/<version>`, the path of a Key Vault key URL. */
const AZURE_KEY_PATH = /^\/keys\/[A-Za-z0-9-]{1,127}(\/[A-Za-z0-9]{1,64})?\/?$/;

/** Throws MS_CONFIG_INVALID unless `key` is an https Key Vault / Managed HSM key URL. */
export function assertValidAzureKmsKey(key: string): void {
  if (isValidAzureKeyUrl(key)) return;
  throw new MongoShieldError("MS_CONFIG_INVALID", `"${key}" is not an Azure Key Vault key URL.`, {
    hint: "Use https://<vault>.vault.azure.net/keys/<name> (optionally /<version>), or a Managed HSM key URL.",
  });
}

function isValidAzureKeyUrl(key: string): boolean {
  let url: URL;
  try {
    url = new URL(key);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    AZURE_KEY_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) &&
    AZURE_KEY_PATH.test(url.pathname)
  );
}

/**
 * Creates a `KmsClient` for one Key Vault key. Nothing is loaded or contacted until
 * the first call.
 */
export function createAzureKmsClient(key: string, options: AzureKmsClientOptions = {}): KmsClient {
  assertValidAzureKmsKey(key);
  const defaultAlgorithm = options.algorithm ?? "RSA-OAEP-256";
  let connection: Promise<AzureKeyWrapSdkClient> | undefined;

  /** Loads the SDK and creates (or adopts) the SDK client, once. */
  function connect(): Promise<AzureKeyWrapSdkClient> {
    connection ??= (async () => {
      if (options.client !== undefined) return options.client;
      const keys = await loadSdk("azure", () => import("@azure/keyvault-keys"));
      const credential = options.credential ?? (await defaultCredential());
      return new keys.CryptographyClient(key, credential);
    })();
    return connection;
  }

  return {
    provider: "azure",
    key,
    async encryptDataKey(dataKey: Uint8Array): Promise<KmsCiphertext> {
      const client = await connect();
      const result = await callAzure("encrypt", key, () =>
        client.wrapKey(defaultAlgorithm, dataKey),
      );
      // Record the versioned key id Key Vault reports: unwrapping with the
      // unversioned URL would use the *latest* version, which fails after rotation.
      const versioned =
        result.keyID !== undefined && isValidAzureKeyUrl(result.keyID) ? result.keyID : key;
      return { key: versioned, algorithm: defaultAlgorithm, ciphertext: result.result };
    },
    async decryptDataKey(wrapped: KmsCiphertext): Promise<Uint8Array> {
      const algorithm = ALGORITHMS.find((candidate) => candidate === wrapped.algorithm);
      if (algorithm === undefined) {
        throw kmsCallError(
          "azure",
          "decrypt",
          key,
          "key-unusable",
          `unsupported algorithm ${wrapped.algorithm}`,
        );
      }
      const client = await connect();
      const result = await callAzure("decrypt", key, () =>
        client.unwrapKey(algorithm, wrapped.ciphertext),
      );
      return result.result;
    },
    // CryptographyClient holds no sockets of its own to release.
  };
}

/** `new DefaultAzureCredential()` from the optional `@azure/identity` package. */
async function defaultCredential(): Promise<AzureTokenCredential> {
  const identity = await loadSdk("azure", () => import("@azure/identity"));
  return new identity.DefaultAzureCredential();
}

/** Runs one SDK call and turns its failure into a MongoShieldError. */
async function callAzure<Output>(
  operation: "encrypt" | "decrypt",
  key: string,
  call: () => Promise<Output>,
): Promise<Output> {
  try {
    return await call();
  } catch (error) {
    throw kmsCallError("azure", operation, key, classifyAzureError(error), error);
  }
}

/**
 * Maps an Azure SDK error (`RestError` with an HTTP `statusCode`, or an identity
 * error by name) to a failure kind. Key Vault answers a ciphertext it cannot unwrap
 * with 400 Bad Request.
 */
export function classifyAzureError(error: unknown): KmsFailureKind {
  const name = propertyOf(error, "name");
  if (name === "CredentialUnavailableError" || name === "AuthenticationError")
    return "access-denied";
  switch (propertyOf(error, "statusCode")) {
    case 401:
    case 403:
      return "access-denied";
    case 404:
      return "not-found";
    case 400:
      return "invalid-ciphertext";
    case 409:
      return "key-unusable";
    default:
      return "other";
  }
}
