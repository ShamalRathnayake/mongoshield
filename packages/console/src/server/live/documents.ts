/**
 * Live documents as BSON: reading them without losing types, hashing them into a
 * "version", merging an edit so untouched fields keep their exact types, and checking
 * the Extended JSON users type into the data browser (filters, projections, sorts,
 * update operators, documents).
 *
 * Why the care with types: the browser edits relaxed Extended JSON, where a double `1.0`
 * reads `1` and a small Long reads `5`. Parsing that text back naively would turn the
 * double into an int32 and the Long into an int32 on every save, silently changing
 * fields the user never touched. `mergeEdit` keeps the original BSON value of every
 * field whose text the user left as it was.
 *
 * Nothing here talks to MongoDB; see apply.ts for the conditional writes.
 */

import { createHash } from "node:crypto";
import { BSON, type Document, Double, Int32, Long } from "mongodb";
import type { LiveDocument } from "../../shared/api.ts";
import { invalid } from "../errors.ts";
import { MAX_FILTER_LENGTH, parseExtendedJsonFilter } from "../filter.ts";

/**
 * Driver read options that keep every BSON type as its class (Int32, Double, Long,
 * Binary, BSONRegExp) instead of promoting it to a JavaScript value. Without them a
 * double `1.0` would come back as the number 1 and be written back as an int32.
 * Pass them to `find`, `findOne` and `findOneAndUpdate` (never to counts or commands,
 * whose numeric results would then be wrapped too).
 */
export const FAITHFUL_READ = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
} as const;

/** Longest accepted document text in a write request (the live routes' body limit is 1 MiB). */
export const MAX_DOCUMENT_TEXT = 1024 * 1024;

/**
 * Operators that run JavaScript on the server. The data browser never accepts them, in
 * filters, projections, sorts or updates: "no arbitrary code execution" is a rule of the
 * console, not a matter of the user's database privileges.
 */
const SERVER_SIDE_JAVASCRIPT = new Set(["$where", "$function", "$accumulator"]);

/** Update operators accepted by "update many" (the documented MongoDB field update operators). */
const UPDATE_OPERATORS = new Set([
  "$set",
  "$unset",
  "$inc",
  "$mul",
  "$rename",
  "$min",
  "$max",
  "$currentDate",
  "$push",
  "$pull",
  "$pullAll",
  "$addToSet",
  "$pop",
]);

// ---------------------------------------------------------------------------
// Versions, ids and views
// ---------------------------------------------------------------------------

/**
 * The version of a document: SHA-256 (hex) of its BSON. The document must have been
 * read with {@link FAITHFUL_READ} (or parsed from canonical Extended JSON), so the same
 * stored document always serializes to the same bytes.
 */
export function versionOf(document: Document): string {
  return createHash("sha256").update(BSON.serialize(document)).digest("hex");
}

/** The `_id` as canonical Extended JSON: a stable key that keeps its exact type. */
export function idKeyOf(document: Document): string {
  return BSON.EJSON.stringify(document._id, { relaxed: false });
}

/** Longest `_id` label kept in the journal index and the audit log. */
const MAX_ID_LABEL = 200;

/** The `_id` as relaxed Extended JSON, shortened, for the history page and the audit log. */
export function idLabelOf(id: unknown): string {
  const label = BSON.EJSON.stringify(id, { relaxed: true });
  return label.length > MAX_ID_LABEL ? `${label.slice(0, MAX_ID_LABEL - 1)}…` : label;
}

/** A document as the browser receives it. `editable: false` for partial (projected) reads. */
export function liveDocumentView(document: Document, editable: boolean): LiveDocument {
  const json = BSON.EJSON.stringify(document, { relaxed: true });
  if (!("_id" in document)) return { json };
  return {
    json,
    id: idKeyOf(document),
    ...(editable ? { version: versionOf(document) } : {}),
  };
}

/** Canonical Extended JSON of a whole document, as stored in the journal. */
export function toCanonical(document: Document): string {
  return BSON.EJSON.stringify(document, { relaxed: false });
}

