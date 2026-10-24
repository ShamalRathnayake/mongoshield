/**
 * Decoder for BSONColumn, the compressed column format of time-series buckets
 * (BSON binary subtype 7). Compressed buckets (`control.version` 2 and 3, written by
 * MongoDB 5.2+ and always by 8.0+) store each data field as one such column: the
 * field's values for every measurement of the bucket, in order, with gaps where a
 * measurement does not have the field. `timeseries-buckets.ts` turns columns back
 * into measurements.
 *
 * The format has no written specification. This follows the server's reference
 * decoder (github.com/mongodb/mongo, release 8.0: `src/mongo/bson/util/bsoncolumn.cpp`,
 * `bsoncolumn_util.h`, `simple8b.h`, `simple8b_helpers.h`, `simple8b_type_util.cpp`),
 * which also reads every column written by 5.x to 7.x servers. A column is a sequence
 * of *controls*, each starting with a control byte:
 *
 *   0x00                       end of the column (must be its last byte)
 *   a BSON type byte           a literal: a whole BSON element with an empty field
 *     (0x01-0x1F, 0x7F, 0xFF)  name (`type · 0x00 · value`), the next value as is
 *   0x80-0xDF                  1 to 16 Simple-8b blocks of deltas: low nibble + 1 is
 *                              the number of 8-byte blocks; the high nibble picks the
 *                              scale of doubles (see SCALE_INDEX_BY_NIBBLE)
 *   0xF0, 0xF1, 0xF2           interleaved mode for embedded documents (see below)
 *
 * Deltas. Every value after a literal is stored as a zigzag-encoded difference from the
 * previous value of the same type, packed with Simple-8b (`decodeSimple8b`); a missing
 * value is a "skip". The difference is taken of an integer encoding of the value:
 *
 *   int32, int64, bool        the number itself                      (64-bit)
 *   date, timestamp, ObjectId delta of delta: the change of the change (64-bit)
 *   double                    value × 10^k rounded, k from the control byte, or the raw
 *                             IEEE-754 bits (64-bit)
 *   string, code, binary      up to 16 bytes as a little-endian integer, strings
 *                             reversed (128-bit); longer values only repeat
 *   decimal128                its 16 bytes (128-bit)
 *   anything else             only a delta of 0 ("same as before") is possible
 *
 * Interleaved mode compresses a column of embedded documents field by field: the
 * control byte is followed by a *reference document*; every scalar field of it (in
 * order, recursing into sub-documents, and into arrays for 0xF1/0xF2) gets its own
 * delta state, and the controls that follow belong to those states in turn, one
 * document after the other, until a 0x00 where the first state needs a new control.
 *
 * Anything this decoder does not understand fails the conversion with
 * MS_FORMAT_UNSUPPORTED; it never guesses.
 */

import { MongoShieldError } from "../errors.ts";
import { BsonType, buildDocument, readElements, valueSize } from "./raw-bson.ts";

/** One value of a column: a BSON element without its field name. */
export interface ColumnValue {
  readonly type: number;
  /** The value's bytes, exactly as a BSON element holds them. */
  readonly value: Buffer;
}

/** A decoded column: one entry per position, `undefined` where the value is missing. */
export type DecodedColumn = (ColumnValue | undefined)[];

/**
 * Decodes a BSONColumn (the payload of a binary subtype 7 value).
 *
 * @param where names the column in error messages, e.g. `app.metrics bucket 65a…, field "temp"`
 * @throws MS_FORMAT_UNSUPPORTED for a column that is not valid BSONColumn
 */
export function decodeBsonColumn(column: Buffer, where: string): DecodedColumn {
  return new ColumnDecoder(column, where).decode();
}

// ---------------------------------------------------------------------------
// Simple-8b (simple8b.h, simple8b_helpers.h)
// ---------------------------------------------------------------------------

/**
 * Simple-8b packs several unsigned integers into one little-endian 64-bit word. The
 * low 4 bits are the selector, which says how many values of how many bits follow.
 * Selectors 7 and 8 have extended forms (the next 4 bits pick one) whose slots carry a
 * count of trailing zero bits (×1 or ×4) after the value bits, for values such as
 * 10^6 that have long runs of zeros. Selector 15 is run-length encoding: the previous
 * value repeated 120 × (n + 1) times. A slot with all its bits set is a skip.
 */
