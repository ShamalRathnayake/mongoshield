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
 * The wrapping algorithm follows the key type, read once with `getKey` before the
 * first wrap: RSA keys (`RSA`, `RSA-HSM`) use RSA-OAEP-256, and Managed HSM
 * symmetric keys (`oct-HSM`, AES-256) use AES key wrap, A256KW. Reading the key
 * needs keys/get (part of the usual "Crypto Service Encryption User" roles);
 * without it RSA-OAEP-256 is used, so pass `algorithm` explicitly for oct keys
 * then, and for AES-128/192 keys (A128KW/A192KW). The algorithm and the exact key
 * *version* are recorded in the backup, so restores need no extra settings and keep
 * working after the key is rotated.
 *
 * A call's `signal` is passed to the SDK as `abortSignal`, which cancels the request.
 */

import type { TokenCredential } from "@azure/identity";
import { abortError, MongoShieldError, throwIfAborted } from "../../errors.ts";
import {
  callKms,
  type KmsFailureKind,
  kmsCallError,
  loadSdk,
  propertyOf,
  untilAborted,
} from "./errors.ts";
import type { KmsCallOptions, KmsCiphertext, KmsClient } from "./types.ts";

/** Key wrap algorithms MongoShield accepts for Azure keys. */
export type AzureKeyWrapAlgorithm = "RSA-OAEP-256" | "RSA-OAEP" | "A128KW" | "A192KW" | "A256KW";

const ALGORITHMS: readonly AzureKeyWrapAlgorithm[] = [
  "RSA-OAEP-256",
  "RSA-OAEP",
  "A128KW",
  "A192KW",
  "A256KW",
];

/** The algorithm used when the key type is unknown: Key Vault keys are RSA by default. */
const DEFAULT_ALGORITHM: AzureKeyWrapAlgorithm = "RSA-OAEP-256";

/**
 * AES key wrap for symmetric (`oct`, `oct-HSM`) keys. Managed HSM creates 256-bit
 * AES keys unless told otherwise; smaller keys need an explicit `algorithm`.
 */
const SYMMETRIC_ALGORITHM: AzureKeyWrapAlgorithm = "A256KW";

/** Per-request options the Azure SDK takes; `abortSignal` cancels the HTTP request. */
export interface AzureOperationOptions {
  readonly abortSignal?: AbortSignal;
}

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
    options?: AzureOperationOptions,
  ): Promise<{ readonly result: Uint8Array; readonly keyID?: string | undefined }>;
  unwrapKey(
    algorithm: AzureKeyWrapAlgorithm,
    encryptedKey: Uint8Array,
    options?: AzureOperationOptions,
  ): Promise<{ readonly result: Uint8Array }>;
}

/**
 * The one method MongoShield calls on a `KeyClient`: reading a key's type to pick
 * the wrapping algorithm. A structural type, so tests can pass a small fake.
 */
export interface AzureKeyReaderSdkClient {
  getKey(
    name: string,
    options?: AzureOperationOptions & { readonly version?: string },
  ): Promise<{ readonly keyType?: string | undefined }>;
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
  /**
   * The wrapping algorithm. Default: chosen from the key type (see the header
   * comment), or `RSA-OAEP-256` when the type cannot be read.
   */
  readonly algorithm?: AzureKeyWrapAlgorithm;
  /**
   * Reads the key type when `algorithm` is not set. Default: a `KeyClient` for the
   * key's vault when MongoShield creates the clients itself; with a custom `client`
   * and no `keyClient`, the type is not read and `RSA-OAEP-256` is used.
   */
  readonly keyClient?: AzureKeyReaderSdkClient;
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
  let connection:
    | Promise<{ crypto: AzureKeyWrapSdkClient; reader: AzureKeyReaderSdkClient | undefined }>
    | undefined;
  /** The wrapping algorithm, decided on the first encrypt (see {@link wrapAlgorithm}). */
  let detectedAlgorithm: Promise<AzureKeyWrapAlgorithm> | undefined;

