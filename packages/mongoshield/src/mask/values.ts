/**
 * Looking at BSON values from the masking point of view.
 *
 * Documents are parsed losslessly (see `LOSSLESS_DESERIALIZE_OPTIONS`), so values are
 * JavaScript strings, booleans, `Date`s, `null`, arrays, plain objects (embedded
 * documents) and js-bson classes (`Int32`, `Double`, `Long`, `ObjectId`, `Binary`, …),
 * which carry a `_bsontype` tag. This file answers three questions about a value:
 *
 *   canonicalBytes   what bytes identify it, for seeding (equal values → equal bytes)
 *   bsonTypeName     what to call its type in warnings ("int", "objectId", …)
 *   isEmbeddedDocument  is it a sub-document a path can descend into
 */

import type { Document } from "mongodb";
import { Binary, Long, ObjectId } from "mongodb";

/**
 * The bytes that identify a value for seeding, or `undefined` for values that have
 * no meaningful identity to mask (embedded documents, arrays, regexes, …).
 *
 * Numbers are identified by their numeric VALUE, whatever their BSON type, because
 * MongoDB compares them that way: a join between an Int32 `userId` and a Double `_id`
 * of 5 matches, so both must mask identically. A type tag keeps `"5"` (a string) and
 * `5` (a number) apart.
 */
export function canonicalBytes(value: unknown): Buffer | undefined {
  if (typeof value === "string") return tagged("s", value);
  if (typeof value === "boolean") return tagged("b", String(value));
  if (typeof value === "number") return tagged("n", numberText(value));
  if (value instanceof Date) return tagged("d", String(value.getTime()));
  if (typeof value === "bigint") return tagged("n", value.toString());

  switch (bsonTag(value)) {
    case "Int32":
    case "Double":
      return tagged("n", numberText(Number(value)));
    case "Long":
      return value instanceof Long ? tagged("n", value.toString()) : undefined;
    case "Decimal128":
      return tagged("m", String(value));
    case "ObjectId":
      return value instanceof ObjectId ? tagged("o", value.toHexString()) : undefined;
    case "Binary":
      return value instanceof Binary
        ? tagged("x", `${value.sub_type}:${Buffer.from(value.buffer).toString("hex")}`)
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The type of a value as MongoDB names it (`$type` aliases), for warnings and reports:
 * "string", "int", "double", "long", "objectId", "binData", "date", "object", …
 */
export function bsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  if (typeof value === "bigint") return "long";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  const tag = bsonTag(value);
  if (tag !== undefined) return BSON_TYPE_NAMES[tag] ?? tag;
  return isEmbeddedDocument(value) ? "object" : typeof value;
}

/** js-bson class tags → MongoDB `$type` aliases. */
const BSON_TYPE_NAMES: Readonly<Record<string, string>> = {
  Int32: "int",
  Double: "double",
  Long: "long",
  Decimal128: "decimal",
  ObjectId: "objectId",
  Binary: "binData",
  BSONRegExp: "regex",
  Timestamp: "timestamp",
  Code: "javascript",
  BSONSymbol: "symbol",
  MinKey: "minKey",
  MaxKey: "maxKey",
  DBRef: "dbPointer",
};

/**
 * True for a sub-document a path can descend into: a plain object that is not a
 * js-bson value, a `Date` or a byte buffer.
 */
export function isEmbeddedDocument(value: unknown): value is Document {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (value instanceof Date || value instanceof Uint8Array) return false;
  return bsonTag(value) === undefined;
}

/** The `_bsontype` tag of a js-bson value, or `undefined`. */
export function bsonTag(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tag: unknown = Reflect.get(value, "_bsontype");
  return typeof tag === "string" ? tag : undefined;
}

/** `-0` and `0` are the same number to MongoDB; everything else uses JavaScript's shortest form. */
function numberText(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

function tagged(tag: string, text: string): Buffer {
  return Buffer.from(`${tag}:${text}`, "utf8");
}
