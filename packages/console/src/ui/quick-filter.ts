/**
 * Quick filters: building the filter box's Extended JSON from clicks, so nobody has to
 * type `{"status": {"$ne": "paid"}}` by hand.
 *
 * Every view offers the same actions on a value or field ("Show documents where status
 * is paid / is not paid / has status"), and the schema and chart views add ranges
 * (a histogram bar: `{"total": {"$gte": 10, "$lt": 20}}`). Each action goes through
 * `addCondition`, which merges the new condition into what is already in the filter box:
 *
 *   ""                              + status = "paid"  → {"status": "paid"}
 *   {"plan": "pro"}                 + status ≠ "paid"  → {"plan": "pro", "status": {"$ne": "paid"}}
 *   {"total": {"$gte": 10}}         + total < 20       → {"total": {"$gte": 10, "$lt": 20}}
 *
 * Values are used exactly as the documents carry them (relaxed Extended JSON), so an
 * ObjectId stays `{"$oid": "…"}` and a date `{"$date": "…"}`, which the server reads back
 * as the same BSON types. The filter's existing text must be valid; if it is not, the
 * caller shows the message instead of overwriting what the user typed.
 */

import { shortText, wrapperKey } from "./bson.ts";
import { isJsonObject, type JsonValue } from "./ejson.ts";

/** What a quick filter does with a field. */
export type QuickFilterOp =
  /** The field equals the value. */
  | "equals"
  /** The field does not equal the value (also matches documents without the field). */
  | "notEquals"
  /** The field exists (any value, null included). */
  | "exists"
  /** The field does not exist. */
  | "missing"
  /** The field is in `[from, to)`; `to` inclusive when `inclusive` (the last histogram bar). */
  | "range";

/** One quick filter action. */
export interface QuickFilter {
  readonly path: string;
  readonly op: QuickFilterOp;
  /** The value for `equals` / `notEquals`. */
  readonly value?: JsonValue;
  /** The bounds for `range`, as Extended JSON values (numbers, or `{"$date": …}`). */
  readonly from?: JsonValue;
  readonly to?: JsonValue;
  readonly inclusive?: boolean;
}

/** The outcome of changing the filter text. */
export type FilterEdit =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

/** A JSON object as parsed from the filter box. */
type FilterObject = { [key: string]: JsonValue };

/** Parses the filter box; blank text is an empty filter. */
function parseFilterText(text: string): FilterObject | string {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ...(parsed as FilterObject) };
    }
  } catch {
    // Reported below.
  }
  return "The filter box has text that is not a valid Extended JSON object. Fix or clear it first, then add the condition again.";
}

/** True for an object of query operators (`{"$gte": 1}`), as opposed to a value. */
function isOperatorObject(value: JsonValue | undefined): value is FilterObject {
  if (value === undefined || !isJsonObject(value) || wrapperKey(value) !== undefined) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith("$"));
}

/** The condition a quick filter puts on its field. */
export function conditionOf(filter: QuickFilter): JsonValue {
  switch (filter.op) {
    case "equals":
      return filter.value ?? null;
    case "notEquals":
      return { $ne: filter.value ?? null };
    case "exists":
      return { $exists: true };
    case "missing":
      return { $exists: false };
    case "range": {
      const condition: FilterObject = {};
      if (filter.from !== undefined) condition.$gte = filter.from;
      if (filter.to !== undefined) condition[filter.inclusive ? "$lte" : "$lt"] = filter.to;
      return condition;
    }
  }
}

/**
 * Adds a quick filter to the filter text. A condition on a field that already has one
 * replaces it, except that two operator objects are merged (so two range clicks, or a
 * `$gte` typed by hand plus a `$lt` from a chart, combine).
 */
export function addCondition(filterText: string, filter: QuickFilter): FilterEdit {
  const parsed = parseFilterText(filterText);
  if (typeof parsed === "string") return { ok: false, message: parsed };
  const condition = conditionOf(filter);
  const existing = parsed[filter.path];
  parsed[filter.path] =
    isOperatorObject(existing) && isOperatorObject(condition)
      ? { ...existing, ...condition }
      : condition;
  return { ok: true, text: JSON.stringify(parsed) };
}

/** Removes the condition on one top-level field of the filter (the × on a filter chip). */
export function removeCondition(filterText: string, path: string): FilterEdit {
  const parsed = parseFilterText(filterText);
  if (typeof parsed === "string") return { ok: false, message: parsed };
  delete parsed[path];
  return { ok: true, text: Object.keys(parsed).length === 0 ? "" : JSON.stringify(parsed) };
}

/** One condition of the applied filter, described for a chip ("status is paid"). */
export interface ConditionChip {
  readonly path: string;
  readonly label: string;
}

/** Operator words for chips. */
const OPERATOR_WORDS: Readonly<Record<string, string>> = {
  $eq: "is",
  $ne: "is not",
  $gt: ">",
  $gte: "≥",
  $lt: "<",
  $lte: "≤",
  $in: "is one of",
  $nin: "is none of",
  $regex: "matches",
  $size: "has size",
  $all: "has all of",
  $elemMatch: "has an element matching",
  $type: "has type",
};

/**
 * The top-level conditions of an applied filter, in words, for the removable chips
 * above the results. `$and`/`$or` and other logical operators become one chip each.
 */
export function describeConditions(filterJson: string | undefined): ConditionChip[] {
  if (filterJson === undefined) return [];
  const parsed = parseFilterText(filterJson);
  if (typeof parsed === "string") return [];
  return Object.entries(parsed).map(([path, condition]) => ({
    path,
    label: describeCondition(path, condition),
  }));
}

/** "status is paid", "total ≥ 10 and < 20", "email exists", "$or (2 conditions)". */
function describeCondition(path: string, condition: JsonValue): string {
  if (path.startsWith("$")) {
    const count = Array.isArray(condition) ? condition.length : 1;
    return `${path} (${count} ${count === 1 ? "condition" : "conditions"})`;
  }
  if (!isOperatorObject(condition)) return `${path} is ${valueWords(condition)}`;
  const parts = Object.entries(condition).map(([operator, operand]) => {
    if (operator === "$exists") return operand === false ? "is missing" : "exists";
    const word = OPERATOR_WORDS[operator] ?? operator;
    return `${word} ${valueWords(operand)}`;
  });
  return `${path} ${parts.join(" and ")}`;
}

/** A value inside a chip: strings quoted, everything else as `shortText`, kept short. */
function valueWords(value: JsonValue): string {
  const text = typeof value === "string" ? `"${value}"` : shortText(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
