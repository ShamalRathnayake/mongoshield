/**
 * Keeping the stored field order of BSON documents when they pass through
 * JavaScript objects, so documents MongoShield writes back (restore, copy, single-
 * document and tenant restore, converge and journal replay) are byte-identical to
 * the ones it read.
 *
 * The problem: JavaScript objects always list integer-like keys ("0", "1", "42")
 * first, in numeric order, whatever order they were assigned in. So
 * `BSON.deserialize` of `{ b: 1, "1": 2 }` yields `{ "1": 2, b: 1 }`, and serializing
 * that object writes the fields in the wrong order. BSON field order matters to the
 * server: embedded documents compare field by field in stored order (equality
 * queries, `_id` values, unique indexes on embedded documents), so a reordered
 * document is a different document.
 *
 * The approach, in two steps:
 *
 *   1. Parse (`deserializeInStoredOrder`): a lossless `BSON.deserialize`, then a cheap
 *      scan of the raw bytes for integer-like names anywhere. Nearly every document
 *      has none and is returned as is. For the others the raw BSON is walked once and
 *      the stored order of every embedded document is recorded in a WeakMap next to
 *      the parsed objects (the root included, which marks the whole document).
 *      Parsed documents stay plain objects, so filters, masks, reference collection
 *      and `_id` lookups work on them unchanged.
 *   2. Write (`inStoredOrder`): just before a document goes to the driver, a document
 *      with a recorded order is rebuilt as nested `Map`s in stored order. js-bson
 *      serializes a Map's entries in insertion order (at any depth, including inside
 *      arrays and as an `_id` value), and the driver serializes documents with
 *      js-bson, so the server receives exactly the stored bytes. Unmarked documents
 *      are passed through untouched: the common case pays one WeakMap lookup.
 *
 * Why not parse every document into Maps: Maps are slower to build and the rest of
 * the code (filters, masking, subsetting) reads plain objects. Why not send the raw
 * bytes: the driver has no public way to insert pre-serialized documents.
 *
 * Driver notes for Map documents: `document._id` is undefined on a Map (use
 * `documentId`), so the driver's "add an `_id` if missing" step would set a
 * JavaScript property that js-bson ignores; inserts use `forceServerObjectId` anyway
 * so the driver never adds an `_id` (time series measurements have none). A Map has
 * no own enumerable keys, so the driver's "replacement must not contain `$`
 * operators" check passes as it should.
 *
 * DBRef-shaped sub-documents (`{ $ref, $id, $db?, …extra }`) are parsed by js-bson into
 * `DBRef` objects, whose extra fields (and an embedded-document `$id`) are plain
 * objects in JavaScript order again. For them the full stored order (`$ref` and `$id`
 * included) is recorded on the `DBRef` object itself, and the write step rebuilds the
 * sub-document as a Map in that order instead of letting js-bson write the DBRef.
 * (A DBRef whose `$ref`/`$id`/`$db` are out of the usual order but which holds no
 * integer-like names is still written in the usual order; see bson-stream.ts.)
 *
 * The same recorded orders serve values that pass through JSON files (collection
 * metadata, checkpoint `_id` bounds): src/format/ordered-json.ts parses and writes
 * them. Catalog entries (`listIndexes`, `listCollections`, `usersInfo`) are read raw
 * and parsed here too, so index keys, validators and custom data keep their order.
 *
 * BSON layout walked here (bsonspec.org): a document is int32 total size, elements,
 * 0x00. An element is a type byte, a NUL-terminated name, then a value whose length
 * depends on the type (fixed, length-prefixed, or a nested document).
 */

import { BSON, DBRef, type Document } from "mongodb";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "./bson-stream.ts";

/**
 * Field order as stored in BSON, for parsed documents whose JavaScript key order may
 * differ (see the file header). A WeakMap keeps the documents themselves unchanged
 * and lets the order go away with them.
 */
const STORED_FIELD_ORDER = new WeakMap<object, readonly string[]>();

/** Records the order the fields of `document` were stored in. */
export function recordStoredFieldOrder(document: object, fields: readonly string[]): void {
  STORED_FIELD_ORDER.set(document, fields);
}

/** The recorded stored field order of a document, if one was recorded. */
export function storedFieldOrder(document: object): readonly string[] | undefined {
  return STORED_FIELD_ORDER.get(document);
}

