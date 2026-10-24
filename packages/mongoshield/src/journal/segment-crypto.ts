/**
 * How journal segments are encrypted and decrypted (docs/specs/JOURNAL.md,
 * "Encryption and compression").
 *
 * Segments use the same settings as backups, but each segment is its own age file
 * encrypted DIRECTLY to the configured recipients and/or KMS keys: there is no
 * per-journal key file, so a later segment never depends on an earlier one, and any
 * single segment can be opened on its own.
 *
 * Passphrases are refused: age runs scrypt (about a second, 256 MiB) for every file,
 * and a journal writes a segment every few minutes, forever. Restoring a day would
 * mean hundreds of scrypt runs. Use recipients (an `age1…` public key) or KMS.
 */

import type { Transform } from "node:stream";
import { createDecryptStream, createEncryptStream } from "../crypto/index.ts";
import { createKmsKeyUnwrapper, createKmsKeyWrapper } from "../crypto/kms/index.ts";
import { planEncryption } from "../engine/backup-options.ts";
import { MongoShieldError } from "../errors.ts";
import type { DecryptionOptions, EncryptionOptions } from "../types.ts";

/** A validated way to encrypt segments: call it once per segment. */
export type SegmentEncryptor = () => Transform;

/**
 * Validates the encryption settings and returns a factory for per-segment encrypt
 * streams, or `undefined` for an unencrypted journal.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for invalid settings or a passphrase.
 */
export function planSegmentEncryption(
  encryption: EncryptionOptions | undefined,
): SegmentEncryptor | undefined {
  const plan = planEncryption(encryption);
  if (plan === undefined) return undefined;
  if (plan.kind === "passphrase") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "The journal cannot be encrypted with a passphrase.",
      {
        hint: "Every segment is its own age file, and a passphrase costs one scrypt run per file. Use recipients (age1…) or KMS keys for the journal.",
      },
    );
  }
  if (plan.kind === "recipients") {
    const { recipients } = plan;
    return () => createEncryptStream({ recipients });
  }
  const { recipients, kms } = plan;
  // One KMS call per segment (every few minutes): cheap, and it keeps each segment
  // independent of every other.
  return () =>
    createEncryptStream({ recipients, keyWrappers: kms.map((ref) => createKmsKeyWrapper(ref)) });
}

/**
 * The decrypt stream for one encrypted segment. Identities open segments encrypted to
 * their recipient; segments encrypted to KMS keys are opened through the KMS named in
 * them (with the credentials of the environment) when no identity matches.
 *
 * @throws MongoShieldError `MS_NO_IDENTITY` when only a passphrase is given (segments
 *   are never passphrase-encrypted).
 */
export function createSegmentDecryptor(decryption: DecryptionOptions | undefined): Transform {
  const identities = decryption?.identities ?? [];
  if (identities.length === 0 && decryption?.passphrase !== undefined) {
    throw new MongoShieldError(
      "MS_NO_IDENTITY",
      "Journal segments are encrypted to recipients or KMS keys, so a passphrase cannot open them.",
      {
        hint: "Pass the age identity (AGE-SECRET-KEY-1…) whose recipient the journal writer used.",
      },
    );
  }
  return createDecryptStream({ identities, keyUnwrappers: [createKmsKeyUnwrapper()] });
}
