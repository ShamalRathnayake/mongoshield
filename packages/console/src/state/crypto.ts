/**
 * Cryptography for the console's own data: the keys derived from
 * MONGOSHIELD_SECRET, encryption of stored secrets, random tokens and hashing.
 *
 * Everything uses node:crypto; no third-party crypto code.
 *
 * Key hierarchy:
 *
 *   MONGOSHIELD_SECRET ──HKDF-SHA256(salt from console.json)──┬─ info "mongoshield-console/v1"       → secrets key (AES-256-GCM)
 *                                                            └─ info "mongoshield-console/v1/csrf"  → CSRF key (HMAC-SHA256)
 *
 * Using HKDF with a per-data-directory salt means two consoles started with the
 * same secret still get different keys, and the two purposes never share a key.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** HKDF `info` for the key that encrypts stored secrets. Part of the on-disk contract. */
export const SECRETS_KEY_INFO = "mongoshield-console/v1";
/** HKDF `info` for the key that derives CSRF tokens from session ids. */
export const CSRF_KEY_INFO = "mongoshield-console/v1/csrf";

/** Shortest MONGOSHIELD_SECRET accepted: 32 characters (`openssl rand -hex 32` gives 64). */
export const MIN_SECRET_LENGTH = 32;

/** AES-GCM's recommended 96-bit nonce; random per encryption (2^-32 collision bound is far away). */
const IV_BYTES = 12;
/** AES-256 needs a 32-byte key. */
const KEY_BYTES = 32;
/** Prefix of every encrypted value, so a future format can be told apart. */
const SECRET_FORMAT = "v1";

/** The keys derived from MONGOSHIELD_SECRET for one data directory. */
export interface ConsoleKeys {
  /** AES-256-GCM key for secrets stored in console.json. */
  readonly secrets: Buffer;
  /** HMAC key that binds CSRF tokens to sessions. */
  readonly csrf: Buffer;
}

/** Derives the console's keys from the operator's secret and the state file's salt. */
export function deriveKeys(secret: string, salt: Buffer): ConsoleKeys {
  const material = Buffer.from(secret, "utf8");
  return {
    secrets: Buffer.from(hkdfSync("sha256", material, salt, SECRETS_KEY_INFO, KEY_BYTES)),
    csrf: Buffer.from(hkdfSync("sha256", material, salt, CSRF_KEY_INFO, KEY_BYTES)),
  };
}

/**
 * Encrypts a secret. `context` is authenticated but not stored (AES-GCM
 * "additional data"): pass where the secret belongs, e.g. `connection:<id>:uri`,
 * so a ciphertext copied into another record fails to decrypt instead of
 * silently handing one connection's password to another.
 */
export function encryptSecret(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SECRET_FORMAT, iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/**
 * Decrypts a value made by {@link encryptSecret} with the same `context`.
 * Throws if the value was tampered with, belongs elsewhere, or the key is wrong.
 */
export function decryptSecret(key: Buffer, value: string, context: string): string {
  const [format, iv, tag, ciphertext] = value.split(".");
  if (
    format !== SECRET_FORMAT ||
    iv === undefined ||
    tag === undefined ||
    ciphertext === undefined
  ) {
    throw new Error("Not an encrypted console secret.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** A random token: `bytes` bytes of CSPRNG output, base64url (256 bits by default). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** A random id for records (users, connections, …): 96 bits, hex. Not a secret. */
export function randomId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * SHA-256 of a token, hex. Session ids and the setup token are stored only as
 * this hash: they are 256-bit random values, so a plain hash (no salt, no
 * stretching) is enough to make a leaked state file useless for logging in.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** HMAC-SHA256 of `message`, base64url. Used for CSRF tokens. */
export function hmac(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("base64url");
}

/**
 * Compares two strings in constant time (for their common length), so an
 * attacker cannot learn a token byte by byte from response timings. Both
 * sides are hashed first, which makes the lengths equal without leaking them.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}
