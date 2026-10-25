/**
 * Tests for the browser key pair generator (age-keys.ts). The tests run in Node, so they
 * check the output against independent implementations: the mongoshield library's age
 * key parser (identityToRecipient, parseIdentityFile) and Node's own X25519.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { identityToRecipient, parseIdentityFile } from "mongoshield";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgeKeysUnsupportedError,
  ageKeyFileName,
  ageKeyFileText,
  encodeBech32,
  generateAgeKeyPair,
  privateKeysFromFileText,
  scalarFromPkcs8,
} from "./age-keys.ts";

/** The PKCS#8 header of an X25519 private key (see age-keys.ts). */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** The Bech32 alphabet, lower and upper case, for format checks. */
const LOWER_BECH32 = "[qpzry9x8gf2tvdw0s3jn54khce6mua7l]";
const UPPER_BECH32 = "[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]";

/** Decodes the 32 key bytes back out of an age key string (the library's decoder is internal). */
function keyBytes(text: string): Buffer {
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const lower = text.toLowerCase();
  // Data words sit between the last "1" and the 6-character checksum.
  const words = [...lower.slice(lower.lastIndexOf("1") + 1, -6)].map((c) => charset.indexOf(c));
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const word of words) {
    accumulator = ((accumulator << 5) | word) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** The raw X25519 public key Node derives from a private scalar. */
function nodePublicKey(scalar: Buffer): Buffer {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, scalar]),
    format: "der",
    type: "pkcs8",
  });
  // The SPKI export ends with the 32 raw public key bytes.
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Replaces the page's `crypto` with one whose `subtle` is the given fake (or none). */
function stubSubtle(subtle: Partial<SubtleCrypto> | undefined): void {
  vi.stubGlobal("crypto", subtle === undefined ? {} : { subtle });
}

describe("generateAgeKeyPair", () => {
  it("makes keys in age's format: age1… (lowercase) and AGE-SECRET-KEY-1… (uppercase)", async () => {
    const { publicKey, privateKey } = await generateAgeKeyPair();
    // 32 bytes = 52 Bech32 words + 6 checksum characters after the separator.
    expect(publicKey).toMatch(new RegExp(`^age1${LOWER_BECH32}{58}$`));
    expect(privateKey).toMatch(new RegExp(`^AGE-SECRET-KEY-1${UPPER_BECH32}{58}$`));
    expect(publicKey).toHaveLength(62);
    expect(privateKey).toHaveLength(74);
  });

  it("makes a public key the library derives from the private key", async () => {
    const { publicKey, privateKey } = await generateAgeKeyPair();
    // identityToRecipient parses (validates) the private key and re-encodes its public half.
    expect(identityToRecipient(privateKey)).toBe(publicKey);
  });

  it("makes a public key that matches Node's X25519 for the same private scalar", async () => {
    const { publicKey, privateKey } = await generateAgeKeyPair();
    const scalar = keyBytes(privateKey);
    expect(scalar).toHaveLength(32);
    expect(keyBytes(publicKey).equals(nodePublicKey(scalar))).toBe(true);
  });

  it("makes a different key pair every time", async () => {
    const first = await generateAgeKeyPair();
    const second = await generateAgeKeyPair();
    expect(first.privateKey).not.toBe(second.privateKey);
    expect(first.publicKey).not.toBe(second.publicKey);
  });

  it("reports an insecure page when there is no crypto.subtle", async () => {
    stubSubtle(undefined);
    const failure = await generateAgeKeyPair().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgeKeysUnsupportedError);
    expect((failure as AgeKeysUnsupportedError).insecureContext).toBe(true);
  });

  it("reports a browser without X25519 when generateKey refuses", async () => {
    const subtle = {
      generateKey: vi.fn(async () => {
        throw new DOMException("Unrecognized name.", "NotSupportedError");
      }),
    };
    stubSubtle(subtle);
    const failure = await generateAgeKeyPair().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgeKeysUnsupportedError);
    expect((failure as AgeKeysUnsupportedError).insecureContext).toBe(false);
    expect(subtle.generateKey).toHaveBeenCalledWith({ name: "X25519" }, true, ["deriveBits"]);
  });

  it("also reports unsupported when the real crypto.subtle.generateKey is mocked to refuse", async () => {
    vi.spyOn(globalThis.crypto.subtle, "generateKey").mockRejectedValue(
      new DOMException("Unrecognized name.", "NotSupportedError"),
    );
    await expect(generateAgeKeyPair()).rejects.toBeInstanceOf(AgeKeysUnsupportedError);
  });

  it("fails loudly when the browser exports keys in an unexpected shape", async () => {
    const real = globalThis.crypto.subtle;
    // A fake that generates real keys but hands back a 31-byte public key.
    const subtle = {
      generateKey: real.generateKey.bind(real),
      exportKey: async (format: "raw" | "pkcs8", key: CryptoKey) =>
        format === "raw" ? new ArrayBuffer(31) : real.exportKey(format, key),
    } as unknown as Partial<SubtleCrypto>;
    stubSubtle(subtle);
    await expect(generateAgeKeyPair()).rejects.toThrow("unexpected format");
  });
});