const RLE_SELECTOR = 15;
const RLE_MULTIPLIER = 120;

/** Extension types: base selectors, selector 7 extended, selector 8 small and large. */
const BASE = 0;

/** Selector extension value → extension type, for base selector 7 and 8; -1 is invalid. */
const EXTENSION_TYPE = [
  [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1],
  [0, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, -1, -1],
] as const;

/** Value bits per slot, by extension type and selector (kBitsPerIntForSelector). */
const VALUE_BITS = [
  [64, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 30, 60, 64],
  [64, 2, 3, 4, 5, 7, 10, 14, 24, 52, 64, 64, 64, 64, 64, 64],
  [64, 4, 5, 7, 10, 14, 24, 52, 0, 0, 64, 64, 64, 64, 64, 64],
  [64, 0, 0, 0, 0, 0, 0, 0, 4, 6, 9, 13, 23, 51, 64, 64],
] as const;

/** Bits of the trailing-zero count per slot, by extension type (kTrailingZeroBitSize). */
const TRAILING_ZERO_BITS: readonly number[] = [0, 4, 4, 5];

/** Zeros per unit of the trailing-zero count, by extension type (kTrailingZerosMultiplier). */
const TRAILING_ZERO_MULTIPLIER: readonly number[] = [0, 1, 4, 4];

/** A decoded Simple-8b value: an unsigned integer, or `undefined` for a skip. */
type Simple8bValue = bigint | undefined;

/**
 * Decodes `blocks` (a whole number of 8-byte words) into values.
 *
 * @param previous the value an RLE block at the very start repeats
 * @param width 64 or 128: values wider than this wrap around, as in the server's C++
 */
