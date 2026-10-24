/**
 * The `rename` option of a restore: where each backed-up namespace lands.
 *
 *   { "app.*": "app_restored.*" }        every collection of `app` goes to `app_restored`
 *   { "app.users": "app.users_old" }     one collection gets a new name (and/or database)
 *
 * Exact rules win over database wildcards, so both can be combined:
 * `{ "app.*": "staging.*", "app.users": "staging.people" }`.
 *
 * Pure functions with no MongoDB access, unit-tested in `restore-rename.test.ts`.
 */

import { MongoShieldError } from "../errors.ts";
import { splitNamespace } from "../mongo/index.ts";

/** Maps a source namespace (`db.collection`) to its target namespace. */
export type NamespaceMapper = (ns: string) => string;

/**
 * Characters MongoDB forbids in database names on some platform. The dot also
 * splits namespaces. We reject the union so a backup restores the same way everywhere.
 */
const FORBIDDEN_DATABASE_CHARACTERS = /[/\\. "$*<>:|?\0]/;

/** Database names are limited to 63 bytes (64 including the terminator). */
const MAX_DATABASE_NAME_BYTES = 63;

/** MongoDB limits a full namespace (`db.collection`) to 255 bytes. */
const MAX_NAMESPACE_BYTES = 255;

const RENAME_HINT =
  'Rename rules look like { "app.users": "app.users_old" } or { "app.*": "app_restored.*" }.';

/** Compiled rename rules. */
interface RenameRules {
  /** `app.users` → `app.users_old`. */
  readonly exact: ReadonlyMap<string, string>;
  /** Database-level rules: `app` → `app_restored`. */
  readonly databases: ReadonlyMap<string, string>;
}

/**
 * Validates the rename rules and returns a function applying them.
 * Namespaces matched by no rule keep their name.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for malformed rules or invalid target names.
 */
export function compileRenameMap(
  rename: Readonly<Record<string, string>> | undefined,
): NamespaceMapper {
  const rules = compileRules(rename ?? {});
  return (ns) => applyRules(rules, ns);
}

/** Sorts each rule into the exact or database-wildcard table, validating it. */
function compileRules(rename: Readonly<Record<string, string>>): RenameRules {
  const exact = new Map<string, string>();
  const databases = new Map<string, string>();

  for (const [from, to] of Object.entries(rename)) {
    if (typeof to !== "string") throw renameError(from, String(to), "the target must be a string");
    const source = splitNamespace(from);
    const target = splitNamespace(to);
    const isWildcard = source.collection === "*";

    if (isWildcard) {
      if (target.collection !== "*") {
        throw renameError(
          from,
          to,
          `a whole-database rule needs a whole-database target ("<db>.*")`,
        );
      }
      assertValidDatabaseName(source.database, from, to);
      assertValidDatabaseName(target.database, from, to);
      databases.set(source.database, target.database);
      continue;
    }

    if (from.includes("*") || to.includes("*")) {
      throw renameError(
        from,
        to,
        'only whole databases can use a wildcard ("app.*"); name other collections exactly',
      );
    }
    assertValidDatabaseName(source.database, from, to);
    if (source.collection.length === 0) {
      throw renameError(from, to, "the source has no collection name");
    }
    assertValidTargetNamespace(to);
    exact.set(from, to);
  }
  return { exact, databases };
}

/** Exact rules first, then the database rule for the namespace's database. */
function applyRules(rules: RenameRules, ns: string): string {
  const exactTarget = rules.exact.get(ns);
  if (exactTarget !== undefined) return exactTarget;

  const { database, collection } = splitNamespace(ns);
  const targetDatabase = rules.databases.get(database);
  if (targetDatabase === undefined) return ns;
  return `${targetDatabase}.${collection}`;
}

/**
 * Throws unless `ns` can be created as a user collection: a valid database name,
 * a collection name that is not empty, has no `$` or NUL and is not a `system.`
 * collection, and a total length within MongoDB's limit.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID`
 */
export function assertValidTargetNamespace(ns: string): void {
  const { database, collection } = splitNamespace(ns);
  const problem =
    databaseNameProblem(database) ?? collectionNameProblem(collection) ?? lengthProblem(ns);
  if (problem !== undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `"${ns}" is not a valid restore target: ${problem}.`,
      { hint: RENAME_HINT },
    );
  }
}

function assertValidDatabaseName(database: string, from: string, to: string): void {
  const problem = databaseNameProblem(database);
  if (problem !== undefined) throw renameError(from, to, problem);
}

function databaseNameProblem(database: string): string | undefined {
  if (database.length === 0) return "the database name is empty";
  if (FORBIDDEN_DATABASE_CHARACTERS.test(database)) {
    return `database name "${database}" contains a character MongoDB does not allow (/ \\ . space " $ * < > : | ? NUL)`;
  }
  if (Buffer.byteLength(database, "utf8") > MAX_DATABASE_NAME_BYTES) {
    return `database name "${database}" is longer than ${MAX_DATABASE_NAME_BYTES} bytes`;
  }
  return undefined;
}

function collectionNameProblem(collection: string): string | undefined {
  if (collection.length === 0) return "the collection name is empty";
  if (collection.includes("$")) return 'collection names cannot contain "$"';
  if (collection.includes("\0")) return "collection names cannot contain NUL";
  // `system.*` collections are reserved for the server. (`system.js` is user data,
  // but restoring it under another name would be surprising, so keep it simple.)
  if (collection.startsWith("system.") && collection !== "system.js") {
    return 'collection names starting with "system." are reserved';
  }
  return undefined;
}

function lengthProblem(ns: string): string | undefined {
  if (Buffer.byteLength(ns, "utf8") > MAX_NAMESPACE_BYTES) {
    return `the namespace is longer than ${MAX_NAMESPACE_BYTES} bytes`;
  }
  return undefined;
}

function renameError(from: string, to: string, problem: string): MongoShieldError {
  return new MongoShieldError(
    "MS_CONFIG_INVALID",
    `Invalid rename rule ${JSON.stringify(from)} → ${JSON.stringify(to)}: ${problem}.`,
    { hint: RENAME_HINT },
  );
}
