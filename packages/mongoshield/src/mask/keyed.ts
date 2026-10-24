/**
 * Keyed, deterministic randomness: the cryptographic core of masking.
 *
 * Every masked value is derived from HMAC-SHA256 under a secret key, never from
 * `Math.random()`. That gives the two properties masking is built on:
 *
 * - **Deterministic**: the same input and secret always give the same output, in every
 *   collection and on every run. This is what keeps joins working: `orders.userId`
 *   and `users._id` mask to the same value because they hold the same value.
 * - **Not reversible without the secret**: HMAC is a keyed one-way function, so an
 *   attacker who sees masked data cannot recompute the mapping (e.g. hash every known
 *   email address) unless they also have the secret.
 *
 * Three building blocks live here:
 *
 *   deriveMaskKeys(secret)      independent sub-keys, one per purpose (domain separation)
 *   KeyedStream                 an endless, deterministic byte stream from a seed,
 *                               with unbiased integers and list picks on top
 *   permuteInteger(value, keys) a keyed bijection on 64-bit integers (Feistel network),
 *                               so hashed integer ids never collide
 *   permuteLargeDouble, permuteBelow   the same for doubles above 2^53 and for domains
 *                               of any size (decimal digit counts)
 */

import { createHmac } from "node:crypto";
import { MongoShieldError } from "../errors.ts";

/**
 * Shortest secret accepted. Hashed values are only as strong as the secret: with a
 * short one, an attacker could brute-force it from a few known (email, masked email)
 * pairs. 16 characters of a random string is well beyond that.
 */
export const MIN_SECRET_LENGTH = 16;

/** Sub-keys derived from the user's secret, one per purpose. */
export interface MaskKeys {
  /** Seeds every per-value derivation (hash strings, fakes, ObjectIds…). */
  readonly value: Buffer;
  /** Round keys of the integer permutations, one per domain width. */
  readonly feistel32: Buffer;
  readonly feistel54: Buffer;
  readonly feistel64: Buffer;
}

/**
 * Derives the sub-keys. Labels are versioned (`v1`) so a future change of algorithm
 * can never silently produce different values under the same label.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when the secret is too short.
 */
