/**
 * Field paths in mask rules and subset `follow` rules, and walking documents along them.
 *
 *   email                     a top-level field
 *   profile.phone             a field of an embedded document
 *   addresses.*.street        `*` = every array element (or every key of a sub-document)
 *   addresses.0.street        a number selects one array element
 *   addresses.street          an array on the way is traversed implicitly, like MongoDB
 *                             queries do: this matches `street` in every element
 *
 * Documents are schemaless, so a path is only checked for syntax; whether it ever
 * matches is reported after the copy (see `masker.ts`).
 */

import type { Document } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { isEmbeddedDocument } from "./values.ts";

/** A parsed path: one entry per segment, `*` for the wildcard. */
export type FieldPath = readonly string[];

/** Wildcard segment: every array element or every key. */
export const WILDCARD = "*";

/** Returned by a visitor to remove the value it was given. */
export const REMOVE: unique symbol = Symbol("mongoshield.mask.remove");

/**
 * Called for every value a path selects. Returns the replacement value (the same
 * value to leave it alone) or `REMOVE` to delete it.
 *
 * `location` is the concrete path of the value, e.g. `addresses.1.street`.
 */
export type PathVisitor = (value: unknown, location: string) => unknown;

/**
 * Parses and validates a dotted path.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for empty paths or segments, and for
 *   segments starting with `$` (operators, never field names in a rule).
 */
export function parseFieldPath(path: string): FieldPath {
  const problem = pathProblem(path);
  if (problem !== undefined) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Invalid field path "${path}": ${problem}.`, {
      hint: 'Paths look like "email", "profile.phone" or "addresses.*.street" (* = every array element).',
    });
  }
  return path.split(".");
}

function pathProblem(path: unknown): string | undefined {
  if (typeof path !== "string") return "paths must be strings";
  if (path.length === 0) return "the path is empty";
  for (const segment of path.split(".")) {
    if (segment.length === 0)
      return "it has an empty segment (two dots, or a leading/trailing dot)";
    if (segment.startsWith("$")) return `segment "${segment}" starts with "$"`;
  }
  return undefined;
}

/**
 * Calls `visitor` for every value `path` selects in `document`, and applies what it
 * returns: a new value replaces the old one, `REMOVE` deletes it (an object key is
 * deleted, an array element is spliced out). Changes the document in place.
 *
 * @returns how many values were visited.
 */
export function visitPath(document: Document, path: FieldPath, visitor: PathVisitor): number {
  return visitContainer(document, path, 0, "", visitor);
}

/**
 * Every value `path` selects, without changing anything. Arrays found at the end of
 * the path are flattened into their elements (a `follow` rule on `tagIds` follows
 * every id in the array, as `$in` would match them).
 */
export function collectPathValues(document: Document, path: FieldPath): unknown[] {
  const values: unknown[] = [];
  visitPath(document, path, (value) => {
    if (Array.isArray(value)) values.push(...flatten(value));
    else values.push(value);
    return value;
  });
  return values;
}

function flatten(values: readonly unknown[]): unknown[] {
  const flat: unknown[] = [];
  for (const value of values) {
    if (Array.isArray(value)) flat.push(...flatten(value));
    else flat.push(value);
  }
  return flat;
}

/** Walks one level: `container` is a document or an array, `path[index]` the segment to apply. */
function visitContainer(
  container: unknown,
  path: FieldPath,
  index: number,
  location: string,
  visitor: PathVisitor,
): number {
  const segment = path[index];
  if (segment === undefined) return 0;
  if (Array.isArray(container)) return visitArray(container, path, index, location, visitor);
  if (!isEmbeddedDocument(container)) return 0;

  const isLast = index === path.length - 1;
  const keys = segment === WILDCARD ? Object.keys(container) : [segment];
  let visited = 0;
  for (const key of keys) {
    if (!Object.hasOwn(container, key)) continue;
    const childLocation = join(location, key);
    if (isLast) {
      visited += 1;
      const replacement = visitor(container[key], childLocation);
      if (replacement === REMOVE) delete container[key];
      else if (replacement !== container[key]) container[key] = replacement;
    } else {
      visited += visitContainer(container[key], path, index + 1, childLocation, visitor);
    }
  }
  return visited;
}

/**
 * An array under a segment: `*` and numbers select elements; any other segment is
 * applied to each element (implicit traversal), keeping the same segment index.
 */
function visitArray(
  array: unknown[],
  path: FieldPath,
  index: number,
  location: string,
  visitor: PathVisitor,
): number {
  const segment = path[index] ?? "";
  const position = arrayIndex(segment);
  if (segment !== WILDCARD && position === undefined) {
    let visited = 0;
    array.forEach((element, elementIndex) => {
      visited += visitContainer(
        element,
        path,
        index,
        join(location, String(elementIndex)),
        visitor,
      );
    });
    return visited;
  }

  const isLast = index === path.length - 1;
  const positions =
    position === undefined ? array.map((_element, elementIndex) => elementIndex) : [position];
  const removed: number[] = [];
  let visited = 0;
  for (const elementIndex of positions) {
    if (elementIndex >= array.length) continue;
    const childLocation = join(location, String(elementIndex));
    if (isLast) {
      visited += 1;
      const replacement = visitor(array[elementIndex], childLocation);
      if (replacement === REMOVE) removed.push(elementIndex);
      else if (replacement !== array[elementIndex]) array[elementIndex] = replacement;
    } else {
      visited += visitContainer(array[elementIndex], path, index + 1, childLocation, visitor);
    }
  }
  // Splice from the back so earlier indexes stay valid.
  for (const elementIndex of removed.reverse()) array.splice(elementIndex, 1);
  return visited;
}

/** `"3"` → 3; anything that is not a plain non-negative integer → undefined. */
function arrayIndex(segment: string): number | undefined {
  return /^(0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : undefined;
}

function join(location: string, key: string): string {
  return location === "" ? key : `${location}.${key}`;
}
