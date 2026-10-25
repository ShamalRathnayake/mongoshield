import { randomBytes } from "node:crypto";
import { Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { findHeaderEnd } from "./header.ts";
import { createHeaderReplacer, readAgeHeader, rewrapHeader } from "./header-rewrite.ts";
import { createDecryptStream, createEncryptStream, generateIdentity } from "./index.ts";

/** Runs bytes through transforms (in small chunks, to exercise buffering) and collects them. */
async function run(input: Buffer, transforms: Transform[], chunkSize = 7): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    pieces.push(input.subarray(offset, offset + chunkSize));
  }
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  await pipeline([Readable.from(pieces), ...transforms, sink]);
  return Buffer.concat(chunks);
}

async function encryptTo(recipients: string[], plaintext: Buffer): Promise<Buffer> {
  return run(plaintext, [createEncryptStream({ recipients })], 64 * 1024);
}

function headerOf(file: Buffer): Buffer {
  const end = findHeaderEnd(file);
  if (end === undefined) throw new Error("no header");
  return file.subarray(0, end);
}

describe("rewrapHeader + createHeaderReplacer", () => {
  const plaintext = randomBytes(150_000);

  it("lets a new recipient decrypt and stops an old one, leaving the payload untouched", async () => {
    const oldKey = generateIdentity();
    const newKey = generateIdentity();
    const file = await encryptTo([oldKey.recipient], plaintext);

    const newHeader = await rewrapHeader(headerOf(file), {
      unwrap: { identities: [oldKey.identity] },
      wrap: { recipients: [newKey.recipient] },
    });
    const rewritten = await run(file, [createHeaderReplacer(newHeader)]);

    // Same payload bytes after the header.
    expect(rewritten.subarray(newHeader.length)).toEqual(file.subarray(headerOf(file).length));
    const opened = await run(rewritten, [createDecryptStream({ identities: [newKey.identity] })]);
    expect(opened).toEqual(plaintext);
    await expect(
      run(rewritten, [createDecryptStream({ identities: [oldKey.identity] })]),
    ).rejects.toSatisfy((error) => isMongoShieldError(error, "MS_NO_IDENTITY"));
  });

  it("keeps chosen stanzas verbatim and can drop every fresh recipient", async () => {
    const own = generateIdentity();
    const recovery = generateIdentity();
    const file = await encryptTo([own.recipient, recovery.recipient], plaintext);

    const newHeader = await rewrapHeader(headerOf(file), {
      unwrap: { identities: [recovery.identity] },
      wrap: {},
      keepStanzas: [0],
    });
    const rewritten = await run(file, [createHeaderReplacer(newHeader)]);
    expect(await run(rewritten, [createDecryptStream({ identities: [own.identity] })])).toEqual(
      plaintext,
    );
    await expect(
      run(rewritten, [createDecryptStream({ identities: [recovery.identity] })]),
    ).rejects.toThrow();
  });

  it("changes a passphrase", async () => {
    const file = await run(
      plaintext,
      [createEncryptStream({ passphrase: "old secret", scryptWorkFactor: 10 })],
      64 * 1024,
    );
    const newHeader = await rewrapHeader(headerOf(file), {
      unwrap: { passphrase: "old secret" },
      wrap: { passphrase: "new secret", scryptWorkFactor: 10 },
    });
    const rewritten = await run(file, [createHeaderReplacer(newHeader)]);
    expect(await run(rewritten, [createDecryptStream({ passphrase: "new secret" })])).toEqual(
      plaintext,
    );
  });

  it("refuses to re-sign a header whose MAC does not verify", async () => {
    const key = generateIdentity();
    const file = await encryptTo([key.recipient], plaintext);
    const header = Buffer.from(headerOf(file));
    // Flip one character of the MAC (the last base64 character before the newline).
    const index = header.length - 2;
    header[index] = header[index] === 0x41 ? 0x42 : 0x41;
    await expect(
      rewrapHeader(header, {
        unwrap: { identities: [key.identity] },
        wrap: { recipients: [generateIdentity().recipient] },
      }),
    ).rejects.toSatisfy((error) => isMongoShieldError(error, "MS_DECRYPTION_FAILED"));
  });

  it("refuses to replace a header that differs from the expected one", async () => {
    const key = generateIdentity();
    const file = await encryptTo([key.recipient], plaintext);
    await expect(
      run(file, [createHeaderReplacer(Buffer.from("x"), Buffer.from("not the header"))]),
    ).rejects.toThrow(/changed since the rekey was prepared/);
  });

  it("reads just the header of a stream", async () => {
    const key = generateIdentity();
    const file = await encryptTo([key.recipient], plaintext);
    expect(await readAgeHeader(Readable.from([file]))).toEqual(headerOf(file));
    await expect(readAgeHeader(Readable.from([Buffer.from("plain text")]))).rejects.toThrow();
  });
});

