/**
 * The native age scrypt (passphrase) recipient type
 * (spec: "The scrypt recipient type").
 *
 *     salt     = random(16)
 *     wrap key = scrypt(N = 2^workFactor, r = 8, p = 1, dkLen = 32,
 *                       S = "age-encryption.org/v1/scrypt" || salt, P = passphrase)
 *     body     = ChaCha20-Poly1305(wrap key, nonce = 12 zero bytes, file key)
 *     stanza   = "-> scrypt <base64(salt)> <workFactor>" + body
 *
 * The spec also requires that an scrypt stanza is the only stanza in a header;
 * that rule is enforced where all stanzas are visible (encrypt.ts, decrypt.ts).
 */

import { randomBytes, scrypt } from "node:crypto";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import { DERIVED_KEY_SIZE, SCRYPT_SALT_LABEL, WRAPPED_FILE_KEY_SIZE } from "./constants.ts";
import { headerError } from "./failures.ts";
import type { Stanza } from "./header.ts";
import { open, seal, ZERO_NONCE } from "./primitives.ts";

/** The first stanza argument that identifies a scrypt stanza (case-sensitive). */
export const SCRYPT_STANZA_TYPE = "scrypt";

/** age's default work factor for new files: N = 2^18 (about 256 MiB, ~1 s). */
export const DEFAULT_SCRYPT_WORK_FACTOR = 18;

/**
 * The highest work factor accepted when decrypting by default, matching the
 * `age` CLI. 2^22 needs 4 GiB of memory; anything higher is far more likely to
 * be a denial-of-service attempt than a real file.
 */
export const DEFAULT_MAX_SCRYPT_WORK_FACTOR = 22;

/** The scrypt salt in the stanza is 16 random bytes. */
const SALT_SIZE = 16;

/** scrypt block size and parallelism are fixed by the spec. */
const BLOCK_SIZE = 8;
const PARALLELISM = 1;

/** "a decimal number composed of only digits with no leading zeroes" (spec). */
const WORK_FACTOR_PATTERN = /^[1-9][0-9]*$/;

/**
 * Memory budget to hand to Node's scrypt.
 *
 * Node refuses to run scrypt above `maxmem` (default 32 MiB), which is far
 * below what age's work factors need. OpenSSL allocates the V array,
 * 128·r·(N+2) bytes, plus the B array, 128·r·p bytes, and rejects the call if
 * their sum exceeds maxmem. We pass exactly that sum plus 1 MiB of headroom,
 * so legitimate work factors run while the explicit work-factor limit (not
 * maxmem) stays the real safeguard.
 */
export function scryptMaxMemory(workFactor: number): number {
  const cost = 2 ** workFactor;
  return 128 * BLOCK_SIZE * (cost + 2 + PARALLELISM) + 1024 * 1024;
}

/** Runs scrypt with age's parameters and returns the 32-byte wrap key. */
function deriveWrapKey(passphrase: string, salt: Uint8Array, workFactor: number): Promise<Buffer> {
  const labelledSalt = Buffer.concat([Buffer.from(SCRYPT_SALT_LABEL, "utf8"), salt]);
  const options = {
    N: 2 ** workFactor,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: scryptMaxMemory(workFactor),
  };
  return new Promise((resolve, reject) => {
    // The async variant runs on the libuv thread pool so a 1-second KDF does
    // not block the event loop.
    scrypt(
      Buffer.from(passphrase, "utf8"),
      labelledSalt,
      DERIVED_KEY_SIZE,
      options,
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Wraps the file key with a passphrase (fresh random salt per file, per spec). */
export async function wrapScrypt(
  fileKey: Uint8Array,
  passphrase: string,
  workFactor: number,
): Promise<Stanza> {
  const salt = randomBytes(SALT_SIZE);
  const wrapKey = await deriveWrapKey(passphrase, salt, workFactor);
  return {
    args: [SCRYPT_STANZA_TYPE, encodeBase64(salt), String(workFactor)],
    body: seal(wrapKey, ZERO_NONCE, fileKey),
  };
}

/** The validated arguments of an scrypt stanza. */
interface ScryptParameters {
  readonly salt: Buffer;
  readonly workFactor: number;
}

/**
 * Validates an scrypt stanza as the spec requires (exactly three arguments,
 * canonical 16-byte salt, digits-only work factor without leading zeros, a
 * 32-byte body) and enforces our work-factor ceiling. Every violation is a
 * header error, raised *before* any expensive KDF work.
 */
function parseScryptStanza(stanza: Stanza, maxWorkFactor: number): ScryptParameters {
  if (stanza.args.length !== 3) {
    throw headerError("scrypt stanza must have exactly two arguments after its type.");
  }
  const salt = decodeBase64(stanza.args[1] ?? "");
  if (salt === undefined || salt.length !== SALT_SIZE) {
    throw headerError("scrypt stanza salt is not canonical base64 of 16 bytes.");
  }
  const workFactorText = stanza.args[2] ?? "";
  if (!WORK_FACTOR_PATTERN.test(workFactorText)) {
    throw headerError("scrypt stanza work factor is not a plain decimal number.");
  }
  const workFactor = Number(workFactorText);
  if (workFactor > maxWorkFactor) {
    throw headerError(
      `scrypt work factor ${workFactorText} exceeds the allowed maximum of ${maxWorkFactor}.`,
      "If you trust this file, raise maxScryptWorkFactor (each step doubles time and memory).",
    );
  }
  if (stanza.body.length !== WRAPPED_FILE_KEY_SIZE) {
    throw headerError(`scrypt stanza body must be ${WRAPPED_FILE_KEY_SIZE} bytes.`);
  }
  return { salt, workFactor };
}

/**
 * Tries to unwrap an scrypt stanza. Returns the file key, or `undefined` if the
 * passphrase is wrong (or the body was modified: the two are indistinguishable).
 */
export async function unwrapScrypt(
  stanza: Stanza,
  passphrase: string,
  maxWorkFactor: number,
): Promise<Buffer | undefined> {
  const { salt, workFactor } = parseScryptStanza(stanza, maxWorkFactor);
  const wrapKey = await deriveWrapKey(passphrase, salt, workFactor);
  return open(wrapKey, ZERO_NONCE, stanza.body);
}
