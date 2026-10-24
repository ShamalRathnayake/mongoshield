/**
 * Reading and writing BSON at the byte level, for the time-series bucket conversions
 * (`timeseries-buckets.ts`, `bson-column.ts`), which must move values between
 * documents without ever re-encoding them: a parsed and re-serialized value can lose
 * its exact form (a NaN payload, the order of fields in an embedded document, a
 * deprecated type), so values are copied as the bytes the server wrote.
 *
 * A BSON document is `int32 totalSize · element* · 0x00`, and an element is
 * `type byte · field name (cstring) · value`, where the value's size depends on the
 * type (bsonspec.org). Everything is little-endian.
 */

import { MongoShieldError } from "../errors.ts";

/** BSON type bytes used by name in this module and its users (bsonspec.org). */
export const BsonType = {
  double: 0x01,
  string: 0x02,
  document: 0x03,
  array: 0x04,
  binary: 0x05,
  undefined: 0x06,
  objectId: 0x07,
  boolean: 0x08,
  date: 0x09,
  null: 0x0a,
  regex: 0x0b,
  dbPointer: 0x0c,
  code: 0x0d,
  symbol: 0x0e,
  codeWithScope: 0x0f,
  int32: 0x10,
  timestamp: 0x11,
  int64: 0x12,
  decimal128: 0x13,
  minKey: 0xff,
  maxKey: 0x7f,
} as const;

/** One element of a document, located by offsets into the document's buffer. */
export interface RawElement {
  readonly type: number;
  readonly name: string;
  /** The value's bytes (without type byte and name). */
  readonly value: Buffer;
}

/**
 * The elements of a BSON document, in order.
 *
 * @param where names the document in error messages
 * @throws MS_INTEGRITY_FAILED when the bytes are not a well-formed document
 */
export function readElements(document: Buffer, where: string): RawElement[] {
  const size = documentSize(document, 0, where);
  if (size !== document.length) {
    throw malformed(where, `its length prefix says ${size} bytes, but it has ${document.length}`);
  }
  const elements: RawElement[] = [];
  let offset = 4;
  // The last byte is the document terminator, checked by documentSize.
  while (offset < size - 1) {
    const type = byteAt(document, offset, where);
    const nameEnd = document.indexOf(0x00, offset + 1);
    if (nameEnd < 0 || nameEnd >= size - 1)
      throw malformed(where, "a field name is not terminated");
    const name = document.toString("utf8", offset + 1, nameEnd);
    const valueStart = nameEnd + 1;
    const valueEnd = valueStart + valueSize(type, document, valueStart, where);
    if (valueEnd > size - 1) throw malformed(where, `the value of "${name}" runs past its end`);
    elements.push({ type, name, value: document.subarray(valueStart, valueEnd) });
    offset = valueEnd;
  }
  return elements;
}

/**
 * The size of the value of type `type` that starts at `offset` of `buffer`.
 *
 * @throws MS_INTEGRITY_FAILED for unknown types and impossible sizes
 */
export function valueSize(type: number, buffer: Buffer, offset: number, where: string): number {
  switch (type) {
    case BsonType.undefined:
    case BsonType.null:
    case BsonType.minKey:
    case BsonType.maxKey:
      return 0;
    case BsonType.boolean:
      return 1;
    case BsonType.int32:
      return 4;
    case BsonType.double:
    case BsonType.date:
    case BsonType.timestamp:
    case BsonType.int64:
      return 8;
    case BsonType.objectId:
      return 12;
    case BsonType.decimal128:
      return 16;
    case BsonType.string:
    case BsonType.code:
    case BsonType.symbol:
      // int32 byte count (including the terminating 0x00), then the bytes.
      return 4 + positiveInt32(buffer, offset, where);
    case BsonType.binary:
      // int32 byte count, subtype byte, then the bytes.
      return 5 + nonNegativeInt32(buffer, offset, where);
    case BsonType.document:
    case BsonType.array:
    case BsonType.codeWithScope:
      // These carry their own total size.
      return documentSize(buffer, offset, where);
    case BsonType.regex: {
      // Two cstrings: pattern and options.
      const patternEnd = buffer.indexOf(0x00, offset);
      const optionsEnd = patternEnd < 0 ? -1 : buffer.indexOf(0x00, patternEnd + 1);
      if (optionsEnd < 0) throw malformed(where, "a regular expression is not terminated");
      return optionsEnd + 1 - offset;
    }
    case BsonType.dbPointer:
      // A string (the namespace) followed by a 12-byte ObjectId.
      return 4 + positiveInt32(buffer, offset, where) + 12;
    default:
      throw malformed(where, `it holds the unknown BSON type 0x${type.toString(16)}`);
  }
}

/** Builds a document from elements given as `[type, name, value]`. */
export function buildDocument(elements: readonly (readonly [number, string, Buffer])[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(4)];
  for (const [type, name, value] of elements) parts.push(encodeElement(type, name, value));
  parts.push(Buffer.from([0x00]));
  const document = Buffer.concat(parts);
  document.writeInt32LE(document.length, 0);
  return document;
}

/** One element's bytes: type, name, value. */
export function encodeElement(type: number, name: string, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), Buffer.from(name, "utf8"), Buffer.from([0]), value]);
}

/** The total size of the document (or array) that starts at `offset`, after checking its framing. */
function documentSize(buffer: Buffer, offset: number, where: string): number {
  const size = positiveInt32(buffer, offset, where);
  if (size < 5 || offset + size > buffer.length) {
    throw malformed(where, `an embedded document claims ${size} bytes`);
  }
  if (buffer[offset + size - 1] !== 0x00) {
    throw malformed(where, "an embedded document does not end with 0x00");
  }
  return size;
}

function positiveInt32(buffer: Buffer, offset: number, where: string): number {
  const value = nonNegativeInt32(buffer, offset, where);
  if (value === 0) throw malformed(where, "a string has a length of 0");
  return value;
}

function nonNegativeInt32(buffer: Buffer, offset: number, where: string): number {
  if (offset + 4 > buffer.length) throw malformed(where, "it ends in the middle of a value");
  const value = buffer.readInt32LE(offset);
  if (value < 0) throw malformed(where, `a length is negative (${value})`);
  return value;
}

function byteAt(buffer: Buffer, offset: number, where: string): number {
  const value = buffer[offset];
  if (value === undefined) throw malformed(where, "it ends in the middle of an element");
  return value;
}

/** The error for bytes that are not the BSON they should be. */
export function malformed(where: string, problem: string): MongoShieldError {
  return new MongoShieldError("MS_INTEGRITY_FAILED", `${where} is not valid BSON: ${problem}.`, {
    hint: "The dump is damaged; take it again with mongodump.",
  });
}