  /** Loads the SDK and creates (or adopts) the SDK clients, once. */
  function connect() {
    connection ??= (async () => {
      if (options.client !== undefined) {
        return { crypto: options.client, reader: options.keyClient };
      }
      const keys = await loadSdk("azure", () => import("@azure/keyvault-keys"));
      const credential = options.credential ?? (await defaultCredential());
      const crypto = new keys.CryptographyClient(key, credential);
      // The algorithm is fixed or another reader was given: no KeyClient needed.
      if (options.algorithm !== undefined || options.keyClient !== undefined) {
        return { crypto, reader: options.keyClient };
      }
      return { crypto, reader: new keys.KeyClient(new URL(key).origin, credential) };
    })();
    return connection;
  }

  /**
   * The configured algorithm, or one chosen from the key type. Cached once it
   * succeeds; a failed lookup (other than a missing permission) fails the wrap.
   */
  function wrapAlgorithm(
    reader: AzureKeyReaderSdkClient | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AzureKeyWrapAlgorithm> {
    if (options.algorithm !== undefined) return Promise.resolve(options.algorithm);
    if (reader === undefined) return Promise.resolve(DEFAULT_ALGORITHM);
    const pending = detectedAlgorithm ?? algorithmForKeyType(reader, key, signal);
    detectedAlgorithm = pending;
    pending.catch(() => {
      if (detectedAlgorithm === pending) detectedAlgorithm = undefined;
    });
    return pending;
  }

  return {
    provider: "azure",
    key,
    async encryptDataKey(dataKey: Uint8Array, call: KmsCallOptions = {}): Promise<KmsCiphertext> {
      const { crypto, reader } = await connect();
      const chosen = await wrapAlgorithm(reader, call.signal);
      const target = { provider: "azure", operation: "encrypt", key, signal: call.signal } as const;
      const result = await callKms(target, classifyAzureError, () =>
        crypto.wrapKey(chosen, dataKey, operationOptions(call.signal)),
      );
      // Record the versioned key id Key Vault reports: unwrapping with the
      // unversioned URL would use the *latest* version, which fails after rotation.
      const versioned =
        result.keyID !== undefined && isValidAzureKeyUrl(result.keyID) ? result.keyID : key;
      return { key: versioned, algorithm: chosen, ciphertext: result.result };
    },
    async decryptDataKey(wrapped: KmsCiphertext, call: KmsCallOptions = {}): Promise<Uint8Array> {
      // The recorded algorithm, never the configured one: the backup says how it was wrapped.
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
      const { crypto } = await connect();
      const target = { provider: "azure", operation: "decrypt", key, signal: call.signal } as const;
      const result = await callKms(target, classifyAzureError, () =>
        crypto.unwrapKey(algorithm, wrapped.ciphertext, operationOptions(call.signal)),
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

/**
 * Reads the key's type and picks the matching algorithm: A256KW for symmetric
 * (`oct`, `oct-HSM`) keys, RSA-OAEP-256 for everything else. Without permission to
 * read the key (403), falls back to RSA-OAEP-256, the Key Vault default.
 */
async function algorithmForKeyType(
  reader: AzureKeyReaderSdkClient,
  key: string,
  signal: AbortSignal | undefined,
): Promise<AzureKeyWrapAlgorithm> {
  const { name, version } = keyNameAndVersion(key);
  throwIfAborted(signal);
  let keyType: string | undefined;
  try {
    const request = { ...(version === undefined ? {} : { version }), ...operationOptions(signal) };
    keyType = (await untilAborted(reader.getKey(name, request), signal)).keyType;
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    const kind = classifyAzureError(error);
    if (kind === "access-denied") return DEFAULT_ALGORITHM;
    throw kmsCallError("azure", "encrypt", key, kind, error);
  }
  return keyType?.toLowerCase().startsWith("oct") ? SYMMETRIC_ALGORITHM : DEFAULT_ALGORITHM;
}

/** `https://v.vault.azure.net/keys/<name>[/<version>]` → its name and version. */
function keyNameAndVersion(key: string): { name: string; version?: string } {
  const [, , name = "", version] = new URL(key).pathname.split("/");
  return version === undefined || version === "" ? { name } : { name, version };
}

/** The SDK's per-request options for a signal. */
function operationOptions(signal: AbortSignal | undefined): AzureOperationOptions {
  return signal === undefined ? {} : { abortSignal: signal };
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
