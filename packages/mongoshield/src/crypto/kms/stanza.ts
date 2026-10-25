/**
 * The `mongoshield-kms` age stanza: an age file key wrapped by a cloud KMS.
 *
 *     -> mongoshield-kms <provider> <base64url(key id)> <algorithm>
 *     <base64 of the KMS ciphertext, 64 columns per line>
 *
 * - `provider`   `aws`, `gcp` or `azure`;
 * - key id       the key that wrapped the file key (see `KmsCiphertext.key`), as
 *                unpadded base64url of its UTF-8 bytes, because ARNs and URLs contain
 *                characters (`:`, `/`) that are best kept out of stanza arguments;
 * - `algorithm`  the provider's wrapping algorithm name, e.g. `SYMMETRIC_DEFAULT`;
 * - body         the provider's ciphertext of the 16-byte file key.
 *
 * It is an ordinary custom stanza as the age spec allows: the header MAC covers it
 * like any other, and age implementations that do not know it (including the `age`
 * CLI, which has no plugin for it) ignore it. That is why KMS backups should also
 * have an offline `recipients` key: see docs/specs/ENCRYPTION.md ("KMS backups").
 *
 * MongoShield only writes this stanza into `backup-key.age`, never into data files,
 * so there is exactly one KMS call per key per backup run, restore or verification.
 */

import { MongoShieldError } from "../../errors.ts";
import type { KmsKeyRef } from "../../types.ts";
import { headerError } from "../failures.ts";
import type { FileKeyUnwrapper, FileKeyWrapper, Stanza } from "../header.ts";
import { assertValidKmsKeyRef, isKmsProvider, resolveKmsClient } from "./registry.ts";
import type { KmsCallOptions, KmsClient } from "./types.ts";

/** The stanza type (its first argument). */
export const KMS_STANZA_TYPE = "mongoshield-kms";

/** Algorithm names are provider identifiers like `RSA-OAEP-256`; nothing else. */
const ALGORITHM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** How stanzas get their `KmsClient`; replaceable for tests. */
export type KmsClientResolver = (ref: KmsKeyRef) => Promise<KmsClient>;

/**
 * A key wrapper (for `createEncryptStream`'s `keyWrappers`) that wraps the file key
 * with one KMS key and returns its `mongoshield-kms` stanza. `options.signal`
 * cancels the KMS call (MS_ABORTED).
 */
export function createKmsKeyWrapper(
  ref: KmsKeyRef,
  resolve: KmsClientResolver = resolveKmsClient,
  options: KmsCallOptions = {},
): FileKeyWrapper {
  return async (fileKey) => {
    const wrapped = await withClient(ref, resolve, (client) =>
      client.encryptDataKey(fileKey, callOptions(options)),
    );
    if (!ALGORITHM_PATTERN.test(wrapped.algorithm) || wrapped.ciphertext.length === 0) {
      throw new MongoShieldError(
        "MS_ENCRYPTION_FAILED",
        `The ${ref.provider} KMS client returned an unusable wrapped key.`,
        { hint: "A custom KmsClient must return a non-empty ciphertext and an algorithm name." },
      );
    }
    // The recorded key must pass the same checks the reader applies, or the backup
    // would be written but refused on restore.
    assertValidKmsKeyRef({ provider: ref.provider, key: wrapped.key });
    const stanza: Stanza = {
      args: [KMS_STANZA_TYPE, ref.provider, encodeKeyId(wrapped.key), wrapped.algorithm],
      body: Buffer.from(wrapped.ciphertext),
    };
    return stanza;
  };
}

/**
 * A key unwrapper (for `createDecryptStream`'s `keyUnwrappers`) that opens
 * `mongoshield-kms` stanzas by asking the KMS named in the stanza. Ignores stanzas
 * of other types. `options.signal` cancels the KMS call (MS_ABORTED).
 */
export function createKmsKeyUnwrapper(
  resolve: KmsClientResolver = resolveKmsClient,
  options: KmsCallOptions = {},
): FileKeyUnwrapper {
  return async (stanza) => {
    if (stanza.args[0] !== KMS_STANZA_TYPE) return undefined;
    const { ref, algorithm } = parseKmsStanza(stanza);
    const fileKey = await withClient(ref, resolve, (client) =>
      client.decryptDataKey(
        { key: ref.key, algorithm, ciphertext: stanza.body },
        callOptions(options),
      ),
    );
    return Buffer.from(fileKey);
  };
}

/**
 * The KMS key a `mongoshield-kms` stanza names, or `undefined` for other stanzas.
 * Throws a header error for a malformed KMS stanza.
 */
export function describeKmsStanza(stanza: Stanza): KmsKeyRef | undefined {
  if (stanza.args[0] !== KMS_STANZA_TYPE) return undefined;
  return parseKmsStanza(stanza).ref;
}

/**
 * Validates a stanza strictly before any network call. The key id is re-checked
 * with the provider's rules: the key file is only protected by the manifest's
 * checksum, which someone with write access could also change, so an identifier
 * that MongoShield would never have written is refused rather than contacted.
 */
function parseKmsStanza(stanza: Stanza): { ref: KmsKeyRef; algorithm: string } {
  const [, provider, encodedKey, algorithm, ...extra] = stanza.args;
  const key = encodedKey === undefined ? undefined : decodeKeyId(encodedKey);
  if (
    provider === undefined ||
    !isKmsProvider(provider) ||
    key === undefined ||
    algorithm === undefined ||
    !ALGORITHM_PATTERN.test(algorithm) ||
    extra.length > 0 ||
    stanza.body.length === 0
  ) {
    throw headerError(`malformed ${KMS_STANZA_TYPE} stanza.`);
  }
  const ref: KmsKeyRef = { provider, key };
  try {
    assertValidKmsKeyRef(ref);
  } catch {
    throw headerError(`the ${KMS_STANZA_TYPE} stanza names an invalid ${provider} key identifier.`);
  }
  return { ref, algorithm };
}

/**
 * The options passed on to `KmsClient` calls: only a signal, and none at all
 * without one, so custom clients written before signals existed see the same call.
 */
function callOptions(options: KmsCallOptions): KmsCallOptions {
  return options.signal === undefined ? {} : { signal: options.signal };
}

/** Gets a client, runs `use`, and always releases the client. */
async function withClient<Result>(
  ref: KmsKeyRef,
  resolve: KmsClientResolver,
  use: (client: KmsClient) => Promise<Result>,
): Promise<Result> {
  const client = await resolve(ref);
  try {
    return await use(client);
  } finally {
    await client.close?.();
  }
}

/** Unpadded base64url of the UTF-8 key id. */
export function encodeKeyId(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

/**
 * Decodes a key id, accepting only canonical unpadded base64url (Node's decoder is
 * lenient, so the result is re-encoded and compared) that is valid, non-empty UTF-8.
 */
export function decodeKeyId(encoded: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== encoded) return undefined;
  const key = bytes.toString("utf8");
  if (!Buffer.from(key, "utf8").equals(bytes)) return undefined;
  return key;
}
