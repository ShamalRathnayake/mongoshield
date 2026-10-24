/**
 * Which `KmsClient` handles a key: a factory registered for its provider, or the
 * built-in SDK adapter.
 *
 * The engines (backup, restore, verify) only see `KmsKeyRef`s (provider + key id,
 * from the config or from a backup's key file), so this registry is where callers
 * plug in clients built their own way:
 *
 *   setKmsClientFactory("aws", (ref) => createAwsKmsClient(ref.key, { client: myKmsClient }));
 *
 * Tests register fake clients here, so no test ever needs the network. Also
 * validates key identifiers, before backups (fail fast on typos) and when reading a
 * key file (never call out with an identifier the backup could not have written).
 */

import { MongoShieldError } from "../../errors.ts";
import type { KmsKeyRef } from "../../types.ts";
import { assertValidAwsKmsKey, createAwsKmsClient } from "./aws.ts";
import { assertValidAzureKmsKey, createAzureKmsClient } from "./azure.ts";
import { assertValidGcpKmsKey, createGcpKmsClient } from "./gcp.ts";
import type { KmsClient, KmsClientFactory, KmsProvider } from "./types.ts";

/** Every supported provider, in documentation order. */
export const KMS_PROVIDERS: readonly KmsProvider[] = ["aws", "gcp", "azure"];

/** Factories set with `setKmsClientFactory`; absent providers use the built-in adapters. */
const factories = new Map<KmsProvider, KmsClientFactory>();

/** The built-in adapter for each provider, with SDK defaults for credentials. */
const DEFAULT_FACTORIES: Record<KmsProvider, KmsClientFactory> = {
  aws: (ref) => createAwsKmsClient(ref.key),
  gcp: (ref) => createGcpKmsClient(ref.key),
  azure: (ref) => createAzureKmsClient(ref.key),
};

/**
 * Sets how clients for one provider are created, process-wide. Pass `undefined` to
 * go back to the built-in adapter. Returns a function that restores the previous
 * factory (handy in tests).
 */
export function setKmsClientFactory(
  provider: KmsProvider,
  factory: KmsClientFactory | undefined,
): () => void {
  assertKnownProvider(provider);
  const previous = factories.get(provider);
  if (factory === undefined) factories.delete(provider);
  else factories.set(provider, factory);
  return () => {
    if (previous === undefined) factories.delete(provider);
    else factories.set(provider, previous);
  };
}

/** Creates the client for a key with the registered (or built-in) factory. */
export async function resolveKmsClient(ref: KmsKeyRef): Promise<KmsClient> {
  assertValidKmsKeyRef(ref);
  const factory = factories.get(ref.provider) ?? DEFAULT_FACTORIES[ref.provider];
  const client = await factory(ref);
  if (client.provider !== ref.provider) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The KMS client factory for "${ref.provider}" returned a client for "${client.provider}".`,
      { hint: "Register each factory under the provider its clients belong to." },
    );
  }
  return client;
}

/**
 * Throws MS_CONFIG_INVALID unless the provider is supported and the key identifier
 * has that provider's shape.
 */
export function assertValidKmsKeyRef(ref: KmsKeyRef): void {
  assertKnownProvider(ref.provider);
  switch (ref.provider) {
    case "aws":
      assertValidAwsKmsKey(ref.key);
      return;
    case "gcp":
      assertValidGcpKmsKey(ref.key);
      return;
    case "azure":
      assertValidAzureKmsKey(ref.key);
      return;
  }
}

/** True for the provider names MongoShield supports. */
export function isKmsProvider(value: string): value is KmsProvider {
  return KMS_PROVIDERS.some((provider) => provider === value);
}

function assertKnownProvider(provider: string): void {
  if (isKmsProvider(provider)) return;
  throw new MongoShieldError("MS_CONFIG_INVALID", `Unknown KMS provider "${provider}".`, {
    hint: `Use one of: ${KMS_PROVIDERS.join(", ")}.`,
  });
}

/** Prefix of KMS entries in a manifest's `encryption.recipients`. */
export const KMS_RECIPIENT_PREFIX = "kms:";

/**
 * The manifest label for a KMS key, `kms:<provider>:<key>` (e.g.
 * `kms:aws:arn:aws:kms:eu-west-1:111122223333:key/…`). Key ids are not secret.
 */
export function kmsRecipientLabel(ref: KmsKeyRef): string {
  return `${KMS_RECIPIENT_PREFIX}${ref.provider}:${ref.key}`;
}

/** True for manifest recipient labels written by `kmsRecipientLabel`. */
export function isKmsRecipientLabel(label: string): boolean {
  return label.startsWith(KMS_RECIPIENT_PREFIX);
}
