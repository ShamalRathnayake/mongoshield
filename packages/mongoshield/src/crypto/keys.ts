/**
 * age key strings: generating, validating and converting X25519 identities
 * (`AGE-SECRET-KEY-1…`) and recipients (`age1…`).
 *
 * Both are Bech32 (not Bech32m) encodings of 32 bytes (spec: "The X25519
 * recipient type"). Identities are secrets: error messages here describe what
 * is wrong with a value but never repeat it.
 */

import { decodeBech32, encodeBech32 } from "./bech32.ts";
import { configError } from "./failures.ts";
import {
  generateX25519KeyPair,
  X25519_KEY_SIZE,
  type X25519KeyPair,
  x25519PublicKey,
} from "./x25519.ts";

/** Bech32 human-readable part of X25519 recipients. */
const RECIPIENT_HRP = "age";

/** Bech32 human-readable part of X25519 identities (uppercase, as age writes them). */
const IDENTITY_HRP = "AGE-SECRET-KEY-";

/**
 * The label `describeRecipient` returns for passphrase encryption, and the
 * value it accepts to describe it. Matches the age stanza type name.
 */
export const PASSPHRASE_RECIPIENT_LABEL = "scrypt";

/** A freshly generated identity and its public recipient. */
export interface GeneratedIdentity {
  /** The secret key, `AGE-SECRET-KEY-1…`. Store it like a password. */
  readonly identity: string;
  /** The public key, `age1…`. Safe to put in config files and on backup servers. */
  readonly recipient: string;
}

const RECIPIENT_HINT =
  "Use an X25519 age recipient such as the output of `age-keygen -y key.txt` (age1…).";
const IDENTITY_HINT =
  "Use an X25519 age identity (AGE-SECRET-KEY-1…), for example a line from an `age-keygen` key file.";

/** Generates a new X25519 identity/recipient pair from the CSPRNG. */
export function generateIdentity(): GeneratedIdentity {
  const keyPair = generateX25519KeyPair();
  return {
    identity: encodeBech32(IDENTITY_HRP, keyPair.secretKey),
    recipient: encodeBech32(RECIPIENT_HRP, keyPair.publicKey),
  };
}

/**
 * Decodes an `age1…` recipient into its raw 32-byte X25519 public key.
 * Throws MS_CONFIG_INVALID with a hint describing the problem.
 */
export function parseRecipient(value: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.toUpperCase().startsWith("AGE-SECRET-KEY-")) {
    throw configError(
      "A secret age identity was given where a public recipient was expected.",
      "Never configure the secret key on the machine that encrypts. Derive its recipient with `age-keygen -y key.txt` and use that (age1…).",
    );
  }
  if (trimmed.startsWith("ssh-")) {
    throw configError("SSH public keys are not supported as age recipients.", RECIPIENT_HINT);
  }
  const decoded = decodeBech32(trimmed);
  if (decoded === undefined) {
    throw configError(
      "The age recipient is not valid Bech32 (typo or truncated?).",
      RECIPIENT_HINT,
    );
  }
  if (decoded.hrp !== RECIPIENT_HRP) {
    throw configError(
      `Unsupported age recipient type "${decoded.hrp}" (only native X25519 "age1…" recipients are supported).`,
      RECIPIENT_HINT,
    );
  }
  if (decoded.data.length !== X25519_KEY_SIZE) {
    throw configError("The age recipient does not encode a 32-byte X25519 key.", RECIPIENT_HINT);
  }
  return decoded.data;
}

/**
 * Decodes an `AGE-SECRET-KEY-1…` identity into an X25519 key pair.
 * Throws MS_CONFIG_INVALID without ever including the identity in the message.
 */
export function parseIdentity(value: string): X25519KeyPair {
  const trimmed = value.trim();
  if (trimmed.startsWith("age1")) {
    throw configError(
      "A public age recipient was given where a secret identity was expected.",
      "Decryption needs the secret key file (AGE-SECRET-KEY-1…) that matches the recipient.",
    );
  }
  const decoded = decodeBech32(trimmed);
  if (decoded === undefined) {
    throw configError("The age identity is not valid Bech32 (typo or truncated?).", IDENTITY_HINT);
  }
  if (decoded.hrp !== IDENTITY_HRP.toLowerCase()) {
    throw configError(
      "Unsupported age identity type (only native X25519 AGE-SECRET-KEY-1… identities are supported).",
      IDENTITY_HINT,
    );
  }
  if (decoded.data.length !== X25519_KEY_SIZE) {
    throw configError("The age identity does not encode a 32-byte X25519 key.", IDENTITY_HINT);
  }
  return { secretKey: decoded.data, publicKey: x25519PublicKey(decoded.data) };
}

/** Throws MS_CONFIG_INVALID unless `value` is a valid X25519 age recipient (`age1…`). */
export function assertValidRecipient(value: string): void {
  parseRecipient(value);
}

/** Throws MS_CONFIG_INVALID unless `value` is a valid X25519 age identity. Never echoes it. */
export function assertValidIdentity(value: string): void {
  parseIdentity(value);
}

/** Returns the `age1…` recipient (public key) for an `AGE-SECRET-KEY-1…` identity. */
export function identityToRecipient(identity: string): string {
  return encodeBech32(RECIPIENT_HRP, parseIdentity(identity).publicKey);
}

/**
 * A short, non-secret label for a recipient, suitable for backup manifests:
 * the normalized `age1…` string itself, or `"scrypt"` for passphrase
 * encryption (pass `PASSPHRASE_RECIPIENT_LABEL`). Throws MS_CONFIG_INVALID for
 * anything else, so a secret mistakenly passed here is never written out.
 */
export function describeRecipient(recipient: string): string {
  if (recipient === PASSPHRASE_RECIPIENT_LABEL) return PASSPHRASE_RECIPIENT_LABEL;
  return encodeBech32(RECIPIENT_HRP, parseRecipient(recipient));
}

/**
 * Extracts identities from the text of an age key file (as written by
 * `age-keygen`): one identity per line, blank lines and `#` comments ignored.
 * Each identity is validated; errors name the line number, never the content.
 */
export function parseIdentityFile(text: string): string[] {
  const identities: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    try {
      parseIdentity(line);
    } catch {
      throw configError(
        `Line ${index + 1} of the identity file is not a valid age identity.`,
        IDENTITY_HINT,
      );
    }
    identities.push(line);
  }
  if (identities.length === 0) {
    throw configError("The identity file contains no age identities.", IDENTITY_HINT);
  }
  return identities;
}