/** True for names JavaScript objects list first ("0", "1", …, up to 2^32 - 2). */
export function isIntegerLikeKey(name: string): boolean {
  // Cheap first-character test before the regex: most names start with a letter.
  const first = name.charCodeAt(0);
  if (first < DIGIT_ZERO || first > DIGIT_NINE) return false;
  if (!/^(0|[1-9]\d*)$/.test(name)) return false;
  return Number(name) < 4_294_967_295;
}

const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Deserializes one document losslessly (`LOSSLESS_DESERIALIZE_OPTIONS`) and, when it
 * holds integer-like field names anywhere, records the stored order of all of its
 * embedded documents, root included (see the file header).
 *
 * @param options deserialization options; lossless by default. Catalog reads
 *   (`listIndexes`, `listCollections`, `usersInfo`) pass `{}` to get the values the
 *   driver would have returned (plain numbers), so only the field order changes there.
 * @throws whatever `BSON.deserialize` throws for malformed bytes; callers wrap it in
 *   the error that fits their context.
 */
export function deserializeInStoredOrder(
  raw: Uint8Array,
  options: BSON.DeserializeOptions = LOSSLESS_DESERIALIZE_OPTIONS,
): Document {
  // Deserializing first also validates the bytes, so the walks below only ever see
  // well-formed BSON.
  const document = BSON.deserialize(raw, options);
  if (hasIntegerLikeName(raw, 0, false)) recordFieldOrder(raw, 0, document);
  return document;
}

/**
 * True when a document (at `offset` in `raw`) or any document nested in it has an
 * integer-like field name. Array element names ("0", "1", …) do not count: arrays
 * keep their order in JavaScript.
 *
 * Why the raw bytes and not the parsed object: this runs for every restored document,
 * and a tight loop over the bytes is about twice as fast as walking the parsed
 * objects (measured on 200k typical documents), which keeps the overhead for ordinary
 * documents to a few percent of the deserialization itself.
 */
function hasIntegerLikeName(raw: Uint8Array, offset: number, isArray: boolean): boolean {
  const end = offset + readInt32(raw, offset);
  let position = offset + 4;
  while (position < end) {
    const type = raw[position] ?? 0;
    position += 1;
    if (type === 0) return false;
    const nameStart = position;
    position = nameEndAt(raw, position, end);
    // The first-byte test is inlined because it rules out nearly every name.
    const first = raw[nameStart] ?? 0;
    const startsWithDigit = first >= DIGIT_ZERO && first <= DIGIT_NINE;
    if (startsWithDigit && !isArray && isIntegerLikeBytes(raw, nameStart, position)) return true;
    position += 1;
    if (type === EMBEDDED_DOCUMENT || type === ARRAY) {
      if (hasIntegerLikeName(raw, position, type === ARRAY)) return true;
    }
    position += valueLength(raw, type, position);
  }
  return false;
}

/** Position of the NUL that ends the name starting at `position` (or `end`). */
function nameEndAt(raw: Uint8Array, position: number, end: number): number {
  let cursor = position;
  while (cursor < end && raw[cursor] !== 0) cursor += 1;
  return cursor;
}

/**
 * `isIntegerLikeKey` on the UTF-8 bytes of a name, without decoding it: "0", or a
 * digit 1-9 followed by digits, below 2^32 - 1. Integer-like names are pure ASCII.
 */
function isIntegerLikeBytes(raw: Uint8Array, start: number, end: number): boolean {
  const first = raw[start] ?? 0;
  if (first < DIGIT_ZERO || first > DIGIT_NINE) return false;
  if (first === DIGIT_ZERO) return end - start === 1;
  // 4294967294 has 10 digits; longer names are too large.
  if (end - start > 10) return false;
  let value = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    const digit = (raw[cursor] ?? 0) - DIGIT_ZERO;
    if (digit < 0 || digit > 9) return false;
    value = value * 10 + digit;
  }
  return value < 4_294_967_295;
}

/**
 * Walks the raw document at `offset` next to its parsed form, recording the stored
 * field order of every embedded document (and the top level) along the way.
 */
