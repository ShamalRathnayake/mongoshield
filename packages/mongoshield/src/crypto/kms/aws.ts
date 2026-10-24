/**
 * AWS KMS adapter: wraps data keys with `Encrypt` and unwraps them with `Decrypt`.
 *
 * Needs the optional package `@aws-sdk/client-kms`, loaded on first use. Credentials
 * and (unless the key is an ARN) the region come from the SDK's default chain
 * (environment, shared config, instance or task role).
 *
 *   permissions: kms:Encrypt (backup), kms:Decrypt (restore, deep verify)
 *
 * Symmetric keys (`SYMMETRIC_DEFAULT`, the usual choice) bind every data key to the
 * encryption context `{"mongoshield:purpose": "backup-key"}`. Asymmetric RSA keys
 * (`RSAES_OAEP_SHA_256`) are supported too; they cannot take an encryption context.
 */

import type * as KmsSdk from "@aws-sdk/client-kms";
import type { KMSClient } from "@aws-sdk/client-kms";
import { MongoShieldError } from "../../errors.ts";
import { type KmsFailureKind, kmsCallError, loadSdk, propertyOf } from "./errors.ts";
import { KMS_DATA_KEY_CONTEXT, type KmsCiphertext, type KmsClient } from "./types.ts";

/** Wrapping algorithms MongoShield uses with AWS KMS. */
export type AwsKmsAlgorithm = "SYMMETRIC_DEFAULT" | "RSAES_OAEP_SHA_256";

const ALGORITHMS: readonly AwsKmsAlgorithm[] = ["SYMMETRIC_DEFAULT", "RSAES_OAEP_SHA_256"];

/** Options for `createAwsKmsClient`. */
export interface AwsKmsClientOptions {
  /**
   * An existing `KMSClient` to use (custom credentials, endpoint, proxies). Its region
   * must be the key's region. MongoShield never destroys a client it did not create.
   */
  readonly client?: KMSClient;
  /** Region for a new client. Default: the key ARN's region, else the SDK default chain. */
  readonly region?: string;
  /** Default `SYMMETRIC_DEFAULT`. Use `RSAES_OAEP_SHA_256` for an asymmetric RSA key. */
  readonly algorithm?: AwsKmsAlgorithm;
}

/**
 * Accepts key ARNs, alias ARNs, `alias/…` names and bare key ids (UUIDs, or
 * multi-Region `mrk-…`). Only characters that can appear in those, so a tampered key file cannot
 * smuggle anything odd into a request.
 */
