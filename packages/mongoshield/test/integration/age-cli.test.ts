/**
 * Cross-checks MongoShield's age implementation against the official `age`
 * CLI (https://github.com/FiloSottile/age), in both directions.
 *
 * Skipped when `age` / `age-keygen` are not on PATH. Passphrase files are not
 * covered here because the CLI reads passphrases from a terminal only.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDecryptStream,
  createEncryptStream,
  generateIdentity,
  identityToRecipient,
} from "../../src/crypto/index.ts";

function commandWorks(command: string): boolean {
  return spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0;
}

const ageInstalled = commandWorks("age") && commandWorks("age-keygen");

/** Runs a buffer through a transform and returns the output. */
async function transform(stream: Transform, input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  await pipeline(Readable.from([input]), stream, sink);
  return Buffer.concat(chunks);
}

/** Runs the age CLI with stdin, failing the test on a non-zero exit. */
function age(args: string[], input?: Buffer): Buffer {
  const result = spawnSync("age", args, { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`age ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

describe.skipIf(!ageInstalled)("age CLI interoperability", () => {
  const workDir = mkdtempSync(join(tmpdir(), "mongoshield-age-"));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  // Sizes around the 64 KiB chunk boundary, where STREAM bugs would show.
  const sizes = [0, 1, 65_535, 65_536, 65_537, 3 * 65_536, 1_000_003];

  it.each(sizes)("the age CLI decrypts a %i-byte file encrypted by MongoShield", async (size) => {
    const { identity, recipient } = generateIdentity();
    const keyFile = join(workDir, `key-${size}.txt`);
    writeFileSync(keyFile, `${identity}\n`, { mode: 0o600 });
    const plaintext = randomBytes(size);
    const encrypted = await transform(createEncryptStream({ recipients: [recipient] }), plaintext);
    expect(age(["-d", "-i", keyFile], encrypted).equals(plaintext)).toBe(true);
  });

  it.each(sizes)("MongoShield decrypts a %i-byte file encrypted by the age CLI", async (size) => {
    const keyFile = join(workDir, `cli-key-${size}.txt`);
    spawnSync("age-keygen", ["-o", keyFile]);
    const identity = readFileSync(keyFile, "utf8")
      .split("\n")
      .find((line) => line.startsWith("AGE-SECRET-KEY-1"));
    if (identity === undefined) throw new Error("age-keygen wrote no identity");
    const recipient = spawnSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).stdout.trim();
    expect(identityToRecipient(identity)).toBe(recipient);

    const plaintext = randomBytes(size);
    const encrypted = age(["-r", recipient], plaintext);
    const decrypted = await transform(createDecryptStream({ identities: [identity] }), encrypted);
    expect(decrypted.equals(plaintext)).toBe(true);
  });
});
