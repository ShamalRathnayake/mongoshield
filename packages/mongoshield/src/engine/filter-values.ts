/**
 * BSON values as the query filter evaluator (`filter.ts`) sees them: what type a
 * value has, and how two values compare in MongoDB's sort order.
 *
 * Documents reach the evaluator deserialized with `LOSSLESS_DESERIALIZE_OPTIONS`, so
 * numbers arrive as `Int32` / `Double` / `Long` / `Decimal128` objects and regular
 * expressions as `BSONRegExp`. Filters written by hand use plain JavaScript values
 * (`number`, `RegExp`, `bigint`). Both shapes are understood here.
 *
 * MongoDB compares values in two steps (src/mongo/bson/bsontypes.cpp and
 * BSONElement::woCompare in the server):
 *
 *   1. by "canonical type": MinKey < null < numbers < strings < objects < arrays
 *      < binary < ObjectId < booleans < dates < timestamps < regexes < … < MaxKey
 *      (all numeric types share one canonical type, as do strings and symbols);
 *   2. within the same canonical type, by value (numbers numerically and exactly
 *      across Int32 / Long / Double / Decimal128, strings by their UTF-8 bytes, …).
 *
 * Query operators such as `$gt` only match values of the SAME canonical type as
 * their operand ("type bracketing"); that rule lives in `filter.ts`.
 */

import type { Document } from "mongodb";

/**
 * A BSON type as named by the `$type` query operator (`"double"`, `"string"`, …),
 * plus `"minKey"` / `"maxKey"`.
 */
export type BsonKind =
  | "minKey"
  | "undefined"
  | "null"
  | "double"
  | "int"
  | "long"
  | "decimal"
  | "string"
  | "symbol"
  | "object"
  | "array"
  | "binData"
  | "objectId"
  | "bool"
  | "date"
  | "timestamp"
  | "regex"
  | "dbPointer"
  | "javascript"
  | "javascriptWithScope"
  | "maxKey";

/**
 * MongoDB's canonical type of each kind (the server's `canonicalizeBSONType`). Values
 * of different canonical types never compare equal; their order is the order of
 * these numbers.
 */
const CANONICAL_RANK: Readonly<Record<BsonKind, number>> = {
  minKey: -1,
  undefined: 0,
  null: 5,
  double: 10,
  int: 10,
  long: 10,
  decimal: 10,
  string: 15,
  symbol: 15,
  object: 20,
  array: 25,
  binData: 30,
  objectId: 35,
  bool: 40,
  date: 45,
  timestamp: 47,
  regex: 50,
  dbPointer: 55,
  javascript: 60,
  javascriptWithScope: 65,
  maxKey: 127,
};

/**
 * The numeric BSON type codes `$type` accepts, e.g. `{ $type: 16 }` for `"int"`
 * (from the BSON specification).
 */
export const BSON_TYPE_CODES: Readonly<Record<number, BsonKind>> = {
  1: "double",
  2: "string",
  3: "object",
  4: "array",
  5: "binData",
  6: "undefined",
  7: "objectId",
  8: "bool",
  9: "date",
  10: "null",
  11: "regex",
  12: "dbPointer",
  13: "javascript",
  14: "symbol",
  15: "javascriptWithScope",
  16: "int",
  17: "timestamp",
  18: "long",
  19: "decimal",
  [-1]: "minKey",
  127: "maxKey",
};

/** The kinds `$type: "number"` stands for. */
export const NUMBER_KINDS: readonly BsonKind[] = ["double", "int", "long", "decimal"];

/** Every name `$type` accepts as a string: the kinds plus the `"number"` alias. */
export function isBsonKindName(name: string): name is BsonKind {
  return Object.hasOwn(CANONICAL_RANK, name);
}

// ---------------------------------------------------------------------------
// Classifying values
// ---------------------------------------------------------------------------

/**
 * The `_bsontype` tag every js-bson value class carries (`"ObjectId"`, `"Int32"`, …),
 * or undefined for plain JavaScript values.
 */
