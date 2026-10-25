/**
 * The navigation tree of the document browsers: connections → databases → collections
 * (the backup browser starts at databases), with type icons, document counts and sizes,
 * and a search box that filters collection names.
 *
 *   ▾ ⛁ Staging
 *     ▾ ◫ shop                   3 · 12 MiB
 *         ▤ orders             25K
 *         ⟳ audit_log (capped) 1.2K
 *         ◉ funnel (view)
 *
 * - It is an ARIA tree (tree-keys.ts): ↑/↓ move, → opens, ← closes or goes to the parent,
 *   Enter opens a collection. One item is in the Tab order (roving tabindex).
 * - Collections with an `href` are links (middle-click opens a new tab); others call
 *   `onSelect`.
 * - Typing in the search box shows only matching collections, with their databases
 *   opened; the matching part of each name is highlighted.
 * - Children can load lazily (a connection's databases): `onToggle` tells the page that a
 *   node was opened, and a node with `loading` says "Loading…" (an `error` says it could
 *   not load, with the reason as its tooltip).
 */

import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./icons.tsx";
import { treeKeyAction } from "./tree-keys.ts";

/** One node of the tree. */
export interface CollectionTreeNode {
  /** Unique in the tree, e.g. `conn:staging`, `db:staging:shop`, `ns:staging:shop.orders`. */
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  /** Collections are leaves that can be opened; the others group them. */
  readonly kind: "connection" | "database" | "collection";
  /** Short text on the right: a count, a size. */
  readonly meta?: string;
  /** Tooltip with the full details (exact counts, type). */
  readonly title?: string;
  /** A word after the name ("view", "capped", "time series"). */
  readonly note?: string;
  /** For collections: a link to open it. */
  readonly href?: string;
  /** Children; undefined while not loaded (a connection that was never opened). */
  readonly children?: readonly CollectionTreeNode[];
  readonly loading?: boolean;
  /** Shown under the node when loading its children failed. */
  readonly error?: string;
}

/** A visible row: the node, its level and its place among its siblings. */
interface Row {
  readonly node: CollectionTreeNode;
  readonly level: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly position: number;
  readonly siblings: number;
}

/** Props for `CollectionTree`. */
export interface CollectionTreeProps {
  readonly label: string;
  readonly roots: readonly CollectionTreeNode[];
  /** The open collection's id. */
  readonly selectedId?: string | undefined;
  /**
   * Node ids open unless the user closes them (the current connection and database). Read
   * on every render, so ids of children that load later still open by default.
   */
  readonly defaultExpanded?: readonly string[];
  /** Told when a node opens (to load its children) or closes. */
  readonly onToggle?: ((node: CollectionTreeNode, open: boolean) => void) | undefined;
  /** For collections without an `href`. */
  readonly onSelect?: ((node: CollectionTreeNode) => void) | undefined;
  /** Shown when there is nothing at all. */
  readonly empty?: ReactNode;
}

/** True when a collection's name contains the search text. */
function matches(node: CollectionTreeNode, search: string): boolean {
  return search !== "" && node.kind === "collection" && node.label.toLowerCase().includes(search);
}

/** Keeps only the branches that lead to matching collections (all of them without search). */
function filterTree(nodes: readonly CollectionTreeNode[], search: string): CollectionTreeNode[] {
  if (search === "") return [...nodes];
  const kept: CollectionTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "collection") {
      if (matches(node, search)) kept.push(node);
      continue;
    }
    const children = filterTree(node.children ?? [], search);
    if (children.length > 0) kept.push({ ...node, children });
  }
  return kept;
}

/** The visible rows for the open set. While searching, every remaining branch is open. */
function visibleRows(
  nodes: readonly CollectionTreeNode[],
  expanded: ReadonlySet<string>,
  searching: boolean,
): Row[] {
  const rows: Row[] = [];
  const walk = (list: readonly CollectionTreeNode[], level: number) => {
    list.forEach((node, index) => {
      const expandable = node.kind !== "collection";
      const open = expandable && (searching || expanded.has(node.id));
      rows.push({
        node,
        level,
        expandable,
        expanded: open,
        position: index + 1,
        siblings: list.length,
      });
      if (open && node.children !== undefined) walk(node.children, level + 1);
    });
  };
  walk(nodes, 1);
  return rows;
}

/** The name with the search match highlighted. */
function highlight(label: string, search: string): ReactNode {
  const index = search === "" ? -1 : label.toLowerCase().indexOf(search);
  if (index === -1) return label;
  return (
    <>
      {label.slice(0, index)}
      <mark>{label.slice(index, index + search.length)}</mark>
      {label.slice(index + search.length)}
    </>
  );
}

