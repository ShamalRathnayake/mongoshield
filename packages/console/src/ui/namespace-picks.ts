/**
 * "Choose databases and collections": the plan editor's checkbox tree, as pure helpers
 * the component and the tests share.
 *
 * The tree's choices are kept as a list of include patterns ("picks"), the same form a
 * plan stores, so nothing has to be converted on save:
 *
 *   a whole database ticked      → "shop.*"      (also covers collections added later)
 *   single collections ticked    → "shop.users", "shop.orders"
 *
 * Ticking every collection of a database one by one collapses to "shop.*", because the
 * tree cannot show the difference. Picks the tree does not contain (a collection that
 * was dropped, or one on another connection) are kept, in their original order, until
 * the user removes them.
 *
 * `selectionModeOf` decides how an existing plan's patterns are shown: "everything"
 * (no include, no exclude), "pick" (only plain picks like the above) or "advanced"
 * (wildcards such as "*.sessions", or any exclude pattern).
 */

import type { DatabaseNode } from "../shared/api.ts";
import { patternProblem, splitNamespace } from "./namespaces.ts";

/** How the plan editor shows "What to back up". */
export type SelectionMode = "everything" | "pick" | "advanced";

/** A database's checkbox: every collection picked, some of them, or none. */
export type PickState = "all" | "some" | "none";

/** The pattern for a whole database: "shop" → "shop.*". */
export function wholeDatabase(database: string): string {
  return `${database}.*`;
}

/**
 * True for patterns the checkbox tree can show: "db.*" or "db.collection", with no
 * other wildcard. ("*.sessions", "shop.events.*" or "app_*.users" are advanced.)
 */
export function isPlainPick(pattern: string): boolean {
  if (pattern === "*" || patternProblem(pattern) !== undefined) return false;
  const { database, collection } = splitNamespace(pattern);
  if (database.includes("*")) return false;
  return collection === "*" || !collection.includes("*");
}

/** The mode an existing plan's patterns open in (see the file comment). */
export function selectionModeOf(
  include: readonly string[],
  exclude: readonly string[],
): SelectionMode {
  if (exclude.length > 0) return "advanced";
  if (include.length === 0) return "everything";
  return include.every(isPlainPick) ? "pick" : "advanced";
}

/** True when `collection` of `database` is picked, on its own or as part of "db.*". */
export function isPicked(
  picks: ReadonlySet<string>,
  database: string,
  collection: string,
): boolean {
  return picks.has(wholeDatabase(database)) || picks.has(`${database}.${collection}`);
}

/** The checkbox state of a database: all, some or none of its collections picked. */
export function databaseState(database: DatabaseNode, picks: ReadonlySet<string>): PickState {
  if (picks.has(wholeDatabase(database.name))) return "all";
  const count = database.collections.filter((collection) =>
    picks.has(`${database.name}.${collection.name}`),
  ).length;
  if (count === 0) return "none";
  return count === database.collections.length ? "all" : "some";
}

/** How many of a database's collections are picked. */
export function pickedCount(database: DatabaseNode, picks: ReadonlySet<string>): number {
  return database.collections.filter((collection) =>
    isPicked(picks, database.name, collection.name),
  ).length;
}

/**
 * Puts picks in a stable order and shape: tree order, a database whose collections are
 * all picked as "db.*", and picks the tree does not know at the end, as they were.
 */
export function normalizePicks(
  tree: readonly DatabaseNode[],
  picks: ReadonlySet<string>,
  previous: readonly string[] = [...picks],
): string[] {
  const result: string[] = [];
  // Everything the tree can describe, so the leftovers can be found afterwards.
  const known = new Set<string>();
  for (const database of tree) {
    const whole = wholeDatabase(database.name);
    known.add(whole);
    const names = database.collections.map((collection) => `${database.name}.${collection.name}`);
    for (const ns of names) known.add(ns);
    const everyCollection = names.length > 0 && names.every((ns) => picks.has(ns));
    if (picks.has(whole) || everyCollection) {
      result.push(whole);
    } else {
      result.push(...names.filter((ns) => picks.has(ns)));
    }
  }
  // Picks for namespaces this tree does not have: kept, in the order they were.
  const leftovers = [...new Set([...previous, ...picks])].filter(
    (pick) => picks.has(pick) && !known.has(pick),
  );
  return [...result, ...leftovers];
}

