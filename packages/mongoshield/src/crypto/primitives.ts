/**
 * Thin wrappers over node:crypto for the three primitives age builds on:
 * HKDF-SHA-256, HMAC-SHA-256 and ChaCha20-Poly1305 (RFC 7539).
 *
 * Keeping them here means the protocol modules read like the spec
 * (`hkdf(ikm, salt, info)`, `seal(key, nonce, plaintext)`) instead of being
 * cluttered with cipher-object plumbing.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import { AEAD_NONCE_SIZE, DERIVED_KEY_SIZE, TAG_SIZE } from "./constants.ts";

/**
 * The fixed all-zero nonce used to wrap file keys in stanza bodies. Safe
 * because every wrap key is used exactly once (fresh ephemeral share or salt
 * per stanza), as required by the "X25519/scrypt recipient stanza" sections.
 */
export const ZERO_NONCE: Buffer = Buffer.alloc(AEAD_NONCE_SIZE);

/**
 * HKDF-SHA-256 (RFC 5869): Extract with `salt`, then Expand with `info`, to
 * the 32-byte output length age always uses ("Conventions").
 */
export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, DERIVED_KEY_SIZE));
}

/** HMAC-SHA-256 (RFC 2104). */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Buffer {
  return createHmac("sha256", key).update(message).digest();
}

/** Constant-time equality for MACs; different lengths are simply unequal. */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** ChaCha20-Poly1305 encryption. Returns `ciphertext || 16-byte tag`. */
export function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_SIZE });
  const ciphertext = cipher.update(plaintext);
  cipher.final();
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

/**
 * ChaCha20-Poly1305 decryption of `ciphertext || tag`. Returns `undefined` if
 * authentication fails, so callers decide which error that represents.
 *
 * Node only checks the tag in `final()`; the bytes returned by `update()` are
 * unauthenticated, so they are discarded unless `final()` succeeds.
 */
export function open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Buffer | undefined {
  if (sealed.length < TAG_SIZE) return undefined;
  const ciphertextLength = sealed.length - TAG_SIZE;
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_SIZE });
  decipher.setAuthTag(sealed.subarray(ciphertextLength));
  const plaintext = decipher.update(sealed.subarray(0, ciphertextLength));
  try {
    decipher.final();
  } catch {
    return undefined;
  }
  return plaintext;
}
