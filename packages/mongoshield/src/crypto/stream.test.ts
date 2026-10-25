/**
 * End-to-end tests for createEncryptStream / createDecryptStream: round trips,
 * chunk boundaries, multiple recipients, passphrases, tampering, truncation,
 * trailing data and option validation.
 *
 * scrypt work factors are kept low (10) so the suite stays fast.
 */

import { randomBytes } from "node:crypto";
import { Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isMongoShieldError, type MongoShieldError } from "../errors.ts";
import {
  CHUNK_SIZE,
  ENCRYPTED_CHUNK_SIZE,
  FILE_KEY_SIZE,
  PAYLOAD_NONCE_SIZE,
} from "./constants.ts";
import { createDecryptStream, type DecryptStreamOptions } from "./decrypt.ts";
import { createEncryptStream, type EncryptStreamOptions } from "./encrypt.ts";
import { encodeHeader, findHeaderEnd } from "./header.ts";
import { generateIdentity, parseRecipient } from "./keys.ts";
import { ChunkCipher, derivePayloadKey } from "./stream-cipher.ts";
import { wrapX25519 } from "./x25519.ts";

const FAST_WORK_FACTOR = 10;

/** The result of running data through a stream: everything emitted, and the error if any. */
interface StreamResult {
  readonly output: Buffer;
  readonly error: MongoShieldError | undefined;
}

/** Splits `data` into pieces of the given sizes (cycled), to vary write boundaries. */
function split(data: Buffer, sizes: readonly number[] = [data.length || 1]): Buffer[] {
  const pieces: Buffer[] = [];
  let offset = 0;
  for (let index = 0; offset < data.length; index++) {
    const size = Math.max(1, sizes[index % sizes.length] ?? 1);
    pieces.push(data.subarray(offset, offset + size));
    offset += size;
  }
  return pieces;
}

/** Pipes pieces through a transform and collects what it emits, even on failure. */
async function run(transform: Transform, pieces: readonly Buffer[]): Promise<StreamResult> {
  const emitted: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      emitted.push(chunk);
      done();
    },
  });
  let error: MongoShieldError | undefined;
  try {
    await pipeline(Readable.from(pieces), transform, sink);
  } catch (failure) {
    if (!isMongoShieldError(failure)) throw failure;
    error = failure;
  }
  return { output: Buffer.concat(emitted), error };
}

async function encrypt(
  plaintext: Buffer,
  options: EncryptStreamOptions,
  sizes?: readonly number[],
): Promise<Buffer> {
  const result = await run(createEncryptStream(options), split(plaintext, sizes));
  if (result.error) throw result.error;
  return result.output;
}

function decrypt(
  ciphertext: Buffer,
  options: DecryptStreamOptions,
  sizes?: readonly number[],
): Promise<StreamResult> {
  return run(createDecryptStream(options), split(ciphertext, sizes));
}

/** Expected encrypted payload size: nonce + plaintext + one tag per chunk (at least one chunk). */
function payloadSize(plaintextLength: number): number {
  const chunks = Math.max(1, Math.ceil(plaintextLength / CHUNK_SIZE));
  return PAYLOAD_NONCE_SIZE + plaintextLength + chunks * 16;
}

function headerLength(ciphertext: Buffer): number {
  const end = findHeaderEnd(ciphertext);
  if (end === undefined) throw new Error("no header");
  return end;
}

const alice = generateIdentity();
const bob = generateIdentity();
const mallory = generateIdentity();

