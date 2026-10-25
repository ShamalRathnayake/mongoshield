/**
 * Choosing namespaces by database: the pure logic behind the restore wizard's
 * "What to restore" picker (pages/restore-namespace-picker.tsx).
 *
 * A backup lists flat namespaces (`shop.users`, `shop.orders`, `analytics.daily`).
 * People think in databases first, so the picker groups them by database, shows a
 * "whole database" checkbox per group that can be checked, unchecked or mixed, and
 * lets a search narrow the list. Everything here is a plain function over strings and
 * sets, so it is unit-tested without rendering anything (namespace-selection.test.ts).
 */

import { splitNamespace } from "./namespaces.ts";

/** The namespaces of one database, in the order the backup lists them. */
export interface DatabaseGroup<Entry extends { readonly ns: string }> {
  /** The database name (the part of the namespace before the first dot). */
  readonly database: string;
  /** Its namespaces, each with whatever extra data the caller attached (counts, type…). */
  readonly entries: readonly Entry[];
}

/**
 * Groups namespaces by database. Databases appear in the order their first namespace
 * appears, and namespaces keep their order inside a group, so the picker matches the
 * order of the backup's manifest.
 */
export function groupByDatabase<Entry extends { readonly ns: string }>(
  entries: readonly Entry[],
): DatabaseGroup<Entry>[] {
  // A Map keeps insertion order, which gives "order of first appearance" for free.
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const { database } = splitNamespace(entry.ns);
    const group = groups.get(database);
    if (group === undefined) groups.set(database, [entry]);
    else group.push(entry);
  }
  return [...groups].map(([database, groupEntries]) => ({ database, entries: groupEntries }));
}

/**
 * Narrows the groups to what matches a search, case-insensitively:
 * - a database whose NAME matches keeps all its collections (searching "shop" shows
 *   the whole shop database);
 * - otherwise only the collections whose full namespace matches stay, and a database
 *   with none left disappears.
 * An empty (or all-space) query returns the groups unchanged.
 */
export function filterGroups<Entry extends { readonly ns: string }>(
  groups: readonly DatabaseGroup<Entry>[],
  query: string,
): DatabaseGroup<Entry>[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...groups];
  const result: DatabaseGroup<Entry>[] = [];
  for (const group of groups) {
    if (group.database.toLowerCase().includes(needle)) {
      result.push(group);
      continue;
    }
    const entries = group.entries.filter((entry) => entry.ns.toLowerCase().includes(needle));
    if (entries.length > 0) result.push({ database: group.database, entries });
  }
  return result;
}

/** How much of a group is chosen: everything, part of it, or nothing. */
export type GroupState = "all" | "some" | "none";

/**
 * The state of a "whole database" checkbox: `all` (checked), `some` (mixed, drawn as a
 * dash) or `none` (unchecked). An empty group counts as `none`.
 */
export function groupState(namespaces: readonly string[], chosen: ReadonlySet<string>): GroupState {
  const count = namespaces.filter((ns) => chosen.has(ns)).length;
  if (count === 0) return "none";
  return count === namespaces.length ? "all" : "some";
}

/**
 * Returns a NEW set with `namespaces` added (`selected` true) or removed (false).
 * Used by the "whole database" checkboxes and the "Select all / none" buttons; the set
 * passed in is never changed, so React sees a new value.
 */
export function setChosen(
  chosen: ReadonlySet<string>,
  namespaces: readonly string[],
  selected: boolean,
): Set<string> {
  const next = new Set(chosen);
  for (const ns of namespaces) {
    if (selected) next.add(ns);
    else next.delete(ns);
  }
  return next;
}

/** The distinct databases of some namespaces, in order of first appearance. */
export function databasesOf(namespaces: Iterable<string>): string[] {
  const databases = new Set<string>();
  for (const ns of namespaces) databases.add(splitNamespace(ns).database);
  return [...databases];
}
