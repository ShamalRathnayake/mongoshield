/**
 * Namespace patterns (`app.*`, `*.sessions`, `app.users`, `*`) and the include/exclude
 * filter built from them. Pure functions with no MongoDB access, so they are unit-tested
 * exhaustively; `namespaces.ts` combines them with discovery.
 *
 * A namespace is `<database>.<collection>`. Database names cannot contain dots but
 * collection names can (`app.events.2024`), so a namespace is always split at its FIRST
 * dot, and each half of a pattern is matched against the matching half of the namespace.
 */

import { MongoShieldError } from "../errors.ts";
import type { NamespacePattern } from "../types.ts";

/** Which namespaces to keep. An empty or missing `include` means "everything". */
export interface NamespaceFilterOptions {
  readonly include?: readonly NamespacePattern[] | undefined;
  readonly exclude?: readonly NamespacePattern[] | undefined;
}

/** A predicate over full namespaces such as `"app.users"`. */
export type NamespaceFilter = (ns: string) => boolean;

/** A validated pattern, ready to match. */
interface CompiledPattern {
  readonly source: string;
  readonly database: RegExp;
  readonly collection: RegExp;
  /** The database name when the database half has no wildcard (e.g. `admin` in `admin.x`). */
  readonly literalDatabase: string | undefined;
}

/** Compiled include and exclude lists. Internal to `src/mongo`. */
export interface NamespaceRules {
  readonly include: readonly CompiledPattern[];
  readonly exclude: readonly CompiledPattern[];
}

/** Characters MongoDB forbids in database names (besides the dot, which splits the pattern). */
const FORBIDDEN_DATABASE_CHARACTERS = /[/\\ "$\0]/;

/**
 * Builds a predicate that keeps a namespace when it matches some `include` pattern
 * (or `include` is empty) and matches no `exclude` pattern.
 *
 * `*` matches any run of characters, including none. `*` on its own matches every
 * namespace. This function only matches names: discovery separately skips internal
 * databases and `system.*` collections.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when a pattern is malformed.
 */
export function compileNamespaceFilter(options: NamespaceFilterOptions): NamespaceFilter {
  const rules = compileNamespaceRules(options);
  return (ns) => matchesRules(rules, ns);
}

/** Validates and compiles both pattern lists. */
export function compileNamespaceRules(options: NamespaceFilterOptions): NamespaceRules {
  return {
    include: (options.include ?? []).map(compilePattern),
    exclude: (options.exclude ?? []).map(compilePattern),
  };
}

/** True when `ns` is included and not excluded. */
export function matchesRules(rules: NamespaceRules, ns: string): boolean {
  const { database, collection } = splitNamespace(ns);
  const isIncluded =
    rules.include.length === 0 ||
    rules.include.some((pattern) => matchesPattern(pattern, database, collection));
  if (!isIncluded) return false;
  return !rules.exclude.some((pattern) => matchesPattern(pattern, database, collection));
}

/**
 * True when some namespace in `database` could be included. Lets discovery skip whole
 * databases without listing their collections (fewer round trips, fewer privilege errors).
 */
export function mayIncludeDatabase(rules: NamespaceRules, database: string): boolean {
  if (rules.include.length === 0) return true;
  return rules.include.some((pattern) => pattern.database.test(database));
}

/**
 * Databases named literally (without `*`) in include patterns. Internal databases such
 * as `admin` are only scanned when the user names them like this; `*.x` does not count.
 */
export function explicitlyNamedDatabases(rules: NamespaceRules): Set<string> {
  const names = new Set<string>();
  for (const pattern of rules.include) {
    if (pattern.literalDatabase !== undefined) names.add(pattern.literalDatabase);
  }
  return names;
}

/** Splits `db.coll.with.dots` at the first dot into `db` and `coll.with.dots`. */
export function splitNamespace(ns: string): { database: string; collection: string } {
  const dot = ns.indexOf(".");
  if (dot === -1) return { database: ns, collection: "" };
  return { database: ns.slice(0, dot), collection: ns.slice(dot + 1) };
}

function matchesPattern(pattern: CompiledPattern, database: string, collection: string): boolean {
  return pattern.database.test(database) && pattern.collection.test(collection);
}

/** Validates one pattern and turns each half into an anchored regular expression. */
function compilePattern(pattern: NamespacePattern): CompiledPattern {
  if (pattern === "*") {
    return { source: pattern, database: /^.*$/s, collection: /^.*$/s, literalDatabase: undefined };
  }
  const problem = patternProblem(pattern);
  if (problem !== undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Invalid namespace pattern ${JSON.stringify(pattern)}: ${problem}.`,
      {
        hint: 'Patterns look like "db.collection" and may use * as a wildcard: "app.*", "*.sessions", "app.users" or "*".',
      },
    );
  }
  const { database, collection } = splitNamespace(pattern);
  return {
    source: pattern,
    database: wildcardToRegExp(database),
    collection: wildcardToRegExp(collection),
    literalDatabase: database.includes("*") ? undefined : database,
  };
}

/** Describes what is wrong with a pattern, or returns undefined when it is valid. */
function patternProblem(pattern: unknown): string | undefined {
  if (typeof pattern !== "string") return "patterns must be strings";
  if (pattern.length === 0) return "the pattern is empty";
  if (!pattern.includes(".")) {
    return `it has no "." between database and collection (use "${pattern}.*" for a whole database)`;
  }
  const { database, collection } = splitNamespace(pattern);
  if (database.length === 0) return "the database part is empty";
  if (collection.length === 0) return "the collection part is empty";
  if (FORBIDDEN_DATABASE_CHARACTERS.test(database)) {
    return 'database names cannot contain /, \\, spaces, quotes, "$" or NUL';
  }
  if (collection.includes("\0")) return "collection names cannot contain NUL";
  return undefined;
}

/** `app_*` → /^app_.*$/s, with every other character matched literally. */
function wildcardToRegExp(wildcard: string): RegExp {
  const parts = wildcard.split("*").map(escapeRegExp);
  // The `s` flag lets `.*` cross any character; names never contain newlines, but a
  // wildcard should not silently stop matching if one ever did.
  return new RegExp(`^${parts.join(".*")}$`, "s");
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