export function decodeSimple8b(
  blocks: Buffer,
  previous: Simple8bValue,
  width: 64 | 128,
  where: string,
): Simple8bValue[] {
  const values: Simple8bValue[] = [];
  let last = previous;
  for (let offset = 0; offset + 8 <= blocks.length; offset += 8) {
    const word = blocks.readBigUInt64LE(offset);
    let selector = Number(word & 0xfn);
    const extension = Number((word >> 4n) & 0xfn);
    if (selector === 0) throw unsupported(where, "a Simple-8b block has the invalid selector 0");

    if (selector === RLE_SELECTOR) {
      const count = (extension + 1) * RLE_MULTIPLIER;
      for (let index = 0; index < count; index += 1) values.push(last);
      continue;
    }

    let extensionType = BASE;
    // Selectors 7 and 8 always reserve the 4 bits after the selector for the extension.
    let shift = 4;
    if (selector === 7 || selector === 8) {
      extensionType = EXTENSION_TYPE[selector - 7]?.[extension] ?? -1;
      if (extensionType < 0) {
        throw unsupported(where, `a Simple-8b block has the invalid extension ${extension}`);
      }
      if (extensionType !== BASE) selector = extension;
      shift = 8;
    }

    const countBits = TRAILING_ZERO_BITS[extensionType] ?? 0;
    const multiplier = BigInt(TRAILING_ZERO_MULTIPLIER[extensionType] ?? 0);
    // Invalid combinations have 64 bits, so the loop below reads no slot at all.
    const valueBits = VALUE_BITS[extensionType]?.[selector] ?? 64;
    const slotBits = valueBits + countBits;
    const mask = (1n << BigInt(slotBits)) - 1n;
    const countMask = (1n << BigInt(countBits)) - 1n;
    const widthMask = (1n << BigInt(width)) - 1n;

    for (; shift + slotBits <= 64; shift += slotBits) {
      const slot = (word >> BigInt(shift)) & mask;
      if (slot === mask) {
        last = undefined; // all bits set: a skip
      } else {
        let zeros = (slot & countMask) * multiplier;
        // The C++ shift of a 64-bit value by 64 or more is taken modulo 64.
        if (width === 64) zeros %= 64n;
        last = ((slot >> BigInt(countBits)) << zeros) & widthMask;
      }
      values.push(last);
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Value encodings (simple8b_type_util.cpp)
// ---------------------------------------------------------------------------

/** Powers of ten doubles are scaled by before delta encoding (kScaleMultiplier). */
const SCALE_MULTIPLIERS = [1, 10, 100, 10_000, 100_000_000] as const;

/** Scale index meaning "the double's raw bits as an integer" (kMemoryAsInteger). */
const MEMORY_AS_INTEGER = 5;

/** Control byte high nibble → scale index (scaleIndexForControlByte); -1 is not a delta block. */
const SCALE_INDEX_BY_NIBBLE = [-1, -1, -1, -1, -1, -1, -1, -1, 5, 0, 1, 2, 3, 4, -1, -1] as const;

/** The largest integer a double holds exactly, 2^53, which bounds scaled doubles. */
const MAX_SAFE_SCALED = 2 ** 53;

/** Types whose deltas are 128-bit (uses128bit). */
const WIDE_TYPES: ReadonlySet<number> = new Set([
  BsonType.decimal128,
  BsonType.binary,
  BsonType.string,
  BsonType.code,
]);

/** Types stored as deltas of deltas (usesDeltaOfDelta). */
const DELTA_OF_DELTA_TYPES: ReadonlySet<number> = new Set([
  BsonType.objectId,
  BsonType.date,
  BsonType.timestamp,
]);

/** A zigzag-encoded unsigned integer back to a signed one, at `width` bits. */
function zigzagDecode(value: bigint, width: 64 | 128): bigint {
  const negate = (value & 1n) === 1n ? -1n : 0n;
  return BigInt.asIntN(width, (value >> 1n) ^ negate);
}

/** C++ `llround`: to the nearest integer, halves away from zero. */
function roundHalfAwayFromZero(value: number): number {
  const rounded = Math.round(Math.abs(value));
  return value < 0 ? -rounded : rounded;
}

/**
 * A double as the integer its deltas are taken from (`encodeDouble`), or undefined
 * when it cannot be represented at this scale (the encoder never does that).
 */
function encodeDouble(value: number, scaleIndex: number): bigint | undefined {
  if (scaleIndex === MEMORY_AS_INTEGER) return doubleBits(value);
  const multiplier = SCALE_MULTIPLIERS[scaleIndex];
  if (multiplier === undefined) return undefined;
  const scaled = value * multiplier;
  if (!(scaled >= -MAX_SAFE_SCALED && scaled <= MAX_SAFE_SCALED)) return undefined;
  const integer = roundHalfAwayFromZero(scaled);
  // Exact round trip only (Object.is tells -0 from 0, which differ in their bits).
  if (!Object.is(integer / multiplier, value)) return undefined;
  return BigInt(integer);
}

function doubleBits(value: number): bigint {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value, 0);
  return bytes.readBigInt64LE(0);
}

/** The low `count` bytes of a 128-bit value, little-endian. */
function littleEndianBytes(value: bigint, count: number): Buffer {
  const bytes = Buffer.alloc(count);
  let rest = BigInt.asUintN(128, value);
  for (let index = 0; index < count; index += 1) {
    bytes[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

/** Up to 16 bytes as a little-endian integer (encodeCharArray). */
function fromLittleEndian(bytes: Buffer): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0);
  }
  return value;
}

/** The integer a literal's later deltas start from (`loadUncompressed`). */
function encodeLiteral(literal: ColumnValue): bigint {
  const { type, value } = literal;
  switch (type) {
    case BsonType.string:
    case BsonType.code: {
      // The bytes without length prefix and terminator, reversed (entropy is usually at
      // the end). Longer or NUL-led strings cannot be delta-encoded: their deltas are 0.
      const text = value.subarray(4, value.length - 1);
      if (text.length > 16 || (text.length > 0 && text[0] === 0)) return 0n;
      return BigInt.asIntN(128, fromLittleEndian(Buffer.from(text).reverse()));
    }
    case BsonType.binary: {
      const data = value.subarray(5);
      return data.length > 16 ? 0n : BigInt.asIntN(128, fromLittleEndian(data));
    }
    case BsonType.decimal128:
      return BigInt.asIntN(128, fromLittleEndian(value));
    case BsonType.objectId:
      return encodeObjectId(value);
    case BsonType.date:
    case BsonType.int64:
    case BsonType.timestamp:
      return value.readBigInt64LE(0);
    case BsonType.boolean:
      return value[0] === 0 ? 0n : 1n;
    case BsonType.int32:
      return BigInt(value.readInt32LE(0));
    default:
      // Doubles are re-encoded at each delta block's scale; other types only repeat.
      return 0n;
  }
}

/**
 * An ObjectId's timestamp and counter bytes, interleaved so that the bytes that change
 * most sit lowest (`encodeObjectId`): | C2 | T3 | C1 | T2 | C0 | T1 | T0 | 0 |. The
 * 5 "process unique" bytes are not encoded; deltas keep those of the previous value.
 */
function encodeObjectId(oid: Buffer): bigint {
  const bytes = Buffer.from([
    oid[11] ?? 0,
    oid[3] ?? 0,
    oid[10] ?? 0,
    oid[2] ?? 0,
    oid[9] ?? 0,
    oid[1] ?? 0,
    oid[0] ?? 0,
    0,
  ]);
  return bytes.readBigInt64LE(0);
}

function decodeObjectId(encoded: bigint, previous: Buffer): Buffer {
  const bytes = littleEndianBytes(encoded, 8);
  const oid = Buffer.from(previous);
  oid[0] = bytes[6] ?? 0;
  oid[1] = bytes[5] ?? 0;
  oid[2] = bytes[3] ?? 0;
  oid[3] = bytes[1] ?? 0;
  oid[9] = bytes[4] ?? 0;
  oid[10] = bytes[2] ?? 0;
  oid[11] = bytes[0] ?? 0;
  return oid;
}

// ---------------------------------------------------------------------------
// The decoder (bsoncolumn.cpp, BSONColumn::Iterator)
// ---------------------------------------------------------------------------

/** Delta decoding state of 64-bit types (Decoder64). */
interface Decoder64 {
  readonly width: 64;
  readonly deltaOfDelta: boolean;
  /** The current value's integer encoding; for delta of delta, the current delta. */
  lastEncoded: bigint;
  /** Delta of delta only: the current value's integer encoding. */
  lastEncodedForDeltaOfDelta: bigint;
  scaleIndex: number;
}

/** Delta decoding state of 128-bit types (Decoder128). */
interface Decoder128 {
  readonly width: 128;
  lastEncoded: bigint;
}

/** Everything one stream of values needs (DecodingState). */
interface DecodingState {
  /** The previous value, which deltas apply to; undefined before the first literal. */
  lastValue: ColumnValue | undefined;
  decoder: Decoder64 | Decoder128;
  /** Deltas of the current control not consumed yet, and the position of the next one. */
  pending: Simple8bValue[];
  next: number;
  /**
   * The last Simple-8b value seen since the last literal (what an RLE block at the start
   * of the next control repeats); `null` when no block was read since then, meaning 0.
   */
  lastDelta: Simple8bValue | null;
}

/** One node of an interleaved reference document. */
type ReferenceNode =
  | { readonly kind: "scalar"; readonly name: string; readonly state: number }
  | {
      readonly kind: "object";
      readonly name: string;
      readonly type: number;
      readonly children: readonly ReferenceNode[];
      /** An empty sub-document of the reference is always written, even with no fields. */
      readonly empty: boolean;
    };

/** Signals that the interleaved section ended (a 0x00 where the first state needed a control). */
const END_OF_INTERLEAVED = Symbol("end of interleaved");

class ColumnDecoder {
  readonly #column: Buffer;
  readonly #where: string;
  #position = 0;
  readonly #values: DecodedColumn = [];

  constructor(column: Buffer, where: string) {
    this.#column = column;
    this.#where = where;
  }

  decode(): DecodedColumn {
    if (this.#column.length === 0) throw unsupported(this.#where, "the column is empty");
    let state = freshState(undefined);
    for (;;) {
      this.#drain(state);
      const control = this.#byte();
      if (control === 0x00) {
        this.#position += 1;
        if (this.#position !== this.#column.length) {
          throw unsupported(this.#where, "bytes follow the end of the column");
        }
        return this.#values;
      }
      if (isInterleavedStart(control)) {
        // After interleaved mode, a fresh state continues from its last document.
        state = freshState(this.#decodeInterleaved());
        continue;
      }
      this.#values.push(this.#loadControl(state));
    }
  }

  /** Emits the remaining deltas of the current control. */
  #drain(state: DecodingState): void {
    while (state.next < state.pending.length) {
      this.#values.push(this.#nextDelta(state));
    }
  }

  #byte(): number {
    const value = this.#column[this.#position];
    if (value === undefined) throw unsupported(this.#where, "the column ends without its 0x00");
    return value;
  }

  /**
   * Reads the control at the current position for `state`: a literal (returned), or
   * a delta block whose first value is returned and the rest queued.
   */
  #loadControl(state: DecodingState): ColumnValue | undefined {
    const control = this.#byte();
    if (isLiteral(control)) {
      const literal = this.#readLiteral();
      loadLiteral(state, literal);
      return literal;
    }

    const blockCount = (control & 0x0f) + 1;
    const start = this.#position + 1;
    const end = start + 8 * blockCount;
    // The server requires at least the column's 0x00 after the blocks.
    if (end >= this.#column.length)
      throw unsupported(this.#where, "a delta block runs past the end");
    const scaleIndex = SCALE_INDEX_BY_NIBBLE[control >> 4] ?? -1;
    if (scaleIndex < 0) {
      throw unsupported(this.#where, `the control byte 0x${control.toString(16)} is unknown`);
    }

    const decoder = state.decoder;
    if (decoder.width === 64) {
      decoder.scaleIndex = scaleIndex;
      if (state.lastValue?.type === BsonType.double) {
        // A double's deltas are taken at this block's scale; the previous value is re-scaled.
        const encoded = encodeDouble(state.lastValue.value.readDoubleLE(0), scaleIndex);
        if (encoded === undefined) {
          throw unsupported(this.#where, "a double cannot be represented at its block's scale");
        }
        decoder.lastEncoded = encoded;
      } else if (scaleIndex !== MEMORY_AS_INTEGER) {
        throw unsupported(this.#where, "a scaled delta block follows a value that is not a double");
      }
    } else if (scaleIndex !== MEMORY_AS_INTEGER) {
      throw unsupported(this.#where, "a scaled delta block follows a 128-bit value");
    }

    const previous = state.lastDelta === null ? 0n : state.lastDelta;
    state.pending = decodeSimple8b(
      this.#column.subarray(start, end),
      previous,
      decoder.width,
      this.#where,
    );
    state.next = 0;
    state.lastDelta = state.pending.at(-1);
    this.#position = end;
    return this.#nextDelta(state);
  }

  /** A literal element at the current position (`type · 0x00 · value`). */
  #readLiteral(): ColumnValue {
    const type = this.#byte();
    if (this.#column[this.#position + 1] !== 0x00) {
      throw unsupported(this.#where, "a literal has a field name");
    }
    const valueStart = this.#position + 2;
    const size = valueSize(type, this.#column, valueStart, this.#where);
    const valueEnd = valueStart + size;
    if (valueEnd > this.#column.length)
      throw unsupported(this.#where, "a literal runs past the end");
    this.#position = valueEnd;
    return { type, value: Buffer.from(this.#column.subarray(valueStart, valueEnd)) };
  }

  /** Applies the next queued delta to `state` and returns the value (`loadDelta`). */
  #nextDelta(state: DecodingState): ColumnValue | undefined {
    const delta = state.pending[state.next];
    state.next += 1;
    const decoder = state.decoder;
    // A skip, or deltas before any literal: the value is missing.
    if (delta === undefined || state.lastValue === undefined) return undefined;

    if (decoder.width === 128) {
      if (delta === 0n) return state.lastValue;
      decoder.lastEncoded = BigInt.asIntN(128, decoder.lastEncoded + zigzagDecode(delta, 128));
      state.lastValue = this.#materialize128(state.lastValue, decoder.lastEncoded);
      return state.lastValue;
    }

    if (!decoder.deltaOfDelta && delta === 0n) return state.lastValue;
    decoder.lastEncoded = BigInt.asIntN(64, decoder.lastEncoded + zigzagDecode(delta, 64));
    if (decoder.deltaOfDelta) {
      decoder.lastEncodedForDeltaOfDelta = BigInt.asIntN(
        64,
        decoder.lastEncodedForDeltaOfDelta + decoder.lastEncoded,
      );
    }
    const encoded = decoder.deltaOfDelta ? decoder.lastEncodedForDeltaOfDelta : decoder.lastEncoded;
    state.lastValue = this.#materialize64(state.lastValue, encoded, decoder.scaleIndex);
    return state.lastValue;
  }

  /** A 64-bit type's value from its integer encoding (Decoder64::materialize). */
  #materialize64(previous: ColumnValue, encoded: bigint, scaleIndex: number): ColumnValue {
    const value = Buffer.alloc(previous.value.length);
    switch (previous.type) {
      case BsonType.double:
        if (scaleIndex === MEMORY_AS_INTEGER) {
          value.writeBigInt64LE(encoded, 0);
        } else {
          value.writeDoubleLE(Number(encoded) / (SCALE_MULTIPLIERS[scaleIndex] ?? 1), 0);
        }
        break;
      case BsonType.objectId:
        return { type: previous.type, value: decodeObjectId(encoded, previous.value) };
      case BsonType.date:
      case BsonType.int64:
      case BsonType.timestamp:
        value.writeBigInt64LE(encoded, 0);
        break;
      case BsonType.boolean:
        value[0] = encoded === 0n ? 0 : 1;
        break;
      case BsonType.int32:
        value.writeInt32LE(Number(BigInt.asIntN(32, encoded)), 0);
        break;
      default:
        throw unsupported(
          this.#where,
          `a non-zero delta follows a value of BSON type ${previous.type}`,
        );
    }
    return { type: previous.type, value };
  }

  /** A 128-bit type's value from its integer encoding (Decoder128::materialize). */
  #materialize128(previous: ColumnValue, encoded: bigint): ColumnValue {
    switch (previous.type) {
      case BsonType.string:
      case BsonType.code: {
        // Reversed bytes; the string ends at the last non-zero byte.
        const bytes = littleEndianBytes(encoded, 16);
        let size = 16;
        while (size > 0 && bytes[size - 1] === 0) size -= 1;
        const text = Buffer.from(bytes.subarray(0, size)).reverse();
        const value = Buffer.alloc(4 + size + 1);
        value.writeInt32LE(size + 1, 0);
        text.copy(value, 4);
        return { type: previous.type, value };
      }
      case BsonType.binary: {
        // Same length and subtype as the previous value.
        const length = previous.value.readInt32LE(0);
        if (length > 16)
          throw unsupported(this.#where, "a delta follows binary data longer than 16 bytes");
        const value = Buffer.concat([
          previous.value.subarray(0, 5),
          littleEndianBytes(encoded, length),
        ]);
        return { type: previous.type, value };
      }
      case BsonType.decimal128:
        return { type: previous.type, value: littleEndianBytes(encoded, 16) };
      default:
        throw unsupported(
          this.#where,
          `a non-zero delta follows a value of BSON type ${previous.type}`,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Interleaved mode (BSONColumn::Iterator::_initializeInterleaving, _incrementInterleaved)
  // -------------------------------------------------------------------------

  /**
   * Decodes an interleaved section starting at its control byte, pushing one value
   * per document, and returns the last value pushed (where regular mode continues).
   */
  #decodeInterleaved(): ColumnValue | undefined {
    const control = this.#byte();
    const rootType = control === 0xf2 ? BsonType.array : BsonType.document;
    // 0xF0 (MongoDB before 7.1) treats arrays as scalars; 0xF1 and 0xF2 recurse into them.
    const intoArrays = control !== 0xf0;
    const referenceStart = this.#position + 1;
    const referenceSize = valueSize(BsonType.document, this.#column, referenceStart, this.#where);
    const reference = this.#column.subarray(referenceStart, referenceStart + referenceSize);

    const states: DecodingState[] = [];
    const root = buildReference(reference, "", rootType, intoArrays, states, this.#where);
    if (states.length === 0)
      throw unsupported(this.#where, "an interleaved reference has no fields");
    this.#position = referenceStart + referenceSize;
    if (this.#byte() === 0x00) throw unsupported(this.#where, "an interleaved section is empty");

    let last: ColumnValue | undefined;
    for (;;) {
      const counter = { processed: 0 };
      const built = this.#buildInterleaved(root, states, counter);
      if (built === END_OF_INTERLEAVED) {
        // Every state must have used up its deltas when the section ends.
        if (states.some((state) => state.next < state.pending.length)) {
          throw unsupported(this.#where, "an interleaved section ends with values left");
        }
        return last;
      }
      const value = built === undefined ? undefined : { type: rootType, value: built };
      this.#values.push(value);
      last = value;
    }
  }

  /**
   * One document of an interleaved section: the reference's structure with each
   * scalar's next value. Returns its bytes (undefined when no field is present), or
   * END_OF_INTERLEAVED when the section ends at its first scalar.
   */
  #buildInterleaved(
    node: ReferenceNode & { kind: "object" },
    states: DecodingState[],
    counter: { processed: number },
  ): Buffer | undefined | typeof END_OF_INTERLEAVED {
    const elements: [number, string, Buffer][] = [];
    for (const child of node.children) {
      if (child.kind === "object") {
        const built = this.#buildInterleaved(child, states, counter);
        if (built === END_OF_INTERLEAVED) return built;
        if (built !== undefined) elements.push([child.type, child.name, built]);
        continue;
      }
      const state = states[child.state];
      if (state === undefined) throw unsupported(this.#where, "an interleaved state is missing");
      let value: ColumnValue | undefined;
      if (state.next < state.pending.length) {
        value = this.#nextDelta(state);
      } else if (this.#byte() === 0x00) {
        this.#position += 1;
        if (counter.processed !== 0) {
          throw unsupported(this.#where, "an interleaved section ends in the middle of a document");
        }
        return END_OF_INTERLEAVED;
      } else {
        value = this.#loadControl(state);
      }
      counter.processed += 1;
      if (value !== undefined) elements.push([value.type, child.name, value.value]);
    }
    // Sub-documents without any field are left out, unless the reference's was empty too.
    if (elements.length === 0 && !node.empty) return undefined;
    return buildDocument(elements);
  }
}

/** Walks a reference document, creating one decoding state per scalar (in order). */
function buildReference(
  document: Buffer,
  name: string,
  type: number,
  intoArrays: boolean,
  states: DecodingState[],
  where: string,
): ReferenceNode & { kind: "object" } {
  const children: ReferenceNode[] = [];
  // readElements checks the framing, so every value below is complete.
  for (const element of readElements(document, where)) {
    const recurse =
      element.type === BsonType.document || (intoArrays && element.type === BsonType.array);
    if (recurse) {
      children.push(
        buildReference(element.value, element.name, element.type, intoArrays, states, where),
      );
    } else {
      const state = freshState(undefined);
      loadLiteral(state, { type: element.type, value: Buffer.from(element.value) });
      children.push({ kind: "scalar", name: element.name, state: states.length });
      states.push(state);
    }
  }
  return { kind: "object", name, type, children, empty: children.length === 0 };
}

/** A new state; `lastValue` is what deltas apply to (none at the start of a column). */
function freshState(lastValue: ColumnValue | undefined): DecodingState {
  return {
    lastValue,
    decoder: {
      width: 64,
      deltaOfDelta: false,
      lastEncoded: 0n,
      lastEncodedForDeltaOfDelta: 0n,
      scaleIndex: MEMORY_AS_INTEGER,
    },
    pending: [],
    next: 0,
    lastDelta: null,
  };
}

/** Resets `state` to continue from a literal (`loadUncompressed`). */
function loadLiteral(state: DecodingState, literal: ColumnValue): void {
  const encoded = encodeLiteral(literal);
  if (WIDE_TYPES.has(literal.type)) {
    state.decoder = { width: 128, lastEncoded: encoded };
  } else {
    const deltaOfDelta = DELTA_OF_DELTA_TYPES.has(literal.type);
    state.decoder = {
      width: 64,
      deltaOfDelta,
      // For delta of delta, the value is the base and the first delta starts at 0.
      lastEncoded: deltaOfDelta ? 0n : encoded,
      lastEncodedForDeltaOfDelta: deltaOfDelta ? encoded : 0n,
      scaleIndex: MEMORY_AS_INTEGER,
    };
  }
  state.lastValue = literal;
  state.pending = [];
  state.next = 0;
  state.lastDelta = null;
}

/** Literal control bytes: BSON types 0x01-0x1F, MinKey (0xFF) and MaxKey (0x7F). */
function isLiteral(control: number): boolean {
  return (control & 0xe0) === 0 || control === BsonType.minKey || control === BsonType.maxKey;
}

function isInterleavedStart(control: number): boolean {
  return control === 0xf0 || control === 0xf1 || control === 0xf2;
}

function unsupported(where: string, problem: string): MongoShieldError {
  return new MongoShieldError(
    "MS_FORMAT_UNSUPPORTED",
    `Cannot decode the compressed time-series data of ${where}: ${problem}.`,
    {
      hint: "The dump may be damaged, or come from a MongoDB version whose bucket format MongoShield does not know. Back the collection up with `mongoshield backup` instead.",
    },
  );
}
