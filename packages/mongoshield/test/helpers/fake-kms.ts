// An in-memory stand-in for cloud KMS services, so KMS code is tested without any
// network or cloud account. `FakeKms` holds one random AES-256-GCM master key per
// key id and can deny access per key; `fakeAwsSdkClient`, `fakeGcpSdkClient` and
// `fakeAzureSdkClient` expose it through each provider SDK's shape (AWS via
// aws-sdk-client-mock on a real KMSClient), and `installFakeKms` registers all three
// behind the real MongoShield adapters.

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
  KMSServiceException,
} from "@aws-sdk/client-kms";
import { mockClient } from "aws-sdk-client-mock";
import { createAwsKmsClient } from "../../src/crypto/kms/aws.ts";
import {
  type AzureKeyWrapAlgorithm,
  type AzureKeyWrapSdkClient,
  createAzureKmsClient,
} from "../../src/crypto/kms/azure.ts";
import { createGcpKmsClient, type GcpKmsSdkClient } from "../../src/crypto/kms/gcp.ts";
import { setKmsClientFactory } from "../../src/crypto/kms/registry.ts";
import type { KmsProvider } from "../../src/crypto/kms/types.ts";

/** Example key ids of the right shape for each provider. */
export const AWS_KEY =
  "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
export const AWS_ALIAS = "alias/mongoshield-backups";
export const GCP_KEY =
  "projects/acme/locations/europe-west1/keyRings/backups/cryptoKeys/mongoshield";
export const AZURE_KEY = "https://acme-backups.vault.azure.net/keys/mongoshield";

/** One recorded call to the fake. */
export interface FakeKmsCall {
  readonly provider: KmsProvider;
  readonly operation: "encrypt" | "decrypt";
  readonly key: string;
}

/** Thrown by `FakeKms.open` when a ciphertext does not authenticate. */
export class FakeCiphertextError extends Error {}

/** The KMS itself: master keys, access rules and a call log. */
export class FakeKms {
  readonly calls: FakeKmsCall[] = [];
  /** Keys (base id, without Azure versions) for which every call is denied. */
  readonly denied = new Set<string>();
  private readonly masterKeys = new Map<string, Buffer>();

  /** AES-256-GCM seal under the key's master key: iv (12) || ciphertext || tag (16). */
  seal(key: string, plaintext: Uint8Array, aad: Uint8Array): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey(key), iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]);
  }

  /** Opens a sealed value, or throws `FakeCiphertextError`. */
  open(key: string, sealed: Uint8Array, aad: Uint8Array): Buffer {
    const bytes = Buffer.from(sealed);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.masterKey(key), bytes.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      return Buffer.concat([
        decipher.update(bytes.subarray(12, bytes.length - 16)),
        decipher.final(),
      ]);
    } catch {
      throw new FakeCiphertextError("ciphertext does not authenticate");
    }
  }

  /** Records a call and reports whether it is allowed. */
  allow(provider: KmsProvider, operation: "encrypt" | "decrypt", key: string): boolean {
    this.calls.push({ provider, operation, key });
    return !this.denied.has(baseKey(key));
  }

  private masterKey(key: string): Buffer {
    const id = baseKey(key);
    let master = this.masterKeys.get(id);
    if (master === undefined) {
      master = randomBytes(32);
      this.masterKeys.set(id, master);
    }
    return master;
  }
}

/** Azure key versions share the key's master key, like a real (unrotated) key. */
function baseKey(key: string): string {
  const match = /^(https:\/\/[^/]+\/keys\/[^/]+)\/[A-Za-z0-9]+$/.exec(key);
  return match?.[1] ?? key;
}

/** AWS context as a stable byte string, so it can serve as the fake's AAD. */
function awsContextBytes(context: Record<string, string> | undefined): Buffer {
  return Buffer.from(JSON.stringify(Object.entries(context ?? {}).sort()), "utf8");
}

function awsError(name: string, httpStatusCode: number): KMSServiceException {
  return new KMSServiceException({
    name,
    $fault: "client",
    $metadata: { httpStatusCode },
    message: `${name} from the fake KMS`,
  });
}

/**
 * A real `KMSClient` whose `send` is answered by the fake. Aliases resolve to
 * `AWS_KEY`, as AWS reports the key ARN for an alias.
 */
