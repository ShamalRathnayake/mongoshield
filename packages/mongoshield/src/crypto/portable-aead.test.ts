/**
 * Tests for the portable ChaCha20-Poly1305 (`@noble/ciphers`, wrapped by
 * ./portable-aead.ts) that runtimes without the native cipher (Bun) use.
 *
 * Pinned three ways: the RFC 8439 test vectors, byte-for-byte agreement with
 * node:crypto (OpenSSL) on random inputs, and tamper detection. Also checks that
 * Node.js never loads it. `./without-native-chacha.test.ts` then runs the age
 * test vectors with the native cipher mocked away, so this path does the work.
 */

import { createCipheriv, createDecipheriv } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { createDecryptStream } from "./decrypt.ts";
import { createEncryptStream } from "./encrypt.ts";
import { generateIdentity } from "./keys.ts";
import {
  isPortableAeadLoaded,
  loadPortableAead,
  portableOpen,
  portableSeal,
} from "./portable-aead.ts";

/** node:crypto's ChaCha20-Poly1305, as the reference: returns ciphertext || tag. */
function referenceSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** node:crypto's decryption of ciphertext || tag, or undefined if the tag is wrong. */
function referenceOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Buffer | undefined {
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plaintext = decipher.update(sealed.subarray(0, sealed.length - 16));
  try {
    decipher.final();
    return plaintext;
  } catch {
    return undefined;
  }
}

const hex = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "hex");

/** The plaintext of the RFC 8439 examples in sections 2.4.2 and 2.8.2. */
const SUNSCREEN = Buffer.from(
  "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
);

// This block runs first, before the block below loads the library.
describe("on Node.js, which has the native cipher", () => {
  it("encrypts and decrypts without ever loading @noble/ciphers", async () => {
    const identity = generateIdentity();
    const encrypted = await buffer(
      Readable.from([SUNSCREEN]).pipe(createEncryptStream({ recipients: [identity.recipient] })),
    );
    const decrypted = await buffer(
      Readable.from([encrypted]).pipe(createDecryptStream({ identities: [identity.identity] })),
    );
    expect(decrypted.equals(SUNSCREEN)).toBe(true);
    expect(isPortableAeadLoaded()).toBe(false);
  });
});

describe("the portable cipher", () => {
  beforeAll(async () => {
    await loadPortableAead();
  });

  describe("the RFC 8439 test vectors", () => {
    it("encrypts the section 2.4.2 example (ChaCha20 from block counter 1, as the AEAD does)", () => {
      const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
      const nonce = hex("000000000000004a00000000");
      const expectedCiphertext = hex(`
        6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b
        f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8
        07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736
        5af90bbf74a35be6b40b8eedf2785e42874d`);
      const sealed = portableSeal(key, nonce, SUNSCREEN);
      expect(Buffer.from(sealed.subarray(0, SUNSCREEN.length))).toEqual(expectedCiphertext);
    });

    it("the loaded library reproduces the section 2.8.2 AEAD example (with its AAD)", async () => {
      // age never uses AAD, so portableSeal has no AAD parameter; this checks the
      // library itself against the RFC's full AEAD example.
      const { chacha20poly1305 } = await import("@noble/ciphers/chacha.js");
      const key = Buffer.from(Array.from({ length: 32 }, (_, index) => 0x80 + index));
      const nonce = hex("070000004041424344454647");
      const aad = hex("50515253c0c1c2c3c4c5c6c7");
      const sealed = Buffer.from(chacha20poly1305(key, nonce, aad).encrypt(SUNSCREEN));
      expect(sealed.subarray(0, 16)).toEqual(hex("d31a8d34648e60db7b86afbc53ef7ec2"));
      expect(sealed.subarray(SUNSCREEN.length)).toEqual(hex("1ae10b594f09e26a7e902ecbd0600691"));
    });
  });

  describe("agreement with node:crypto", () => {
    // Lengths around the 16-byte Poly1305 block and the 64-byte ChaCha20 block,
    // plus age's 64 KiB chunk, where carry and padding bugs would show.
    const interestingLength = fc.oneof(
      fc.integer({ min: 0, max: 300 }),
      fc.constantFrom(15, 16, 17, 63, 64, 65, 65_535, 65_536),
    );
    const key = fc.uint8Array({ minLength: 32, maxLength: 32 });
    const nonce = fc.uint8Array({ minLength: 12, maxLength: 12 });

    it("seals to the same bytes as node:crypto", () => {
      fc.assert(
        fc.property(
          key,
          nonce,
          interestingLength,
          fc.integer(),
          (keyBytes, nonceBytes, length, seed) => {
            const plaintext = Buffer.alloc(length, seed & 0xff).map(
              (byte, index) => (byte + index * 31) & 0xff,
            );
            const expected = referenceSeal(keyBytes, nonceBytes, plaintext);
            expect(Buffer.from(portableSeal(keyBytes, nonceBytes, plaintext))).toEqual(expected);
          },
        ),
        { numRuns: 200 },
      );
      // 200 pure-JavaScript seals take a few hundred ms locally, but can pass the
      // 5 s default on a loaded CI runner with coverage instrumentation.
    }, 30_000);

    it("opens what node:crypto sealed, and node:crypto opens what it sealed", () => {
      fc.assert(
        fc.property(
          key,
          nonce,
          fc.uint8Array({ maxLength: 1000 }),
          (keyBytes, nonceBytes, plaintext) => {
            const sealedByNode = referenceSeal(keyBytes, nonceBytes, plaintext);
            expect(Buffer.from(portableOpen(keyBytes, nonceBytes, sealedByNode) ?? [])).toEqual(
              Buffer.from(plaintext),
            );
            const sealedHere = portableSeal(keyBytes, nonceBytes, plaintext);
            expect(referenceOpen(keyBytes, nonceBytes, sealedHere)).toEqual(Buffer.from(plaintext));
          },
        ),
        { numRuns: 200 },
      );
    }, 30_000);

    it("agrees on the edge case of an all-ones key, where Poly1305's final reduction matters", () => {
      const allOnes = new Uint8Array(32).fill(0xff);
      const nonce = new Uint8Array(12).fill(0xff);
      for (const length of [0, 16, 160, 1600]) {
        const plaintext = new Uint8Array(length).fill(0xff);
        expect(Buffer.from(portableSeal(allOnes, nonce, plaintext))).toEqual(
          referenceSeal(allOnes, nonce, plaintext),
        );
      }
    });
  });

  describe("authentication", () => {
    const key = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(12).fill(9);

    it("rejects a flipped bit anywhere in the ciphertext or tag", () => {
      const sealed = portableSeal(key, nonce, Buffer.from("attack at dawn"));
      for (let index = 0; index < sealed.length; index++) {
        const tampered = Uint8Array.from(sealed);
        tampered[index] = (tampered[index] ?? 0) ^ 0x01;
        expect(portableOpen(key, nonce, tampered)).toBeUndefined();
      }
    });

    it("rejects the wrong key, the wrong nonce and input shorter than a tag", () => {
      const sealed = portableSeal(key, nonce, Buffer.from("attack at dawn"));
      expect(portableOpen(new Uint8Array(32).fill(8), nonce, sealed)).toBeUndefined();
      expect(portableOpen(key, new Uint8Array(12), sealed)).toBeUndefined();
      expect(portableOpen(key, nonce, sealed.subarray(0, 15))).toBeUndefined();
    });
  });
});
