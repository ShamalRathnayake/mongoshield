/**
 * The document tree: one document as an expandable outline of its fields, with each
 * value's BSON type as a badge, like Compass's list view.
 *
 *   ▾ address   { 2 fields }               Object
 *       city    "Colombo"                  String
 *       zip     "10012"                    String
 *   ▸ tags      [2] beta newsletter        Array
 *
 * - "Expand all" / "Collapse all" open or close every level at once.
 * - Every row has "Copy value", "Copy path" and (where the page can filter) a value menu
 *   with quick filters. With the mouse they show on hover; from the keyboard, focus a row
 *   and press C (copy value), P (copy path) or F (the value menu).
 * - Keyboard: it is an ARIA tree (see tree-keys.ts): ↑/↓ move, →/← open and close,
 *   Enter toggles. Only one row is in the Tab order (roving tabindex), so tabbing moves
 *   past the whole document in one step.
 *
 * The tree renders its visible rows as a flat list with `aria-level`, which keeps
 * expanding and keyboard movement simple and fast for large documents.
 */

import { type KeyboardEvent, type MouseEvent, useMemo, useRef, useState } from "react";
import { bsonTypeOf, isPlainObject } from "../bson.ts";
import type { JsonValue } from "../ejson.ts";
import { BsonValue, TypeBadge } from "./bson-value.tsx";
import { copyText } from "./copy-button.tsx";
import { Icon } from "./icons.tsx";
import { Menu } from "./popover.tsx";
import { treeKeyAction } from "./tree-keys.ts";
import { type QuickFilterHandler, valueMenuItems } from "./value-menu.tsx";

/** Children of a value: the fields of a document or the items of an array. */
function childrenOf(value: JsonValue): [string, JsonValue][] {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  if (isPlainObject(value)) return Object.entries(value);
  return [];
}

/** True when a value has children to show (non-empty documents and arrays). */
function isBranch(value: JsonValue): boolean {
  return childrenOf(value).length > 0;
}

/** One visible row of the tree. */
interface TreeRow {
  readonly path: string;
  readonly name: string;
  readonly value: JsonValue;
  readonly level: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** Position among its siblings (1-based) and how many siblings there are. */
  readonly position: number;
  readonly siblings: number;
}

/** The rows currently visible: every field of the root, and the children of open branches. */
function visibleRows(root: JsonValue, open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (value: JsonValue, prefix: string, level: number) => {
    const children = childrenOf(value);
    children.forEach(([name, child], index) => {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      const expandable = isBranch(child);
      const expanded = expandable && open.has(path);
      rows.push({
        path,
        name,
        value: child,
        level,
        expandable,
        expanded,
        position: index + 1,
        siblings: children.length,
      });
      if (expanded) walk(child, path, level + 1);
    });
  };
  walk(root, "", 1);
  return rows;
}

/** Every branch path of a value, for "Expand all". */
export function branchPaths(root: JsonValue): string[] {
  const paths: string[] = [];
  const walk = (value: JsonValue, prefix: string) => {
    for (const [name, child] of childrenOf(value)) {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      if (isBranch(child)) {
        paths.push(path);
        walk(child, path);
      }
    }
  };
  walk(root, "");
  return paths;
}

/** Branches open from the start: the first `depth` levels below the root. */
function initiallyOpen(root: JsonValue, depth: number): Set<string> {
  return new Set(branchPaths(root).filter((path) => path.split(".").length < depth));
}

/** Props for `DocumentTree`. */
export interface DocumentTreeProps {
  /** The document (or any value: an array's items, a single value). */
  readonly value: JsonValue;
  /** Accessible name of the tree, e.g. "Document 65f…". */
  readonly label: string;
  /** Levels open from the start below the root: 1 shows nested values collapsed. */
  readonly openDepth?: number;
  /** Adds quick filters to each row's value menu. */
  readonly onQuickFilter?: QuickFilterHandler | undefined;
  /** Shows "Expand all" / "Collapse all" above the tree (default true). */
  readonly toolbar?: boolean;
  /** Prefix for copied paths, for subtrees shown on their own (a nested value in a popover). */
  readonly pathPrefix?: string;
  readonly onCopied?: ((ok: boolean, what: string) => void) | undefined;
}

