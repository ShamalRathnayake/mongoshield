/**
 * Understanding BSON values in the browser.
 *
 * Documents arrive as relaxed Extended JSON (see `LiveDocument.json` and `DocumentPage`),
 * which `JSON.parse` reads into plain values. Most BSON types survive as an object with a
 * single `$`-key, an "EJSON wrapper": `{"$oid": "65f…"}` is an ObjectId,
 * `{"$date": "2026-…"}` a date, `{"$binary": {…}}` binary data. This module recognises
 * them, so every view (table, tree, cards, schema, charts) talks about the same types:
 *
 *   bsonTypeOf(value)    which BSON type a value is ("objectId", "date", "string", …)
 *   BSON_TYPE_LABELS     how to name a type to people ("ObjectId", "Date", "String", …)
 *   objectIdTime(hex)    when an ObjectId was created (its first 4 bytes are a timestamp)
 *   dateOf / numberOf    the JavaScript Date / number inside a value, for sorting and charts
 *   shortText(value)     a one-line text for table cells, cards and chips
 *   flattenDocument      a document's fields as dot paths (`address.city`), for table columns
 *
 * Relaxed Extended JSON writes Int32, Int64 (when it fits) and Double all as plain JSON
 * numbers, so a plain number is just a "number" here: the browser cannot tell those three
 * apart without canonical Extended JSON, and pretending otherwise would mislead.
 */

import { isJsonObject, type JsonValue } from "./ejson.ts";

/** Every type the viewers distinguish. The `$`-wrapper each one comes from is noted. */
export type BsonType =
  | "objectId" // {"$oid": "…"}
  | "date" // {"$date": "…ISO…"} or {"$date": {"$numberLong": "ms"}}
  | "string"
  | "number" // a plain JSON number: Int32, Int64 or Double in relaxed Extended JSON
  | "int" // {"$numberInt": "…"} (canonical only)
  | "long" // {"$numberLong": "…"}
  | "double" // {"$numberDouble": "…"} (canonical, or NaN / Infinity in relaxed)
  | "decimal" // {"$numberDecimal": "…"}
  | "boolean"
  | "null"
  | "binary" // {"$binary": {"base64": "…", "subType": "…"}}
  | "uuid" // {"$uuid": "…"}, or binary subtype 4
  | "regex" // {"$regularExpression": {"pattern": "…", "options": "…"}}
  | "timestamp" // {"$timestamp": {"t": …, "i": …}}
  | "minKey" // {"$minKey": 1}
  | "maxKey" // {"$maxKey": 1}
  | "code" // {"$code": "…"} (with an optional "$scope")
  | "symbol" // {"$symbol": "…"}
  | "dbPointer" // {"$dbPointer": {…}}
  | "undefined" // {"$undefined": true}
  | "array"
  | "object";

/** How each type is named in badges, legends and tooltips (the names MongoDB users know). */
export const BSON_TYPE_LABELS: { readonly [Type in BsonType]: string } = {
  objectId: "ObjectId",
  date: "Date",
  string: "String",
  number: "Number",
  int: "Int32",
  long: "Int64",
  double: "Double",
  decimal: "Decimal128",
  boolean: "Boolean",
  null: "Null",
  binary: "Binary",
  uuid: "UUID",
  regex: "Regex",
  timestamp: "Timestamp",
  minKey: "MinKey",
  maxKey: "MaxKey",
  code: "Code",
  symbol: "Symbol",
  dbPointer: "DBPointer",
  undefined: "Undefined",
  array: "Array",
  object: "Object",
};

/** The `$`-keys that make an object a single BSON value, and the type each one means. */
const WRAPPER_TYPES: Readonly<Record<string, BsonType>> = {
  $oid: "objectId",
  $date: "date",
  $numberInt: "int",
  $numberLong: "long",
  $numberDouble: "double",
  $numberDecimal: "decimal",
  $binary: "binary",
  $uuid: "uuid",
  $regularExpression: "regex",
  $timestamp: "timestamp",
  $minKey: "minKey",
  $maxKey: "maxKey",
  $code: "code",
  $symbol: "symbol",
  $dbPointer: "dbPointer",
  $undefined: "undefined",
};

/** Binary subtype 4 is a UUID (RFC 4122); relaxed EJSON may write it as `$binary`. */
const UUID_SUBTYPE = "04";

/**
 * The wrapper key of an EJSON value, or undefined for anything else. `$code` may come
 * with a `$scope` (code with scope), so that one pair is accepted too.
 */