export function fakeAwsSdkClient(kms: FakeKms): KMSClient {
  const client = new KMSClient({
    region: "eu-west-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const resolveArn = (keyId: string | undefined) => (keyId === AWS_ALIAS ? AWS_KEY : (keyId ?? ""));
  const mock = mockClient(client);
  mock.on(EncryptCommand).callsFake((input: EncryptCommand["input"]) => {
    const arn = resolveArn(input.KeyId);
    if (!kms.allow("aws", "encrypt", arn)) throw awsError("AccessDeniedException", 400);
    const plaintext = input.Plaintext ?? new Uint8Array();
    const blob = kms.seal(arn, plaintext, awsContextBytes(input.EncryptionContext));
    return { CiphertextBlob: blob, KeyId: arn, EncryptionAlgorithm: input.EncryptionAlgorithm };
  });
  mock.on(DecryptCommand).callsFake((input: DecryptCommand["input"]) => {
    const arn = resolveArn(input.KeyId);
    if (!kms.allow("aws", "decrypt", arn)) throw awsError("AccessDeniedException", 400);
    try {
      const blob = input.CiphertextBlob ?? new Uint8Array();
      const plaintext = kms.open(arn, blob, awsContextBytes(input.EncryptionContext));
      return { Plaintext: plaintext, KeyId: arn };
    } catch {
      throw awsError("InvalidCiphertextException", 400);
    }
  });
  return client;
}

/** A gRPC-style error as google-gax throws them. */
function grpcError(code: number, message: string): Error {
  return Object.assign(new Error(`${code} ${message}`), { code });
}

/** A `KeyManagementServiceClient` look-alike answered by the fake. */
export function fakeGcpSdkClient(kms: FakeKms): GcpKmsSdkClient & { closed: boolean } {
  return {
    closed: false,
    async encrypt(request) {
      if (!kms.allow("gcp", "encrypt", request.name)) throw grpcError(7, "PERMISSION_DENIED");
      const ciphertext = kms.seal(
        request.name,
        request.plaintext,
        request.additionalAuthenticatedData,
      );
      return [{ ciphertext, name: `${request.name}/cryptoKeyVersions/1` }];
    },
    async decrypt(request) {
      if (!kms.allow("gcp", "decrypt", request.name)) throw grpcError(7, "PERMISSION_DENIED");
      try {
        return [
          {
            plaintext: kms.open(
              request.name,
              request.ciphertext,
              request.additionalAuthenticatedData,
            ),
          },
        ];
      } catch {
        throw grpcError(3, "INVALID_ARGUMENT: Decryption failed");
      }
    },
    async close() {
      this.closed = true;
    },
  };
}

/** An Azure `RestError` look-alike. */
function restError(statusCode: number): Error {
  return Object.assign(new Error(`Key Vault answered ${statusCode}`), {
    name: "RestError",
    statusCode,
  });
}

/**
 * A `CryptographyClient` look-alike for one key URL. `wrapKey` reports a versioned
 * key id, as Key Vault does. The algorithm is bound into the fake's AAD, so
 * unwrapping with another algorithm fails like it would at Key Vault.
 */
export function fakeAzureSdkClient(kms: FakeKms, keyUrl: string): AzureKeyWrapSdkClient {
  const aad = (algorithm: AzureKeyWrapAlgorithm) => Buffer.from(algorithm, "utf8");
  return {
    async wrapKey(algorithm, key) {
      if (!kms.allow("azure", "encrypt", keyUrl)) throw restError(403);
      return {
        result: kms.seal(keyUrl, key, aad(algorithm)),
        keyID: `${baseKey(keyUrl)}/0123456789abcdef`,
      };
    },
    async unwrapKey(algorithm, encryptedKey) {
      if (!kms.allow("azure", "decrypt", keyUrl)) throw restError(403);
      try {
        return { result: kms.open(keyUrl, encryptedKey, aad(algorithm)) };
      } catch {
        throw restError(400);
      }
    },
  };
}

/**
 * Registers the fake for all three providers, behind the real adapters (so the
 * adapters' request building and error mapping are exercised too). Returns a
 * function that restores the previous factories.
 */
export function installFakeKms(kms: FakeKms): () => void {
  const restorers = [
    setKmsClientFactory("aws", (ref) =>
      createAwsKmsClient(ref.key, { client: fakeAwsSdkClient(kms) }),
    ),
    setKmsClientFactory("gcp", (ref) =>
      createGcpKmsClient(ref.key, { client: fakeGcpSdkClient(kms) }),
    ),
    setKmsClientFactory("azure", (ref) =>
      createAzureKmsClient(ref.key, { client: fakeAzureSdkClient(kms, ref.key) }),
    ),
  ];
  return () => {
    for (const restore of restorers.reverse()) restore();
  };
}

/** A key id that the fake has never seen, of the AWS shape. */
export function otherAwsKey(): string {
  return `arn:aws:kms:eu-west-1:111122223333:key/${randomUUID()}`;
}
