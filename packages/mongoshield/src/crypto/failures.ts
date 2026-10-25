/**
 * Error constructors for the crypto module.
 *
 * Decryption errors carry a `details.stage` so callers (and the CCTV test
 * vectors) can tell *where* a file was rejected without parsing messages:
 *
 * - `header`  the header is malformed, truncated or uses an unsupported feature
 * - `unwrap`  the header parsed but no stanza could be opened with the given keys
 * - `mac`     a file key was found but the header MAC does not match
 * - `payload` the encrypted payload failed authentication, is truncated or has trailing data
 *
 * Messages never contain key material, identities or passphrases.
 */

import { MongoShieldError } from "../errors.ts";

/** Where in the age file a decryption failure was detected. */
export type DecryptionStage = "header" | "unwrap" | "mac" | "payload";

const TAMPER_HINT =
  "The file is corrupted, truncated or was modified after encryption. Restore it from another copy.";

/** A configuration problem: bad key strings or incompatible options. */
export function configError(message: string, hint: string): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", message, { hint });
}

/** The header could not be parsed, or a stanza addressed to us is malformed. */
export function headerError(message: string, hint: string = TAMPER_HINT): MongoShieldError {
  return new MongoShieldError("MS_DECRYPTION_FAILED", `Invalid age header: ${message}`, {
    hint,
    details: { stage: "header" satisfies DecryptionStage },
  });
}

/** None of the given identities (or the passphrase) matches any stanza. */
export function noIdentityError(message: string, hint: string): MongoShieldError {
  return new MongoShieldError("MS_NO_IDENTITY", message, {
    hint,
    details: { stage: "unwrap" satisfies DecryptionStage },
  });
}

/** The passphrase did not open the scrypt stanza. */
export function wrongPassphraseError(): MongoShieldError {
  return new MongoShieldError(
    "MS_DECRYPTION_FAILED",
    "The passphrase is incorrect (or the file's passphrase stanza was modified).",
    {
      hint: "Check the passphrase used when the backup was created.",
      details: { stage: "unwrap" satisfies DecryptionStage },
    },
  );
}

/** The header MAC did not verify: the header was modified. */
export function headerMacError(): MongoShieldError {
  return new MongoShieldError(
    "MS_DECRYPTION_FAILED",
    "The age header failed authentication (header MAC mismatch).",
    { hint: TAMPER_HINT, details: { stage: "mac" satisfies DecryptionStage } },
  );
}

/** The payload failed authentication or is structurally invalid. */
export function payloadError(message: string): MongoShieldError {
  return new MongoShieldError("MS_DECRYPTION_FAILED", `Encrypted payload rejected: ${message}`, {
    hint: TAMPER_HINT,
    details: { stage: "payload" satisfies DecryptionStage },
  });
}

/** Wraps an unexpected failure during encryption. */
export function encryptionError(cause: unknown): MongoShieldError {
  if (cause instanceof MongoShieldError) return cause;
  return new MongoShieldError("MS_ENCRYPTION_FAILED", "Encrypting data with age failed.", {
    cause,
  });
}

/** Wraps an unexpected (non-MongoShield) failure during decryption. */
export function unexpectedDecryptionError(cause: unknown): MongoShieldError {
  if (cause instanceof MongoShieldError) return cause;
  return new MongoShieldError("MS_DECRYPTION_FAILED", "Decrypting age data failed.", { cause });
}
