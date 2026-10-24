/**
 * Thin wrappers over node:crypto for the three primitives age builds on:
 * HKDF-SHA-256, HMAC-SHA-256 and ChaCha20-Poly1305 (RFC 7539).
 *
 * Keeping them here means the protocol modules read like the spec
 * (`hkdf(ikm, salt, info)`, `seal(key, nonce, plaintext)`) instead of being
 * cluttered with cipher-object plumbing.
 *
 * ChaCha20-Poly1305 comes from node:crypto wherever it exists (Node.js, Deno).
 * Runtimes whose node:crypto lacks the cipher (Bun) use the audited
 * `@noble/ciphers` instead (see `./portable-aead.ts`), loaded by
 * `prepareChaCha20Poly1305()`. The choice is made once, by trying to create the
 * cipher, not by asking which runtime this is. Both produce identical bytes, so
 * backups are the same whichever one wrote them.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import { AEAD_NONCE_SIZE, DERIVED_KEY_SIZE, TAG_SIZE } from "./constants.ts";
import { loadPortableAead, portableOpen, portableSeal } from "./portable-aead.ts";

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

/** The node:crypto name of the AEAD cipher age uses. */
const CHACHA20_POLY1305 = "chacha20-poly1305";

/** Cached answer of `hasNativeChaCha20Poly1305()`; undefined until first asked. */
let nativeChaCha20Poly1305: boolean | undefined;

/**
 * True when node:crypto can create a ChaCha20-Poly1305 cipher. Bun 1.x throws
 * "Unknown cipher" here. Checked once, on first use, with a throwaway key.
 */
export function hasNativeChaCha20Poly1305(): boolean {
  if (nativeChaCha20Poly1305 === undefined) {
    try {
      createCipheriv(CHACHA20_POLY1305, Buffer.alloc(DERIVED_KEY_SIZE), ZERO_NONCE, {
        authTagLength: TAG_SIZE,
      });
      nativeChaCha20Poly1305 = true;
    } catch {
      nativeChaCha20Poly1305 = false;
    }
  }
  return nativeChaCha20Poly1305;
}

/**
 * Makes `seal` and `open` usable: loads `@noble/ciphers` if node:crypto lacks
 * ChaCha20-Poly1305, and does nothing (loads nothing) where it has it.
 * Awaited at the start of file key wrapping and unwrapping, which every
 * encryption and decryption goes through before its first chunk.
 */
export async function prepareChaCha20Poly1305(): Promise<void> {
  if (!hasNativeChaCha20Poly1305()) await loadPortableAead();
}

/**
 * ChaCha20-Poly1305 encryption. Returns `ciphertext || 16-byte tag`.
 * Without the native cipher, `prepareChaCha20Poly1305()` must have been awaited.
 */
export function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Buffer {
  if (!hasNativeChaCha20Poly1305()) {
    const sealed = portableSeal(key, nonce, plaintext);
    return Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  }
  const cipher = createCipheriv(CHACHA20_POLY1305, key, nonce, { authTagLength: TAG_SIZE });
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
  if (!hasNativeChaCha20Poly1305()) {
    const plaintext = portableOpen(key, nonce, sealed);
    return plaintext && Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  }
  const ciphertextLength = sealed.length - TAG_SIZE;
  const decipher = createDecipheriv(CHACHA20_POLY1305, key, nonce, { authTagLength: TAG_SIZE });
  decipher.setAuthTag(sealed.subarray(ciphertextLength));
  const plaintext = decipher.update(sealed.subarray(0, ciphertextLength));
  try {
    decipher.final();
  } catch {
    return undefined;
  }
  return plaintext;
}
