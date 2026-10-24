/**
 * Google Cloud KMS adapter: wraps data keys with `encrypt` and unwraps them with
 * `decrypt` on a symmetric CryptoKey.
 *
 * Needs the optional package `@google-cloud/kms`, loaded on first use. Credentials
 * come from Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS, gcloud,
 * the metadata server or workload identity).
 *
 *   permissions: cloudkms.cryptoKeyVersions.useToEncrypt (backup),
 *                cloudkms.cryptoKeyVersions.useToDecrypt (restore, deep verify)
 *
 * Every data key is bound to the additional authenticated data
 * `mongoshield:purpose=backup-key`. The ciphertext names the key version itself, so
 * rotating the key does not affect old backups as long as old versions stay enabled.
 */

import { MongoShieldError } from "../../errors.ts";
import { type KmsFailureKind, kmsCallError, loadSdk, propertyOf } from "./errors.ts";
import { KMS_DATA_KEY_CONTEXT, type KmsCiphertext, type KmsClient } from "./types.ts";

/** The only algorithm used: GCP symmetric encryption (AES-256-GCM inside the KMS). */
export const GCP_KMS_ALGORITHM = "GOOGLE_SYMMETRIC_ENCRYPTION";

/** Bytes as the GCP client returns them: a Buffer/Uint8Array, or base64 text over REST. */
type GcpBytes = Uint8Array | string | null | undefined;

/**
 * The two methods MongoShield calls on a `KeyManagementServiceClient`. A structural
 * type, so a real client fits, and tests can pass a small fake.
 */
export interface GcpKmsSdkClient {
  encrypt(request: {
    name: string;
    plaintext: Uint8Array;
    additionalAuthenticatedData: Uint8Array;
  }): Promise<readonly [{ ciphertext?: GcpBytes }, ...unknown[]]>;
  decrypt(request: {
    name: string;
    ciphertext: Uint8Array;
    additionalAuthenticatedData: Uint8Array;
  }): Promise<readonly [{ plaintext?: GcpBytes }, ...unknown[]]>;
  close?(): Promise<void>;
}

/** Options for `createGcpKmsClient`. */
export interface GcpKmsClientOptions {
  /**
   * An existing `KeyManagementServiceClient` (custom credentials or endpoint).
   * MongoShield never closes a client it did not create.
   */
  readonly client?: GcpKmsSdkClient;
}

/**
 * A CryptoKey resource name. Not a key *version*: `encrypt` needs the key (it picks
 * the primary version) and `decrypt` takes the key too. Segment ids are limited to
 * the characters GCP allows.
 */
const GCP_KEY_PATTERN =
  /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/;

/** Throws MS_CONFIG_INVALID unless `key` is a GCP CryptoKey resource name. */
export function assertValidGcpKmsKey(key: string): void {
  if (GCP_KEY_PATTERN.test(key)) return;
  throw new MongoShieldError("MS_CONFIG_INVALID", `"${key}" is not a Google Cloud KMS key name.`, {
    hint: "Use projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key> (without /cryptoKeyVersions/…).",
  });
}

/**
 * Creates a `KmsClient` for one GCP CryptoKey. Nothing is loaded or contacted until
 * the first call.
 */
export function createGcpKmsClient(key: string, options: GcpKmsClientOptions = {}): KmsClient {
  assertValidGcpKmsKey(key);
  const authenticatedData = Buffer.from(KMS_DATA_KEY_CONTEXT.gcp, "utf8");
  let connection: Promise<{ client: GcpKmsSdkClient; owned: boolean }> | undefined;

  /** Loads the SDK and creates (or adopts) the SDK client, once. */
  function connect() {
    connection ??= (async () => {
      if (options.client !== undefined) return { client: options.client, owned: false };
      const sdk = await loadSdk("gcp", () => import("@google-cloud/kms"));
      const client: GcpKmsSdkClient = new sdk.KeyManagementServiceClient();
      return { client, owned: true };
    })();
    return connection;
  }

  return {
    provider: "gcp",
    key,
    async encryptDataKey(dataKey: Uint8Array): Promise<KmsCiphertext> {
      const { client } = await connect();
      const [response] = await callGcp("encrypt", key, () =>
        client.encrypt({
          name: key,
          plaintext: dataKey,
          additionalAuthenticatedData: authenticatedData,
        }),
      );
      const ciphertext = toBytes(response.ciphertext);
      if (ciphertext === undefined) {
        throw kmsCallError("gcp", "encrypt", key, "other", "encrypt returned no ciphertext");
      }
      return { key, algorithm: GCP_KMS_ALGORITHM, ciphertext };
    },
    async decryptDataKey(wrapped: KmsCiphertext): Promise<Uint8Array> {
      if (wrapped.algorithm !== GCP_KMS_ALGORITHM) {
        throw kmsCallError(
          "gcp",
          "decrypt",
          key,
          "key-unusable",
          `unsupported algorithm ${wrapped.algorithm}`,
        );
      }
      const { client } = await connect();
      const [response] = await callGcp("decrypt", key, () =>
        client.decrypt({
          name: key,
          ciphertext: wrapped.ciphertext,
          additionalAuthenticatedData: authenticatedData,
        }),
      );
      const plaintext = toBytes(response.plaintext);
      if (plaintext === undefined) {
        throw kmsCallError("gcp", "decrypt", key, "other", "decrypt returned no plaintext");
      }
      return plaintext;
    },
    async close(): Promise<void> {
      if (connection === undefined) return;
      const { client, owned } = await connection;
      if (owned) await client.close?.();
    },
  };
}

/** Normalises the client's byte fields; `undefined` when absent or empty. */
function toBytes(value: GcpBytes): Uint8Array | undefined {
  if (value === null || value === undefined) return undefined;
  const bytes = typeof value === "string" ? Buffer.from(value, "base64") : value;
  return bytes.length === 0 ? undefined : bytes;
}

/** Runs one SDK call and turns its failure into a MongoShieldError. */
async function callGcp<Output>(
  operation: "encrypt" | "decrypt",
  key: string,
  call: () => Promise<Output>,
): Promise<Output> {
  try {
    return await call();
  } catch (error) {
    throw kmsCallError("gcp", operation, key, classifyGcpError(error), error);
  }
}

/** gRPC status codes (https://grpc.io/docs/guides/status-codes/) used below. */
const GRPC = {
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  FAILED_PRECONDITION: 9,
  UNAUTHENTICATED: 16,
} as const;

/**
 * Maps a google-gax error (numeric gRPC `code`) to a failure kind. GCP reports a
 * ciphertext made with another key or AAD as INVALID_ARGUMENT, and a disabled or
 * destroyed key version as FAILED_PRECONDITION.
 */
export function classifyGcpError(error: unknown): KmsFailureKind {
  switch (propertyOf(error, "code")) {
    case GRPC.PERMISSION_DENIED:
    case GRPC.UNAUTHENTICATED:
      return "access-denied";
    case GRPC.NOT_FOUND:
      return "not-found";
    case GRPC.INVALID_ARGUMENT:
      return "invalid-ciphertext";
    case GRPC.FAILED_PRECONDITION:
      return "key-unusable";
    default:
      return "other";
  }
}
