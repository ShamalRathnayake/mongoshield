/**
 * Options for the filter selects above the lists (audit log, jobs, edit history), built
 * from the values in the rows that are loaded.
 *
 * Building them from the data, rather than asking the server for every user, plan or
 * storage location, means every role gets working filters (the user list is admin
 * only), and a filter never offers a value that would match nothing on screen. Each
 * option shows how many loaded rows have the value, e.g. "maya (3)", so the choice
 * also tells how much it will show.
 */

import type { SelectOption } from "./components/field.tsx";

/** The option value meaning "no filter". */
export const ANY = "";

/** One distinct value and how many times it occurs. */
export interface ValueCount {
  readonly value: string;
  readonly count: number;
}

/**
 * Orders two texts A → Z ignoring case, character by character. Deliberately not
 * `localeCompare`: collation skips punctuation, which would sort "shop_restored" before
 * "shop.orders"; identifiers read better in plain character order.
 */
export function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return a < b ? -1 : a > b ? 1 : 0;
  return left < right ? -1 : 1;
}

/**
 * The distinct values of `values` with their counts, sorted A → Z (case-insensitive) so
 * an option is easy to find in a long list. Undefined and empty values are skipped.
 */
export function countValues(values: Iterable<string | undefined>): ValueCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === undefined || value === "") continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => compareText(a.value, b.value));
}

/** "maya (3)": a label with its count. */
export function withCount(label: string, count: number): string {
  return `${label} (${count})`;
}

/** How `filterOptions` builds its list. */
export interface FilterOptionsSettings {
  /** The first option's label, meaning "no filter", e.g. "Anyone". */
  readonly any: string;
  /** Turns a value into the words shown (default: the value itself), e.g. an id into a name. */
  readonly labelFor?: (value: string) => string;
  /** Values offered even when no loaded row has them (shown with a count of 0). */
  readonly always?: readonly string[];
  /**
   * The value chosen now: kept in the list even when no loaded row has it any more, so
   * the select never shows a value it does not list.
   */
  readonly selected?: string;
}

/**
 * Select options for one column: "no filter" first, then every distinct value with its
 * count. Options are sorted by the label people read, not by the raw value (an id).
 */
export function filterOptions(
  values: Iterable<string | undefined>,
  settings: FilterOptionsSettings,
): SelectOption<string>[] {
  const counted = countValues(values);
  const known = new Set(counted.map((entry) => entry.value));
  // Values that must be listed even without rows: the "always" ones and the current choice.
  for (const value of [...(settings.always ?? []), settings.selected ?? ANY]) {
    if (value !== ANY && !known.has(value)) {
      counted.push({ value, count: 0 });
      known.add(value);
    }
  }
  const label = settings.labelFor ?? ((value: string) => value);
  const options = counted
    .map((entry) => ({ value: entry.value, label: withCount(label(entry.value), entry.count) }))
    .sort((a, b) => compareText(a.label, b.label));
  return [{ value: ANY, label: settings.any }, ...options];
}

/** True when `value` passes a filter select: "no filter", or exactly the chosen value. */
export function matchesChoice(choice: string, value: string | undefined): boolean {
  return choice === ANY || choice === value;
}