/** A document as an expandable tree (see the file header). */
export function DocumentTree(props: DocumentTreeProps) {
  const { value } = props;
  const [open, setOpen] = useState<ReadonlySet<string>>(() =>
    initiallyOpen(value, props.openDepth ?? 1),
  );
  const [focused, setFocused] = useState(0);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; row: TreeRow } | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => visibleRows(value, open), [value, open]);
  const allBranches = useMemo(() => branchPaths(value), [value]);
  const fullPath = (row: TreeRow) =>
    props.pathPrefix === undefined ? row.path : `${props.pathPrefix}.${row.path}`;

  if (rows.length === 0) {
    return (
      <p className="muted document-tree-empty">
        {isPlainObject(value) ? "An empty document." : <BsonValue value={value} full />}
      </p>
    );
  }

  const toggle = (row: TreeRow) => {
    if (!row.expandable) return;
    const next = new Set(open);
    if (next.has(row.path)) next.delete(row.path);
    else next.add(row.path);
    setOpen(next);
  };

  /** Moves focus to the row at `index` (it is rendered, the list is not virtualized). */
  const focusRow = (index: number) => {
    setFocused(index);
    listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.focus();
  };

  const copy = (text: string, what: string) => {
    void copyText(text).then((ok) => props.onCopied?.(ok, what));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number, row: TreeRow) => {
    // Shortcuts for the row actions (no modifier keys, so typing elsewhere is unaffected).
    if (!event.altKey && !event.ctrlKey && !event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        copy(JSON.stringify(row.value, null, 2), "value");
        return;
      }
      if (key === "p") {
        event.preventDefault();
        copy(fullPath(row), "path");
        return;
      }
      if (key === "f") {
        event.preventDefault();
        setMenu({ anchor: event.currentTarget, row });
        return;
      }
    }
    const action = treeKeyAction(rows, index, event.key === " " ? "Enter" : event.key);
    if (action === undefined) return;
    event.preventDefault();
    if (action.kind === "focus") focusRow(action.index);
    else if (action.kind === "expand" || action.kind === "collapse" || action.kind === "activate") {
      toggle(row);
    }
  };

  const openMenu = (event: MouseEvent<HTMLButtonElement>, row: TreeRow) => {
    event.stopPropagation();
    // Anchor on the row so focus returns to it when the menu closes.
    const rowElement = event.currentTarget.closest<HTMLElement>('[role="treeitem"]');
    setMenu({ anchor: rowElement ?? event.currentTarget, row });
  };

  // The focused index may point past the end after collapsing; clamp it.
  const tabStop = Math.min(focused, rows.length - 1);

  return (
    <div className="document-tree">
      {props.toolbar === false || allBranches.length === 0 ? null : (
        <div className="document-tree-toolbar">
          <button
            type="button"
            className="button button-ghost button-small"
            onClick={() => setOpen(new Set(allBranches))}
          >
            <Icon name="expand" size={14} />
            Expand all
          </button>
          <button
            type="button"
            className="button button-ghost button-small"
            onClick={() => setOpen(new Set())}
          >
            <Icon name="collapse" size={14} />
            Collapse all
          </button>
        </div>
      )}
      <div ref={listRef} role="tree" aria-label={props.label} className="document-tree-rows">
        {rows.map((row, index) => {
          const type = bsonTypeOf(row.value);
          return (
            <div
              key={row.path}
              role="treeitem"
              aria-level={row.level}
              aria-posinset={row.position}
              aria-setsize={row.siblings}
              aria-expanded={row.expandable ? row.expanded : undefined}
              tabIndex={index === tabStop ? 0 : -1}
              data-row={index}
              className="tree-row"
              style={{ paddingLeft: `calc(${row.level - 1} * var(--tree-indent))` }}
              onFocus={() => setFocused(index)}
              onClick={() => {
                setFocused(index);
                toggle(row);
              }}
              onKeyDown={(event) => onKeyDown(event, index, row)}
            >
              <span className="tree-caret" aria-hidden="true">
                {row.expandable ? (
                  <Icon name={row.expanded ? "chevronDown" : "chevronRight"} size={12} />
                ) : null}
              </span>
              <span className="tree-key">{row.name}</span>
              <span className="tree-value">
                {row.expandable && row.expanded ? (
                  <span className="bson bson-nested">
                    {Array.isArray(row.value)
                      ? `[${(row.value as readonly JsonValue[]).length}]`
                      : `{ ${childrenOf(row.value).length} fields }`}
                  </span>
                ) : (
                  <BsonValue value={row.value} full />
                )}
              </span>
              <TypeBadge type={type} />
              <span className="tree-actions">
                <button
                  type="button"
                  className="button-icon-tiny"
                  tabIndex={-1}
                  aria-label={`Copy the value of ${fullPath(row)}`}
                  title="Copy value (C)"
                  onClick={(event) => {
                    event.stopPropagation();
                    copy(JSON.stringify(row.value, null, 2), "value");
                  }}
                >
                  <Icon name="copy" size={12} />
                </button>
                <button
                  type="button"
                  className="button-icon-tiny"
                  tabIndex={-1}
                  aria-label={`More actions for ${fullPath(row)}`}
                  title="Filter and copy (F)"
                  onClick={(event) => openMenu(event, row)}
                >
                  <Icon name="filter" size={12} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {menu === undefined ? null : (
        <Menu
          anchor={menu.anchor}
          label={`Actions for ${fullPath(menu.row)}`}
          onClose={() => setMenu(undefined)}
          items={valueMenuItems({
            path: fullPath(menu.row),
            value: menu.row.value,
            onQuickFilter: props.onQuickFilter,
            onCopied: props.onCopied,
          })}
        />
      )}
    </div>
  );
}