export function wrapperKey(value: JsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const keys = Object.keys(value);
  const first = keys[0];
  if (first === undefined) return undefined;
  if (keys.length === 1 && WRAPPER_TYPES[first] !== undefined) return first;
  if (keys.length === 2 && keys.includes("$code") && keys.includes("$scope")) return "$code";
  return undefined;
}

/** True for a plain (sub)document: an object that is not an EJSON wrapper. */
export function isPlainObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return isJsonObject(value) && wrapperKey(value) === undefined;
}

/** Which BSON type a relaxed (or canonical) Extended JSON value is. */
export function bsonTypeOf(value: JsonValue): BsonType {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  const key = wrapperKey(value);
  if (key === undefined) return "object";
  const type = WRAPPER_TYPES[key] ?? "object";
  // A binary with subtype 4 is a UUID, however it was written.
  if (type === "binary" && binarySubtype(value) === UUID_SUBTYPE) return "uuid";
  return type;
}

/** The two-digit hex subtype of a `$binary` value (`"00"` generic, `"04"` UUID, …). */
function binarySubtype(value: JsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const binary = value.$binary;
  if (binary === undefined || !isJsonObject(binary)) return undefined;
  const subType = binary.subType;
  return typeof subType === "string" ? subType.padStart(2, "0").toLowerCase() : undefined;
}

/** The inner value of a wrapper (`{"$oid": "65f…"}` → `"65f…"`). */
function innerOf(value: JsonValue, key: string): JsonValue | undefined {
  return isJsonObject(value) ? value[key] : undefined;
}

/**
 * When an ObjectId was created: its first 4 bytes are seconds since the Unix epoch.
 * Returns undefined for text that is not 24 hex digits.
 */
export function objectIdTime(hex: string): Date | undefined {
  if (!/^[0-9a-f]{24}$/i.test(hex)) return undefined;
  return new Date(Number.parseInt(hex.slice(0, 8), 16) * 1000);
}

/** The hex text of an ObjectId value, or undefined. */
export function objectIdHex(value: JsonValue): string | undefined {
  const inner = innerOf(value, "$oid");
  return typeof inner === "string" ? inner : undefined;
}

/**
 * The Date inside a date value. Relaxed EJSON uses an ISO string for years 1970–9999 and
 * `{"$numberLong": "<ms>"}` outside them (and in canonical form).
 */