describe("rewrapHeader refuses stanzas it cannot keep", () => {
  const plaintext = randomBytes(1000);

  it("refuses a passphrase next to kept stanzas", async () => {
    const own = generateIdentity();
    const file = await encryptTo([own.recipient], plaintext);
    await expect(
      rewrapHeader(headerOf(file), {
        unwrap: { identities: [own.identity] },
        wrap: { passphrase: "new secret", scryptWorkFactor: 10 },
        keepStanzas: [0],
      }),
    ).rejects.toSatisfy((error) => isMongoShieldError(error, "MS_CONFIG_INVALID"));
  });

  it("refuses to keep a stanza the header does not have", async () => {
    const own = generateIdentity();
    const file = await encryptTo([own.recipient], plaintext);
    await expect(
      rewrapHeader(headerOf(file), {
        unwrap: { identities: [own.identity] },
        wrap: {},
        keepStanzas: [3],
      }),
    ).rejects.toThrow(/no stanza #4/);
  });

  it("refuses to keep a passphrase stanza", async () => {
    const file = await run(
      plaintext,
      [createEncryptStream({ passphrase: "old secret", scryptWorkFactor: 10 })],
      64 * 1024,
    );
    await expect(
      rewrapHeader(headerOf(file), {
        unwrap: { passphrase: "old secret" },
        wrap: { recipients: [generateIdentity().recipient] },
        keepStanzas: [0],
      }),
    ).rejects.toThrow(/scrypt/);
  });
});

describe("header size limits and truncation", () => {
  /**
   * The start of a plausible age header that never ends: the version line, then
   * stanza lines well past the 1 MiB header limit, in 64 KiB pieces.
   */
  function endlessHeader(): Buffer[] {
    const line = Buffer.from(`-> X25519 ${"A".repeat(43)}\n${"B".repeat(43)}\n`);
    const piece = Buffer.concat(
      Array.from({ length: Math.ceil(65_536 / line.length) }, () => line),
    );
    return [Buffer.from("age-encryption.org/v1\n"), ...Array.from({ length: 20 }, () => piece)];
  }

  it("readAgeHeader gives up on a header larger than 1 MiB", async () => {
    await expect(readAgeHeader(Readable.from(endlessHeader()))).rejects.toThrow(/larger than/);
  });

  it("readAgeHeader reports a stream that ends inside the header", async () => {
    await expect(
      readAgeHeader(Readable.from([Buffer.from("age-encryption.org/v1\n")])),
    ).rejects.toThrow(/incomplete/);
  });

  it("createHeaderReplacer gives up on a header larger than 1 MiB", async () => {
    const replacer = createHeaderReplacer(Buffer.from("new header"));
    await expect(run(Buffer.concat(endlessHeader()), [replacer], 64 * 1024)).rejects.toThrow(
      /larger than/,
    );
  });

  it("createHeaderReplacer reports input that ends inside the header", async () => {
    const replacer = createHeaderReplacer(Buffer.from("new header"));
    await expect(
      run(Buffer.from("age-encryption.org/v1\n-> X25519 abc\n"), [replacer]),
    ).rejects.toThrow(/incomplete/);
  });
});
