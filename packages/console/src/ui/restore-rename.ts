/**
 * "Restore as": where restored namespaces land, as the restore wizard offers it, and the
 * rename rules each choice sends to the server.
 *
 * The server (and the library's `engine/restore-rename.ts`) accepts rename rules as a
 * map of `from` → `to` with two forms only:
 *
 *   { "shop.*": "shop_restored.*" }     a whole database goes to another database
 *   { "shop.users": "shop.users_old" }  one collection gets a new name
 *
 * Exact rules win over whole-database rules. People rarely want to type those, so the
 * wizard offers four choices and generates the rules for the first three:
 *
 *   original   no rules: every namespace keeps its name
 *   copy       every chosen database `db` → `db<suffix>` (`shop` → `shop_restored`)
 *   database   the (single) chosen database → another database on the target
 *   custom     the rules typed by hand, one `from=to` per line (`parseRenameRules`)
 *
 * The database name checks mirror the library's, so a mistake is reported next to the
 * field instead of after a round trip. Pure functions, unit-tested in
 * restore-rename.test.ts.
 */

import { patternProblem, splitNamespace } from "./namespaces.ts";

/** The four "Restore as" choices (see the file header). */
export type RestoreAs = "original" | "copy" | "database" | "custom";

/** The suffix a copy gets unless the user types another: `shop` → `shop_restored`. */
export const DEFAULT_COPY_SUFFIX = "_restored";

/**
 * The value of the "New database…" option in the target database select. It contains
 * `*`, which no database name may contain, so it can never collide with a real one.
 */
export const NEW_DATABASE = "*new*";

/**
 * Characters the library refuses in a database name (`/ \ . space " $ * < > : | ?` and
 * NUL): the union of what MongoDB forbids on any platform, plus the namespace dot.
 */
const FORBIDDEN_DATABASE_CHARACTERS = /[/\\. "$*<>:|?\0]/;

/** MongoDB limits database names to 63 bytes (64 with the terminator). */
const MAX_DATABASE_NAME_BYTES = 63;

/**
 * Says what is wrong with a database name, as a sentence, or returns undefined when it
 * is a name the library will accept as a restore target.
 */
export function databaseNameProblem(name: string): string | undefined {
  if (name === "") return "Enter a database name.";
  if (FORBIDDEN_DATABASE_CHARACTERS.test(name)) {
    return 'Database names cannot contain spaces or any of / \\ . " $ * < > : | ?';
  }
  // Bytes, not characters: "é" counts twice, as it does for MongoDB.
  if (new TextEncoder().encode(name).length > MAX_DATABASE_NAME_BYTES) {
    return `Database names are limited to ${MAX_DATABASE_NAME_BYTES} bytes.`;
  }
  return undefined;
}

/** What the generated choices need besides the chosen databases. */
export interface RestoreAsOptions {
  /** For `copy`: appended to every database name. */
  readonly suffix: string;
  /** For `database`: the target database (an existing one or a new name). */
  readonly targetDatabase: string;
}

/**
 * The rename rules for a generated choice, or a message saying why there are none.
 *
 * `databases` are the databases of the chosen namespaces (see `databasesOf`). Whole-
 * database rules (`db.*`) are enough for every generated choice, because the wizard
 * restores whole databases or collections inside them under the same collection names.
 */
export function renameRulesFor(
  choice: Exclude<RestoreAs, "custom">,
  databases: readonly string[],
  options: RestoreAsOptions,
): Record<string, string> | string {
  if (choice === "original") return {};

  if (choice === "copy") {
    if (options.suffix === "") return "Enter a suffix, e.g. _restored.";
    const rules: Record<string, string> = {};
    for (const database of databases) {
      const copy = `${database}${options.suffix}`;
      const problem = databaseNameProblem(copy);
      if (problem !== undefined) return `"${copy}" is not a valid database name. ${problem}`;
      rules[`${database}.*`] = `${copy}.*`;
    }
    return rules;
  }

  // choice === "database": only one source database can go into one target database.
  const [source] = databases;
  if (source === undefined) return {}; // Nothing chosen; the namespace check reports it.
  if (databases.length > 1) return oneDatabaseOnly(databases);
  const target = options.targetDatabase;
  if (target === "") return "Choose the database to restore into.";
  const problem = databaseNameProblem(target);
  if (problem !== undefined) return problem;
  if (target === source) {
    return `"${source}" is the original database. Choose “Original names” to restore into it.`;
  }
  return { [`${source}.*`]: `${target}.*` };
}

/** Everything the "Restore as" part of the wizard remembers, whichever choice is active. */
export interface RestoreAsSettings {
  readonly kind: RestoreAs;
  /** For `copy`. */
  readonly suffix: string;
  /** For `database`: an existing database's name, `NEW_DATABASE`, or "" (not chosen yet). */
  readonly database: string;
  /** For `database` with `NEW_DATABASE`: the name typed for the new database. */
  readonly newDatabase: string;
  /** For `custom`: the typed `from=to` lines. */
  readonly customText: string;
}

/** What the wizard starts with: original names, and a ready suffix for a copy. */
export const DEFAULT_RESTORE_AS: RestoreAsSettings = {
  kind: "original",
  suffix: DEFAULT_COPY_SUFFIX,
  database: "",
  newDatabase: "",
  customText: "",
};

/**
 * The rename rules (or the problem with them) for the wizard's current settings, given
 * the databases of the chosen namespaces. The other settings are kept but ignored, so
 * switching back and forth between choices loses nothing.
 */
export function renameOf(
  settings: RestoreAsSettings,
  databases: readonly string[],
): Record<string, string> | string {
  if (settings.kind === "custom") {
    const rules = parseRenameRules(settings.customText);
    // No rules at all would quietly restore under the original names.
    if (typeof rules !== "string" && Object.keys(rules).length === 0) {
      return "Type at least one from=to rule, or choose “Original names”.";
    }
    return rules;
  }
  return renameRulesFor(settings.kind, databases, {
    suffix: settings.suffix.trim(),
    targetDatabase: (settings.database === NEW_DATABASE
      ? settings.newDatabase
      : settings.database
    ).trim(),
  });
}

/** Why "Into another database" cannot be used for collections from several databases. */
export function oneDatabaseOnly(databases: readonly string[]): string {
  return `“Into another database” needs collections from one database, but these come from ${databases.length} (${databases.join(", ")}). Restore them as a copy next to the original, or write custom rules.`;
}

/**
 * Parses rename rules typed by hand, one `from=to` per line (blank lines are skipped).
 * Returns the map or an error message naming the first bad line. Both sides must be
 * valid namespace patterns, and the library's finer rules are checked too
 * (`renameRuleProblem`), so a mistake shows next to the field instead of after the
 * server's dry run.
 */
export function parseRenameRules(text: string): Record<string, string> | string {
  const rules: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const equals = line.indexOf("=");
    if (equals <= 0) return `"${line}" is not from=to, e.g. shop.*=shop_restored.*`;
    const from = line.slice(0, equals).trim();
    const to = line.slice(equals + 1).trim();
    const problem = patternProblem(from) ?? patternProblem(to) ?? renameRuleProblem(from, to);
    if (problem !== undefined) return `"${line}": ${problem}.`;
    rules[from] = to;
  }
  return rules;
}