describe("round trips", () => {
  it.each([0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE, 3 * CHUNK_SIZE + 1])(
    "encrypts and decrypts %i bytes with the STREAM layout the spec defines",
    async (size) => {
      const plaintext = randomBytes(size);
      const ciphertext = await encrypt(plaintext, { recipients: [alice.recipient] });
      expect(ciphertext.length - headerLength(ciphertext)).toBe(payloadSize(size));

      const result = await decrypt(ciphertext, { identities: [alice.identity] });
      expect(result.error).toBeUndefined();
      expect(result.output.equals(plaintext)).toBe(true);
    },
  );

  it("round-trips random sizes with random write boundaries on both sides", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4 * CHUNK_SIZE + 100 }),
        fc.array(fc.integer({ min: 1, max: 2 * CHUNK_SIZE }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 1, max: 2 * CHUNK_SIZE }), { minLength: 1, maxLength: 8 }),
        async (size, writeSizes, readSizes) => {
          const plaintext = randomBytes(size);
          const ciphertext = await encrypt(
            plaintext,
            { recipients: [alice.recipient] },
            writeSizes,
          );
          const result = await decrypt(ciphertext, { identities: [alice.identity] }, readSizes);
          expect(result.error).toBeUndefined();
          expect(result.output.equals(plaintext)).toBe(true);
        },
      ),
      { numRuns: 30 },
    );
    // Thirty files of up to 4 chunks each, encrypted and decrypted: well under a
    // second locally, but slower than Vitest's 5 s default on a busy CI runner with
    // coverage instrumentation.
  }, 30_000);

  it("decrypts input delivered one byte at a time", async () => {
    const plaintext = randomBytes(1000);
    const ciphertext = await encrypt(plaintext, { recipients: [alice.recipient] });
    const result = await decrypt(ciphertext, { identities: [alice.identity] }, [1]);
    expect(result.output.equals(plaintext)).toBe(true);
  });

  it("uses a fresh file key and nonce for every file", async () => {
    const plaintext = Buffer.from("same input");
    const first = await encrypt(plaintext, { recipients: [alice.recipient] });
    const second = await encrypt(plaintext, { recipients: [alice.recipient] });
    expect(first.equals(second)).toBe(false);
  });

  it("emits plaintext for authenticated chunks before the input ends (streaming)", async () => {
    const plaintext = randomBytes(3 * CHUNK_SIZE);
    const ciphertext = await encrypt(plaintext, { recipients: [alice.recipient] });
    const decryptor = createDecryptStream({ identities: [alice.identity] });
    const emitted: Buffer[] = [];
    decryptor.on("data", (chunk: Buffer) => emitted.push(chunk));
    // Everything except the last chunk: the first two chunks are provably non-final.
    const cut = ciphertext.length - 1000;
    await new Promise<void>((resolve) =>
      decryptor.write(ciphertext.subarray(0, cut), () => resolve()),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(Buffer.concat(emitted).equals(plaintext.subarray(0, 2 * CHUNK_SIZE))).toBe(true);
    decryptor.destroy();
  });
});

describe("recipients and identities", () => {
  it("lets every recipient decrypt a multi-recipient file", async () => {
    const plaintext = randomBytes(70_000);
    const ciphertext = await encrypt(plaintext, { recipients: [alice.recipient, bob.recipient] });
    for (const identity of [alice.identity, bob.identity]) {
      const result = await decrypt(ciphertext, { identities: [identity] });
      expect(result.output.equals(plaintext)).toBe(true);
    }
  });

  it("tries every given identity", async () => {
    const ciphertext = await encrypt(Buffer.from("x"), { recipients: [bob.recipient] });
    const result = await decrypt(ciphertext, { identities: [mallory.identity, bob.identity] });
    expect(result.output.toString()).toBe("x");
  });

  it("fails with MS_NO_IDENTITY and no output for a non-matching identity", async () => {
    const ciphertext = await encrypt(Buffer.from("secret"), { recipients: [alice.recipient] });
    const result = await decrypt(ciphertext, { identities: [mallory.identity] });
    expect(result.error?.code).toBe("MS_NO_IDENTITY");
    expect(result.output.length).toBe(0);
  });

  it("fails with MS_NO_IDENTITY when only a passphrase is given for a recipient file", async () => {
    const ciphertext = await encrypt(Buffer.from("secret"), { recipients: [alice.recipient] });
    const result = await decrypt(ciphertext, { passphrase: "hunter2" });
    expect(result.error?.code).toBe("MS_NO_IDENTITY");
  });
});

describe("passphrase encryption", () => {
  const options = {
    passphrase: "correct horse battery staple",
    scryptWorkFactor: FAST_WORK_FACTOR,
  };

  it("round-trips with the passphrase and writes a single scrypt stanza", async () => {
    const plaintext = randomBytes(100_000);
    const ciphertext = await encrypt(plaintext, options);
    const header = ciphertext.subarray(0, headerLength(ciphertext)).toString("latin1");
    expect(header).toMatch(/^age-encryption\.org\/v1\n-> scrypt [A-Za-z0-9+/]{22} 10\n/);
    expect(header.match(/^-> /gm)).toHaveLength(1);

    const result = await decrypt(ciphertext, { passphrase: options.passphrase });
    expect(result.output.equals(plaintext)).toBe(true);
  });

  it("uses work factor 18 by default", async () => {
    // Only the header is needed; skip running the expensive KDF twice.
    const encryptor = createEncryptStream({ passphrase: "p" });
    const first: Buffer = await new Promise((resolve) => {
      encryptor.once("data", resolve);
      encryptor.end();
    });
    expect(first.toString("latin1")).toMatch(/^age-encryption\.org\/v1\n-> scrypt \S+ 18\n/);
  });

  it("rejects a wrong passphrase with MS_DECRYPTION_FAILED", async () => {
    const ciphertext = await encrypt(Buffer.from("data"), options);
    const result = await decrypt(ciphertext, { passphrase: "wrong" });
    expect(result.error?.code).toBe("MS_DECRYPTION_FAILED");
    expect(result.error?.details).toEqual({ stage: "unwrap" });
    expect(result.error?.message).not.toContain("wrong");
    expect(result.output.length).toBe(0);
  });

  it("rejects a work factor above maxScryptWorkFactor before running scrypt", async () => {
    const ciphertext = await encrypt(Buffer.from("data"), options);
    const result = await decrypt(ciphertext, {
      passphrase: options.passphrase,
      maxScryptWorkFactor: FAST_WORK_FACTOR - 1,
    });
    expect(result.error?.code).toBe("MS_DECRYPTION_FAILED");
    expect(result.error?.hint).toContain("maxScryptWorkFactor");
  });

  it("fails with MS_NO_IDENTITY when only identities are given for a passphrase file", async () => {
    const ciphertext = await encrypt(Buffer.from("data"), options);
    const result = await decrypt(ciphertext, { identities: [alice.identity] });
    expect(result.error?.code).toBe("MS_NO_IDENTITY");
  });
});

