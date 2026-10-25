/**
 * The table view of the document viewer: one row per document, one column per field.
 *
 * - Columns come from the documents themselves: every field path of the page, nested
 *   fields flattened as dot paths (`address.city`), `_id` first. The column picker hides,
 *   shows and reorders them; dragging a header reorders too, and the handle at a header's
 *   right edge resizes (with the mouse, or focused with ← / →). The viewer remembers all
 *   of it per collection.
 * - Clicking a header sorts on the server (`onSort`): ascending, descending, then off.
 *   Without `onSort` (backups, which are read in storage order) headers do not sort.
 * - Cells render each BSON type for what it is (components/bson-value.tsx). Clicking a
 *   cell opens its value menu (quick filters, copy, open the document); arrays and nested
 *   documents open in a popover as a tree.
 * - Rows: ↑/↓ move between rows, Enter opens the document, Space ticks it (when the page
 *   offers selection). Double-clicking a row opens it too.
 * - The header sticks while scrolling, and only the rows in view (plus a margin) are in
 *   the DOM, so long pages stay smooth. Rows have a fixed height for that reason;
 *   long values are cut with "…" and shown whole in the tooltip, menu or detail panel.
 */

import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { bsonTypeOf, isNumericType, valueAtPath } from "../bson.ts";
import type { JsonValue } from "../ejson.ts";
import type { SortState, ViewerDocument, ViewerSelection } from "../viewer-model.ts";
import { BsonValue } from "./bson-value.tsx";
import { DocumentTree } from "./document-tree.tsx";
import { Icon } from "./icons.tsx";
import { Menu, Popover } from "./popover.tsx";
import { type QuickFilterHandler, valueMenuItems } from "./value-menu.tsx";

/** Height of one row in pixels; must match `--grid-row-height` in styles.css. */
export const ROW_HEIGHT = 36;
/**
 * Pages up to this many rows are rendered whole: windowing them saves nothing, and every
 * row stays in the DOM for find-in-page. Longer pages (50 and 100) render only what is in
 * view.
 */
export const VIRTUALIZE_FROM = 50;
/** Rows rendered above and below the visible ones, so fast scrolling shows no gaps. */
const OVERSCAN = 8;
/** Width of a column nobody has resized (px). */
export const DEFAULT_COLUMN_WIDTH = 180;
/** Narrowest and widest a column can be made (px); the same bounds as view-prefs.ts. */
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 1200;
/** One ← / → press on a resize handle (px). */
const RESIZE_STEP = 16;

/** Props for `DocumentGrid`. */
export interface DocumentGridProps {
  readonly documents: readonly ViewerDocument[];
  /** Row number of the first document (skip + 1), shown in the first column. */
  readonly firstNumber: number;
  /** The visible columns, in order. */
  readonly columns: readonly string[];
  readonly widths: Readonly<Record<string, number>>;
  readonly onResize: (path: string, width: number) => void;
  /** Moves the column `path` to the position of `before` (dragging a header). */
  readonly onReorder: (path: string, before: string) => void;
  readonly sort?: SortState | undefined;
  /** Sorts on the server; absent: headers do not sort. */
  readonly onSort?: ((path: string) => void) | undefined;
  readonly onOpen: (index: number) => void;
  readonly onQuickFilter?: QuickFilterHandler | undefined;
  readonly selection?: ViewerSelection | undefined;
  readonly onCopied?: ((ok: boolean, what: string) => void) | undefined;
  /** Accessible name of the table. */
  readonly caption: string;
}

/** Width of a column nobody resized: `_id` fits a whole ObjectId, the rest share a default. */
export function defaultWidthOf(path: string): number {
  return path === "_id" ? ID_COLUMN_WIDTH : DEFAULT_COLUMN_WIDTH;
}

/** Wide enough for the 24 hex digits of an ObjectId in the monospace font (px). */
const ID_COLUMN_WIDTH = 232;