/** Parses canonical (or relaxed) Extended JSON keeping BSON types (`relaxed: false`). */
export function fromExtendedJson(text: string): unknown {
  return BSON.EJSON.parse(text, { relaxed: false });
}

// ---------------------------------------------------------------------------
// Parsing what the user typed
// ---------------------------------------------------------------------------

/** Parses an `_id` sent back by the browser (`LiveDocument.id`, canonical Extended JSON). */
export function parseIdKey(raw: unknown): unknown {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_FILTER_LENGTH) {
    throw invalid('"id" must be the document\'s _id as Extended JSON.');
  }
  try {
    return fromExtendedJson(raw);
  } catch {
    throw invalid('"id" is not valid Extended JSON.');
  }
}

/** A version string as produced by {@link versionOf}. */
export function parseVersion(raw: unknown): string {
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) {
    throw invalid('"version" must be the version the document was loaded with.');
  }
  return raw;
}

/** Parses a whole document typed in the editor. Must be an object; `$`-keys at the top are refused. */
export function parseDocumentText(raw: unknown): Document {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw invalid('"document" is required (Extended JSON).');
  }
  if (raw.length > MAX_DOCUMENT_TEXT) {
    throw invalid(`"document" must be at most ${MAX_DOCUMENT_TEXT / 1024} KiB of Extended JSON.`);
  }
  let parsed: unknown;
  try {
    parsed = fromExtendedJson(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw invalid(`The document is not valid Extended JSON: ${detail}.`);
  }
  if (!isPlainObject(parsed)) throw invalid("The document must be a JSON object.");
  for (const key of Object.keys(parsed)) {
    if (key.startsWith("$")) {
      throw invalid(
        `Top-level field names cannot start with "$" ("${key}").`,
        "To change many documents with update operators, use “Update many”.",
      );
    }
  }
  return parsed;
}

/**
 * Parses a filter, projection or sort from a query string or body: Extended JSON
 * object, at most 16 KiB, no server-side JavaScript anywhere inside.
 */
export function parseQueryObject(raw: string | undefined, label: string): Document | undefined {
  const parsed = parseExtendedJsonFilter(raw, label);
  if (parsed === undefined) return undefined;
  assertNoServerJavaScript(parsed, label);
  return parsed;
}

/** A sort specification: every value 1 or -1, at most 32 keys. */
export function parseSort(raw: string | undefined): Document | undefined {
  const sort = parseQueryObject(raw, "The sort");
  if (sort === undefined) return undefined;
  const entries = Object.entries(sort);
  if (entries.length > 32) throw invalid("The sort may name at most 32 fields.");
  const normalized: Document = {};
  for (const [field, direction] of entries) {
    const value = numericValue(direction);
    if (value !== 1 && value !== -1) {
      throw invalid(`Sort directions must be 1 or -1 (field "${field}").`);
    }
    normalized[field] = value;
  }
  return normalized;
}

/** Update operators for "update many": an object whose keys are all allowed `$`-operators. */
export function parseUpdate(raw: unknown): Document {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw invalid('"update" is required for "update many", e.g. {"$set": {"status": "archived"}}.');
  }
  const update = parseQueryObject(raw, "The update");
  if (update === undefined || Object.keys(update).length === 0) {
    throw invalid('The update must contain at least one operator, e.g. {"$set": {…}}.');
  }
  for (const [operator, fields] of Object.entries(update)) {
    if (!UPDATE_OPERATORS.has(operator)) {
      throw invalid(
        `"${operator}" is not an allowed update operator.`,
        `Use ${[...UPDATE_OPERATORS].join(", ")}. Replacement documents and pipelines are not accepted.`,
      );
    }
    if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
      throw invalid(`"${operator}" needs an object of fields, e.g. {"${operator}": {"field": …}}.`);
    }
    if (Object.hasOwn(fields, "_id") || Object.keys(fields).some((key) => key.startsWith("_id."))) {
      throw invalid("An update may not change _id.");
    }
  }
  return update;
}