/** The tree (see the file header). */
export function CollectionTree(props: CollectionTreeProps) {
  // What the user changed: opened or closed by hand (wins over `defaultExpanded`).
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const defaults = new Set(props.defaultExpanded ?? []);
  const expanded = new Set([...opened, ...[...defaults].filter((id) => !closed.has(id))]);
  const [search, setSearch] = useState("");
  const [focusedId, setFocusedId] = useState<string | undefined>(props.selectedId);
  const listRef = useRef<HTMLDivElement>(null);
  const needle = search.trim().toLowerCase();
  const filtered = useMemo(() => filterTree(props.roots, needle), [props.roots, needle]);
  const rows = visibleRows(filtered, expanded, needle !== "");
  const focusIndex = Math.max(
    0,
    rows.findIndex((row) => row.node.id === (focusedId ?? props.selectedId)),
  );

  const setOpen = (node: CollectionTreeNode, open: boolean) => {
    const nextOpened = new Set(opened);
    const nextClosed = new Set(closed);
    if (open) {
      nextOpened.add(node.id);
      nextClosed.delete(node.id);
    } else {
      nextOpened.delete(node.id);
      nextClosed.add(node.id);
    }
    setOpened(nextOpened);
    setClosed(nextClosed);
    props.onToggle?.(node, open);
  };

  const focusRow = (index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    setFocusedId(row.node.id);
    // Matched by dataset rather than a selector: ids contain dots and colons.
    const items = listRef.current?.querySelectorAll<HTMLElement>("[data-node]") ?? [];
    [...items].find((item) => item.dataset.node === row.node.id)?.focus();
  };

  const activate = (row: Row) => {
    if (row.expandable) setOpen(row.node, !row.expanded);
    else if (row.node.href === undefined) props.onSelect?.(row.node);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    const action = treeKeyAction(rows, index, event.key);
    if (action === undefined) return;
    // Enter on a link follows it natively.
    if (action.kind === "activate" && row.node.href !== undefined) return;
    event.preventDefault();
    if (action.kind === "focus") focusRow(action.index);
    else if (action.kind === "expand") setOpen(row.node, true);
    else if (action.kind === "collapse") setOpen(row.node, false);
    else activate(row);
  };

  return (
    <div className="collection-tree">
      <div className="tree-search">
        <span className="tree-search-icon" aria-hidden="true">
          <Icon name="search" size={14} />
        </span>
        <input
          type="search"
          className="input input-with-icon"
          placeholder="Find a collection"
          aria-label="Find a collection"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            // ↓ from the search box goes into the tree.
            if (event.key === "ArrowDown" && rows.length > 0) {
              event.preventDefault();
              focusRow(0);
            }
          }}
        />
      </div>
      {rows.length === 0 ? (
        <p className="tree-empty muted">
          {needle === ""
            ? (props.empty ?? "Nothing here.")
            : `No collection matches “${search.trim()}”.`}
        </p>
      ) : (
        <div ref={listRef} role="tree" aria-label={props.label} className="tree">
          {rows.map((row, index) => {
            const { node } = row;
            const selected = node.id === props.selectedId;
            const common = {
              "aria-level": row.level,
              "aria-posinset": row.position,
              "aria-setsize": row.siblings,
              "aria-expanded": row.expandable ? row.expanded : undefined,
              "aria-selected": node.kind === "collection" ? selected : undefined,
              "aria-current": selected ? ("page" as const) : undefined,
              "data-node": node.id,
              className: `tree-item tree-${node.kind} ${selected ? "tree-item-selected" : ""}`,
              style: {
                paddingLeft: `calc(${row.level - 1} * var(--tree-indent) + var(--space-2))`,
              },
              title: node.error ?? node.title,
              onFocus: () => setFocusedId(node.id),
            };
            const content = (
              <>
                <span className="tree-caret" aria-hidden="true">
                  {row.expandable ? (
                    <Icon name={row.expanded ? "chevronDown" : "chevronRight"} size={12} />
                  ) : null}
                </span>
                <Icon name={node.icon} size={14} className="tree-icon" />
                <span className="tree-label">
                  {highlight(node.label, needle)}
                  {node.note === undefined ? null : <span className="tree-note"> {node.note}</span>}
                </span>
                {/* Loading and errors show in the row itself: a tree may only contain tree items. */}
                {node.loading === true ? (
                  <span className="tree-meta">Loading…</span>
                ) : node.error !== undefined ? (
                  <span className="tree-meta tree-error">Could not load</span>
                ) : node.meta === undefined ? null : (
                  <span className="tree-meta">{node.meta}</span>
                )}
              </>
            );
            return node.href !== undefined ? (
              <a
                key={node.id}
                {...common}
                role="treeitem"
                tabIndex={index === focusIndex ? 0 : -1}
                href={node.href}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                {content}
              </a>
            ) : (
              // An ARIA treeitem (a <button> cannot carry the tree's roles and levels).
              <div
                key={node.id}
                {...common}
                role="treeitem"
                tabIndex={index === focusIndex ? 0 : -1}
                onKeyDown={(event) => onKeyDown(event, index)}
                onClick={() => activate(row)}
              >
                {content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