/** Which rows to render for a scroll position: `[start, end)`. All of them when unmeasured. */
export function visibleRange(
  count: number,
  scrollTop: number,
  viewportHeight: number,
): { start: number; end: number } {
  // Short pages, jsdom and the first paint (no layout yet): render everything.
  if (count <= VIRTUALIZE_FROM || viewportHeight <= 0) return { start: 0, end: count };
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(count, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  return { start, end };
}

/** The table view (see the file header). */
export function DocumentGrid(props: DocumentGridProps) {
  const { documents, columns, widths, selection } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [focusedRow, setFocusedRow] = useState(0);
  const [menu, setMenu] = useState<
    { anchor: HTMLElement; row: HTMLElement; index: number; path: string } | undefined
  >(undefined);
  const [nested, setNested] = useState<
    { anchor: HTMLElement; value: JsonValue; path: string; label: string } | undefined
  >(undefined);
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  /** A row to focus once it has been rendered (after scrolling it into view). */
  const pendingFocus = useRef<number | undefined>(undefined);

  // Track the scroll viewport's height, for virtualization.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const measure = () => setViewportHeight(element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new page starts at the top.
  useEffect(() => {
    if (documents.length >= 0) {
      scrollRef.current?.scrollTo?.({ top: 0 });
      setScrollTop(0);
      setFocusedRow(0);
    }
  }, [documents]);

  // Focus a row that keyboard navigation scrolled into view.
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === undefined) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`tr[data-index="${index}"]`);
    if (row !== null && row !== undefined) {
      pendingFocus.current = undefined;
      row.focus();
    }
  });

  const { start, end } = visibleRange(documents.length, scrollTop, viewportHeight);
  const rowTabStop = Math.min(focusedRow, Math.max(0, documents.length - 1));

  /** Moves keyboard focus to a row, scrolling it into view first when needed. */
  const focusRow = (index: number) => {
    const target = Math.max(0, Math.min(documents.length - 1, index));
    setFocusedRow(target);
    pendingFocus.current = target;
    const element = scrollRef.current;
    if (element !== null && viewportHeight > 0) {
      // The header row is sticky and covers the first row height of the viewport.
      const top = target * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT * 2;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + viewportHeight) {
        element.scrollTop = bottom - viewportHeight;
      }
      setScrollTop(element.scrollTop);
    }
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    // Keys pressed inside the row's own controls (checkbox, buttons) are theirs.
    if (event.target !== event.currentTarget) return;
    const page = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
    const document = documents[index];
    switch (event.key) {
      case "ArrowDown":
        focusRow(index + 1);
        break;
      case "ArrowUp":
        focusRow(index - 1);
        break;
      case "PageDown":
        focusRow(index + page);
        break;
      case "PageUp":
        focusRow(index - page);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(documents.length - 1);
        break;
      case "Enter":
        props.onOpen(index);
        break;
      case " ":
        if (selection === undefined || document === undefined || !selection.canSelect(document)) {
          return;
        }
        selection.toggle(document);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onCellClick = (event: MouseEvent<HTMLTableCellElement>, index: number, path: string) => {
    // Buttons inside the cell (nested values) handle their own clicks.
    if (event.target instanceof Element && event.target.closest("button, input, a")) return;
    const row = event.currentTarget.closest("tr");
    if (row === null) return;
    setFocusedRow(index);
    setMenu({ anchor: event.currentTarget, row, index, path });
  };

  // ---- resizing: pointer drag on the handle, or ← / → while it has focus ----------------

  const widthOf = (path: string) => widths[path] ?? defaultWidthOf(path);
  const clampWidth = (width: number) =>
    Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));

  const startResize = (event: PointerEvent<HTMLSpanElement>, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widthOf(path);
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const onMove = (move: globalThis.PointerEvent) =>
      props.onResize(path, clampWidth(startWidth + move.clientX - startX));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const onResizeKey = (event: KeyboardEvent<HTMLSpanElement>, path: string) => {
    const step =
      event.key === "ArrowRight" ? RESIZE_STEP : event.key === "ArrowLeft" ? -RESIZE_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    event.stopPropagation();
    props.onResize(path, clampWidth(widthOf(path) + step));
  };

  // ---- reordering by dragging headers -------------------------------------------------

  const onDrop = (event: DragEvent<HTMLTableCellElement>, before: string) => {
    event.preventDefault();
    const path = dragging ?? event.dataTransfer.getData("text/plain");
    setDragging(undefined);
    if (path !== "" && path !== before) props.onReorder(path, before);
  };

  const menuDocument = menu === undefined ? undefined : documents[menu.index];
  const totalWidth =
    columns.reduce((sum, path) => sum + widthOf(path), 0) + (selection === undefined ? 88 : 120);

  return (
    <div
      ref={scrollRef}
      className="grid-scroll"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <table className="grid" style={{ width: totalWidth }} aria-rowcount={documents.length + 1}>
        <caption className="visually-hidden">{props.caption}</caption>
        <colgroup>
          <col style={{ width: selection === undefined ? 88 : 120 }} />
          {columns.map((path) => (
            <col key={path} style={{ width: widthOf(path) }} />
          ))}
        </colgroup>
        <thead>
          <tr aria-rowindex={1}>
            <th scope="col" className="grid-number-head">
              <span className="visually-hidden">Row</span>#
            </th>
            {columns.map((path) => {
              const sorted = props.sort?.path === path ? props.sort.direction : undefined;
              return (
                <th
                  key={path}
                  scope="col"
                  aria-sort={
                    props.onSort === undefined
                      ? undefined
                      : sorted === 1
                        ? "ascending"
                        : sorted === -1
                          ? "descending"
                          : "none"
                  }
                  className={dragging === path ? "grid-head grid-head-dragging" : "grid-head"}
                  draggable
                  onDragStart={(event) => {
                    setDragging(path);
                    event.dataTransfer.setData("text/plain", path);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDragging(undefined)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => onDrop(event, path)}
                  title={path}
                >
                  {props.onSort === undefined ? (
                    <span className="grid-head-label">{path}</span>
                  ) : (
                    <button
                      type="button"
                      className="grid-sort"
                      onClick={() => props.onSort?.(path)}
                      aria-label={`Sort by ${path}${sorted === 1 ? ", sorted ascending" : sorted === -1 ? ", sorted descending" : ""}`}
                    >
                      <span className="grid-head-label">{path}</span>
                      <span className="grid-sort-indicator" aria-hidden="true">
                        {sorted === 1 ? (
                          <Icon name="arrowUp" size={12} />
                        ) : sorted === -1 ? (
                          <Icon name="arrowDown" size={12} />
                        ) : null}
                      </span>
                    </button>
                  )}
                  {/* The handle is a focusable separator, as the ARIA pattern for resizers says. */}
                  {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be a draggable handle. */}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize column ${path}`}
                    aria-valuenow={widthOf(path)}
                    aria-valuemin={MIN_COLUMN_WIDTH}
                    aria-valuemax={MAX_COLUMN_WIDTH}
                    tabIndex={0}
                    className="grid-resize"
                    onPointerDown={(event) => startResize(event, path)}
                    onKeyDown={(event) => onResizeKey(event, path)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {/* Spacers stand in for the rows scrolled out of view. */}
          {start > 0 ? (
            // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a spacer row is never focusable.
            <tr aria-hidden="true" className="grid-spacer" style={{ height: start * ROW_HEIGHT }} />
          ) : null}
          {documents.slice(start, end).map((document, offset) => {
            const index = start + offset;
            const number = props.firstNumber + index;
            const selected = selection?.isSelected(document) === true;
            return (
              <tr
                key={document.key}
                data-index={index}
                aria-rowindex={index + 2}
                aria-selected={selection === undefined ? undefined : selected}
                tabIndex={index === rowTabStop ? 0 : -1}
                className={selected ? "grid-row grid-row-selected" : "grid-row"}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) setFocusedRow(index);
                }}
                onKeyDown={(event) => onRowKeyDown(event, index)}
                onDoubleClick={() => props.onOpen(index)}
              >
                <th scope="row" className="grid-number">
                  {selection === undefined ? null : (
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={selected}
                      disabled={!selection.canSelect(document)}
                      aria-label={`Select document ${document.label}`}
                      onChange={() => selection.toggle(document)}
                    />
                  )}
                  <span className="grid-number-text">{number}</span>
                  <button
                    type="button"
                    className="button-icon-tiny grid-open"
                    tabIndex={-1}
                    aria-label={`Open document ${document.label}`}
                    title="Open document (Enter)"
                    onClick={() => props.onOpen(index)}
                  >
                    <Icon name="open" size={12} />
                  </button>
                </th>
                {document.value === undefined ? (
                  // Not JSON at all: show the text as it came, across the row.
                  <td colSpan={Math.max(1, columns.length)} className="grid-cell grid-raw">
                    {document.text}
                  </td>
                ) : null}
                {document.value === undefined
                  ? null
                  : columns.map((path) => {
                      const value = valueAtPath(document.value, path);
                      const numeric = value !== undefined && isNumericType(bsonTypeOf(value));
                      return (
                        // A mouse shortcut: from the keyboard, the row's Enter opens the
                        // document, whose tree has the same value menu (F on a field).
                        // biome-ignore lint/a11y/useKeyWithClickEvents: see above.
                        <td
                          key={path}
                          className={numeric ? "grid-cell grid-cell-number" : "grid-cell"}
                          onClick={(event) => onCellClick(event, index, path)}
                        >
                          <BsonValue
                            value={value}
                            nestedLabel={`Show ${path} of document ${number}`}
                            onOpenNested={(nestedValue, event) =>
                              setNested({
                                anchor: event.currentTarget,
                                value: nestedValue,
                                path,
                                label: `${path} of document ${number}`,
                              })
                            }
                          />
                        </td>
                      );
                    })}
              </tr>
            );
          })}
          {end < documents.length ? (
            // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a spacer row is never focusable.
            <tr
              aria-hidden="true"
              className="grid-spacer"
              style={{ height: (documents.length - end) * ROW_HEIGHT }}
            />
          ) : null}
        </tbody>
      </table>

      {menu === undefined || menuDocument === undefined ? null : (
        <Menu
          anchor={menu.anchor}
          returnFocus={menu.row}
          label={`Actions for ${menu.path}`}
          onClose={() => setMenu(undefined)}
          items={[
            ...valueMenuItems({
              path: menu.path,
              value: valueAtPath(menuDocument.value, menu.path),
              onQuickFilter: props.onQuickFilter,
              ...(props.onCopied === undefined ? {} : { onCopied: props.onCopied }),
            }),
            { label: "Open document", onSelect: () => props.onOpen(menu.index) },
          ]}
        />
      )}
      {nested === undefined ? null : (
        <Popover
          anchor={nested.anchor}
          label={nested.label}
          onClose={() => setNested(undefined)}
          className="popover-tree"
        >
          <DocumentTree
            value={nested.value}
            label={nested.label}
            pathPrefix={nested.path}
            toolbar={false}
            {...(props.onQuickFilter === undefined ? {} : { onQuickFilter: props.onQuickFilter })}
            {...(props.onCopied === undefined ? {} : { onCopied: props.onCopied })}
          />
        </Popover>
      )}
    </div>
  );
}
