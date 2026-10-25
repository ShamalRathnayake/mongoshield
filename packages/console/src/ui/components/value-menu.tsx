/**
 * The value menu: what you can do with one field value in any view, the same everywhere.
 *
 *   Show documents where status is "paid"       (equals)
 *   Show documents where status is not "paid"   (not equals)
 *   Show documents that have status             (exists)
 *   Copy value · Copy path
 *
 * Choosing a filter adds it to the filter box and runs the query (see quick-filter.ts).
 * The filter actions appear only where the page can filter (`onQuickFilter`).
 */

import { isPlainObject, shortText } from "../bson.ts";
import type { JsonValue } from "../ejson.ts";
import type { QuickFilter } from "../quick-filter.ts";
import { copyText } from "./copy-button.tsx";
import type { MenuItem } from "./popover.tsx";

/** Quick filters reach the page through this callback. */
export type QuickFilterHandler = (filter: QuickFilter) => void;

/**
 * The path to filter on for a value shown at `path`: array positions are dropped, because
 * `{"items.sku": "A"}` matches any element while `{"items.0.sku": "A"}` only the first.
 */
export function filterPathOf(path: string): string {
  return path
    .split(".")
    .filter((part) => !/^\d+$/.test(part))
    .join(".");
}

/** A value as it appears inside a menu label: strings quoted, clipped to stay one line. */
function valueLabel(value: JsonValue): string {
  const text = typeof value === "string" ? `"${shortText(value)}"` : shortText(value);
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** The menu items for one value (see the file header). */
export function valueMenuItems(options: {
  readonly path: string;
  /** Undefined: the field is missing from this document (only "has the field" is offered). */
  readonly value: JsonValue | undefined;
  readonly onQuickFilter: QuickFilterHandler | undefined;
  /** Tells the user the copy worked (or not), e.g. with a toast. */
  readonly onCopied?: ((ok: boolean, what: string) => void) | undefined;
}): MenuItem[] {
  const { value, onQuickFilter, onCopied } = options;
  const copy = (text: string, what: string) => {
    void copyText(text).then((ok) => onCopied?.(ok, what));
  };
  const path = filterPathOf(options.path);
  const items: MenuItem[] = [];
  // `_id` alone, or a path made only of array positions, still filters on the field itself.
  const target = path === "" ? options.path : path;
  if (onQuickFilter !== undefined) {
    // Whole documents and arrays make poor equality filters; offer only "has the field".
    const comparable = value !== undefined && !isPlainObject(value) && !Array.isArray(value);
    if (comparable) {
      items.push(
        {
          label: `Show documents where ${target} is ${valueLabel(value)}`,
          onSelect: () => onQuickFilter({ path: target, op: "equals", value }),
        },
        {
          label: `Show documents where ${target} is not ${valueLabel(value)}`,
          onSelect: () => onQuickFilter({ path: target, op: "notEquals", value }),
        },
      );
    }
    items.push({
      label: `Show documents that have ${target}`,
      onSelect: () => onQuickFilter({ path: target, op: "exists" }),
    });
  }
  if (value !== undefined) {
    items.push({
      label: "Copy value",
      detail: "As Extended JSON",
      onSelect: () => copy(JSON.stringify(value, null, 2), "value"),
    });
  }
  items.push({
    label: "Copy path",
    detail: options.path,
    onSelect: () => copy(options.path, "path"),
  });
  return items;
}
