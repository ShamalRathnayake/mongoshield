/**
 * ChaCha20-Poly1305 for runtimes whose node:crypto does not have it.
 *
 * age encrypts everything with ChaCha20-Poly1305 (RFC 8439), and `./primitives.ts`
 * normally gets it from node:crypto (OpenSSL in Node.js, Rust crates in Deno).
 * Bun's node:crypto (checked with 1.3 and 1.4) has no "chacha20-poly1305" cipher,
 * and Web Crypto has none either. There, `./primitives.ts` uses this file, which
 * wraps the audited `@noble/ciphers` implementation.
 *
 * `@noble/ciphers` is loaded lazily, with a dynamic import, the first time a
 * runtime without the native cipher wraps or unwraps a file key
 * (`prepareChaCha20Poly1305()` in `./primitives.ts`). Node.js and Deno never load it.
 * The import is asynchronous while sealing and opening are not, so it happens
 * at the start of the (already asynchronous) key wrapping steps, before any chunk
 * is sealed or opened.
 *
 * Both implementations produce identical bytes: `ciphertext || 16-byte tag`, no
 * additional authenticated data (age never uses AAD).
 */

/** The ChaCha20-Poly1305 factory of `@noble/ciphers`: `chacha20poly1305(key, nonce)`. */
type NobleChaCha20Poly1305 = typeof import("@noble/ciphers/chacha.js")["chacha20poly1305"];

/** The loaded implementation; undefined until `loadPortableAead()` has run. */
let nobleChaCha20Poly1305: NobleChaCha20Poly1305 | undefined;

/** Loads `@noble/ciphers` once. Later calls return immediately. */
export async function loadPortableAead(): Promise<void> {
  if (nobleChaCha20Poly1305 !== undefined) return;
  const module = await import("@noble/ciphers/chacha.js");
  nobleChaCha20Poly1305 = module.chacha20poly1305;
}

/** True once `@noble/ciphers` has been loaded (tests check it stays false on Node.js). */
export function isPortableAeadLoaded(): boolean {
  return nobleChaCha20Poly1305 !== undefined;
}

/** The loaded implementation, or an internal error if nobody loaded it first. */
function loaded(): NobleChaCha20Poly1305 {
  if (nobleChaCha20Poly1305 === undefined) {
    // A programming error: every path that seals or opens starts with a key
    // wrapping step, which awaits `prepareChaCha20Poly1305()` first.
    throw new Error("The portable ChaCha20-Poly1305 was used before it was loaded.");
  }
  return nobleChaCha20Poly1305;
}

/** Encrypts `plaintext`; returns `ciphertext || 16-byte tag`, like node:crypto. */
export function portableSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  return loaded()(key, nonce).encrypt(plaintext);
}

/**
 * Checks the tag of `ciphertext || tag` and decrypts it. Returns `undefined`
 * when the tag does not match (noble throws then, and decrypts nothing).
 * Keys and nonces always have the right size here: `./primitives.ts` callers
 * derive them with fixed lengths.
 */
export function portableOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
): Uint8Array | undefined {
  const cipher = loaded()(key, nonce);
  try {
    return cipher.decrypt(sealed);
  } catch {
    return undefined;
  }
}
