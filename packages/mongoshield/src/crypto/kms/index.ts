/**
 * Cloud KMS protection for backups: the `KmsClient` interface, the AWS / GCP / Azure
 * adapters, the client registry, and the `mongoshield-kms` age stanza that stores a
 * KMS-wrapped file key. See docs/specs/ENCRYPTION.md ("KMS backups").
 */

export {
  type AwsKmsAlgorithm,
  type AwsKmsClientOptions,
  createAwsKmsClient,
} from "./aws.ts";
export {
  type AzureKeyReaderSdkClient,
  type AzureKeyWrapAlgorithm,
  type AzureKeyWrapSdkClient,
  type AzureKmsClientOptions,
  type AzureOperationOptions,
  type AzureTokenCredential,
  createAzureKmsClient,
} from "./azure.ts";
export type { KmsFailureKind, KmsOperation } from "./errors.ts";
export {
  createGcpKmsClient,
  GCP_KMS_ALGORITHM,
  type GcpKmsClientOptions,
  type GcpKmsSdkClient,
} from "./gcp.ts";
export {
  assertValidKmsKeyRef,
  isKmsRecipientLabel,
  KMS_PROVIDERS,
  kmsRecipientLabel,
  resolveKmsClient,
  setKmsClientFactory,
} from "./registry.ts";
export {
  createKmsKeyUnwrapper,
  createKmsKeyWrapper,
  describeKmsStanza,
  KMS_STANZA_TYPE,
  type KmsClientResolver,
} from "./stanza.ts";
export {
  KMS_DATA_KEY_CONTEXT,
  type KmsCallOptions,
  type KmsCiphertext,
  type KmsClient,
  type KmsClientFactory,
  type KmsProvider,
} from "./types.ts";