export function bsonTag(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tag: unknown = Reflect.get(value, "_bsontype");
  return typeof tag === "string" ? tag : undefined;
}

/** js-bson class tags → kinds. `Binary` covers `UUID` too. */
const KIND_BY_TAG: Readonly<Record<string, BsonKind>> = {
  MinKey: "minKey",
  MaxKey: "maxKey",
  Double: "double",
  Int32: "int",
  Long: "long",
  Decimal128: "decimal",
  BSONSymbol: "symbol",
  Binary: "binData",
  ObjectId: "objectId",
  Timestamp: "timestamp",
  BSONRegExp: "regex",
  Code: "javascript",
  // A DBRef is stored as an ordinary embedded document ({ $ref, $id, $db? }).
  DBRef: "object",
};

/** The BSON kind of a value (a document field, an array element, or a filter operand). */
export function bsonKind(value: unknown): BsonKind {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "number":
      return "double";
    case "bigint":
      return "long";
    case "string":
      return "string";
    case "boolean":
      return "bool";
    default:
      break;
  }
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof RegExp) return "regex";
  const tag = bsonTag(value);
  if (tag === "Code") return codeScope(value) === undefined ? "javascript" : "javascriptWithScope";
  if (tag !== undefined) return KIND_BY_TAG[tag] ?? "object";
  return "object";
}

/** The canonical type rank of a value (see `CANONICAL_RANK`). */
export function canonicalRank(value: unknown): number {
  return CANONICAL_RANK[bsonKind(value)];
}

/** True for embedded documents (including DBRefs), which paths can descend into. */
export function isDocument(value: unknown): value is Document {
  return bsonKind(value) === "object";
}

/**
 * The fields of an embedded document, in stored order. DBRefs are turned back into
 * the `{ $ref, $id, $db, … }` document they are stored as.
 */
export function documentFields(value: Document): Document {
  if (bsonTag(value) === "DBRef") {
    const json: unknown = Reflect.apply(Reflect.get(value, "toJSON"), value, []);
    if (typeof json === "object" && json !== null) return json;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Comparing values
// ---------------------------------------------------------------------------

/**
 * Compares two values in MongoDB's sort order (with the simple, binary collation):
 * negative when `left` sorts first, 0 when they are equal, positive otherwise.
 * NaN equals NaN and sorts before every other number, as on the server.
 */
export function compareValues(left: unknown, right: unknown): number {
  const rankDifference = canonicalRank(left) - canonicalRank(right);
  if (rankDifference !== 0) return Math.sign(rankDifference);
  return compareSameRank(left, right);
}

/** True when two values are equal for a query (`$eq`): same canonical type, same value. */
export function valuesEqual(left: unknown, right: unknown): boolean {
  return canonicalRank(left) === canonicalRank(right) && compareSameRank(left, right) === 0;
}

/** True when the value is a NaN of any numeric type. */
export function isNaNValue(value: unknown): boolean {
  if (canonicalRank(value) !== CANONICAL_RANK.double) return false;
  return toExactNumber(value).kind === "nan";
}

/** Compares two values known to have the same canonical type. */
function compareSameRank(left: unknown, right: unknown): number {
  const kind = bsonKind(left);
  switch (kind) {
    case "double":
    case "int":
    case "long":
    case "decimal":
      return compareNumbers(left, right);
    case "string":
    case "symbol":
      return compareStrings(stringOf(left), stringOf(right));
    case "object":
      return compareDocuments(fieldsOf(left), fieldsOf(right));
    case "array":
      return compareArrays(arrayOf(left), arrayOf(right));
    case "binData":
      return compareBinaries(left, right);
    case "objectId":
      return compareBytes(objectIdBytes(left), objectIdBytes(right));
    case "bool":
      return Number(left === true) - Number(right === true);
    case "date":
      return Math.sign(dateMillis(left) - dateMillis(right));
    case "timestamp":
      return compareTimestamps(left, right);
    case "regex":
      return compareRegexes(left, right);
    case "javascript":
    case "javascriptWithScope":
      return compareCode(left, right);
    default:
      // minKey, maxKey, null, undefined, dbPointer: one value per type.
      return 0;
  }
}

/**
 * Embedded documents compare field by field: first the canonical type of the
 * values, then the field names, then the values; a document that is a prefix of
 * the other sorts first.
 */
function compareDocuments(left: Document, right: Document): number {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  const shared = Math.min(leftEntries.length, rightEntries.length);
  for (let index = 0; index < shared; index++) {
    const [leftName, leftValue] = leftEntries[index] ?? ["", undefined];
    const [rightName, rightValue] = rightEntries[index] ?? ["", undefined];
    const rankDifference = canonicalRank(leftValue) - canonicalRank(rightValue);
    if (rankDifference !== 0) return Math.sign(rankDifference);
    const nameDifference = compareStrings(leftName, rightName);
    if (nameDifference !== 0) return nameDifference;
    const valueDifference = compareSameRank(leftValue, rightValue);
    if (valueDifference !== 0) return valueDifference;
  }
  return Math.sign(leftEntries.length - rightEntries.length);
}

/** Arrays compare like documents whose field names are "0", "1", … */
function compareArrays(left: readonly unknown[], right: readonly unknown[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    const difference = compareValues(left[index], right[index]);
    if (difference !== 0) return difference;
  }
  return Math.sign(left.length - right.length);
}

/**
 * Strings compare by their UTF-8 bytes, which is the same as comparing code points.
 * JavaScript's `<` compares UTF-16 code units instead, which orders characters
 * outside the Basic Multilingual Plane (emoji) differently, so it is not used.
 */
export function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex) ?? 0;
    const rightPoint = right.codePointAt(rightIndex) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  return Math.sign(left.length - leftIndex - (right.length - rightIndex));
}