/** MongoDB limits a whole namespace (`db.collection`) to 255 bytes. */
const MAX_NAMESPACE_BYTES = 255;

/**
 * What the library (engine/restore-rename.ts) would refuse in one rule whose two sides
 * are already valid patterns, in words (lower case, no full stop), or undefined:
 *
 *   shop.*=shop_restored.*      a whole database → a whole database
 *   shop.users=shop.users_old   one collection → one collection, named exactly
 */
export function renameRuleProblem(from: string, to: string): string | undefined {
  const source = splitNamespace(from);
  const target = splitNamespace(to);
  if (source.collection === "*") {
    if (target.collection !== "*") {
      return `a whole-database rule needs a whole-database target, e.g. ${source.database}.*=${source.database}_restored.*`;
    }
    return databaseProblemInRule(source.database) ?? databaseProblemInRule(target.database);
  }
  if (from.includes("*") || to.includes("*")) {
    return "only whole databases can use a wildcard (shop.*); name other collections exactly";
  }
  const databaseProblem =
    databaseProblemInRule(source.database) ?? databaseProblemInRule(target.database);
  if (databaseProblem !== undefined) return databaseProblem;
  if (source.collection === "" || target.collection === "") {
    return "name the collection on both sides, e.g. shop.users=shop.users_old";
  }
  if (target.collection.includes("$")) return 'collection names cannot contain "$"';
  // `system.` collections belong to MongoDB itself (system.js is ordinary user data).
  if (target.collection.startsWith("system.") && target.collection !== "system.js") {
    return 'collection names starting with "system." are reserved';
  }
  if (new TextEncoder().encode(to).length > MAX_NAMESPACE_BYTES) {
    return `the target is longer than ${MAX_NAMESPACE_BYTES} bytes`;
  }
  return undefined;
}

/** `databaseNameProblem` worded for the middle of a rule's message. */
function databaseProblemInRule(name: string): string | undefined {
  const problem = databaseNameProblem(name);
  if (problem === undefined) return undefined;
  // "Database names cannot …" → "database names cannot …", without the full stop.
  return `${problem.charAt(0).toLowerCase()}${problem.slice(1)}`.replace(/\.$/, "");
}

/** Rules as the custom textarea shows them: one `from=to` per line. */
export function renameRulesToText(rules: Readonly<Record<string, string>>): string {
  return Object.entries(rules)
    .map(([from, to]) => `${from}=${to}`)
    .join("\n");
}

/**
 * Where one namespace lands under some rules, with the library's precedence: an exact
 * rule first, then the whole-database rule for its database, else the same name. Used
 * for the live "shop.users → shop_restored.users" preview.
 */
export function targetNamespace(ns: string, rules: Readonly<Record<string, string>>): string {
  const exact = rules[ns];
  if (exact !== undefined) return exact;
  const { database, collection } = splitNamespace(ns);
  const wholeDatabase = rules[`${database}.*`];
  if (wholeDatabase === undefined) return ns;
  // The target of a whole-database rule is `<db>.*`; keep its database part.
  return `${splitNamespace(wholeDatabase).database}.${collection}`;
}
