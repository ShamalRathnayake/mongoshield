/**
 * The `hash` mask operation: replace a value with a deterministic, keyed pseudonym
 * OF THE SAME TYPE, so the application reading the masked data keeps working.
 *
 *   string      → string of base32 characters, length rounded up to its length class
 *                 (16, 32, 64, or the original length beyond 64); "" stays ""
 *   symbol      → a symbol, hashed like the string it holds
 *   Int32/Long/Double (integers) → same type, via a keyed bijection (`permuteInteger`):
 *                 distinct ids stay distinct, an Int32 stays in the Int32 range, and a
 *                 Double above 2^53 becomes another double above 2^53 (`permuteLargeDouble`)
 *   Double (fractional) → a Double with two decimals in [0, 10 000 000)
 *   Decimal128  → a Decimal128: whole numbers in the int64 range like the integer
 *                 types (so `Decimal128("5")` and `Int32(5)` agree), every other value
 *                 keeps its sign, its number of significant digits and its decimal
 *                 exponent (19.99 → 73.41), through a bijection, so distinct values
 *                 never collide
 *   any number with `range: [min, max]` → an integer in that range (collisions possible)
 *   ObjectId    → ObjectId with the SAME 4-byte timestamp and 8 keyed bytes, so sorting
 *                 by `_id` still sorts by creation time
 *   Binary      → same subtype and length; UUIDs (subtype 4) stay valid version-4
 *                 UUIDs, vectors (subtype 9) stay valid vectors of the same element type
 *
 * Booleans, dates, regexes, timestamps, embedded documents, encrypted binaries
 * (subtype 6: already unreadable, and random bytes would not decrypt)… are not hashed:
 * `UNSUPPORTED` is returned and the caller decides (warn and keep, null, or fail).
 * NaN and ±Infinity are kept as they are: they hide nothing.
 */

import { Binary, BSONSymbol, Decimal128, Double, Int32, Long, ObjectId } from "mongodb";
import {
  domainKey,
  KeyedStream,
  type MaskKeys,
  permuteBelow,
  permuteInteger,
  permuteLargeDouble,
  valueSeed,
} from "./keyed.ts";
import { decimalText, type ExactDecimal, exactDecimalOf, integerOf } from "./numbers.ts";
import { bsonTag, canonicalBytes } from "./values.ts";

/** Returned when an operation cannot handle a value's type. */
export const UNSUPPORTED: unique symbol = Symbol("mongoshield.mask.unsupported");

/** Options of the `hash` operation. */
export interface HashOptions {
  /**
   * Inclusive integer range for numbers, e.g. `[18, 90]` for ages. Values in a range
   * can collide (two inputs, one output), so do not use it on ids.
   */
  readonly range?: readonly [number, number];
}

/** Lowercase RFC 4648 base32 alphabet: letters and digits that survive any system. */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Length classes for hashed strings (see the header comment). */
const STRING_LENGTH_CLASSES = [16, 32, 64] as const;

/** Upper bound (exclusive) of hashed fractional doubles, and their decimals. */
const FRACTION_RANGE = 1_000_000_000;
const FRACTION_DIVISOR = 100;

/** Bytes of an ObjectId, and of its leading timestamp. */
const OBJECT_ID_BYTES = 12;
const OBJECT_ID_TIMESTAMP_BYTES = 4;

/** BSON binary subtypes with a structure of their own. */
const UUID_SUBTYPE = 4;
const ENCRYPTED_SUBTYPE = 6;
const VECTOR_SUBTYPE = 9;

/** Vector element types (first byte of a subtype 9 binary) and the header length. */
const VECTOR_FLOAT32 = 0x27;
const VECTOR_PACKED_BIT = 0x10;
const VECTOR_HEADER_BYTES = 2;

/** Hashed float32 vector elements: 24-bit fractions in [-1, 1), exact in a float32. */
const FLOAT_STEPS = 2 ** 24;

/** The int64 range, which decides whether a decimal hashes like an integer. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Doubles of this magnitude are beyond every integer type (and all whole numbers). */
const TWO_63 = 2 ** 63;

/** The Int32 range. */
const INT32_MIN = -(2 ** 31);
const INT32_LIMIT = 2 ** 31;

/**
 * Hashes one value (see the header comment for every type).
 *
 * @returns the hashed value, or `UNSUPPORTED`.
 */
