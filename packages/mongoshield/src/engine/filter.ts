/**
 * An in-process evaluator for MongoDB query filters, used by `find` to search a
 * backup without restoring it (src/engine/find.ts).
 *
 *   const matches = compileFilter({ "address.city": "Oslo", age: { $gte: 18 } });
 *   matches(document); // true / false, as collection.find(filter) would decide
 *
 * The filter is compiled once (validated, regexes built) into a tree of small
 * closures, then applied to every document of the backup.
 *
 * Supported (a documented subset of the server's query language):
 *
 *   field equality     { field: value }, dotted paths ("a.b", "items.0.sku"), arrays
 *                      (an array field matches when the whole array OR any element
 *                      matches), embedded documents (exact, field order matters)
 *   comparison         $eq $ne $gt $gte $lt $lte $in $nin
 *   element            $exists $type (names, numeric codes, arrays of them, "number")
 *   evaluation         $regex (+ $options i, m, s, u, x), regex literals
 *   arrays             $elemMatch (both forms) $size
 *   logical            $and $or $nor $not
 *   ignored            $comment
 *
 * Values compare in MongoDB's order with "type bracketing": `$gt: 5` only matches
 * numbers, `$lt: ISODate(…)` only dates. Numbers compare exactly across Int32, Long,
 * Double and Decimal128 (filter-values.ts); strings by UTF-8 bytes (simple collation).
 *
 * Anything else ($all, $mod, $expr, $where, $text, geo and bitwise operators) fails
 * with MS_CONFIG_INVALID naming every unsupported operator, rather than silently
 * matching the wrong documents.
 *
 * Regexes run on JavaScript's engine, not PCRE. Translated so they behave the same:
 * the `x` option (whitespace and `#` comments removed), options at the start of the
 * pattern (`(?i)…`), and the anchors `\A`, `\z`, `\Z`.
 *
 * Embedded documents compare in stored field order, also when their field names look
 * like integers ("0", "1"), which JavaScript objects would list first: documents read
 * from a backup carry their stored order (find-parse.ts). Filters written in
 * JavaScript have JavaScript's order, which is also what the driver sends the server.
 *
 * Known differences from the server, all edge cases:
 * - PCRE-only regex syntax still behaves differently or fails to compile: possessive
 *   quantifiers (`a++`), atomic groups (`(?>…)`), inline options anywhere but at the
 *   start, recursion, conditionals, `\h` / `\R`, and `$` without `m` (PCRE also
 *   matches before a final newline); the `l` option is rejected;
 * - documents changed by a converge backup's window (find-window.ts) lose the stored
 *   order of fields a change added, which only matters for integer-like names;
 * - collations are not supported: string comparison is always binary.
 *
 * The test suite checks results against `collection.find(filter)` on a real server
 * for random documents and filters (test/integration/find.test.ts).
 */

import type { Document } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import {
  MISSING,
  type PathValue,
  type ReachedValue,
  resolvePath,
  splitPath,
} from "./filter-path.ts";
import {
  BSON_TYPE_CODES,
  type BsonKind,
  bsonKind,
  bsonTag,
  canonicalRank,
  compareStrings,
  compareValues,
  isBsonKindName,
  isDocument,
  isNaNValue,
  NUMBER_KINDS,
  regexParts,
  toExactNumber,
  valuesEqual,
} from "./filter-values.ts";

/** A compiled filter: true when the document matches. */
export type DocumentMatcher = (document: Document) => boolean;

/** Every operator `compileFilter` understands, for error hints and docs. */
export const SUPPORTED_FILTER_OPERATORS: readonly string[] = [
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
  "$not",
  "$elemMatch",
  "$size",
  "$and",
  "$or",
  "$nor",
  "$comment",
];

/**
 * Compiles a MongoDB query filter into a matcher.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when the filter uses operators outside
 *   the supported subset (all of them are listed), or is malformed (e.g. `$in` without
 *   an array, `$size: -1`, an invalid regex).
 */