/** Binary values: shorter first, then by subtype, then byte by byte (the server's order). */
function compareBinaries(left: unknown, right: unknown): number {
  const leftBytes = binaryBytes(left);
  const rightBytes = binaryBytes(right);
  if (leftBytes.length !== rightBytes.length) {
    return Math.sign(leftBytes.length - rightBytes.length);
  }
  const subtypeDifference = binarySubtype(left) - binarySubtype(right);
  if (subtypeDifference !== 0) return Math.sign(subtypeDifference);
  return compareBytes(leftBytes, rightBytes);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return Math.sign(Buffer.compare(left, right));
}

/** Timestamps are unsigned (seconds, increment) pairs. */
function compareTimestamps(left: unknown, right: unknown): number {
  const [leftSeconds, leftIncrement] = timestampParts(left);
  const [rightSeconds, rightIncrement] = timestampParts(right);
  if (leftSeconds !== rightSeconds) return leftSeconds < rightSeconds ? -1 : 1;
  return Math.sign(leftIncrement - rightIncrement);
}

/** Regexes compare by pattern, then by flags. */
function compareRegexes(left: unknown, right: unknown): number {
  const leftRegex = regexParts(left);
  const rightRegex = regexParts(right);
  return (
    compareStrings(leftRegex.pattern, rightRegex.pattern) ||
    compareStrings(leftRegex.flags, rightRegex.flags)
  );
}

/** JavaScript code compares by its source, then (with scope) by the scope document. */
function compareCode(left: unknown, right: unknown): number {
  const sourceDifference = compareStrings(codeSource(left), codeSource(right));
  if (sourceDifference !== 0) return sourceDifference;
  return compareDocuments(codeScope(left) ?? {}, codeScope(right) ?? {});
}

// ---------------------------------------------------------------------------
// Numbers: exact comparison across Int32, Long, Double and Decimal128
// ---------------------------------------------------------------------------