export function hashValue(
  value: unknown,
  keys: MaskKeys,
  options: HashOptions = {},
): unknown | typeof UNSUPPORTED {
  if (typeof value === "string") return hashString(value, keys);
  if (typeof value === "number") return hashNumber(value, keys, options, (result) => result);
  if (typeof value === "bigint") return hashBigInt(value, keys, options);
  switch (bsonTag(value)) {
    case "Int32":
      return hashNumber(Number(value), keys, options, asInt32);
    case "Double":
      return hashNumber(Number(value), keys, options, (result) => new Double(result));
    case "Long":
      return value instanceof Long ? hashLong(value, keys, options) : UNSUPPORTED;
    case "Decimal128":
      return value instanceof Decimal128 ? hashDecimal(value, keys, options) : UNSUPPORTED;
    case "ObjectId":
      return value instanceof ObjectId ? hashObjectId(value, keys) : UNSUPPORTED;
    case "Binary":
      return value instanceof Binary ? hashBinary(value, keys) : UNSUPPORTED;
    case "BSONSymbol":
      return value instanceof BSONSymbol
        ? new BSONSymbol(hashString(value.valueOf(), keys))
        : UNSUPPORTED;
    default:
      return UNSUPPORTED;
  }
}

/** A keyed byte stream for `value` under `label`; `undefined` if the value has no identity. */
export function streamFor(value: unknown, keys: MaskKeys, label: string): KeyedStream | undefined {
  const canonical = canonicalBytes(value);
  return canonical === undefined ? undefined : new KeyedStream(valueSeed(keys, label, canonical));
}

function hashString(value: string, keys: MaskKeys): string {
  const stream = streamFor(value, keys, "hash");
  if (value.length === 0 || stream === undefined) return value;
  return base32(stream, hashedStringLength(value.length));
}

/** Rounds a length up to its class, so lengths leak only coarsely. */
export function hashedStringLength(length: number): number {
  for (const lengthClass of STRING_LENGTH_CLASSES) {
    if (length <= lengthClass) return lengthClass;
  }
  return length;
}

/** `length` base32 characters (5 bits each) from the stream. */
export function base32(stream: KeyedStream, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) text += BASE32[stream.int(BASE32.length)];
  return text;
}

/**
 * An Int32 when the result fits. Only a `range` reaching beyond the Int32 range can
 * produce one that does not; it becomes a Long rather than silently wrapping around.
 */
function asInt32(result: number): Int32 | Long {
  return result >= INT32_MIN && result < INT32_LIMIT ? new Int32(result) : Long.fromNumber(result);
}

/**
 * Hashes a JavaScript number (from an Int32, a Double or a plain number) and hands
 * the result to `wrap`, which restores the original BSON type.
 */
function hashNumber<T>(
  value: number,
  keys: MaskKeys,
  options: HashOptions,
  wrap: (result: number) => T,
): T | number {
  // NaN and ±Infinity carry no information worth hiding, and have no integer form.
  if (!Number.isFinite(value)) return value;
  if (options.range !== undefined) return wrap(inRange(value, keys, options.range));
  if (Number.isInteger(value)) return wrap(permuteWholeDouble(value, keys));
  const stream = streamFor(value, keys, "hash");
  if (stream === undefined) return value;
  return wrap(stream.int(FRACTION_RANGE) / FRACTION_DIVISOR);
}

/**
 * Whole doubles in the int64 range go through the integer permutation (so they agree
 * with Int32 and Long); larger ones through the double permutation. Either way the
 * result is a double that holds the permuted value exactly.
 */
function permuteWholeDouble(value: number, keys: MaskKeys): number {
  // -2^63 is the one int64 whose magnitude is 2^63.
  if (Math.abs(value) >= TWO_63 && value !== -TWO_63) return permuteLargeDouble(value, keys);
  return Number(permuteInteger(BigInt(value), keys));
}

function hashLong(value: Long, keys: MaskKeys, options: HashOptions): Long {
  if (options.range !== undefined) return Long.fromNumber(inRange(value, keys, options.range));
  return Long.fromBigInt(permuteInteger(value.toBigInt(), keys));
}

/** Plain bigints only reach here from custom functions (`context.hash(10n)`). */
function hashBigInt(
  value: bigint,
  keys: MaskKeys,
  options: HashOptions,
): bigint | typeof UNSUPPORTED {
  if (options.range !== undefined) return BigInt(inRange(value, keys, options.range));
  return inInt64(value) ? permuteInteger(value, keys) : UNSUPPORTED;
}

/** A keyed integer in [min, max], seeded by the value (so equal numbers agree). */
function inRange(value: unknown, keys: MaskKeys, range: readonly [number, number]): number {
  const [min, max] = range;
  const stream = streamFor(value, keys, "hash-range");
  if (stream === undefined) return min;
  return min + stream.int(max - min + 1);
}

// ---------------------------------------------------------------------------
// Decimal128
// ---------------------------------------------------------------------------

/** See the header comment. Zero, NaN and ±Infinity are kept: they hide nothing. */
function hashDecimal(value: Decimal128, keys: MaskKeys, options: HashOptions): Decimal128 {
  const exact = exactDecimalOf(value);
  if (exact === undefined) return value;
  if (options.range !== undefined) {
    return Decimal128.fromString(String(inRange(value, keys, options.range)));
  }
  if (exact.coefficient === 0n) return value;
  const integer = integerOf(exact);
  if (integer !== undefined && inInt64(integer)) {
    return Decimal128.fromString(permuteInteger(integer, keys).toString());
  }
  return Decimal128.fromString(decimalText(permuteCoefficient(exact, keys)));
}