export function dateOf(value: JsonValue): Date | undefined {
  if (bsonTypeOf(value) !== "date") return undefined;
  const inner = innerOf(value, "$date");
  let date: Date | undefined;
  if (typeof inner === "string") date = new Date(inner);
  else if (typeof inner === "number") date = new Date(inner);
  else if (inner !== undefined && isJsonObject(inner) && typeof inner.$numberLong === "string") {
    date = new Date(Number(inner.$numberLong));
  }
  return date === undefined || Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The number inside a numeric value (plain numbers, Int32/Int64/Double/Decimal128
 * wrappers), for statistics and charts. Long and Decimal128 values beyond what a
 * JavaScript number holds exactly come back rounded; their text (`shortText`) is exact.
 */
export function numberOf(value: JsonValue): number | undefined {
  if (typeof value === "number") return value;
  const key = wrapperKey(value);
  if (
    key !== "$numberInt" &&
    key !== "$numberLong" &&
    key !== "$numberDouble" &&
    key !== "$numberDecimal"
  ) {
    return undefined;
  }
  const parsed = Number(innerOf(value, key));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** True for every numeric BSON type. */
export function isNumericType(type: BsonType): boolean {
  return (
    type === "number" ||
    type === "int" ||
    type === "long" ||
    type === "double" ||
    type === "decimal"
  );
}

/**
 * Bytes of a base64 string: every 4 characters hold 3 bytes, minus the `=` padding.
 * Used to say "Binary · 16 bytes" without decoding the data.
 */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** The base64 text and size of a binary value. */
export function binaryInfo(
  value: JsonValue,
): { readonly base64: string; readonly bytes: number; readonly subType: string } | undefined {
  const binary = innerOf(value, "$binary");
  if (binary === undefined || !isJsonObject(binary) || typeof binary.base64 !== "string") {
    return undefined;
  }
  return {
    base64: binary.base64,
    bytes: base64Bytes(binary.base64),
    subType: binarySubtype(value) ?? "00",
  };
}

/**
 * A UUID's text: `{"$uuid": "…"}` as is, or a subtype-4 binary decoded from base64 into
 * the usual 8-4-4-4-12 hex groups.
 */
export function uuidText(value: JsonValue): string | undefined {
  const direct = innerOf(value, "$uuid");
  if (typeof direct === "string") return direct;
  const info = binaryInfo(value);
  if (info === undefined || info.bytes !== 16) return undefined;
  let hex = "";
  try {
    for (const char of atob(info.base64)) hex += char.charCodeAt(0).toString(16).padStart(2, "0");
  } catch {
    return undefined;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Longest text `shortText` returns before cutting it with "…". */
const SHORT_TEXT_LIMIT = 120;

/** Cuts long text so one value never fills a whole cell or card line. */
function clip(text: string, limit = SHORT_TEXT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * One line of text for a value, as people read it: ObjectIds as their hex, dates as
 * ISO text, numbers as digits, strings unquoted, arrays and documents summarised.
 * Used by table cells, cards, chips and CSV-like contexts; the tree and JSON views
 * show the full value instead.
 */
export function shortText(value: JsonValue): string {
  const type = bsonTypeOf(value);
  switch (type) {
    case "null":
      return "null";
    case "string":
      return clip(value as string);
    case "number":
    case "boolean":
      return String(value);
    case "array":
      return `[${(value as readonly JsonValue[]).length} items]`;
    case "object":
      return `{${Object.keys(value as object).length} fields}`;
    case "objectId":
      return objectIdHex(value) ?? "ObjectId";
    case "date":
      return dateOf(value)?.toISOString() ?? "Invalid date";
    case "int":
    case "long":
    case "double":
    case "decimal": {
      const key = wrapperKey(value) ?? "";
      return String(innerOf(value, key));
    }
    case "uuid":
      return uuidText(value) ?? "UUID";
    case "binary": {
      const info = binaryInfo(value);
      return info === undefined ? "Binary" : `Binary · ${info.bytes} bytes`;
    }
    case "regex": {
      const inner = innerOf(value, "$regularExpression");
      if (inner !== undefined && isJsonObject(inner)) {
        return `/${String(inner.pattern ?? "")}/${String(inner.options ?? "")}`;
      }
      return "Regex";
    }
    case "timestamp": {
      const inner = innerOf(value, "$timestamp");
      if (inner !== undefined && isJsonObject(inner)) {
        return `Timestamp(${String(inner.t)}, ${String(inner.i)})`;
      }
      return "Timestamp";
    }
    case "code":
      return clip(String(innerOf(value, "$code")));
    case "symbol":
      return clip(String(innerOf(value, "$symbol")));
    case "minKey":
      return "MinKey";
    case "maxKey":
      return "MaxKey";
    case "undefined":
      return "undefined";
    case "dbPointer":
      return "DBPointer";
  }
}

// ---------------------------------------------------------------------------
// Dot paths: nested fields as table columns
// ---------------------------------------------------------------------------

/** Deepest nesting the table flattens into columns; deeper documents stay one cell. */
export const FLATTEN_MAX_DEPTH = 4;

/**
 * A document's fields as `[dot path, value]` pairs, in document order. Plain
 * subdocuments are walked into (`address.city`), up to {@link FLATTEN_MAX_DEPTH} levels;
 * arrays, EJSON values and empty subdocuments are leaves.
 *
 * Field names that themselves contain a dot (legal since MongoDB 5.0, but rare) would
 * read like nesting here; `valueAtPath` walks the same way, so the table stays consistent.
 */
export function flattenDocument(
  document: { readonly [key: string]: JsonValue },
  maxDepth = FLATTEN_MAX_DEPTH,
): [string, JsonValue][] {
  const pairs: [string, JsonValue][] = [];
  const walk = (value: { readonly [key: string]: JsonValue }, prefix: string, depth: number) => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      const nested = isPlainObject(child) && Object.keys(child).length > 0;
      if (nested && depth < maxDepth) walk(child, path, depth + 1);
      else pairs.push([path, child]);
    }
  };
  walk(document, "", 1);
  return pairs;
}

/** Most columns the table derives from a page of documents (more are in the column picker). */
export const MAX_AUTO_COLUMNS = 40;

/**
 * The columns for a page of documents: the union of their flattened field paths, in the
 * order they first appear, with `_id` first. Documents that are not objects add nothing.
 */
export function columnsOf(documents: readonly (JsonValue | undefined)[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const document of documents) {
    if (document === undefined || !isJsonObject(document)) continue;
    for (const [path] of flattenDocument(document)) {
      if (seen.has(path)) continue;
      seen.add(path);
      columns.push(path);
    }
  }
  // `_id` leads, like in every MongoDB tool.
  const idIndex = columns.indexOf("_id");
  if (idIndex > 0) {
    columns.splice(idIndex, 1);
    columns.unshift("_id");
  }
  return columns;
}

/** The value at a dot path, walking plain subdocuments only; undefined when absent. */
export function valueAtPath(document: JsonValue | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = document;
  for (const part of path.split(".")) {
    if (current === undefined || !isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}