const AWS_KEY_PATTERN =
  /^(arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key|alias)\/[A-Za-z0-9/_+=.@-]+|alias\/[A-Za-z0-9/_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/;

/** Throws MS_CONFIG_INVALID unless `key` looks like an AWS KMS key identifier. */
export function assertValidAwsKmsKey(key: string): void {
  if (AWS_KEY_PATTERN.test(key)) return;
  throw new MongoShieldError("MS_CONFIG_INVALID", `"${key}" is not an AWS KMS key identifier.`, {
    hint: "Use a key ARN (arn:aws:kms:<region>:<account>:key/<id>), an alias ARN, or alias/<name>.",
  });
}

/** The region in a KMS ARN (`arn:aws:kms:<region>:…`), if the key is an ARN. */
export function regionOfAwsKey(key: string): string | undefined {
  const parts = key.split(":");
  return parts[0] === "arn" && parts[2] === "kms" ? parts[3] : undefined;
}

/**
 * Creates a `KmsClient` for one AWS KMS key. Nothing is loaded or contacted until
 * the first call.
 */
export function createAwsKmsClient(key: string, options: AwsKmsClientOptions = {}): KmsClient {
  assertValidAwsKmsKey(key);
  const defaultAlgorithm = options.algorithm ?? "SYMMETRIC_DEFAULT";
  let connection: Promise<{ sdk: typeof KmsSdk; client: KMSClient; owned: boolean }> | undefined;

  /** Loads the SDK and creates (or adopts) the SDK client, once. */
  function connect() {
    connection ??= (async () => {
      const sdk = await loadSdk("aws", () => import("@aws-sdk/client-kms"));
      if (options.client !== undefined) return { sdk, client: options.client, owned: false };
      const region = options.region ?? regionOfAwsKey(key);
      const client = new sdk.KMSClient(region === undefined ? {} : { region });
      return { sdk, client, owned: true };
    })();
    return connection;
  }

  return {
    provider: "aws",
    key,
    async encryptDataKey(dataKey: Uint8Array): Promise<KmsCiphertext> {
      const { sdk, client } = await connect();
      const output = await callAws("encrypt", key, () =>
        client.send(
          new sdk.EncryptCommand({
            KeyId: key,
            Plaintext: dataKey,
            EncryptionAlgorithm: defaultAlgorithm,
            ...encryptionContextFor(defaultAlgorithm),
          }),
        ),
      );
      if (output.CiphertextBlob === undefined) {
        throw kmsCallError("aws", "encrypt", key, "other", "Encrypt returned no CiphertextBlob");
      }
      // Record the key ARN AWS reports, not an alias: aliases can be re-pointed later,
      // which would make Decrypt with the alias fail for this backup.
      const keyArn =
        output.KeyId !== undefined && AWS_KEY_PATTERN.test(output.KeyId) ? output.KeyId : key;
      return { key: keyArn, algorithm: defaultAlgorithm, ciphertext: output.CiphertextBlob };
    },
    async decryptDataKey(wrapped: KmsCiphertext): Promise<Uint8Array> {
      const algorithm = parseAlgorithm(wrapped.algorithm, key);
      const { sdk, client } = await connect();
      const output = await callAws("decrypt", key, () =>
        client.send(
          new sdk.DecryptCommand({
            // Naming the key makes KMS refuse ciphertexts of any other key, instead
            // of decrypting with whichever key the ciphertext points to.
            KeyId: key,
            CiphertextBlob: wrapped.ciphertext,
            EncryptionAlgorithm: algorithm,
            ...encryptionContextFor(algorithm),
          }),
        ),
      );
      if (output.Plaintext === undefined) {
        throw kmsCallError("aws", "decrypt", key, "other", "Decrypt returned no Plaintext");
      }
      return output.Plaintext;
    },
    async close(): Promise<void> {
      if (connection === undefined) return;
      const { client, owned } = await connection;
      if (owned) client.destroy();
    },
  };
}

/** The encryption context, for symmetric keys only (RSA encryption cannot take one). */
function encryptionContextFor(algorithm: AwsKmsAlgorithm): {
  EncryptionContext?: Record<string, string>;
} {
  return algorithm === "SYMMETRIC_DEFAULT"
    ? { EncryptionContext: { ...KMS_DATA_KEY_CONTEXT.aws } }
    : {};
}

/** Validates the algorithm recorded in a stanza. */
function parseAlgorithm(value: string, key: string): AwsKmsAlgorithm {
  const algorithm = ALGORITHMS.find((candidate) => candidate === value);
  if (algorithm !== undefined) return algorithm;
  throw kmsCallError("aws", "decrypt", key, "key-unusable", `unsupported algorithm ${value}`);
}

/** Runs one SDK call and turns its failure into a MongoShieldError. */
async function callAws<Output>(
  operation: "encrypt" | "decrypt",
  key: string,
  call: () => Promise<Output>,
): Promise<Output> {
  try {
    return await call();
  } catch (error) {
    throw kmsCallError("aws", operation, key, classifyAwsError(error), error);
  }
}

/** Maps AWS SDK v3 error names (the service exception type) to a failure kind. */
export function classifyAwsError(error: unknown): KmsFailureKind {
  const name = propertyOf(error, "name");
  switch (name) {
    case "AccessDeniedException":
    case "UnrecognizedClientException":
    case "InvalidSignatureException":
    case "ExpiredTokenException":
    case "CredentialsProviderError":
      return "access-denied";
    case "NotFoundException":
      return "not-found";
    case "InvalidCiphertextException":
    case "IncorrectKeyException":
      return "invalid-ciphertext";
    case "DisabledException":
    case "KMSInvalidStateException":
    case "InvalidKeyUsageException":
    case "UnsupportedOperationException":
      return "key-unusable";
    default:
      return "other";
  }
}