function recordFieldOrder(raw: Uint8Array, offset: number, parsed: unknown): void {
  const end = offset + readInt32(raw, offset);
  const fields: string[] = [];
  let position = offset + 4;
  while (position < end) {
    const type = raw[position] ?? 0;
    position += 1;
    if (type === 0) break;
    const nameEnd = nameEndAt(raw, position, end);
    const name = Buffer.from(raw.buffer, raw.byteOffset + position, nameEnd - position).toString(
      "utf8",
    );
    position = nameEnd + 1;
    fields.push(name);
    if (type === EMBEDDED_DOCUMENT || type === ARRAY) {
      recordFieldOrder(raw, position, childOf(parsed, name));
    }
    position += valueLength(raw, type, position);
  }
  // Arrays need no order (their indexes are their order). A DBRef gets the order of
  // its whole sub-document (see the file header); other BSON values parsed from
  // documents are not documents and are left alone.
  if (isPlainDocument(parsed) || parsed instanceof DBRef) recordStoredFieldOrder(parsed, fields);
}

/** BSON element types this file treats specially. */
const EMBEDDED_DOCUMENT = 0x03;
const ARRAY = 0x04;

/**
 * The parsed value of field `name` (array elements are named "0", "1", …). In a DBRef,
 * `$id` is its `oid` and every field other than `$ref`/`$id`/`$db` is in `fields`.
 */
function childOf(parsed: unknown, name: string): unknown {
  if (Array.isArray(parsed)) return parsed[Number(name)];
  if (isPlainDocument(parsed)) return parsed[name];
  if (parsed instanceof DBRef) return dbRefField(parsed, name);
  return undefined;
}

/** The value of one field of a DBRef sub-document, by its stored name. */
function dbRefField(reference: DBRef, name: string): unknown {
  switch (name) {
    case "$ref":
      return reference.collection;
    case "$id":
      return reference.oid;
    case "$db":
      return reference.db;
    default:
      return reference.fields[name];
  }
}

/** The little-endian int32 at `position` (BSON lengths). */
function readInt32(raw: Uint8Array, position: number): number {
  return (
    (raw[position] ?? 0) |
    ((raw[position + 1] ?? 0) << 8) |
    ((raw[position + 2] ?? 0) << 16) |
    ((raw[position + 3] ?? 0) << 24)
  );
}

/** Bytes taken by a value of BSON type `type` starting at `position`. */
function valueLength(raw: Uint8Array, type: number, position: number): number {
  switch (type) {
    case 0x01: // double
    case 0x09: // UTC datetime
    case 0x11: // timestamp
    case 0x12: // int64
      return 8;
    case 0x02: // string: int32 length (including NUL) + bytes
    case 0x0d: // JavaScript code
    case 0x0e: // symbol
      return 4 + readInt32(raw, position);
    case 0x03: // embedded document: int32 total size
    case 0x04: // array
    case 0x0f: // code with scope: int32 total size
      return readInt32(raw, position);
    case 0x05: // binary: int32 length + subtype byte + bytes
      return 4 + 1 + readInt32(raw, position);
    case 0x07: // ObjectId
      return 12;
    case 0x08: // boolean
      return 1;
    case 0x0b: {
      // regex: two NUL-terminated strings (pattern, options)
      const patternEnd = raw.indexOf(0, position);
      return raw.indexOf(0, patternEnd + 1) + 1 - position;
    }
    case 0x0c: // DBPointer: string + 12-byte ObjectId
      return 4 + readInt32(raw, position) + 12;
    case 0x10: // int32
      return 4;
    case 0x13: // decimal128
      return 16;
    default:
      // 0x06 undefined, 0x0a null, 0x7f MaxKey, 0xff MinKey: no value bytes.
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The document to hand to the driver: `document` itself, or, when its root carries a
 * recorded order (it was parsed by `deserializeInStoredOrder` and has integer-like
 * names somewhere), a copy built from `Map`s in stored order. The input is not
 * modified.
 *
 * Only the root is checked, which is what keeps the common case fast; use
 * `inStoredOrderAnywhere` for documents assembled from several parsed pieces.
 */
export function inStoredOrder(document: Document): Document {
  if (!STORED_FIELD_ORDER.has(document)) return document;
  return orderedCopy(document);
}

/**
 * Like `inStoredOrder`, but finds recorded orders at any depth: for documents whose
 * root was built in memory around parsed values (a reassembled change event, a
 * document with a replayed `$set` of a parsed sub-document).
 */
export function inStoredOrderAnywhere(document: Document): Document {
  if (!containsStoredFieldOrder(document)) return document;
  return orderedCopy(document);
}

/**
 * Any value (an `_id`, a `$set` value) as it should be written: plain documents with
 * a recorded order become Maps, arrays are searched, everything else is returned as
 * is.
 */
export function valueInStoredOrder(value: unknown): unknown {
  return containsStoredFieldOrder(value) ? orderedValue(value) : value;
}

/** The `_id` of a document as parsed or as rebuilt by `inStoredOrder`. */
export function documentId(document: Document): unknown {
  return document instanceof Map ? document.get("_id") : document._id;
}

/** True when a recorded order exists anywhere in the value. */
export function containsStoredFieldOrder(value: unknown): boolean {
  if (Array.isArray(value)) {
    for (const element of value) {
      if (containsStoredFieldOrder(element)) return true;
    }
    return false;
  }
  // A DBRef parsed from a document with integer-like names carries its own order.
  if (value instanceof DBRef) return STORED_FIELD_ORDER.has(value);
  if (!isPlainDocument(value)) return false;
  if (STORED_FIELD_ORDER.has(value)) return true;
  for (const field in value) {
    if (containsStoredFieldOrder(value[field])) return true;
  }
  return false;
}

/**
 * A Map of the document's fields in stored order, with every nested document and
 * array rebuilt the same way. Typed as `Document` because the driver accepts Maps
 * wherever it accepts documents.
 */
function orderedCopy(document: Document): Document {
  const copy = new Map<string, unknown>();
  for (const [field, value] of entriesInStoredOrder(document)) copy.set(field, orderedValue(value));
  return copy;
}

function orderedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element: unknown) => orderedValue(element));
  if (value instanceof DBRef) return orderedDbRef(value);
  if (!isPlainDocument(value)) return value;
  return orderedCopy(value);
}