/** Ticks or unticks a whole database. */
export function setDatabasePicked(
  tree: readonly DatabaseNode[],
  picks: readonly string[],
  database: DatabaseNode,
  on: boolean,
): string[] {
  const next = new Set(picks);
  // Remove every pick inside the database first, then add the whole-database pattern.
  next.delete(wholeDatabase(database.name));
  for (const collection of database.collections) next.delete(`${database.name}.${collection.name}`);
  if (on) next.add(wholeDatabase(database.name));
  return normalizePicks(tree, next, picks);
}

/** Ticks or unticks one collection. */
export function setCollectionPicked(
  tree: readonly DatabaseNode[],
  picks: readonly string[],
  database: DatabaseNode,
  collection: string,
  on: boolean,
): string[] {
  const next = new Set(picks);
  const whole = wholeDatabase(database.name);
  if (!on && next.has(whole)) {
    // Unticking one collection of a whole database: the others stay picked, one by one.
    next.delete(whole);
    for (const other of database.collections) next.add(`${database.name}.${other.name}`);
  }
  const ns = `${database.name}.${collection}`;
  if (on) next.add(ns);
  else next.delete(ns);
  return normalizePicks(tree, next, picks);
}

/** Picks that point at nothing in the tree (dropped collections, another connection's). */
export function unknownPicks(tree: readonly DatabaseNode[], picks: readonly string[]): string[] {
  return picks.filter((pick) => {
    const { database, collection } = splitNamespace(pick);
    const node = tree.find((candidate) => candidate.name === database);
    if (node === undefined) return true;
    if (collection === "*") return false;
    return !node.collections.some((candidate) => candidate.name === collection);
  });
}

/**
 * The databases and collections whose name contains `query` (case-insensitive). A
 * database whose own name matches keeps all its collections. An empty query keeps all.
 */
export function filterTree(tree: readonly DatabaseNode[], query: string): DatabaseNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...tree];
  const result: DatabaseNode[] = [];
  for (const database of tree) {
    if (database.name.toLowerCase().includes(needle)) {
      result.push(database);
      continue;
    }
    const collections = database.collections.filter((collection) =>
      collection.name.toLowerCase().includes(needle),
    );
    if (collections.length > 0) result.push({ ...database, collections });
  }
  return result;
}

/** The estimated documents in a database (the sum over its collections). */
export function documentsIn(database: DatabaseNode): number {
  return database.collections.reduce((sum, collection) => sum + collection.estimatedDocuments, 0);
}

/**
 * "Select all" / "Select none" for what is shown: with no search, every database; with
 * a search, only the databases and collections that match it (`shown`, from
 * `filterTree`). A database shown with all its collections is ticked as a whole.
 */
export function setShownPicked(
  tree: readonly DatabaseNode[],
  picks: readonly string[],
  shown: readonly DatabaseNode[],
  on: boolean,
): string[] {
  let next = [...picks];
  for (const shownDatabase of shown) {
    // The full node, so a whole-database tick covers collections the search hid.
    const database = tree.find((candidate) => candidate.name === shownDatabase.name);
    if (database === undefined) continue;
    if (shownDatabase.collections.length === database.collections.length) {
      next = setDatabasePicked(tree, next, database, on);
    } else {
      for (const collection of shownDatabase.collections) {
        next = setCollectionPicked(tree, next, database, collection.name, on);
      }
    }
  }
  return next;
}

/** How many collections (and about how many documents) the picks cover in a tree. */
export function pickedTotals(
  tree: readonly DatabaseNode[],
  picks: readonly string[],
): { collections: number; total: number; documents: number } {
  const set = new Set(picks);
  let collections = 0;
  let total = 0;
  let documents = 0;
  for (const database of tree) {
    for (const collection of database.collections) {
      total += 1;
      if (isPicked(set, database.name, collection.name)) {
        collections += 1;
        documents += collection.estimatedDocuments;
      }
    }
  }
  return { collections, total, documents };
}
