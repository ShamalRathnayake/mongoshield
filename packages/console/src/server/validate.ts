/**
 * Small input validators for request bodies and query strings.
 *
 * Every request body is untrusted JSON. Routes read it only through these
 * helpers, which check type, length and allowed values and throw a
 * `400 CONSOLE_VALIDATION` naming the offending field. Unknown fields are
 * ignored (never copied into state): routes build records field by field.
 *
 * Length limits exist so a single request cannot store megabytes of junk in
 * console.json (the body limit caps the request; these cap each field).
 */

import { invalid } from "./errors.ts";

/** A parsed JSON object whose fields are still unknown. */
export type Fields = Readonly<Record<string, unknown>>;

/** Longest accepted plain string (names, reasons, patterns). */
const DEFAULT_MAX_LENGTH = 200;

/** The request body must be a JSON object. */
export function asObject(value: unknown, field = "body"): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${field} must be a JSON object.`);
  }
  // Checked just above: a non-null, non-array object.
  return value as Fields;
}

/**
 * Control characters (newlines, NUL, escape…). Refused in names and other plain
 * strings: they have no business there, and a newline in a name could otherwise
 * break out of a comment in the exported config file or forge audit lines in a
 * terminal.
 */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    // C0 controls (U+0000-U+001F) and DEL (U+007F).
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A required non-empty string (trimmed, no control characters), at most `max` characters. */
export function requiredString(fields: Fields, name: string, max = DEFAULT_MAX_LENGTH): string {
  const value = fields[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`"${name}" is required and must be a non-empty string.`);
  }
  if (value.length > max) throw invalid(`"${name}" must be at most ${max} characters.`);
  if (hasControlCharacters(value)) throw invalid(`"${name}" must not contain control characters.`);
  return value.trim();
}

/** An optional string; `undefined` when absent or null. Not trimmed (secrets keep their exact value). */
export function optionalString(
  fields: Fields,
  name: string,
  max = DEFAULT_MAX_LENGTH,
): string | undefined {
  const value = fields[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`"${name}" must be a string.`);
  if (value.length > max) throw invalid(`"${name}" must be at most ${max} characters.`);
  return value;
}

/** A required boolean. */
export function requiredBoolean(fields: Fields, name: string): boolean {
  const value = fields[name];
  if (typeof value !== "boolean") throw invalid(`"${name}" must be true or false.`);
  return value;
}

/** One of a fixed set of strings. */
export function oneOf<const Value extends string>(
  fields: Fields,
  name: string,
  allowed: readonly Value[],
): Value {
  const value = fields[name];
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw invalid(`"${name}" must be one of ${allowed.join(", ")}.`);
  return match;
}

/** An optional positive integer up to `max`. */
export function optionalPositiveInt(fields: Fields, name: string, max: number): number | undefined {
  const value = fields[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw invalid(`"${name}" must be a whole number between 0 and ${max}.`);
  }
  return value;
}

/** An optional array of strings (each at most `maxLength`), at most `maxItems` long. */
export function optionalStringArray(
  fields: Fields,
  name: string,
  options: { readonly maxItems?: number; readonly maxLength?: number } = {},
): string[] | undefined {
  const value = fields[name];
  if (value === undefined || value === null) return undefined;
  const maxItems = options.maxItems ?? 100;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw invalid(`"${name}" must be a list of at most ${maxItems} strings.`);
  }
  const strings: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.trim() === "" ||
      item.length > maxLength ||
      hasControlCharacters(item)
    ) {
      throw invalid(
        `Every entry of "${name}" must be a non-empty string of at most ${maxLength} characters.`,
      );
    }
    strings.push(item.trim());
  }
  return strings;
}

/** An optional `{ string: string }` map. */
export function optionalStringMap(
  fields: Fields,
  name: string,
  options: { readonly maxEntries?: number; readonly maxLength?: number } = {},
): Record<string, string> | undefined {
  const value = fields[name];
  if (value === undefined || value === null) return undefined;
  const object = asObject(value, `"${name}"`);
  const entries = Object.entries(object);
  const maxEntries = options.maxEntries ?? 100;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (entries.length > maxEntries) throw invalid(`"${name}" has more than ${maxEntries} entries.`);
  const map: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (typeof item !== "string" || key.length > DEFAULT_MAX_LENGTH || item.length > maxLength) {
      throw invalid(
        `Every value of "${name}" must be a string of at most ${maxLength} characters.`,
      );
    }
    map[key] = item;
  }
  return map;
}

/** A query parameter as a bounded integer, with a default. */
export function queryInt(
  raw: string | undefined,
  name: string,
  options: { readonly min: number; readonly max: number; readonly fallback: number },
): number {
  if (raw === undefined || raw === "") return options.fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    throw invalid(`"${name}" must be a whole number between ${options.min} and ${options.max}.`);
  }
  return value;
}

/** Backup ids look like `2026-11-14T03-00-04Z_7f3a9c`. Anything else never reaches storage. */
const BACKUP_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f]{6}$/;

/** Checks a backup id from a URL path. */
export function backupIdParam(value: string): string {
  if (!BACKUP_ID.test(value)) throw invalid(`"${value.slice(0, 64)}" is not a backup id.`);
  return value;
}