/**
 * A DBRef with a recorded order as the Map of its stored sub-document: `$ref`, `$id`,
 * `$db` and the extra fields exactly where they were stored, nested values rebuilt
 * too. js-bson writes a Map like any document, so the bytes are the stored ones (it
 * would write a DBRef object's extra fields in JavaScript order). A DBRef without a
 * recorded order is returned as is.
 */
function orderedDbRef(reference: DBRef): unknown {
  const order = STORED_FIELD_ORDER.get(reference);
  if (order === undefined) return reference;
  const copy = new Map<string, unknown>();
  for (const name of order) {
    const value = dbRefField(reference, name);
    // `$db` is optional; any other listed field is present by construction.
    if (value === undefined && name === "$db") continue;
    copy.set(name, orderedValue(value));
  }
  return copy;
}

/**
 * The entries of a document in stored order: the recorded order for the fields it
 * still has, then any other fields (added since, e.g. by masking or a replayed
 * `$set`) in JavaScript order. Without a recorded order, plain `Object.entries`.
 */
export function entriesInStoredOrder(document: Document): [string, unknown][] {
  const order = STORED_FIELD_ORDER.get(document);
  if (order === undefined) return Object.entries(document);
  const entries: [string, unknown][] = [];
  const listed = new Set<string>();
  for (const field of order) {
    if (!Object.hasOwn(document, field) || listed.has(field)) continue;
    listed.add(field);
    entries.push([field, document[field]]);
  }
  for (const [field, value] of Object.entries(document)) {
    if (!listed.has(field)) entries.push([field, value]);
  }
  return entries;
}

/**
 * Gives `copy` (a copy of `original` made with `{ ...original }` or field by field)
 * the recorded stored order of `original`, if it has one, so the copy is written in
 * that order too. Returns `copy`.
 */
export function withStoredFieldOrderOf<T extends object>(copy: T, original: object): T {
  const order = STORED_FIELD_ORDER.get(original);
  if (order !== undefined) STORED_FIELD_ORDER.set(copy, order);
  return copy;
}

/**
 * An embedded document as js-bson parses it: a plain object. Arrays, Dates, RegExps,
 * Buffers and BSON value classes (Int32, ObjectId, DBRef, …) have other prototypes.
 * `null` prototypes are accepted for documents built with `Object.create(null)`.
 */
export function isPlainDocument(value: unknown): value is Document {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
