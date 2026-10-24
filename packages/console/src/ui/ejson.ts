/**
 * Extended JSON in the browser: validating the document browser's filter box and
 * recognising EJSON type wrappers (`{"$oid": …}`, `{"$date": …}`) so the document tree can
 * show them as `ObjectId("…")` instead of nested objects.
 *
 * Documents arrive as relaxed Extended JSON strings (see `DocumentPage`). Relaxed EJSON
 * is valid JSON, so `JSON.parse` reads it; the wrappers are just objects with a single
 * `$`-key that we display specially.
 */

/** A JSON value as `JSON.parse` returns it. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Result of checking the filter box. */
export type FilterCheck =
  | { readonly ok: true; readonly filter: string | undefined }
  | { readonly ok: false; readonly message: string };

/**
 * Query operators the filter may use. Anything else that starts with `$` at a field
 * position is almost certainly a typo, and reporting it here is friendlier than a
 * server error.
 */
const QUERY_OPERATORS = new Set([
  "$and",
  "$or",
  "$nor",
  "$not",
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
  "$type",
  "$regex",
  "$options",
  "$size",
  "$all",
  "$elemMatch",
  "$mod",
]);

/** EJSON type wrappers: an object with exactly this one key is a value, not a query. */
const EJSON_WRAPPERS = new Set([
  "$oid",
  "$date",
  "$numberLong",
  "$numberInt",
  "$numberDouble",
  "$numberDecimal",
  "$binary",
  "$uuid",
  "$regularExpression",
  "$timestamp",
  "$minKey",
  "$maxKey",
  "$symbol",
  "$code",
  "$dbPointer",
  "$undefined",
]);

/**
 * Validates the filter box. Empty means "no filter". Otherwise it must be a JSON object
 * whose `$`-keys are known query operators or EJSON wrappers. Returns the compact JSON
 * to send, so whitespace differences don't change the request.
 */
export function checkFilter(text: string): FilterCheck {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "{}") return { ok: true, filter: undefined };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    return {
      ok: false,
      message: `Not valid Extended JSON: ${detail}. Keys and strings need double quotes, e.g. {"status": "active"}.`,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: 'The filter must be an object, e.g. {"_id": {"$oid": "…"}}.' };
  }
  const unknownOperator = findUnknownOperator(value);
  if (unknownOperator !== undefined) {
    return {
      ok: false,
      message: `Unknown operator "${unknownOperator}". Allowed: ${[...QUERY_OPERATORS].join(", ")} and Extended JSON types such as $oid and $date.`,
    };
  }
  return { ok: true, filter: JSON.stringify(value) };
}

/** Walks the filter and returns the first `$`-key that is neither an operator nor a wrapper. */
function findUnknownOperator(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUnknownOperator(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const keys = Object.keys(value);
  // `{"$oid": "…"}` and friends are values; do not look inside them.
  const firstKey = keys[0];
  if (keys.length === 1 && firstKey !== undefined && EJSON_WRAPPERS.has(firstKey)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("$") && !QUERY_OPERATORS.has(key) && !EJSON_WRAPPERS.has(key)) return key;
    const found = findUnknownOperator(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Parses one relaxed-EJSON document string; returns undefined if it is not JSON. */
export function parseDocument(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** True when a JSON value is a plain object (not an array, not null). */
export function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * When `value` is an EJSON type wrapper, returns how to show it compactly
 * (`ObjectId("65f…")`, `ISODate("2026-…")`, `NumberLong(42)`), else undefined.
 */
export function describeWrapper(value: JsonValue): { type: string; text: string } | undefined {
  if (!isJsonObject(value)) return undefined;
  const keys = Object.keys(value);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined || !EJSON_WRAPPERS.has(key)) return undefined;
  const inner = value[key];
  switch (key) {
    case "$oid":
      return { type: "ObjectId", text: `ObjectId("${String(inner)}")` };
    case "$date": {
      // Relaxed EJSON uses an ISO string; canonical uses {"$numberLong": "ms"}.
      const iso =
        typeof inner === "string"
          ? inner
          : inner !== undefined && isJsonObject(inner) && typeof inner.$numberLong === "string"
            ? new Date(Number(inner.$numberLong)).toISOString()
            : JSON.stringify(inner);
      return { type: "Date", text: `ISODate("${iso}")` };
    }
    case "$numberLong":
      return { type: "Long", text: `NumberLong(${String(inner)})` };
    case "$numberDecimal":
      return { type: "Decimal128", text: `NumberDecimal("${String(inner)}")` };
    case "$numberInt":
    case "$numberDouble":
      return { type: "Number", text: String(inner) };
    case "$uuid":
      return { type: "UUID", text: `UUID("${String(inner)}")` };
    default:
      return { type: key.slice(1), text: `${key.slice(1)}(${JSON.stringify(inner)})` };
  }
}

/** A stable short label for a document, used for selection and checkboxes: its `_id`. */
export function documentIdLabel(document: JsonValue | undefined): string {
  if (document === undefined || !isJsonObject(document)) return "(unparseable document)";
  const id = document._id;
  if (id === undefined) return "(no _id)";
  return describeWrapper(id)?.text ?? JSON.stringify(id);
}
