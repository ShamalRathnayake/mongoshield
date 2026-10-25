/**
 * Projections for `find` over a backup: `{ name: 1, "address.city": 1 }` keeps only
 * those fields, `{ password: 0 }` drops fields. This is the plain inclusion /
 * exclusion subset of MongoDB's projection language, applied in-process to each
 * matching document (src/engine/find.ts).
 *
 * Rules, as on the server:
 * - a projection either includes or excludes fields; only `_id` may differ
 *   (`{ name: 1, _id: 0 }`); `_id` is included unless excluded explicitly;
 * - dotted paths descend into embedded documents, and into every document of an
 *   array (`{ "items.sku": 1 }`). In inclusion mode, array elements that are not
 *   documents are dropped and documents keep only the included fields; in exclusion
 *   mode they are kept as they are;
 * - operators (`$slice`, `$elemMatch`, `$`, `$meta`) and expressions are not
 *   supported and fail with MS_CONFIG_INVALID.
 */

import type { Document } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { documentFields, isDocument, toExactNumber } from "./filter-values.ts";

/** Turns a matching document into what `find` returns. */
export type Projector = (document: Document) => Document;

/** A tree of projected paths: `{ address: { city: true } }` for `"address.city"`. */
interface PathTree {
  [field: string]: PathTree | true;
}

/** Returns the document unchanged (no projection given). */
const IDENTITY: Projector = (document) => document;

/**
 * Compiles a projection document.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for operators, expressions, or a mix
 *   of included and excluded fields.
 */
export function compileProjection(projection: Document | undefined): Projector {
  if (projection === undefined || Object.keys(projection).length === 0) return IDENTITY;

  let includeId = true;
  const included: string[] = [];
  const excluded: string[] = [];
  for (const [path, flag] of Object.entries(projection)) {
    const include = projectionFlag(path, flag);
    if (path === "_id") includeId = include;
    else if (include) included.push(path);
    else excluded.push(path);
  }

  if (included.length > 0 && excluded.length > 0) {
    throw invalidProjection(
      `it mixes included (${included.join(", ")}) and excluded (${excluded.join(", ")}) fields`,
    );
  }
  if (included.length > 0) {
    const tree = buildTree(includeId ? [...included, "_id"] : included);
    return (document) => includeFields(document, tree);
  }
  const tree = buildTree(includeId ? excluded : [...excluded, "_id"]);
  return (document) => excludeFields(document, tree);
}

/** `1`/`true` include, `0`/`false` exclude; anything else is not supported. */
function projectionFlag(path: string, flag: unknown): boolean {
  if (path.startsWith("$") || path.split(".").some((part) => part === "" || part.startsWith("$"))) {
    throw invalidProjection(`"${path}" is not a plain field path`);
  }
  if (typeof flag === "boolean") return flag;
  const exact = isDocument(flag) ? undefined : toExactNumber(flag);
  if (exact?.kind === "finite" && exact.denominator === 1n) return exact.numerator !== 0n;
  throw invalidProjection(
    `"${path}" must be 1 or 0 (projection operators and expressions are not supported)`,
  );
}

function buildTree(paths: readonly string[]): PathTree {
  const root: PathTree = {};
  for (const path of paths) addPath(root, path.split("."));
  return root;
}

/** Adds one path to the tree. A path below one that is projected whole adds nothing. */
function addPath(root: PathTree, parts: readonly string[]): void {
  let node = root;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] ?? "";
    if (index === parts.length - 1) {
      node[part] = true;
      return;
    }
    const child = node[part];
    if (child === true) return;
    const next: PathTree = child ?? {};
    node[part] = next;
    node = next;
  }
}

/** Inclusion: keeps only the fields in the tree, in the document's own field order. */
function includeFields(document: Document, tree: PathTree): Document {
  const result: Document = {};
  for (const [field, value] of Object.entries(document)) {
    const node = tree[field];
    if (node === undefined) continue;
    if (node === true) {
      result[field] = value;
      continue;
    }
    const projected = includeNested(value, node);
    if (projected !== undefined) result[field] = projected;
  }
  return result;
}

/** Inclusion below a field: documents are projected; arrays element by element. */
function includeNested(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) {
    const elements: unknown[] = [];
    for (const element of value) {
      const projected = includeNested(element, tree);
      if (projected !== undefined) elements.push(projected);
    }
    return elements;
  }
  if (isDocument(value)) return includeFields(documentFields(value), tree);
  // A scalar where the projection expected a document is dropped.
  return undefined;
}

/** Exclusion: removes the fields in the tree, keeps everything else. */
function excludeFields(document: Document, tree: PathTree): Document {
  const result: Document = {};
  for (const [field, value] of Object.entries(document)) {
    const node = tree[field];
    if (node === true) continue;
    result[field] = node === undefined ? value : excludeNested(value, node);
  }
  return result;
}

function excludeNested(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) return value.map((element) => excludeNested(element, tree));
  if (isDocument(value)) return excludeFields(documentFields(value), tree);
  return value;
}

function invalidProjection(problem: string): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", `The projection is not valid: ${problem}.`, {
    hint: 'Use field paths with 1 (include) or 0 (exclude), e.g. { name: 1, "address.city": 1 }.',
  });
}
