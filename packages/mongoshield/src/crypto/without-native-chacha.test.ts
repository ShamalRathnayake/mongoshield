/**
 * Simulates a runtime whose node:crypto has no "chacha20-poly1305" cipher (Bun)
 * by mocking `node:crypto` so creating that cipher throws, exactly as Bun does.
 * Kept in its own file because the mock applies to the whole module graph.
 *
 * Under that mock, `./primitives.ts` must load `@noble/ciphers` (./portable-aead.ts)
 * on the first key wrap, and all of age must keep working: the official CCTV
 * vectors and the stream tests are imported below, so they run a second time
 * against the portable cipher.
 *
 * Order matters: the imported suites seal with `wrapX25519` and `ChunkCipher`
 * directly in places, without a key wrap step, and some encrypt fixtures while
 * they are imported. So whether the library was loaded is recorded before they
 * are imported, and the first test below (which Vitest runs before theirs)
 * loads it through a real key wrap.
 */

import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  /** Bun's error for ciphers it does not implement. */
  const unknownCipher = (algorithm: string) => {
    if (algorithm.toLowerCase() === "chacha20-poly1305") throw new Error("Unknown cipher");
  };
  return {
    ...original,
    createCipheriv: (algorithm: string, ...rest: unknown[]) => {
      unknownCipher(algorithm);
      return Reflect.apply(original.createCipheriv, original, [algorithm, ...rest]);
    },
    createDecipheriv: (algorithm: string, ...rest: unknown[]) => {
      unknownCipher(algorithm);
      return Reflect.apply(original.createDecipheriv, original, [algorithm, ...rest]);
    },
  };
});

const { hasNativeChaCha20Poly1305 } = await import("./primitives.ts");
const { isPortableAeadLoaded } = await import("./portable-aead.ts");
const { createEncryptStream } = await import("./encrypt.ts");
const { createDecryptStream } = await import("./decrypt.ts");
const { generateIdentity } = await import("./keys.ts");

/** Nothing has encrypted or decrypted yet, so nothing may have loaded the library. */
const loadedBeforeFirstUse = isPortableAeadLoaded();

describe("on a runtime without ChaCha20-Poly1305 in node:crypto", () => {
  it("detects that the cipher is missing", () => {
    expect(hasNativeChaCha20Poly1305()).toBe(false);
  });

  it("loads @noble/ciphers only once a file key is wrapped, and encrypts multi-chunk files", async () => {
    expect(loadedBeforeFirstUse).toBe(false);
    const identity = generateIdentity();
    // Three full 64 KiB chunks and a partial one.
    const plaintext = Buffer.alloc(3 * 65_536 + 1234).map((_, index) => index % 251);
    const encrypted = await buffer(
      Readable.from([plaintext]).pipe(createEncryptStream({ recipients: [identity.recipient] })),
    );
    const decrypted = await buffer(
      Readable.from([encrypted]).pipe(createDecryptStream({ identities: [identity.identity] })),
    );
    expect(decrypted.equals(plaintext)).toBe(true);
    expect(isPortableAeadLoaded()).toBe(true);
  });
});

// The same suites as with node:crypto, now against the portable cipher.
await import("./cctv.test.ts");
await import("./stream.test.ts");
