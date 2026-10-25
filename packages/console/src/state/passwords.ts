/**
 * Password hashing with scrypt (node:crypto), as the console's security design asks:
 * N = 2^17, r = 8, p = 1 (OWASP's recommended minimum for scrypt).
 *
 * Stored format: `scrypt$<log2 N>$<r>$<p>$<salt base64url>$<hash base64url>`.
 * The parameters are stored with each hash, so raising the cost later keeps old
 * hashes verifiable (and tests can use a cheaper cost without a different code path).
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** Production cost: log2(N) = 17, i.e. N = 131072. About 128 MiB of memory per hash. */
export const DEFAULT_PASSWORD_COST = 17;

/** Block size and parallelism: the standard values for scrypt. */
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** Shortest and longest accepted password. Long passphrases are welcome; megabytes are not. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

/** Lowest cost a stored hash may claim. Guards against a tampered file downgrading hashes. */
const MIN_STORED_COST = 14;
/** Highest cost a stored hash may claim, so a tampered file cannot make login exhaust memory. */
const MAX_STORED_COST = 20;

/**
 * scrypt needs 128 * N * r bytes; Node's default `maxmem` (32 MiB) is too small
 * for N = 2^17, so allow twice what the parameters need.
 */
function maxMemoryFor(cost: number): number {
  return 2 * 128 * 2 ** cost * BLOCK_SIZE;
}

/** Runs scrypt asynchronously (on the libuv thread pool, so the server stays responsive). */
function derive(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFC"),
      salt,
      HASH_BYTES,
      { N: 2 ** cost, r: BLOCK_SIZE, p: PARALLELISM, maxmem: maxMemoryFor(cost) },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/**
 * Hashes a password for storage.
 * @param cost log2(N); defaults to {@link DEFAULT_PASSWORD_COST}. Tests pass a lower value.
 */
export async function hashPassword(
  password: string,
  cost = DEFAULT_PASSWORD_COST,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, cost);
  return [
    "scrypt",
    String(cost),
    String(BLOCK_SIZE),
    String(PARALLELISM),
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/**
 * Checks a password against a stored hash in constant time. Returns false (never
 * throws) for malformed hashes, including the empty hash of proxy-only users.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < MIN_STORED_COST || cost > MAX_STORED_COST) return false;
  if (parts[2] !== String(BLOCK_SIZE) || parts[3] !== String(PARALLELISM)) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (expected.length !== HASH_BYTES) return false;
  const actual = await derive(password, salt, cost);
  return timingSafeEqual(actual, expected);
}

/**
 * A hash that never matches, computed once per cost. Login checks unknown
 * usernames against it, so "no such user" takes as long as "wrong password"
 * and response times do not reveal which usernames exist.
 */
const dummyHashes = new Map<number, Promise<string>>();

/** Spends the same time as {@link verifyPassword} on a real hash, and returns false. */
export async function verifyAgainstDummy(password: string, cost: number): Promise<false> {
  let dummy = dummyHashes.get(cost);
  if (dummy === undefined) {
    dummy = hashPassword(randomBytes(16).toString("hex"), cost);
    dummyHashes.set(cost, dummy);
  }
  await verifyPassword(password, await dummy);
  return false;
}