/**
 * A number as an exact fraction, so that a Long beyond 2^53, a Double and a
 * Decimal128 can be compared without rounding (comparing via `Number()` would
 * call 2^53 + 1 equal to 2^53).
 */
export type ExactNumber =
  | { readonly kind: "nan" }
  | { readonly kind: "infinity"; readonly sign: 1 | -1 }
  /** `numerator / denominator`, denominator > 0. */
  | { readonly kind: "finite"; readonly numerator: bigint; readonly denominator: bigint };

/** Compares two numeric values (any numeric BSON type or JavaScript number/bigint). */
function compareNumbers(left: unknown, right: unknown): number {
  const leftPlain = plainNumber(left);
  const rightPlain = plainNumber(right);
  // Fast path: both are doubles or Int32s, which JavaScript numbers hold exactly.
  if (leftPlain !== undefined && rightPlain !== undefined) {
    return compareDoubles(leftPlain, rightPlain);
  }
  return compareExact(toExactNumber(left), toExactNumber(right));
}

/** Doubles in MongoDB order: NaN first (and equal to itself), -0 equal to 0. */
function compareDoubles(left: number, right: number): number {
  const leftIsNaN = Number.isNaN(left);
  const rightIsNaN = Number.isNaN(right);
  if (leftIsNaN || rightIsNaN) {
    if (leftIsNaN && rightIsNaN) return 0;
    return leftIsNaN ? -1 : 1;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareExact(left: ExactNumber, right: ExactNumber): number {
  const leftOrder = exactOrderClass(left);
  const rightOrder = exactOrderClass(right);
  if (leftOrder !== rightOrder) return Math.sign(leftOrder - rightOrder);
  if (left.kind !== "finite" || right.kind !== "finite") return 0;
  // a/b vs c/d with b, d > 0  ⇔  a·d vs c·b.
  const crossLeft = left.numerator * right.denominator;
  const crossRight = right.numerator * left.denominator;
  if (crossLeft === crossRight) return 0;
  return crossLeft < crossRight ? -1 : 1;
}

/** NaN < -Infinity < finite numbers < +Infinity. */
function exactOrderClass(value: ExactNumber): number {
  if (value.kind === "nan") return 0;
  if (value.kind === "infinity") return value.sign === -1 ? 1 : 3;
  return 2;
}

/** The value of a Double, an Int32 or a JavaScript number; undefined for other numerics. */
function plainNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  const tag = bsonTag(value);
  if (tag === "Double" || tag === "Int32") return numberField(value, "value");
  return undefined;
}

/** Converts any numeric value into an exact fraction. */
export function toExactNumber(value: unknown): ExactNumber {
  const plain = plainNumber(value);
  if (plain !== undefined) return doubleToExact(plain);
  if (typeof value === "bigint") return { kind: "finite", numerator: value, denominator: 1n };
  const tag = bsonTag(value);
  if (tag === "Long") return { kind: "finite", numerator: callBigInt(value), denominator: 1n };
  if (tag === "Decimal128") return decimalToExact(String(value));
  return { kind: "nan" };
}

/**
 * The exact value of a double. Every finite double is `mantissa · 2^exponent`; the
 * bits are read straight from its IEEE 754 representation.
 */
function doubleToExact(value: number): ExactNumber {
  if (Number.isNaN(value)) return { kind: "nan" };
  if (!Number.isFinite(value)) return { kind: "infinity", sign: value < 0 ? -1 : 1 };
  if (Number.isSafeInteger(value)) {
    return { kind: "finite", numerator: BigInt(value), denominator: 1n };
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  // Subnormal numbers (exponent bits 0) have no implicit leading 1.
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  // 1075 = exponent bias (1023) + 52 fraction bits; subnormals use the minimum, -1074.
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075;
  const signed = negative ? -mantissa : mantissa;
  if (exponent >= 0)
    return { kind: "finite", numerator: signed << BigInt(exponent), denominator: 1n };
  return { kind: "finite", numerator: signed, denominator: 1n << BigInt(-exponent) };
}

/** Parses Decimal128's string form ("-1.50E+3", "0.001", "NaN", "-Infinity"). */
function decimalToExact(text: string): ExactNumber {
  if (text === "NaN") return { kind: "nan" };
  if (text === "Infinity") return { kind: "infinity", sign: 1 };
  if (text === "-Infinity") return { kind: "infinity", sign: -1 };
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:E([+-]\d+))?$/i.exec(text);
  if (match === null) return { kind: "nan" };
  const [, sign = "", whole = "0", fractionDigits = "", exponentText = "0"] = match;
  const coefficient = BigInt(`${sign}${whole}${fractionDigits}`);
  const exponent = Number(exponentText) - fractionDigits.length;
  if (exponent >= 0) {
    return { kind: "finite", numerator: coefficient * 10n ** BigInt(exponent), denominator: 1n };
  }
  return { kind: "finite", numerator: coefficient, denominator: 10n ** BigInt(-exponent) };
}

// ---------------------------------------------------------------------------
// Reading the parts of js-bson values (without `any`)
// ---------------------------------------------------------------------------

function numberField(value: unknown, field: string): number {
  if (typeof value !== "object" || value === null) return Number.NaN;
  const found: unknown = Reflect.get(value, field);
  return typeof found === "number" ? found : Number.NaN;
}

function callBigInt(value: unknown): bigint {
  if (typeof value !== "object" || value === null) return 0n;
  const method: unknown = Reflect.get(value, "toBigInt");
  if (typeof method !== "function") return 0n;
  const result: unknown = Reflect.apply(method, value, []);
  return typeof result === "bigint" ? result : 0n;
}

function stringOf(value: unknown): string {
  if (typeof value === "string") return value;
  // BSONSymbol keeps its text in `value`.
  const text: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, "value") : "";
  return typeof text === "string" ? text : "";
}

