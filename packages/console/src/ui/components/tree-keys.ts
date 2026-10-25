/**
 * Keyboard behaviour shared by the console's tree widgets (the collection sidebar and the
 * document tree), following the WAI-ARIA tree view pattern:
 *
 *   ↓ / ↑        next / previous visible item
 *   Home / End   first / last visible item
 *   →            expand a closed item; on an open one, move to its first child
 *   ←            collapse an open item; on a closed one or a leaf, move to its parent
 *   Enter        activate (open a collection, toggle a field)
 *
 * The trees render their visible items as one flat list (each with its level), so this
 * module only needs that list and the index of the focused item.
 */

/** What the keyboard logic needs to know about each visible tree item. */
export interface TreeNavItem {
  /** 1 for top-level items. */
  readonly level: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
}

/** What a key press asks the tree to do. */
export type TreeKeyAction =
  | { readonly kind: "focus"; readonly index: number }
  | { readonly kind: "expand"; readonly index: number }
  | { readonly kind: "collapse"; readonly index: number }
  | { readonly kind: "activate"; readonly index: number };

/** The action for a key on the item at `index`, or undefined when the key means nothing. */
export function treeKeyAction(
  items: readonly TreeNavItem[],
  index: number,
  key: string,
): TreeKeyAction | undefined {
  const item = items[index];
  if (item === undefined) return undefined;
  const last = items.length - 1;
  switch (key) {
    case "ArrowDown":
      return index < last ? { kind: "focus", index: index + 1 } : undefined;
    case "ArrowUp":
      return index > 0 ? { kind: "focus", index: index - 1 } : undefined;
    case "Home":
      return { kind: "focus", index: 0 };
    case "End":
      return { kind: "focus", index: last };
    case "ArrowRight":
      if (item.expandable && !item.expanded) return { kind: "expand", index };
      if (item.expandable && item.expanded && index < last) {
        return { kind: "focus", index: index + 1 };
      }
      return undefined;
    case "ArrowLeft": {
      if (item.expandable && item.expanded) return { kind: "collapse", index };
      const parent = parentIndex(items, index);
      return parent === undefined ? undefined : { kind: "focus", index: parent };
    }
    case "Enter":
      return { kind: "activate", index };
    default:
      return undefined;
  }
}

/** The index of the nearest item above with a lower level (the parent), if any. */
export function parentIndex(items: readonly TreeNavItem[], index: number): number | undefined {
  const level = items[index]?.level ?? 1;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    if ((items[candidate]?.level ?? 1) < level) return candidate;
  }
  return undefined;
}
