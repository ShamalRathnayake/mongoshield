/**
 * Looking inside backed-up definitions (validators, view pipelines, index keys,
 * stored JavaScript) for the things the upgrade compatibility rules care about
 * (upgrade-compat.ts): which operators they use, which JavaScript they run, which
 * regular expression options they pass, and which fields they compare with `null`.
 *
 * Every function here is pure and works on values as the metadata parser returns
 * them (src/format/metadata.ts): canonical Extended JSON turned back into BSON
 * values, so a number may be a plain `number` or an `Int32` / `Double` / `Long` /
 * `Decimal128` object, code is a `Code` object and a regex a `BSONRegExp`.
 */

import type { Document } from "mongodb";
import { isPlainDocument } from "../format/field-order.ts";

// ---------------------------------------------------------------------------
// BSON values
// ---------------------------------------------------------------------------

/** The js-bson class name of a BSON value object (`"Int32"`, `"Code"`, …), if it is one. */
export function bsonTypeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type: unknown = Reflect.get(value, "_bsontype");
  return typeof type === "string" ? type : undefined;
}

/**
 * The numeric value of a BSON number in any of its forms, or undefined for
 * anything that is not a number. `NaN` stays `NaN`, which is the point for the TTL
 * and index key rules: they look for exactly that.
 */
export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  switch (bsonTypeOf(value)) {
    case "Int32":
    case "Double":
      return Number(Reflect.get(value as object, "value"));
    case "Long":
    case "Decimal128":
      // Both print their exact value; Number() of "NaN" is NaN, as it should be.
      return Number(String(value));
    default:
      return undefined;
  }
}

/** The source text of a piece of JavaScript: a `Code` value or a plain string. */
export function codeText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (bsonTypeOf(value) === "Code") {
    const code: unknown = Reflect.get(value as object, "code");
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Walking documents
// ---------------------------------------------------------------------------

/**
 * Calls `visit` for every field of every embedded document in `value` (arrays are
 * walked into, BSON value objects are not: they are leaves).
 */
export function forEachField(
  value: unknown,
  visit: (name: string, fieldValue: unknown, parent: Document) => void,
): void {
  if (Array.isArray(value)) {
    for (const element of value) forEachField(element, visit);
    return;
  }
  if (!isPlainDocument(value)) return;
  for (const [name, fieldValue] of Object.entries(value)) {
    visit(name, fieldValue, value);
    forEachField(fieldValue, visit);
  }
}

/** Every `$`-prefixed field name in `value`: the operators and stages it uses. */
export function operatorsUsed(value: unknown): Set<string> {
  const operators = new Set<string>();
  forEachField(value, (name) => {
    if (name.startsWith("$")) operators.add(name);
  });
  return operators;
}

// ---------------------------------------------------------------------------
// Server-side JavaScript
// ---------------------------------------------------------------------------

/**
 * The fields of the server-side JavaScript operators that hold code
 * (https://www.mongodb.com/docs/manual/core/server-side-javascript/):
 * `$function: { body }` and `$accumulator: { init, accumulate, merge, finalize }`.
 * `$where` holds code directly.
 */
const CODE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  $function: ["body"],
  $accumulator: ["init", "accumulate", "merge", "finalize"],
};

/** The source of every piece of server-side JavaScript in `value` (a pipeline or query). */
export function javaScriptSources(value: unknown): string[] {
  const sources: string[] = [];
  forEachField(value, (name, fieldValue) => {
    if (name === "$where") {
      const text = codeText(fieldValue);
      if (text !== undefined) sources.push(text);
      return;
    }
    const fields = CODE_FIELDS[name];
    if (fields === undefined || !isPlainDocument(fieldValue)) return;
    for (const field of fields) {
      const text = codeText(fieldValue[field]);
      if (text !== undefined) sources.push(text);
    }
  });
  return sources;
}

/**
 * The static `Array.*` and `String.*` functions MongoDB 6.0 removed from server-side
 * JavaScript when it moved from MozJS-60 to MozJS-91, exactly as listed in
 * https://www.mongodb.com/docs/manual/release-notes/6.0-compatibility/#removed-array-functions
 * (the prototype methods, `[1].concat(…)`, still work).
 */
export const REMOVED_STATIC_JS_FUNCTIONS: Readonly<Record<"Array" | "String", readonly string[]>> =
  {
    Array: [
      "concat",
      "every",
      "filter",
      "forEach",
      "indexOf",
      "join",
      "lastIndexOf",
      "map",
      "pop",
      "push",
      "reduce",
      "reduceRight",
      "reverse",
      "shift",
      "slice",
      "some",
      "sort",
      "splice",
      "unshift",
    ],
    String: [
      "charAt",
      "charCodeAt",
      "concat",
      "contains",
      "endsWith",
      "includes",
      "indexOf",
      "lastIndexOf",
      "localeCompare",
      "match",
      "normalize",
      "replace",
      "search",
      "slice",
      "split",
      "startsWith",
      "substr",
      "substring",
      "toLocaleLowerCase",
      "toLocaleUpperCase",
      "toLowerCase",
      "toUpperCase",
      "trim",
      "trimLeft",
      "trimRight",
    ],
  };

/**
 * `Array.concat(` or `String.trim (`, but not `MyArray.concat(` or `x.Array.map(`:
 * the object name must not be preceded by a word character or a dot.
 */