/**
 * Permutes the coefficient among those with the same number of digits that are not
 * multiples of 10, keeping the sign and the exponent. That domain is exactly the set
 * of normalized values of this shape, so the result is normalized too and two
 * different inputs can never become equal numbers (12.3 and 12.30 are one input).
 * Whole numbers beyond the int64 range stay beyond it: inside it they could collide
 * with outputs of the integer permutation.
 */
function permuteCoefficient(exact: ExactDecimal, keys: MaskKeys): ExactDecimal {
  const digits = exact.coefficient.toString().length;
  const smallest = 10n ** BigInt(digits - 1);
  const count = 10n ** BigInt(digits);
  const key = domainKey(keys, `decimal-${digits}`);
  const belongs = (coefficient: bigint): boolean => {
    if (coefficient < smallest || coefficient % 10n === 0n) return false;
    const integer = integerOf({ ...exact, coefficient });
    return integer === undefined || !inInt64(integer);
  };
  // Cycle walking (see `permuteBelow`): the input belongs, so this ends on another member.
  let coefficient = exact.coefficient;
  do {
    coefficient = permuteBelow(coefficient, count, key);
  } while (!belongs(coefficient));
  return { ...exact, coefficient };
}

function inInt64(value: bigint): boolean {
  return value >= INT64_MIN && value <= INT64_MAX;
}

// ---------------------------------------------------------------------------
// ObjectId and Binary
// ---------------------------------------------------------------------------

/** Keeps the creation timestamp; the 8 bytes that identify the document are keyed. */
function hashObjectId(value: ObjectId, keys: MaskKeys): ObjectId {
  const stream = streamFor(value, keys, "hash");
  if (stream === undefined) return value;
  const bytes = Buffer.alloc(OBJECT_ID_BYTES);
  Buffer.from(value.id).copy(bytes, 0, 0, OBJECT_ID_TIMESTAMP_BYTES);
  stream.bytes(OBJECT_ID_BYTES - OBJECT_ID_TIMESTAMP_BYTES).copy(bytes, OBJECT_ID_TIMESTAMP_BYTES);
  return new ObjectId(bytes);
}

function hashBinary(value: Binary, keys: MaskKeys): Binary | typeof UNSUPPORTED {
  if (value.sub_type === ENCRYPTED_SUBTYPE) return UNSUPPORTED;
  const stream = streamFor(value, keys, "hash");
  if (stream === undefined) return value;
  if (value.sub_type === VECTOR_SUBTYPE) return hashVector(value, stream);
  const bytes = stream.bytes(value.length());
  if (value.sub_type === UUID_SUBTYPE && bytes.length === 16) markAsUuidV4(bytes);
  return new Binary(bytes, value.sub_type);
}

/**
 * A vector (subtype 9: element type, padding, elements) of the same element type and
 * length, with keyed elements. Random bytes would not do: the header must stay valid
 * for drivers and vector search to read it, float32 elements must be numbers (not
 * NaN), and the padding bits of a packed bit vector must be zero.
 */
function hashVector(value: Binary, stream: KeyedStream): Binary {
  const original = Buffer.from(value.buffer.subarray(0, value.length()));
  const bytes = Buffer.alloc(original.length);
  original.copy(bytes, 0, 0, VECTOR_HEADER_BYTES);
  const elementType = original[0];
  if (elementType === VECTOR_FLOAT32) {
    // Elements in [-1, 1), like the normalized embeddings vectors usually hold.
    for (let offset = VECTOR_HEADER_BYTES; offset + 4 <= bytes.length; offset += 4) {
      bytes.writeFloatLE((stream.int(FLOAT_STEPS) * 2) / FLOAT_STEPS - 1, offset);
    }
    return new Binary(bytes, VECTOR_SUBTYPE);
  }
  if (bytes.length > VECTOR_HEADER_BYTES) {
    stream.bytes(bytes.length - VECTOR_HEADER_BYTES).copy(bytes, VECTOR_HEADER_BYTES);
  }
  const padding = original[1] ?? 0;
  const last = bytes.length - 1;
  if (elementType === VECTOR_PACKED_BIT && padding > 0 && last >= VECTOR_HEADER_BYTES) {
    // The low `padding` bits of the last byte are not elements and must stay zero.
    bytes[last] = (bytes[last] ?? 0) & ((0xff << padding) & 0xff);
  }
  return new Binary(bytes, VECTOR_SUBTYPE);
}

/**
 * Sets the version (4, random) and variant (RFC 4122) bits, so the bytes are a valid
 * UUID that UUID parsers accept.
 */
export function markAsUuidV4(bytes: Buffer): void {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
}