describe("tampering", () => {
  const plaintext = randomBytes(3 * CHUNK_SIZE + 500);
  const ciphertextPromise = encrypt(plaintext, { recipients: [alice.recipient, bob.recipient] });

  function flip(data: Buffer, position: number): Buffer {
    const copy = Buffer.from(data);
    copy[position] = (copy[position] ?? 0) ^ 0x01;
    return copy;
  }

  it("rejects a change to any byte of the header without emitting plaintext", async () => {
    const ciphertext = await ciphertextPromise;
    for (let position = 0; position < headerLength(ciphertext); position++) {
      const result = await decrypt(flip(ciphertext, position), { identities: [alice.identity] });
      expect(result.error, `header byte ${position}`).toBeDefined();
      expect(result.output.length).toBe(0);
    }
  });

  it("rejects a changed payload byte and emits only the chunks before it", async () => {
    const ciphertext = await ciphertextPromise;
    const payloadStart = headerLength(ciphertext) + PAYLOAD_NONCE_SIZE;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: headerLength(ciphertext), max: ciphertext.length - 1 }),
        async (position) => {
          const result = await decrypt(flip(ciphertext, position), {
            identities: [alice.identity],
          });
          expect(result.error?.code).toBe("MS_DECRYPTION_FAILED");
          const intactChunks =
            position < payloadStart
              ? 0
              : Math.floor((position - payloadStart) / ENCRYPTED_CHUNK_SIZE);
          expect(result.output.equals(plaintext.subarray(0, intactChunks * CHUNK_SIZE))).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("rejects truncation at any point, including exactly at a chunk boundary", async () => {
    const ciphertext = await ciphertextPromise;
    const payloadStart = headerLength(ciphertext) + PAYLOAD_NONCE_SIZE;
    const cuts = [
      0,
      10,
      headerLength(ciphertext),
      payloadStart - 1,
      payloadStart,
      payloadStart + ENCRYPTED_CHUNK_SIZE,
      payloadStart + 2 * ENCRYPTED_CHUNK_SIZE,
      payloadStart + 3 * ENCRYPTED_CHUNK_SIZE,
      ciphertext.length - 1,
    ];
    for (const cut of cuts) {
      const result = await decrypt(ciphertext.subarray(0, cut), { identities: [alice.identity] });
      expect(result.error?.code, `cut at ${cut}`).toBe("MS_DECRYPTION_FAILED");
      expect(plaintext.subarray(0, result.output.length).equals(result.output)).toBe(true);
      expect(result.output.length).toBeLessThan(plaintext.length);
    }
  });

  it.each([1, 16, 17, ENCRYPTED_CHUNK_SIZE])("rejects %i appended bytes", async (extra) => {
    const ciphertext = await ciphertextPromise;
    const appended = Buffer.concat([ciphertext, randomBytes(extra)]);
    const result = await decrypt(appended, { identities: [alice.identity] });
    expect(result.error?.details).toEqual({ stage: "payload" });
  });

  it("rejects data appended after a full final chunk", async () => {
    const exact = randomBytes(2 * CHUNK_SIZE);
    const ciphertext = await encrypt(exact, { recipients: [alice.recipient] });
    const result = await decrypt(Buffer.concat([ciphertext, Buffer.from("x")]), {
      identities: [alice.identity],
    });
    expect(result.error?.message).toContain("after the final chunk");
    // Both chunks authenticate (the last one as final), so they are released,
    // as the reference implementation does; the appended byte is the error.
    expect(result.output.equals(exact)).toBe(true);
  });

  it("rejects input that is not an age file", async () => {
    const result = await decrypt(Buffer.from("(\xb5/\xfd not age at all"), {
      identities: [alice.identity],
    });
    expect(result.error?.details).toEqual({ stage: "header" });
    expect(result.error?.hint).toContain("not age-encrypted");
  });
});

describe("STREAM chunk rules (hand-built files)", () => {
  /**
   * Builds an age file for `alice` with an arbitrary chunk sequence, using
   * the real header and STREAM code, so each malformed layout is otherwise valid.
   */
  function buildFile(chunks: ReadonlyArray<{ size: number; last: boolean }>): Buffer {
    const fileKey = randomBytes(FILE_KEY_SIZE);
    const payloadNonce = randomBytes(PAYLOAD_NONCE_SIZE);
    const stanza = wrapX25519(fileKey, parseRecipient(alice.recipient));
    const cipher = new ChunkCipher(derivePayloadKey(fileKey, payloadNonce));
    const parts = [encodeHeader([stanza], fileKey), payloadNonce];
    for (const chunk of chunks) parts.push(cipher.seal(Buffer.alloc(chunk.size, 7), chunk.last));
    return Buffer.concat(parts);
  }

  it("accepts a well-formed hand-built file (sanity check)", async () => {
    const file = buildFile([
      { size: CHUNK_SIZE, last: false },
      { size: 10, last: true },
    ]);
    const result = await decrypt(file, { identities: [alice.identity] });
    expect(result.error).toBeUndefined();
    expect(result.output.length).toBe(CHUNK_SIZE + 10);
  });

  it.each<[string, Array<{ size: number; last: boolean }>, number]>([
    [
      "an empty final chunk after a full chunk",
      [
        { size: CHUNK_SIZE, last: false },
        { size: 0, last: true },
      ],
      CHUNK_SIZE,
    ],
    [
      "an empty non-final chunk",
      [
        { size: 0, last: false },
        { size: 5, last: true },
      ],
      0,
    ],
    [
      "a short non-final chunk",
      [
        { size: 100, last: false },
        { size: 5, last: true },
      ],
      0,
    ],
    [
      "no final chunk",
      [
        { size: CHUNK_SIZE, last: false },
        { size: CHUNK_SIZE, last: false },
      ],
      2 * CHUNK_SIZE,
    ],
    ["a short non-final chunk alone", [{ size: 5, last: false }], 0],
  ])("rejects %s", async (_name, chunks, releasedBytes) => {
    const result = await decrypt(buildFile(chunks), { identities: [alice.identity] });
    expect(result.error?.details).toEqual({ stage: "payload" });
    expect(result.output.length).toBe(releasedBytes);
  });
});

describe("option validation", () => {
  function codeOf(action: () => unknown): string | undefined {
    try {
      action();
    } catch (error) {
      return isMongoShieldError(error) ? error.code : "not a MongoShieldError";
    }
    return undefined;
  }

  it.each<[string, EncryptStreamOptions]>([
    ["no recipients and no passphrase", {}],
    ["an empty recipient list", { recipients: [] }],
    ["a passphrase together with recipients", { recipients: [alice.recipient], passphrase: "p" }],
    ["an empty passphrase", { passphrase: "" }],
    ["an invalid recipient", { recipients: ["age1nope"] }],
    ["a secret identity as recipient", { recipients: [alice.identity] }],
    ["a fractional work factor", { passphrase: "p", scryptWorkFactor: 10.5 }],
    ["a work factor above 22", { passphrase: "p", scryptWorkFactor: 23 }],
    ["a work factor of 0", { passphrase: "p", scryptWorkFactor: 0 }],
  ])("createEncryptStream rejects %s with MS_CONFIG_INVALID", (_name, options) => {
    expect(codeOf(() => createEncryptStream(options))).toBe("MS_CONFIG_INVALID");
  });

  it.each<[string, DecryptStreamOptions, string]>([
    ["no identities and no passphrase", {}, "MS_NO_IDENTITY"],
    ["an invalid identity", { identities: ["AGE-SECRET-KEY-1NOPE"] }, "MS_CONFIG_INVALID"],
    ["an empty passphrase", { passphrase: "" }, "MS_CONFIG_INVALID"],
    ["a max work factor of 31", { passphrase: "p", maxScryptWorkFactor: 31 }, "MS_CONFIG_INVALID"],
  ])("createDecryptStream rejects %s", (_name, options, code) => {
    expect(codeOf(() => createDecryptStream(options))).toBe(code);
  });

  it("accepts both identities and a passphrase when decrypting", () => {
    expect(
      codeOf(() => createDecryptStream({ identities: [alice.identity], passphrase: "p" })),
    ).toBeUndefined();
  });
});
