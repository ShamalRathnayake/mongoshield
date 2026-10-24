/**
 * The `hash` mask operation: replace a value with a deterministic, keyed pseudonym
 * OF THE SAME TYPE, so the application reading the masked data keeps working.
 *
 *   string      → string of base32 characters, length rounded up to its length class
 *                 (16, 32, 64, or the original length beyond 64); "" stays ""
 *   Int32/Long/Double (integers) → same type, via a keyed bijection (`permuteInteger`):
 *                 distinct ids stay distinct, an Int32 stays in the Int32 range
 *   Double (fractional) → a Double with two decimals in [0, 10 000 000)
 *   any number with `range: [min, max]` → an integer in that range (collisions possible)
 *   ObjectId    → ObjectId with the SAME 4-byte timestamp and 8 keyed bytes, so sorting
 *                 by `_id` still sorts by creation time
 *   Binary      → same subtype and length; UUIDs (subtype 4) stay valid version-4 UUIDs
 *
 * Booleans, dates, decimals, regexes, embedded documents… are not hashed: `UNSUPPORTED`
 * is returned and the caller decides (warn and keep, null, or fail).
 */

import { Binary, Double, Int32, Long, ObjectId } from "mongodb";
import { KeyedStream, type MaskKeys, permuteInteger, valueSeed } from "./keyed.ts";
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

/** BSON binary subtype of UUIDs. */
const UUID_SUBTYPE = 4;

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
  switch (bsonTag(value)) {
    case "Int32":
      return hashNumber(Number(value), keys, options, (result) => new Int32(result));
    case "Double":
      return hashNumber(Number(value), keys, options, (result) => new Double(result));
    case "Long":
      return value instanceof Long ? hashLong(value, keys, options) : UNSUPPORTED;
    case "ObjectId":
      return value instanceof ObjectId ? hashObjectId(value, keys) : UNSUPPORTED;
    case "Binary":
      return value instanceof Binary ? hashBinary(value, keys) : UNSUPPORTED;
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
  if (Number.isInteger(value)) return wrap(Number(permuteInteger(BigInt(value), keys)));
  const stream = streamFor(value, keys, "hash");
  if (stream === undefined) return value;
  return wrap(stream.int(FRACTION_RANGE) / FRACTION_DIVISOR);
}

function hashLong(value: Long, keys: MaskKeys, options: HashOptions): Long {
  if (options.range !== undefined) return Long.fromNumber(inRange(value, keys, options.range));
  return Long.fromBigInt(permuteInteger(value.toBigInt(), keys));
}

/** A keyed integer in [min, max], seeded by the value (so equal numbers agree). */
function inRange(value: unknown, keys: MaskKeys, range: readonly [number, number]): number {
  const [min, max] = range;
  const stream = streamFor(value, keys, "hash-range");
  if (stream === undefined) return min;
  return min + stream.int(max - min + 1);
}

/** Keeps the creation timestamp; the 8 bytes that identify the document are keyed. */
function hashObjectId(value: ObjectId, keys: MaskKeys): ObjectId {
  const stream = streamFor(value, keys, "hash");
  if (stream === undefined) return value;
  const bytes = Buffer.alloc(OBJECT_ID_BYTES);
  Buffer.from(value.id).copy(bytes, 0, 0, OBJECT_ID_TIMESTAMP_BYTES);
  stream.bytes(OBJECT_ID_BYTES - OBJECT_ID_TIMESTAMP_BYTES).copy(bytes, OBJECT_ID_TIMESTAMP_BYTES);
  return new ObjectId(bytes);
}

function hashBinary(value: Binary, keys: MaskKeys): Binary {
  const stream = streamFor(value, keys, "hash");
  if (stream === undefined) return value;
  const bytes = stream.bytes(value.length());
  if (value.sub_type === UUID_SUBTYPE && bytes.length === 16) markAsUuidV4(bytes);
  return new Binary(bytes, value.sub_type);
}

/**
 * Sets the version (4, random) and variant (RFC 4122) bits, so the bytes are a valid
 * UUID that UUID parsers accept.
 */
export function markAsUuidV4(bytes: Buffer): void {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
}
