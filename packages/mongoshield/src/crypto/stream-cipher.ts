/**
 * The age payload: a STREAM construction over ChaCha20-Poly1305
 * (spec: "Payload").
 *
 *     payload     = nonce (16 random bytes) || chunk 0 || chunk 1 || ... || final chunk
 *     payload key = HKDF-SHA-256(ikm = file key, salt = nonce, info = "payload")
 *     chunk i     = ChaCha20-Poly1305(payload key, chunk nonce i, 64 KiB of plaintext)
 *
 * Chunk nonce (12 bytes):
 *
 *     +-------------------------------------------+------------+
 *     | chunk counter, 11 bytes, big endian, from 0 | last flag  |
 *     +-------------------------------------------+------------+
 *                                                   0x01 on the final chunk, else 0x00
 *
 * The last-chunk flag is what makes truncation detectable: a file cut at a
 * chunk boundary ends with a chunk sealed as "not last", which fails to open as
 * the final chunk. Every chunk except the last holds exactly 64 KiB; the last
 * holds 1..64 KiB, or 0 bytes only when the whole plaintext is empty.
 */

import { AEAD_NONCE_SIZE, PAYLOAD_KEY_INFO } from "./constants.ts";
import { hkdf, open, seal } from "./primitives.ts";

/** Index of the last-chunk flag byte inside the 12-byte chunk nonce. */
const LAST_FLAG_INDEX = AEAD_NONCE_SIZE - 1;

/** Derives the payload key from the file key and the payload's 16-byte nonce. */
export function derivePayloadKey(fileKey: Uint8Array, payloadNonce: Uint8Array): Buffer {
  return hkdf(fileKey, payloadNonce, PAYLOAD_KEY_INFO);
}

/**
 * Seals or opens the chunks of one payload in order, tracking the chunk
 * counter. One instance per file; never reuse it across files.
 */
export class ChunkCipher {
  readonly #key: Buffer;
  /** The 12-byte chunk nonce: counter in bytes 0..10, last flag in byte 11. */
  readonly #nonce = Buffer.alloc(AEAD_NONCE_SIZE);
  #chunkIndex = 0;
  #finished = false;

  /** @param payloadKey the key from `derivePayloadKey`. */
  constructor(payloadKey: Buffer) {
    this.#key = payloadKey;
  }

  /** Number of chunks processed so far (the counter of the next chunk). */
  get chunkIndex(): number {
    return this.#chunkIndex;
  }

  /** Encrypts the next chunk. `last` must be true exactly once, for the final chunk. */
  seal(plaintext: Uint8Array, last: boolean): Buffer {
    const sealed = seal(this.#key, this.#nextNonce(last), plaintext);
    this.#advance(last);
    return sealed;
  }

  /**
   * Decrypts and authenticates the next chunk. Returns `undefined` (without
   * advancing) if authentication fails, so the caller can report the error.
   */
  open(sealed: Uint8Array, last: boolean): Buffer | undefined {
    const plaintext = open(this.#key, this.#nextNonce(last), sealed);
    if (plaintext !== undefined) this.#advance(last);
    return plaintext;
  }

  /** Builds the nonce for the current counter with the given last-chunk flag. */
  #nextNonce(last: boolean): Buffer {
    if (this.#finished) throw new Error("STREAM already finished with a final chunk");
    this.#nonce[LAST_FLAG_INDEX] = last ? 0x01 : 0x00;
    return this.#nonce;
  }

  /** Increments the 11-byte big-endian counter after a chunk is processed. */
  #advance(last: boolean): void {
    this.#chunkIndex++;
    if (last) {
      this.#finished = true;
      return;
    }
    for (let index = LAST_FLAG_INDEX - 1; index >= 0; index--) {
      const next = ((this.#nonce[index] ?? 0) + 1) & 0xff;
      this.#nonce[index] = next;
      if (next !== 0) return;
    }
    // 2^88 chunks (2^104 bytes) is unreachable in practice, but wrapping the
    // counter would reuse nonces, so fail loudly rather than silently.
    throw new Error("STREAM chunk counter overflow");
  }
}
