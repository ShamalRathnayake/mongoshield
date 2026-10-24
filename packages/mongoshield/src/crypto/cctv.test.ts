/**
 * Runs the official C2SP CCTV age test vectors
 * (https://github.com/C2SP/CCTV/tree/main/age) against createDecryptStream.
 *
 * Each vector is a small text header (expect, payload hash, identities,
 * passphrases) followed by an age file, optionally zlib-compressed. We check
 * that decryption fails at the right stage, and that the plaintext released
 * before any failure matches the vector's payload hash exactly (so nothing
 * unauthenticated ever leaks).
 *
 * Skipped, because MongoShield does not implement them: ASCII armor and the
 * post-quantum / tagged recipient types (their identities are not X25519).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isMongoShieldError, type MongoShieldError } from "../errors.ts";
import { createDecryptStream } from "./decrypt.ts";
import { assertValidIdentity, generateIdentity } from "./keys.ts";

const VECTORS_DIR = new URL("../../test/fixtures/age-cctv/testdata/", import.meta.url);

/** One parsed CCTV vector. */
interface Vector {
  readonly name: string;
  readonly expect: string;
  readonly payloadHash: string | undefined;
  readonly identities: string[];
  readonly passphrases: string[];
  readonly armored: boolean;
  readonly file: Buffer;
}

function parseVector(name: string): Vector {
  const raw = readFileSync(new URL(name, VECTORS_DIR));
  const split = raw.indexOf("\n\n");
  const fields = raw.subarray(0, split).toString("utf8").split("\n");
  const values = (key: string): string[] =>
    fields.filter((line) => line.startsWith(`${key}: `)).map((line) => line.slice(key.length + 2));
  const body = raw.subarray(split + 2);
  return {
    name,
    expect: values("expect")[0] ?? "",
    payloadHash: values("payload")[0],
    identities: values("identity"),
    passphrases: values("passphrase"),
    armored: values("armored")[0] === "yes",
    file: values("compressed")[0] === "zlib" ? inflateSync(body) : body,
  };
}

/** Why a vector is skipped, or undefined if MongoShield should handle it. */
function skipReason(vector: Vector): string | undefined {
  if (vector.armored) return "ASCII armor is not supported";
  for (const identity of vector.identities) {
    try {
      assertValidIdentity(identity);
    } catch {
      return "non-X25519 identity type";
    }
  }
  return undefined;
}

/** Maps a CCTV expectation to the `details.stage` MongoShield reports. */
const EXPECTED_STAGE: Record<string, string> = {
  "header failure": "header",
  "no match": "unwrap",
  "HMAC failure": "mac",
  "payload failure": "payload",
};

async function decryptVector(
  vector: Vector,
  pieceSize: number,
): Promise<{ output: Buffer; error: MongoShieldError | undefined }> {
  const emitted: Buffer[] = [];
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < vector.file.length; offset += pieceSize) {
    pieces.push(vector.file.subarray(offset, offset + pieceSize));
  }
  const passphrase = vector.passphrases[0];
  // A few header-failure vectors list no keys at all; any identity will do.
  const needsKey = vector.identities.length === 0 && passphrase === undefined;
  const decryptor = createDecryptStream({
    identities: needsKey ? [generateIdentity().identity] : vector.identities,
    ...(passphrase === undefined ? {} : { passphrase }),
  });
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      emitted.push(chunk);
      done();
    },
  });
  let error: MongoShieldError | undefined;
  try {
    await pipeline(Readable.from(pieces), decryptor, sink);
  } catch (failure) {
    if (!isMongoShieldError(failure)) throw failure;
    error = failure;
  }
  return { output: Buffer.concat(emitted), error };
}

const vectors = readdirSync(VECTORS_DIR)
  .sort()
  .map((name) => parseVector(name));
const runnable = vectors.filter((vector) => skipReason(vector) === undefined);

describe("CCTV age test vectors", () => {
  it("has the vector set available", () => {
    expect(vectors.length).toBeGreaterThan(100);
    expect(runnable.length).toBeGreaterThan(90);
  });

  for (const vector of vectors) {
    const reason = skipReason(vector);
    if (reason !== undefined) {
      it.skip(`${vector.name} (${reason})`, () => {});
      continue;
    }

    it(`${vector.name}: ${vector.expect}`, async () => {
      // Whole-file writes and odd-sized pieces must give identical results.
      for (const pieceSize of [vector.file.length || 1, 4099]) {
        const { output, error } = await decryptVector(vector, pieceSize);
        if (vector.expect === "success") {
          expect(error).toBeUndefined();
        } else {
          expect(error, "expected decryption to fail").toBeDefined();
          expect(error?.details?.stage).toBe(EXPECTED_STAGE[vector.expect]);
        }
        if (vector.payloadHash !== undefined) {
          expect(createHash("sha256").update(output).digest("hex")).toBe(vector.payloadHash);
        } else {
          expect(output.length).toBe(0);
        }
      }
    });
  }
});