export function compileFilter(filter: unknown): DocumentMatcher {
  const compiler: Compiler = { unsupported: new Set(), problems: [] };
  let test: RootTest = () => true;
  if (isPlainDocument(filter)) {
    test = compileDocument(compiler, filter);
  } else {
    compiler.problems.push("the filter must be a document, e.g. { name: 'Ada' }");
  }
  throwIfInvalid(compiler);
  return (document) => test(document);
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Collects every problem of a filter, so one error can list them all. */
interface Compiler {
  readonly unsupported: Set<string>;
  readonly problems: string[];
}

/** Matches a document (or, inside `$elemMatch`, an array element treated as one). */
type RootTest = (root: unknown) => boolean;

/** A test of one value reached by a path (or MISSING). */
type ValueTest = (value: PathValue) => boolean;

/** A compiled condition on a field: `{ $gt: 5, $lt: 10 }`, `{ $size: 2 }`, a literal, … */
interface FieldCondition {
  /** True when the values a path reached satisfy the condition (server semantics). */
  readonly matchesPath: (values: readonly ReachedValue[]) => boolean;
  /** True when one value satisfies it directly (used by the value form of `$elemMatch`). */
  readonly matchesValue: ValueTest;
}

/**
 * A condition that holds when ANY reached value passes `test`. With `expandArrays`,
 * an array at the end of the path is tested element by element AND as a whole
 * (`{ tags: "x" }` matches `{ tags: ["x", "y"] }`); only one level is expanded, and
 * not for arrays reached by an index (see filter-path.ts).
 */
function anyValue(test: ValueTest, expandArrays: boolean): FieldCondition {
  return {
    matchesPath(values) {
      for (const { value, expandable } of values) {
        if (expandArrays && expandable && Array.isArray(value)) {
          for (const element of value) if (test(element)) return true;
        }
        if (test(value)) return true;
      }
      return false;
    },
    matchesValue: test,
  };
}

/** `$ne`, `$nin`, `$not`, `$exists: false`: the field-level negation of a condition. */
function negate(condition: FieldCondition): FieldCondition {
  return {
    matchesPath: (values) => !condition.matchesPath(values),
    matchesValue: (value) => !condition.matchesValue(value),
  };
}

/** Several operators on one field (`{ $gte: 1, $lt: 5 }`) must all hold. */
function allOf(conditions: readonly FieldCondition[]): FieldCondition {
  if (conditions.length === 1 && conditions[0] !== undefined) return conditions[0];
  return {
    matchesPath: (values) => conditions.every((condition) => condition.matchesPath(values)),
    matchesValue: (value) => conditions.every((condition) => condition.matchesValue(value)),
  };
}

const NEVER: FieldCondition = anyValue(() => false, false);

// ---------------------------------------------------------------------------
// Documents and logical operators
// ---------------------------------------------------------------------------

/** `{ field: condition, $or: [...], … }`: every entry must match. */
function compileDocument(compiler: Compiler, filter: Document): RootTest {
  const tests: RootTest[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$comment") continue;
    if (key === "$and" || key === "$or" || key === "$nor") {
      tests.push(compileLogical(compiler, key, value));
    } else if (key.startsWith("$")) {
      compiler.unsupported.add(key);
    } else {
      tests.push(compileField(compiler, key, value));
    }
  }
  return (root) => tests.every((test) => test(root));
}

/** `$and` / `$or` / `$nor`: a non-empty array of filter documents. */
function compileLogical(compiler: Compiler, operator: string, clauses: unknown): RootTest {
  if (!Array.isArray(clauses) || clauses.length === 0) {
    compiler.problems.push(`${operator} needs a non-empty array of filters`);
    return () => false;
  }
  const tests: RootTest[] = [];
  for (const clause of clauses) {
    if (isPlainDocument(clause)) tests.push(compileDocument(compiler, clause));
    else compiler.problems.push(`every element of ${operator} must be a filter document`);
  }
  if (operator === "$and") return (root) => tests.every((test) => test(root));
  if (operator === "$or") return (root) => tests.some((test) => test(root));
  return (root) => !tests.some((test) => test(root));
}

/** `"a.b": <literal or operators>`. */
function compileField(compiler: Compiler, path: string, value: unknown): RootTest {
  const parts = splitPath(path);
  if (parts.some((part) => part === "")) {
    compiler.problems.push(`"${path}" is not a valid field path (empty part)`);
  }
  const condition = isOperatorDocument(value)
    ? compileOperators(compiler, value)
    : compileEquality(value, compiler);
  return (root) => condition.matchesPath(resolvePath(root, parts));
}

// ---------------------------------------------------------------------------
// Field operators
// ---------------------------------------------------------------------------

/** `{ $gt: 1, $lt: 5, … }` on one field. */
function compileOperators(compiler: Compiler, operators: Document): FieldCondition {
  const conditions: FieldCondition[] = [];
  for (const [operator, operand] of Object.entries(operators)) {
    const condition = compileOperator(compiler, operator, operand, operators);
    if (condition !== undefined) conditions.push(condition);
  }
  return allOf(conditions);
}

/** One field operator. Returns undefined for operators that only modify another ($options). */
function compileOperator(
  compiler: Compiler,
  operator: string,
  operand: unknown,
  siblings: Document,
): FieldCondition | undefined {
  switch (operator) {
    case "$eq":
      return compileLiteralEquality(operand);
    case "$ne":
      return negate(compileLiteralEquality(operand));
    case "$gt":
    case "$gte":
    case "$lt":
    case "$lte":
      return compileComparison(operator, operand);
    case "$in":
      return compileMembership(compiler, operator, operand);
    case "$nin":
      return negate(compileMembership(compiler, operator, operand));
    case "$exists":
      return isTruthy(operand) ? EXISTS : negate(EXISTS);
    case "$type":
      return compileType(compiler, operand);
    case "$regex":
      return compileRegex(compiler, operand, siblings.$options);
    case "$options":
      if (!Object.hasOwn(siblings, "$regex")) compiler.problems.push("$options needs $regex");
      return undefined;
    case "$not":
      return compileNot(compiler, operand);
    case "$elemMatch":
      return compileElemMatch(compiler, operand);
    case "$size":
      return compileSize(compiler, operand);
    default:
      if (operator.startsWith("$")) compiler.unsupported.add(operator);
      else compiler.problems.push(`"${operator}" mixes a field name into an operator document`);
      return undefined;
  }
}

/**
 * `{ field: value }`. A regex value here is a pattern to match strings against
 * (`{ name: /^A/ }`); null also matches missing fields.
 */
function compileEquality(operand: unknown, compiler?: Compiler): FieldCondition {
  if (isRegexValue(operand)) return regexCondition(buildRegExp(operand, undefined, compiler));
  return compileLiteralEquality(operand);
}

/**
 * `$eq` / `$ne`: plain equality. Unlike the implicit form, `{ $eq: /^A/ }` matches
 * only a stored regex equal to `/^A/`, not strings (the server's rule).
 */
function compileLiteralEquality(operand: unknown): FieldCondition {
  return anyValue((value) => equalsOperand(value, operand), true);
}

/** Equality of one reached value with a filter operand. */
function equalsOperand(value: PathValue, operand: unknown): boolean {
  if (operand === null || operand === undefined) {
    // `null` matches both explicit nulls and missing fields (but not `undefined`).
    return value === MISSING || bsonKind(value) === "null";
  }
  return value !== MISSING && valuesEqual(value, operand);
}

/** True when a comparison result satisfies `$gt`, `$gte`, `$lt` or `$lte`. */
function comparisonHolds(operator: string, difference: number): boolean {
  switch (operator) {
    case "$gt":
      return difference > 0;
    case "$gte":
      return difference >= 0;
    case "$lt":
      return difference < 0;
    default:
      return difference <= 0;
  }
}

/**
 * `$gt` / `$gte` / `$lt` / `$lte`, with the server's special cases:
 * - against null, `$gte`/`$lte` mean "equals null" and `$gt`/`$lt` match nothing;
 * - against NaN, only `$gte`/`$lte` match (NaN values); NaN values never satisfy a
 *   comparison with a real number;
 * - against MinKey / MaxKey, every type compares (that is what they are for), and a
 *   missing field counts as null;
 * - otherwise only values of the operand's canonical type are compared.
 */
function compileComparison(operator: string, operand: unknown): FieldCondition {
  const inclusive = operator === "$gte" || operator === "$lte";
  const operandKind = bsonKind(operand);
  if (operandKind === "null" || operandKind === "undefined") {
    return inclusive ? compileLiteralEquality(null) : NEVER;
  }
  if (isNaNValue(operand)) {
    return inclusive ? anyValue((value) => value !== MISSING && isNaNValue(value), true) : NEVER;
  }
  if (operandKind === "minKey" || operandKind === "maxKey") {
    return anyValue(
      (value) =>
        comparisonHolds(operator, compareValues(value === MISSING ? null : value, operand)),
      true,
    );
  }
  const operandRank = canonicalRank(operand);
  return anyValue(
    (value) =>
      value !== MISSING &&
      canonicalRank(value) === operandRank &&
      !isNaNValue(value) &&
      comparisonHolds(operator, compareValues(value, operand)),
    true,
  );
}

/** `$in` / `$nin`: an array of literals and regexes. */
function compileMembership(compiler: Compiler, operator: string, operand: unknown): FieldCondition {
  if (!Array.isArray(operand)) {
    compiler.problems.push(`${operator} needs an array`);
    return NEVER;
  }
  const tests: ValueTest[] = [];
  for (const item of operand) {
    if (isOperatorDocument(item)) {
      compiler.problems.push(`${operator} cannot contain operators like ${firstKey(item)}`);
    } else if (isRegexValue(item)) {
      const regex = buildRegExp(item, undefined, compiler);
      tests.push((value) => regexMatches(regex, value));
    } else {
      tests.push((value) => equalsOperand(value, item));
    }
  }
  return anyValue((value) => tests.some((test) => test(value)), true);
}

/** `$exists: true`: the path reaches at least one value. */
const EXISTS: FieldCondition = anyValue((value) => value !== MISSING, false);

/** `$type`: a name ("string", "number"), a numeric code (2), or an array of them. */
function compileType(compiler: Compiler, operand: unknown): FieldCondition {
  const kinds = new Set<BsonKind>();
  const items = Array.isArray(operand) ? operand : [operand];
  if (items.length === 0) compiler.problems.push("$type needs at least one type");
  for (const item of items) {
    const resolved = typeKinds(item);
    if (resolved === undefined) {
      compiler.problems.push(`$type does not know the type ${describe(item)}`);
      continue;
    }
    for (const kind of resolved) kinds.add(kind);
  }
  return anyValue((value) => value !== MISSING && kinds.has(bsonKind(value)), true);
}

/** The kinds one `$type` item stands for, or undefined when it names no type. */
function typeKinds(item: unknown): readonly BsonKind[] | undefined {
  if (typeof item === "string") {
    if (item === "number") return NUMBER_KINDS;
    return isBsonKindName(item) ? [item] : undefined;
  }
  const code = wholeNumber(item);
  if (code === undefined) return undefined;
  const kind = BSON_TYPE_CODES[code];
  return kind === undefined ? undefined : [kind];
}

/** `$regex` (a string or regex) with optional `$options`. */
function compileRegex(compiler: Compiler, pattern: unknown, options: unknown): FieldCondition {
  if (typeof pattern !== "string" && !isRegexValue(pattern)) {
    compiler.problems.push("$regex needs a string or a regular expression");
    return NEVER;
  }
  if (options !== undefined && typeof options !== "string") {
    compiler.problems.push("$options needs a string such as 'i'");
    return NEVER;
  }
  return regexCondition(buildRegExp(pattern, options, compiler));
}

/** `$not`: a regex, or an operator document whose result is negated. */
function compileNot(compiler: Compiler, operand: unknown): FieldCondition {
  if (isRegexValue(operand))
    return negate(regexCondition(buildRegExp(operand, undefined, compiler)));
  if (isOperatorDocument(operand)) return negate(compileOperators(compiler, operand));
  compiler.problems.push(
    "$not needs a regex or a document of operators, e.g. { $not: { $gt: 5 } }",
  );
  return NEVER;
}

/**
 * `$elemMatch`: the field is an array with at least one element that matches.
 * `{ $elemMatch: { $gt: 1, $lt: 5 } }` (operators) tests each element as a value;
 * `{ $elemMatch: { sku: "x", qty: { $gt: 1 } } }` tests each element as a document.
 */
function compileElemMatch(compiler: Compiler, operand: unknown): FieldCondition {
  if (!isPlainDocument(operand)) {
    compiler.problems.push("$elemMatch needs a document");
    return NEVER;
  }
  const first = firstKey(operand);
  const valueForm = first?.startsWith("$") === true && !["$and", "$or", "$nor"].includes(first);
  if (valueForm) {
    const condition = compileOperators(compiler, operand);
    return anyValue(
      (value) => Array.isArray(value) && value.some((element) => condition.matchesValue(element)),
      false,
    );
  }
  const test = compileDocument(compiler, operand);
  return anyValue(
    (value) => Array.isArray(value) && value.some((element) => elementMatches(test, element)),
    false,
  );
}

/**
 * The document form of `$elemMatch` tests elements that are documents, and also
 * nested arrays, which the server then reads as documents with the fields "0", "1", …
 * (so `{ $elemMatch: { "0": 1 } }` matches `[[1, 2]]`, but `{ $elemMatch: { a: 0 } }`
 * does not match `[[{ a: 0 }]]`).
 */
function elementMatches(test: RootTest, element: unknown): boolean {
  if (isDocument(element)) return test(element);
  if (!Array.isArray(element)) return false;
  const asDocument: Document = {};
  element.forEach((item, index) => {
    asDocument[String(index)] = item;
  });
  return test(asDocument);
}

/** `$size: n`: the field is an array of exactly n elements (arrays are not expanded). */
function compileSize(compiler: Compiler, operand: unknown): FieldCondition {
  const size = wholeNumber(operand);
  if (size === undefined || size < 0) {
    compiler.problems.push(`$size needs a whole number ≥ 0 (got ${describe(operand)})`);
    return NEVER;
  }
  return anyValue((value) => Array.isArray(value) && value.length === size, false);
}

// ---------------------------------------------------------------------------
// Regular expressions
// ---------------------------------------------------------------------------

/**
 * Options MongoDB regexes accept that JavaScript has no equivalent for: `l` (locale
 * dependent `\w`, `\b`). `x` (extended syntax) is emulated by rewriting the pattern.
 */
const UNSUPPORTED_REGEX_OPTIONS = new Set(["l"]);

/** Options a pattern may switch on at its very start, PCRE style: `(?i)`, `(?sx)`. */
const LEADING_INLINE_OPTIONS = /^\(\?([imsx]+)\)/;

/** A compiled regex together with its BSON form, for matching stored regex values. */
interface CompiledRegex {
  readonly regExp: RegExp;
  readonly pattern: string;
  readonly options: string;
}

function regexCondition(regex: CompiledRegex): FieldCondition {
  return anyValue((value) => regexMatches(regex, value), true);
}

/** Strings (and symbols) match by search; stored regex values match when identical. */
function regexMatches(regex: CompiledRegex, value: PathValue): boolean {
  const kind = value === MISSING ? "undefined" : bsonKind(value);
  if (kind === "string") return regex.regExp.test(String(value));
  if (kind === "symbol") return regex.regExp.test(String(Reflect.get(Object(value), "value")));
  if (kind === "regex") {
    const stored = regexParts(value);
    return stored.pattern === regex.pattern && sameFlags(stored.flags, regex.options);
  }
  return false;
}

function sameFlags(left: string, right: string): boolean {
  return compareStrings([...left].sort().join(""), [...right].sort().join("")) === 0;
}

/**
 * Builds a JavaScript RegExp from a pattern (string, RegExp or BSONRegExp) and
 * MongoDB options. Unicode mode is used when the pattern allows it, because the
 * server's PCRE works on code points (`.` matches a whole emoji).
 */
function buildRegExp(
  source: unknown,
  extraOptions: string | undefined,
  compiler?: Compiler,
): CompiledRegex {
  const parts = typeof source === "string" ? { pattern: source, flags: "" } : regexParts(source);
  if (parts.flags !== "" && extraOptions !== undefined && extraOptions !== "") {
    compiler?.problems.push("options are given both in the regex and in $options");
  }
  const options = `${parts.flags}${extraOptions ?? ""}`;
  // `g` and `y` make RegExp.test stateful; MongoDB has no such options, so drop them.
  const flags = [...new Set(options)].filter((flag) => !["g", "y", "d"].includes(flag));
  for (const flag of flags) {
    if (UNSUPPORTED_REGEX_OPTIONS.has(flag)) {
      compiler?.unsupported.add(`$options "${flag}"`);
    }
  }
  const translated = translatePcre(parts.pattern, new Set(flags));
  const jsFlags = [...translated.flags].filter((flag) => ["i", "m", "s"].includes(flag)).join("");
  return {
    regExp: compileRegExp(translated.pattern, jsFlags, compiler),
    pattern: parts.pattern,
    options: flags.join(""),
  };
}

/**
 * Rewrites the PCRE features JavaScript lacks but can express:
 * - leading inline options, `(?i)^abc` → flag `i`;
 * - the `x` option (extended syntax): whitespace and `#` comments outside character
 *   classes are removed, escaped whitespace and `\#` stay as literal characters;
 * - the anchors `\A` (start of the subject), `\z` (end) and `\Z` (end, or before a
 *   final newline), as lookarounds.
 */
function translatePcre(
  pattern: string,
  options: ReadonlySet<string>,
): { pattern: string; flags: ReadonlySet<string> } {
  const flags = new Set(options);
  let rest = pattern;
  const leading = LEADING_INLINE_OPTIONS.exec(rest);
  if (leading !== null) {
    for (const flag of leading[1] ?? "") flags.add(flag);
    rest = rest.slice(leading[0].length);
  }
  return { pattern: rewritePattern(rest, flags.has("x")), flags };
}

/** Whitespace the PCRE `x` option ignores. */
const PCRE_EXTENDED_SPACE = new Set([" ", "\t", "\n", "\v", "\f", "\r"]);

/** JavaScript forms of PCRE-only anchors. */
const PCRE_ANCHORS: Readonly<Record<string, string>> = {
  A: "(?<![\\s\\S])",
  z: "(?![\\s\\S])",
  Z: "(?=\\n?(?![\\s\\S]))",
};

/** One pass over the pattern, tracking escapes and character classes (see translatePcre). */
function rewritePattern(pattern: string, extended: boolean): string {
  let output = "";
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index] ?? "";
    if (character === "\\") {
      const next = pattern[index + 1];
      index += 1;
      if (next === undefined) output += character;
      else if (!inClass && extended && (PCRE_EXTENDED_SPACE.has(next) || next === "#")) {
        output += next; // `\ ` is a literal space; JavaScript's Unicode mode rejects `\ `.
      } else if (!inClass && Object.hasOwn(PCRE_ANCHORS, next)) {
        output += PCRE_ANCHORS[next];
      } else output += `${character}${next}`;
      continue;
    }
    if (inClass) {
      if (character === "]") inClass = false;
      output += character;
      continue;
    }
    if (character === "[") {
      inClass = true;
      output += character;
      continue;
    }
    if (extended && PCRE_EXTENDED_SPACE.has(character)) continue;
    if (extended && character === "#") {
      // A comment runs to the end of the line.
      while (index + 1 < pattern.length && pattern[index + 1] !== "\n") index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

/** `new RegExp`, trying Unicode mode first and reporting invalid patterns. */
function compileRegExp(pattern: string, flags: string, compiler: Compiler | undefined): RegExp {
  try {
    return new RegExp(pattern, `${flags}u`);
  } catch {
    // Unicode mode is stricter about escapes (`\-` outside a class); fall back.
  }
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    compiler?.problems.push(
      `invalid regular expression /${pattern}/: ${error instanceof Error ? error.message : String(error)}`,
    );
    return /(?!)/;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A plain embedded document (not an ObjectId, Date, array, …). */
function isPlainDocument(value: unknown): value is Document {
  return isDocument(value) && bsonTag(value) === undefined;
}

/**
 * `{ $gt: 1 }` is an operator document; `{ city: "Oslo" }` and DBRefs
 * (`{ $ref, $id }`) are literal values. The first key decides, as on the server.
 */
function isOperatorDocument(value: unknown): value is Document {
  if (!isPlainDocument(value)) return false;
  const first = firstKey(value);
  if (first === undefined || !first.startsWith("$")) return false;
  return !(Object.hasOwn(value, "$ref") && Object.hasOwn(value, "$id"));
}

function isRegexValue(value: unknown): boolean {
  return bsonKind(value) === "regex";
}

function firstKey(document: Document): string | undefined {
  for (const key of Object.keys(document)) return key;
  return undefined;
}

/** `$exists` truthiness: false, 0, null and undefined are false; everything else is true. */
function isTruthy(value: unknown): boolean {
  if (value === false || value === null || value === undefined) return false;
  if (canonicalRank(value) === canonicalRank(0)) {
    const exact = toExactNumber(value);
    return !(exact.kind === "finite" && exact.numerator === 0n);
  }
  return true;
}

/** The value of an integral number of any numeric type, or undefined. */
function wholeNumber(value: unknown): number | undefined {
  if (canonicalRank(value) !== canonicalRank(0)) return undefined;
  const exact = toExactNumber(value);
  if (exact.kind !== "finite" || exact.numerator % exact.denominator !== 0n) return undefined;
  const whole = Number(exact.numerator / exact.denominator);
  return Number.isSafeInteger(whole) ? whole : undefined;
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value !== null && typeof value === "object") return bsonKind(value);
  return String(value);
}

/** Throws one MS_CONFIG_INVALID listing every unsupported operator and problem. */
function throwIfInvalid(compiler: Compiler): void {
  const unsupported = [...compiler.unsupported].sort();
  if (unsupported.length > 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The filter uses ${unsupported.length === 1 ? "an operator" : "operators"} that find does not support: ${unsupported.join(", ")}.`,
      {
        hint: `Supported: ${SUPPORTED_FILTER_OPERATORS.join(" ")}. For anything else, restore the collection under another name (mongoshield restore --include <ns> --rename …) and query it there.`,
        details: { unsupported },
      },
    );
  }
  if (compiler.problems.length > 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The filter is not valid: ${compiler.problems.join("; ")}.`,
      {
        hint: "Check the filter against MongoDB's query syntax.",
        details: { problems: compiler.problems },
      },
    );
  }
}
