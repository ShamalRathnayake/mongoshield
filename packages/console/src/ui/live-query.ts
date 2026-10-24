/**
 * Checking what users type into the live data browser before any request: projections,
 * sorts, update operators and whole documents (the filter uses `checkFilter` from
 * ejson.ts, shared with the backup document browser).
 *
 * Each check returns either the compact JSON to send, or a message to show under the
 * field. The server checks everything again; these only make mistakes visible sooner.
 */

import { isJsonObject, type JsonValue } from "./ejson.ts";

/** The result of a check: the compact JSON to send (absent = nothing typed), or why not. */
export type QueryCheck =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly message: string };

/** Update operators the server accepts for "update many". */
export const UPDATE_OPERATORS: readonly string[] = [
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
];

/** Operators that run JavaScript on the server, refused everywhere. */
const SERVER_JAVASCRIPT = ["$where", "$function", "$accumulator"];

/** Parses text as a JSON object; `undefined` value for blank text. */
function parseObject(text: string, example: string): QueryCheck & { parsed?: JsonValue } {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "{}") return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    return { ok: false, message: `Not valid Extended JSON: ${detail}. Example: ${example}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: `Must be an object, e.g. ${example}` };
  }
  const javascript = SERVER_JAVASCRIPT.find((operator) => trimmed.includes(`"${operator}"`));
  if (javascript !== undefined) {
    return {
      ok: false,
      message: `${javascript} runs JavaScript on the server and is not allowed.`,
    };
  }
  return { ok: true, value: JSON.stringify(parsed), parsed: parsed as JsonValue };
}

/** A projection: `{"name": 1, "email": 1}` or `{"history": 0}`. */
export function checkProjection(text: string): QueryCheck {
  const result = parseObject(text, '{"name": 1, "email": 1}');
  return result.ok ? { ok: true, value: result.value } : result;
}

/** A sort: every value 1 (ascending) or -1 (descending). */
export function checkSort(text: string): QueryCheck {
  const result = parseObject(text, '{"createdAt": -1}');
  if (!result.ok || result.parsed === undefined || !isJsonObject(result.parsed)) {
    return result.ok ? { ok: true, value: result.value } : result;
  }
  for (const [field, direction] of Object.entries(result.parsed)) {
    if (direction !== 1 && direction !== -1) {
      return { ok: false, message: `Sort directions must be 1 or -1 (field "${field}").` };
    }
  }
  return { ok: true, value: result.value };
}

/** Update operators for "update many": only allowed `$`-operators, each with fields. */
export function checkUpdate(text: string): QueryCheck {
  const result = parseObject(text, '{"$set": {"status": "archived"}}');
  if (!result.ok) return result;
  if (result.parsed === undefined || !isJsonObject(result.parsed)) {
    return {
      ok: false,
      message: 'Give at least one update operator, e.g. {"$set": {"status": "archived"}}.',
    };
  }
  for (const [operator, fields] of Object.entries(result.parsed)) {
    if (!UPDATE_OPERATORS.includes(operator)) {
      return {
        ok: false,
        message: `"${operator}" is not an update operator. Use ${UPDATE_OPERATORS.join(", ")}.`,
      };
    }
    if (!isJsonObject(fields) || Object.keys(fields).length === 0) {
      return { ok: false, message: `"${operator}" needs an object of fields.` };
    }
  }
  return { ok: true, value: result.value };
}

/** A document typed in the editor: a JSON object, no `$` at the top level. */
export type DocumentCheck =
  | {
      readonly ok: true;
      readonly document: { readonly [key: string]: JsonValue };
      readonly text: string;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Checks the editor's text. With `originalId` (editing), the `_id` must be unchanged:
 * an edit replaces one document, it cannot move it to another `_id`.
 */
export function checkDocument(text: string, originalId?: JsonValue): DocumentCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    return { ok: false, message: `Not valid Extended JSON: ${detail}.` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "The document must be a JSON object." };
  }
  const document = parsed as { readonly [key: string]: JsonValue };
  const dollarKey = Object.keys(document).find((key) => key.startsWith("$"));
  if (dollarKey !== undefined) {
    return { ok: false, message: `Top-level field names cannot start with "$" ("${dollarKey}").` };
  }
  if (originalId !== undefined && JSON.stringify(document._id) !== JSON.stringify(originalId)) {
    return {
      ok: false,
      message: "An edit cannot change or remove _id. Use Duplicate to insert a copy instead.",
    };
  }
  return { ok: true, document, text: JSON.stringify(document) };
}