function fieldsOf(value: unknown): Document {
  return typeof value === "object" && value !== null ? documentFields(value) : {};
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The bytes of a Binary (its buffer may be larger than the data; `position` is the length). */
function binaryBytes(value: unknown): Uint8Array {
  if (typeof value !== "object" || value === null) return new Uint8Array();
  const buffer: unknown = Reflect.get(value, "buffer");
  const length: unknown = Reflect.get(value, "position");
  if (!(buffer instanceof Uint8Array)) return new Uint8Array();
  return typeof length === "number" ? buffer.subarray(0, length) : buffer;
}

function binarySubtype(value: unknown): number {
  const subtype = numberField(value, "sub_type");
  return Number.isNaN(subtype) ? 0 : subtype;
}

function objectIdBytes(value: unknown): Uint8Array {
  if (typeof value !== "object" || value === null) return new Uint8Array();
  const bytes: unknown = Reflect.get(value, "id");
  return bytes instanceof Uint8Array ? bytes : new Uint8Array();
}

function dateMillis(value: unknown): number {
  return value instanceof Date ? value.getTime() : 0;
}

function timestampParts(value: unknown): [number, number] {
  return [numberField(value, "t"), numberField(value, "i")];
}

/** Pattern and flags of a BSONRegExp or a JavaScript RegExp. */
export function regexParts(value: unknown): { pattern: string; flags: string } {
  if (value instanceof RegExp) return { pattern: value.source, flags: value.flags };
  if (typeof value !== "object" || value === null) return { pattern: "", flags: "" };
  const pattern: unknown = Reflect.get(value, "pattern");
  const flags: unknown = Reflect.get(value, "options");
  return {
    pattern: typeof pattern === "string" ? pattern : "",
    flags: typeof flags === "string" ? flags : "",
  };
}

function codeSource(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const code: unknown = Reflect.get(value, "code");
  return typeof code === "string" ? code : String(code);
}

function codeScope(value: unknown): Document | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const scope: unknown = Reflect.get(value, "scope");
  return typeof scope === "object" && scope !== null ? scope : undefined;
}
