/**
 * Resolving a dotted field path (`"address.city"`, `"items.0.sku"`) inside a document
 * the way MongoDB's query matcher does, for the filter evaluator (`filter.ts`).
 *
 * A path can reach several values when it crosses arrays, and it can reach none.
 * The rules, checked against a real server (see test/integration/find.test.ts):
 *
 *   value at the step       next path part        what happens
 *   embedded document       a field it has        continue in that field
 *   embedded document       a field it lacks      MISSING ("the field does not exist")
 *   scalar (number, …)      anything              MISSING (nothing when the scalar
 *                                                 was reached by an array index)
 *   array                   a number "N"          continue in element N (if it exists)
 *                                                 AND in every element that is a
 *                                                 document (which may have a field "N")
 *   array                   a name                continue in every element that is a
 *                                                 document; other elements are skipped
 *
 * So `{ a: [1, 2] }` has no value at all at `a.b` (not even MISSING): it neither
 * equals null nor fails `$exists`. Nested arrays are not entered by name: in
 * `{ a: [[{ b: 1 }]] }` the path `a.b` reaches nothing, but `a.0.b` reaches 1.
 *
 * An array at the end of the path is usually matched element by element as well
 * as whole (`{ tags: "x" }` matches `{ tags: ["x", "y"] }`), but NOT when the path
 * reached it by an array index: in `{ a: [[1, 2]] }`, `a.0` is `[1, 2]` and
 * `{ "a.0": 1 }` does not match (the server behaves the same). `ReachedValue.expandable`
 * records this; whether an operator expands arrays at all is decided in `filter.ts`.
 */

import { documentFields, isDocument } from "./filter-values.ts";

/** Marks "the path ends at a field that does not exist". */
export const MISSING: unique symbol = Symbol("missing");

/** A value reached by a path (or MISSING). */
export type PathValue = unknown;

/** One value a path reached, and whether an array there may be matched element-wise. */
export interface ReachedValue {
  readonly value: PathValue;
  /** False when the last step was an array index (`a.0`), see the header comment. */
  readonly expandable: boolean;
}

/** Shared result objects for the common "nothing there" case. */
const REACHED_MISSING: ReachedValue = { value: MISSING, expandable: true };

/** Splits a dotted path into its parts. Empty parts are rejected by the filter compiler. */
export function splitPath(path: string): string[] {
  return path.split(".");
}

/** Every value `parts` reaches inside `root` (see the rules in the header comment). */
export function resolvePath(root: unknown, parts: readonly string[]): ReachedValue[] {
  const reached: ReachedValue[] = [];
  walk(root, parts, 0, false, reached);
  return reached;
}

/**
 * One step of `resolvePath`: `value` is what the parts before `index` reached;
 * `viaIndex` says whether the step that reached it was an array index.
 */
function walk(
  value: unknown,
  parts: readonly string[],
  index: number,
  viaIndex: boolean,
  reached: ReachedValue[],
): void {
  if (index === parts.length) {
    reached.push({ value, expandable: !viaIndex });
    return;
  }
  const part = parts[index] ?? "";

  if (Array.isArray(value)) {
    walkArray(value, parts, index, reached);
    return;
  }
  if (isDocument(value)) {
    const fields = documentFields(value);
    if (Object.hasOwn(fields, part)) walk(fields[part], parts, index + 1, false, reached);
    else reached.push(REACHED_MISSING);
    return;
  }
  // A scalar in the middle of the path: the field below it does not exist. The
  // server reports that as MISSING, except when the scalar was an array element
  // picked by index (`a.0.b` in `{ a: [5] }` reaches nothing at all).
  if (!viaIndex) reached.push(REACHED_MISSING);
}

/** An array in the middle of the path: positional element, then document elements. */
function walkArray(
  array: readonly unknown[],
  parts: readonly string[],
  index: number,
  reached: ReachedValue[],
): void {
  const part = parts[index] ?? "";
  const position = arrayPosition(part);
  if (position !== undefined && position < array.length) {
    walk(array[position], parts, index + 1, true, reached);
  }
  for (const element of array) {
    // Only documents are entered by name; scalars and nested arrays are skipped.
    if (isDocument(element)) walk(element, parts, index, false, reached);
  }
}

/**
 * The array index a path part names, or undefined. Only plain decimal digits count
 * ("01" or "+1" are field names, as on the server).
 */
function arrayPosition(part: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(part)) return undefined;
  const position = Number(part);
  return Number.isSafeInteger(position) ? position : undefined;
}