const STATIC_CALL_PATTERN = /(?<![\w$.])(Array|String)\s*\.\s*([A-Za-z]+)\s*\(/g;

/**
 * The removed static functions a piece of JavaScript calls, e.g. `["Array.concat"]`.
 * A text search, so a call inside a comment or a string literal counts too: the
 * rule that uses this says "calls", and a false alarm costs one look at the code.
 */
export function removedStaticFunctionCalls(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(STATIC_CALL_PATTERN)) {
    const object = match[1] as "Array" | "String";
    const method = match[2] ?? "";
    if (REMOVED_STATIC_JS_FUNCTIONS[object].includes(method)) found.add(`${object}.${method}`);
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Regular expressions
// ---------------------------------------------------------------------------

/**
 * The `$regex` options MongoDB accepts: i, m, x, s and u
 * (https://www.mongodb.com/docs/manual/reference/operator/query/regex/#mongodb-query-op.-options).
 * Since 5.1 a validator with any other option blocks every insert and update
 * (6.0 compatibility notes, "$regex Schema Validation Error Behavior"), and current
 * servers refuse to create one ("invalid flag in regex options").
 */
export const VALID_REGEX_OPTIONS = "imxsu";

/** The option strings of every regular expression in `value` (BSON regexes and `$regex`). */
export function regexOptionsIn(value: unknown): string[] {
  const options: string[] = [];
  const walk = (candidate: unknown): void => {
    if (candidate instanceof RegExp) {
      options.push(candidate.flags);
    } else if (bsonTypeOf(candidate) === "BSONRegExp") {
      options.push(String(Reflect.get(candidate as object, "options") ?? ""));
    } else if (Array.isArray(candidate)) {
      for (const element of candidate) walk(element);
    } else if (isPlainDocument(candidate)) {
      // `{ $regex: "x", $options: "i" }`: the options sit next to the pattern.
      if ("$regex" in candidate && typeof candidate.$options === "string") {
        options.push(candidate.$options);
      }
      for (const field of Object.values(candidate)) walk(field);
    }
  };
  walk(value);
  return options;
}

/** The characters of an options string MongoDB does not accept, deduplicated. */
export function invalidRegexOptions(options: string): string[] {
  return [...new Set(options)].filter((option) => !VALID_REGEX_OPTIONS.includes(option));
}

// ---------------------------------------------------------------------------
// Equality with null (the MongoDB 8.0 undefined change)
// ---------------------------------------------------------------------------

/** Query operators whose arguments are lists of sub-queries. */
const LOGICAL_OPERATORS = new Set(["$and", "$or", "$nor"]);

/**
 * The field paths a query compares with `null` by equality: `{ f: null }`,
 * `{ f: { $eq: null } }`, `{ f: { $in: [null, …] } }`, `{ f: { $ne: null } }` and
 * `{ f: { $nin: [null] } }` (the negations change too: they are defined as "not
 * equal"). Logical operators are followed; `$expr` and `$jsonSchema` are not,
 * because MongoDB documents the change for query equality only
 * (https://www.mongodb.com/docs/manual/release-notes/8.0-compatibility/#queries-for-null-don-t-match-undefined-fields).
 */
export function nullEqualityPaths(query: unknown, prefix = ""): string[] {
  if (!isPlainDocument(query)) return [];
  const paths = new Set<string>();
  for (const [name, condition] of Object.entries(query)) {
    if (LOGICAL_OPERATORS.has(name) && Array.isArray(condition)) {
      for (const clause of condition)
        for (const path of nullEqualityPaths(clause, prefix)) paths.add(path);
      continue;
    }
    if (name.startsWith("$")) continue;
    const path = `${prefix}${name}`;
    if (comparesWithNull(condition)) paths.add(path);
    // `{ a: { $elemMatch: { b: null } } }` compares `a.b` inside each element.
    if (isPlainDocument(condition) && isPlainDocument(condition.$elemMatch)) {
      for (const nested of nullEqualityPaths(condition.$elemMatch, `${path}.`)) paths.add(nested);
    }
  }
  return [...paths].sort();
}

/** True for a field condition that is (or negates) an equality with null. */
function comparesWithNull(condition: unknown): boolean {
  if (condition === null) return true;
  if (!isPlainDocument(condition)) return false;
  if (condition.$eq === null || condition.$ne === null) return true;
  for (const listOperator of ["$in", "$nin"]) {
    const list: unknown = condition[listOperator];
    if (Array.isArray(list) && list.some((element) => element === null)) return true;
  }
  return false;
}

/**
 * The `$match` queries of a view pipeline, in pipeline order (also those nested in
 * `$lookup` / `$unionWith` / `$facet` sub-pipelines).
 */
export function matchQueries(pipeline: unknown): Document[] {
  const queries: Document[] = [];
  forEachField(pipeline, (name, fieldValue) => {
    if (name === "$match" && isPlainDocument(fieldValue)) queries.push(fieldValue);
  });
  return queries;
}

/** True when a pipeline joins with `$lookup` on `localField` / `foreignField`. */
export function hasEqualityLookup(pipeline: unknown): boolean {
  let found = false;
  forEachField(pipeline, (name, fieldValue) => {
    if (name === "$lookup" && isPlainDocument(fieldValue) && "localField" in fieldValue)
      found = true;
  });
  return found;
}