/** Refuses `$where`, `$function` and `$accumulator` anywhere in a parsed object. */
export function assertNoServerJavaScript(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoServerJavaScript(item, label);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SERVER_SIDE_JAVASCRIPT.has(key)) {
      throw invalid(
        `${label} uses ${key}, which runs JavaScript on the server.`,
        "The data browser does not run server-side JavaScript. Use query operators instead.",
      );
    }
    assertNoServerJavaScript(child, label);
  }
}

// ---------------------------------------------------------------------------
// Merging an edit
// ---------------------------------------------------------------------------

/** The result of {@link mergeEdit}. */
export interface MergedEdit {
  /** The document to store: the edit, with untouched values taken from the original. */
  readonly document: Document;
  /** Dotted paths (array elements by index) of the values that changed. */
  readonly changedFields: readonly string[];
}

/**
 * Merges an edited document into the original so untouched values keep their BSON type.
 *
 * The browser showed the user `relaxed(original)`. Parsing that text back gives the
 * "untouched" document `roundTrip`, which has the same shape as the original but possibly
 * different number types. Walking original, roundTrip and edited together: wherever the
 * edited value equals the roundTrip value, the user did not change it, so the original
 * value is kept; elsewhere the edited value is used. Objects and arrays are walked into,
 * so changing one field of a sub-document keeps the types of its siblings.
 *
 * Field order follows the edited document (the user may reorder fields).
 */
export function mergeEdit(original: Document, edited: Document): MergedEdit {
  const roundTrip = fromExtendedJson(BSON.EJSON.stringify(original, { relaxed: true }));
  const changed: string[] = [];
  const document = mergeValue(original, roundTrip, edited, "", changed);
  // Fields the user deleted are changes too.
  collectRemoved(original, edited, "", changed);
  if (!isPlainObject(document)) throw invalid("The document must be a JSON object.");
  return { document, changedFields: changed };
}

/** One step of {@link mergeEdit}: returns the value to store at `path`. */
function mergeValue(
  original: unknown,
  roundTrip: unknown,
  edited: unknown,
  path: string,
  changed: string[],
): unknown {
  if (sameValue(roundTrip, edited)) return original;
  if (isPlainObject(original) && isPlainObject(roundTrip) && isPlainObject(edited)) {
    const merged: Document = {};
    for (const [key, value] of Object.entries(edited)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (!Object.hasOwn(original, key)) {
        changed.push(childPath);
        merged[key] = value;
        continue;
      }
      merged[key] = mergeValue(original[key], roundTrip[key], value, childPath, changed);
    }
    return merged;
  }
  if (Array.isArray(original) && Array.isArray(roundTrip) && Array.isArray(edited)) {
    // Arrays are compared element by element. If the length changed, the array as a
    // whole is reported; elements that still line up keep their types.
    if (original.length !== edited.length) changed.push(path);
    return edited.map((value: unknown, index) => {
      const childPath = `${path}.${index}`;
      if (index >= original.length) return value;
      const before = changed.length;
      const merged = mergeValue(original[index], roundTrip[index], value, childPath, changed);
      // Inside an array whose length changed, the array itself is the reported change.
      if (original.length !== edited.length) changed.length = before;
      return merged;
    });
  }
  changed.push(path === "" ? "(document)" : path);
  return edited;
}

/** Adds the paths of fields present in `original` but missing from `edited`. */
function collectRemoved(original: unknown, edited: unknown, path: string, changed: string[]): void {
  if (!isPlainObject(original) || !isPlainObject(edited)) return;
  for (const key of Object.keys(original)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (!Object.hasOwn(edited, key)) changed.push(childPath);
    else collectRemoved(original[key], edited[key], childPath, changed);
  }
}

/** Value equality through canonical Extended JSON (types included). */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    BSON.EJSON.stringify(left, { relaxed: false }) ===
    BSON.EJSON.stringify(right, { relaxed: false })
  );
}

/** True for objects built by JSON/EJSON parsing (not arrays, not BSON classes, not Dates). */
export function isPlainObject(value: unknown): value is Document {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A number from a JS number or a BSON numeric class (Int32, Double, Long). */
function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (value instanceof Int32 || value instanceof Double) return value.valueOf();
  if (value instanceof Long) return value.toNumber();
  return undefined;
}
