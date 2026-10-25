/**
 * Namespace patterns in the browser: the same rules as the library's
 * `packages/mongoshield/src/mongo/namespace-filter.ts`, re-implemented here so the plan
 * editor can preview a selection live without a server round trip.
 *
 * A namespace is `<database>.<collection>`, split at the FIRST dot (collection names may
 * contain dots). A pattern matches each half separately; `*` matches any run of
 * characters; `*` alone matches everything. Empty `include` means "everything".
 */

import type { DatabaseNode } from "../shared/api.ts";

/** Splits `db.coll.with.dots` into `db` and `coll.with.dots`. */
export function splitNamespace(ns: string): { database: string; collection: string } {
  const dot = ns.indexOf(".");
  if (dot === -1) return { database: ns, collection: "" };
  return { database: ns.slice(0, dot), collection: ns.slice(dot + 1) };
}

/** Characters MongoDB forbids in database names (besides the dot). */
const FORBIDDEN_DATABASE_CHARACTERS = /[/\\ "$\0]/;

/** Says what is wrong with a pattern, or returns undefined when it is valid. */
export function patternProblem(pattern: string): string | undefined {
  if (pattern === "*") return undefined;
  if (pattern.length === 0) return "the pattern is empty";
  if (!pattern.includes(".")) {
    return `add a "." between database and collection (use "${pattern}.*" for a whole database)`;
  }
  const { database, collection } = splitNamespace(pattern);
  if (database.length === 0) return "the database part is empty";
  if (collection.length === 0) return "the collection part is empty";
  if (FORBIDDEN_DATABASE_CHARACTERS.test(database)) {
    return 'database names cannot contain /, \\, spaces, quotes or "$"';
  }
  return undefined;
}

/** `app_*` → /^app_.*$/s, every other character literal. */
function wildcardToRegExp(wildcard: string): RegExp {
  const parts = wildcard.split("*").map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`, "s");
}

/** True when `ns` matches one pattern. Invalid patterns match nothing. */
export function matchesPattern(pattern: string, ns: string): boolean {
  if (pattern === "*") return true;
  if (patternProblem(pattern) !== undefined) return false;
  const patternParts = splitNamespace(pattern);
  const nsParts = splitNamespace(ns);
  return (
    wildcardToRegExp(patternParts.database).test(nsParts.database) &&
    wildcardToRegExp(patternParts.collection).test(nsParts.collection)
  );
}

/** True when `ns` is included (or `include` is empty) and matches no `exclude` pattern. */
export function isSelected(
  ns: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  const included = include.length === 0 || include.some((pattern) => matchesPattern(pattern, ns));
  return included && !exclude.some((pattern) => matchesPattern(pattern, ns));
}

/** Every `db.collection` in a namespace tree, in tree order. */
export function namespacesOf(tree: readonly DatabaseNode[]): string[] {
  const result: string[] = [];
  for (const database of tree) {
    for (const collection of database.collections) {
      result.push(`${database.name}.${collection.name}`);
    }
  }
  return result;
}

/**
 * Applies restore rename rules (`{"app.*": "app_restored.*"}`) to a namespace.
 * The first matching rule wins; `*` in the target is replaced by what `*` matched in
 * the source (only single-wildcard rules are supported here, which covers the CLI's
 * documented forms). Returns the namespace unchanged when no rule matches.
 */
export function applyRename(ns: string, rename: Readonly<Record<string, string>>): string {
  for (const [from, to] of Object.entries(rename)) {
    if (from === ns) return to;
    const star = from.indexOf("*");
    if (star === -1 || from.indexOf("*", star + 1) !== -1) continue;
    const prefix = from.slice(0, star);
    const suffix = from.slice(star + 1);
    if (
      ns.startsWith(prefix) &&
      ns.endsWith(suffix) &&
      ns.length >= prefix.length + suffix.length
    ) {
      const captured = ns.slice(prefix.length, ns.length - suffix.length);
      return to.replace("*", captured);
    }
  }
  return ns;
}