describe("scalarFromPkcs8", () => {
  it("returns the 32 bytes after the X25519 header", () => {
    const scalar = Buffer.alloc(32, 7);
    expect(Buffer.from(scalarFromPkcs8(Buffer.concat([PKCS8_PREFIX, scalar]))).equals(scalar)).toBe(
      true,
    );
  });

  it("refuses another algorithm's header or a wrong length", () => {
    const ed25519Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    expect(() => scalarFromPkcs8(Buffer.concat([ed25519Prefix, Buffer.alloc(32)]))).toThrow();
    expect(() => scalarFromPkcs8(Buffer.concat([PKCS8_PREFIX, Buffer.alloc(31)]))).toThrow();
  });
});

describe("encodeBech32", () => {
  it("matches BIP 173's test vector", () => {
    // From BIP 173: "a12uel5l" is the valid Bech32 encoding of an empty payload with HRP "a".
    expect(encodeBech32("a", new Uint8Array())).toBe("a12uel5l");
  });

  it("uppercases private keys whole, with the checksum over the lowercase form", () => {
    // The library accepts the result as a private key, and it equals the lowercase
    // encoding uppercased (the checksum is the same), as age's spec requires.
    const zero = new Uint8Array(32);
    expect(identityToRecipient(encodeBech32("AGE-SECRET-KEY-", zero))).toMatch(/^age1/);
    expect(encodeBech32("AGE-SECRET-KEY-", zero)).toBe(
      encodeBech32("age-secret-key-", zero).toUpperCase(),
    );
  });
});

describe("key files", () => {
  const keyPair = {
    publicKey: "age1publicexample",
    privateKey: "AGE-SECRET-KEY-1EXAMPLE",
  };
  const created = new Date("2026-10-25T08:30:00.000Z");

  it("are written in age-keygen's format", () => {
    expect(ageKeyFileText(keyPair, created)).toBe(
      "# created: 2026-10-25T08:30:00.000Z\n# public key: age1publicexample\nAGE-SECRET-KEY-1EXAMPLE\n",
    );
    expect(ageKeyFileName(created)).toBe("mongoshield-backup-key-2026-10-25.txt");
  });

  it("can be read by the library when the key is real", async () => {
    const real = await generateAgeKeyPair();
    expect(parseIdentityFile(ageKeyFileText(real))).toEqual([real.privateKey]);
  });

  it("give back their private keys, skipping comments, blanks, other text and repeats", async () => {
    const one = await generateAgeKeyPair();
    const two = await generateAgeKeyPair();
    const text = [
      "# created: 2026-10-25T08:30:00Z",
      `# public key: ${one.publicKey}`,
      `  ${one.privateKey}  `,
      "",
      "some note",
      `${two.privateKey}\r`,
      one.privateKey,
    ].join("\n");
    expect(privateKeysFromFileText(text)).toEqual([one.privateKey, two.privateKey]);
    expect(privateKeysFromFileText(`# nothing here\n${one.publicKey}\n`)).toEqual([]);
  });
});
