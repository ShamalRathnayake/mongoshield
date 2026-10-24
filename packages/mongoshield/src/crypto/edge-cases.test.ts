/**
 * Edge cases of the age building blocks that the end-to-end stream tests do not
 * reach: error wrapping that must keep typed errors as they are, the STREAM cipher
 * refusing to go on after its final chunk, X25519 refusing low-order recipients,
 * custom unwrappers that pass on a stanza, and the decryptor's header size limit.
 */

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import { readStreamToBuffer } from "../util/streams.ts";
import { createDecryptStream } from "./decrypt.ts";
import { createEncryptStream } from "./encrypt.ts";
import { encryptionError, unexpectedDecryptionError } from "./failures.ts";
import type { Stanza } from "./header.ts";
import { generateIdentity } from "./keys.ts";
import { ChunkCipher, derivePayloadKey } from "./stream-cipher.ts";
import { wrapX25519 } from "./x25519.ts";

/** Runs `data` through `transform` and returns the output, or the error it failed with. */
async function through(
  transform: ReturnType<typeof createDecryptStream>,
  pieces: Buffer[],
): Promise<unknown> {
  return readStreamToBuffer(Readable.from(pieces).pipe(transform), {
    maxBytes: 16 * 1024 * 1024,
  }).catch((error: unknown) => error);
}

describe("error wrapping", () => {
  it("passes MongoShieldErrors through unchanged and wraps anything else", () => {
    const typed = new MongoShieldError("MS_ABORTED");
    expect(encryptionError(typed)).toBe(typed);
    expect(unexpectedDecryptionError(typed)).toBe(typed);
    expect(encryptionError(new Error("disk")).code).toBe("MS_ENCRYPTION_FAILED");
    expect(unexpectedDecryptionError("boom").code).toBe("MS_DECRYPTION_FAILED");
  });
});

describe("ChunkCipher", () => {
  it("refuses to seal another chunk after the final one", () => {
    const cipher = new ChunkCipher(derivePayloadKey(Buffer.alloc(16, 1), Buffer.alloc(16, 2)));
    cipher.seal(Buffer.from("last"), true);
    expect(() => cipher.seal(Buffer.from("more"), false)).toThrow(/already finished/);
  });
});

describe("wrapX25519", () => {
  it("refuses a low-order recipient, whose shared secret would be predictable", () => {
    expect(() => wrapX25519(Buffer.alloc(16, 1), Buffer.alloc(32, 0))).toThrow(/low-order/);
  });
});

describe("custom key unwrappers", () => {
  it("moves on to the next unwrapper when one returns undefined for a stanza", async () => {
    const fileKeys: Buffer[] = [];
    const custom: Stanza = { args: ["test-wrap"], body: Buffer.alloc(0) };
    const encryptor = createEncryptStream({
      keyWrappers: [
        async (fileKey) => {
          fileKeys.push(Buffer.from(fileKey));
          return custom;
        },
      ],
    });
    const file = await readStreamToBuffer(Readable.from([Buffer.from("secret")]).pipe(encryptor), {
      maxBytes: 1024,
    });
    const decryptor = createDecryptStream({
      keyUnwrappers: [async () => undefined, async () => fileKeys[0]],
    });
    expect(await through(decryptor, [file])).toEqual(Buffer.from("secret"));
  });
});

describe("createDecryptStream header limit", () => {
  it("fails with MS_DECRYPTION_FAILED when the header grows past 1 MiB", async () => {
    const line = Buffer.from(`-> X25519 ${"A".repeat(43)}\n${"B".repeat(43)}\n`);
    const piece = Buffer.concat(
      Array.from({ length: Math.ceil(65_536 / line.length) }, () => line),
    );
    const pieces = [
      Buffer.from("age-encryption.org/v1\n"),
      ...Array.from({ length: 20 }, () => piece),
    ];
    const error = await through(
      createDecryptStream({ identities: [generateIdentity().identity] }),
      pieces,
    );
    expect(isMongoShieldError(error, "MS_DECRYPTION_FAILED")).toBe(true);
    expect(String(error)).toMatch(/larger than/);
  });
});