export function deriveMaskKeys(secret: string): MaskKeys {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The masking secret must be at least ${MIN_SECRET_LENGTH} characters long.`,
      {
        hint: "Generate one with `openssl rand -base64 32` and pass it as `secret` in the mask file, or set MONGOSHIELD_MASK_SECRET.",
      },
    );
  }
  return {
    value: hmac(secret, "mongoshield/mask/v1/value"),
    feistel32: hmac(secret, "mongoshield/mask/v1/feistel32"),
    feistel54: hmac(secret, "mongoshield/mask/v1/feistel54"),
    feistel64: hmac(secret, "mongoshield/mask/v1/feistel64"),
  };
}

/** HMAC-SHA256 of `data` under `key`. */
export function hmac(key: Buffer | string, data: Buffer | string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * The seed of one input value: HMAC(value key, label ‖ canonical bytes). The label
 * keeps different uses of the same value independent (the fake email of "x" tells
 * nothing about the hash of "x").
 */
export function valueSeed(keys: MaskKeys, label: string, canonical: Buffer): Buffer {
  return hmac(keys.value, Buffer.concat([Buffer.from(`${label}\0`, "utf8"), canonical]));
}

/** Bytes per `KeyedStream.int` draw: 48 bits fit exactly in a JavaScript number. */
const INT_DRAW_BYTES = 6;
const INT_DRAW_RANGE = 2 ** 48;

/**
 * A deterministic stream of pseudo-random bytes expanded from a seed:
 * block i = HMAC(seed, i). Like HKDF-Expand, simpler, and plenty for masking.
 */
export class KeyedStream {
  readonly #seed: Buffer;
  #counter = 0;
  #pending: Buffer = Buffer.alloc(0);

  constructor(seed: Buffer) {
    this.#seed = seed;
  }

  /** The next `count` bytes. */
  bytes(count: number): Buffer {
    while (this.#pending.length < count) {
      const block = hmac(this.#seed, String(this.#counter));
      this.#counter += 1;
      this.#pending = Buffer.concat([this.#pending, block]);
    }
    const taken = this.#pending.subarray(0, count);
    this.#pending = this.#pending.subarray(count);
    return Buffer.from(taken);
  }

  /**
   * A uniform integer in [0, bound). Uses rejection sampling: draws that fall in
   * the last, incomplete multiple of `bound` are discarded, so small values are
   * not favoured (plain `draw % bound` would be biased).
   */
  int(bound: number): number {
    if (!Number.isSafeInteger(bound) || bound < 1 || bound > INT_DRAW_RANGE) {
      throw new MongoShieldError("MS_INTERNAL", `Invalid bound for a keyed draw: ${bound}.`);
    }
    const limit = INT_DRAW_RANGE - (INT_DRAW_RANGE % bound);
    for (;;) {
      const draw = this.bytes(INT_DRAW_BYTES).readUIntBE(0, INT_DRAW_BYTES);
      if (draw < limit) return draw % bound;
    }
  }

  /** One item of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new MongoShieldError("MS_INTERNAL", "Picked from an empty list.");
    return item;
  }
}

// ---------------------------------------------------------------------------
// Integer permutation
// ---------------------------------------------------------------------------

/**
 * Feistel rounds. A Feistel network is a permutation for ANY round function, so
 * correctness does not depend on this number; 8 rounds make the mapping look
 * random (4 already suffice for a pseudo-random permutation, per Luby–Rackoff).
 */
const FEISTEL_ROUNDS = 8;

const TWO_31 = 2n ** 31n;
const TWO_53 = 2n ** 53n;
const TWO_63 = 2n ** 63n;

/**
 * A keyed bijection on 64-bit signed integers that also maps each of these
 * three tiers onto itself:
 *
 *   tier 32   [-2^31, 2^31)                  fits an Int32
 *   tier 54   [-2^53, 2^53) minus tier 32    fits a Long, and a Double exactly
 *   tier 64   the rest of the int64 range    fits a Long only
 *
 * Because it is a bijection, two different ids can never hash to the same id (a
 * plain hash truncated to 32 bits would collide after ~77 000 values, and a
 * collision on `_id` would fail the copy). Because tiers map onto themselves, an
 * Int32 stays an Int32, and the result depends only on the numeric VALUE: Int32(5),
 * Long(5) and Double(5) all map to the same number, as MongoDB considers them equal.
 *
 * Tiers 54 and 64 use "cycle walking": apply the wider permutation again until the
 * result leaves the inner tiers. That is a permutation of the tier, and needs a
 * second step only for a tiny fraction of values (2^-22 and 2^-10 of them).
 *
 * Tier 64 is split once more, because doubles are sparse there (only every 2nd…1024th
 * integer is one): the integers a double holds exactly map among themselves
 * (`permuteLargeDouble`), the others among themselves. So `Double(2^60)` and
 * `Long(2^60)` still hash to the same number, and a hashed Double is always a double
 * again, never rounded onto another input's output.
 *
 * @throws MongoShieldError `MS_INTERNAL` for a value outside the int64 range.
 */
export function permuteInteger(value: bigint, keys: MaskKeys): bigint {
  if (value < -TWO_63 || value >= TWO_63) {
    throw new MongoShieldError("MS_INTERNAL", `${value} is outside the 64-bit integer range.`);
  }
  if (value >= -TWO_31 && value < TWO_31) {
    return feistel(value + TWO_31, 32, keys.feistel32) - TWO_31;
  }
  if (value >= -TWO_53 && value < TWO_53) {
    let walked = value + TWO_53;
    do {
      walked = feistel(walked, 54, keys.feistel54);
    } while (walked - TWO_53 >= -TWO_31 && walked - TWO_53 < TWO_31);
    return walked - TWO_53;
  }
  if (isExactDouble(value)) return BigInt(permuteLargeDouble(Number(value), keys));
  let walked = value + TWO_63;
  do {
    walked = feistel(walked, 64, keys.feistel64);
  } while (inInnerTiers(walked - TWO_63) || isExactDouble(walked - TWO_63));
  return walked - TWO_63;
}

/** True for tiers 32 and 54: [-2^53, 2^53). */
function inInnerTiers(value: bigint): boolean {
  return value >= -TWO_53 && value < TWO_53;
}

/** True when a double holds exactly this integer. */
function isExactDouble(value: bigint): boolean {
  return BigInt(Number(value)) === value;
}

/**
 * A keyed bijection on [0, `count`): a Feistel network on the smallest even bit width
 * that holds every value, cycle-walking until the result is below `count`. The width
 * is at most 2 bits more than needed, so fewer than 4 steps are needed on average.
 * Used for domains whose size is not a power of two (digit counts of decimals, the
 * doubles of a range). `count` may be up to 2^128 (the round function takes 64 bits).
 */
export function permuteBelow(value: bigint, count: bigint, key: Buffer): bigint {
  if (count <= 1n) return value;
  const needed = (count - 1n).toString(2).length;
  // A balanced Feistel network splits the value into two equal halves of at least 1 bit.
  const width = Math.max(2, needed % 2 === 0 ? needed : needed + 1);
  let walked = value;
  do {
    walked = feistel(walked, width, key);
  } while (walked >= count);
  return walked;
}

/** A sub-key for one permutation domain, independent of every other one. */
export function domainKey(keys: MaskKeys, domain: string): Buffer {
  return hmac(keys.feistel64, `mongoshield/mask/v1/domain/${domain}`);
}

// ---------------------------------------------------------------------------
// Large doubles
// ---------------------------------------------------------------------------

/** Bit patterns of 2^53, 2^63 and the largest finite double (positive, so ordered like the values). */
const BITS_2_53 = doubleBits(2 ** 53);
const BITS_2_63 = doubleBits(2 ** 63);
const BITS_MAX = doubleBits(Number.MAX_VALUE);

/**
 * A keyed bijection on the doubles of magnitude 2^53 and above (all of them whole
 * numbers), keeping the sign and keeping each value on its side of the int64 limit:
 *
 *   domain                        why it is separate
 *   [2^53, 2^63) and (-2^63, -2^53]   int64 values a double holds exactly: shared with
 *     plus -2^63                  `permuteInteger`, so `Long(x)` and `Double(x)` agree
 *   beyond the int64 range        no integer type can hold them
 *
 * Positive doubles are ordered like their IEEE 754 bit patterns, so each domain is a
 * contiguous range of patterns and permuting the pattern's offset in it permutes the
 * values. Distinct inputs therefore never share an output, which a hash truncated
 * to a double (or an integer permutation rounded to one) cannot promise.
 *
 * @param value a double with |value| >= 2^53, finite.
 */
export function permuteLargeDouble(value: number, keys: MaskKeys): number {
  const negative = value < 0;
  const magnitude = doubleBits(Math.abs(value));
  // In int64 terms the negative side reaches one further (-2^63 is an int64, 2^63 is not),
  // so its ranges start one pattern later: (2^53, 2^63] instead of [2^53, 2^63).
  const offset = negative ? 1n : 0n;
  const int64Low = BITS_2_53 + offset;
  const int64High = BITS_2_63 + offset;
  const [low, high, domain] =
    magnitude < int64High
      ? [int64Low, int64High, "double-int64"]
      : [int64High, BITS_MAX + 1n, "double-huge"];
  const key = domainKey(keys, `${domain}-${negative ? "negative" : "positive"}`);
  const permuted = fromDoubleBits(low + permuteBelow(magnitude - low, high - low, key));
  return negative ? -permuted : permuted;
}

/** The IEEE 754 bit pattern of a double. */
function doubleBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}

function fromDoubleBits(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

/** A balanced Feistel network over unsigned `bits`-bit integers (`bits` even). */
function feistel(value: bigint, bits: number, key: Buffer): bigint {
  const half = BigInt(bits / 2);
  const mask = (1n << half) - 1n;
  let left = (value >> half) & mask;
  let right = value & mask;
  for (let round = 0; round < FEISTEL_ROUNDS; round += 1) {
    const mixed = left ^ roundFunction(key, round, right, mask);
    left = right;
    right = mixed;
  }
  return (left << half) | right;
}

/** F(round, right) = the first 64 bits of HMAC(key, round ‖ right), cut to the half width. */
function roundFunction(key: Buffer, round: number, right: bigint, mask: bigint): bigint {
  const input = Buffer.alloc(9);
  input.writeUInt8(round, 0);
  input.writeBigUInt64BE(right, 1);
  return hmac(key, input).readBigUInt64BE(0) & mask;
}
