/**
 * Table: the console's data table, used for every list (backups, jobs, audit, …).
 *
 * - Columns are declared once with a header, a cell renderer and optionally a sort value;
 *   sortable headers are buttons and the active column has `aria-sort`.
 * - Rows are keyboard navigable when `onRowActivate` is set: each row is focusable,
 *   ↑/↓/Home/End move between rows and Enter or Space opens the row. A mouse click on
 *   the row does the same, except on links and buttons inside it.
 * - Numeric columns (`align: "end"`) use tabular figures so digits line up.
 */

import { type KeyboardEvent, type MouseEvent, type ReactNode, useState } from "react";

/** One column of a `Table`. */
export interface Column<Row> {
  /** Stable id, also used as the React key. */
  readonly key: string;
  readonly header: ReactNode;
  readonly render: (row: Row) => ReactNode;
  /** When set, the column can be sorted by this value. */
  readonly sortValue?: (row: Row) => string | number | undefined;
  /** `end` right-aligns the column and uses tabular figures (numbers, sizes). */
  readonly align?: "start" | "end";
  /** Hide below tablet width to keep wide tables readable. */
  readonly hideOnNarrow?: boolean;
}

/** Props for `Table`. */
export interface TableProps<Row> {
  /** Describes the table for screen readers; shown visually only if `showCaption`. */
  readonly caption: string;
  readonly showCaption?: boolean;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  /** Makes rows focusable and clickable. */
  readonly onRowActivate?: (row: Row) => void;
  /** Extra class per row, e.g. to highlight conflicts. */
  readonly rowClassName?: (row: Row) => string | undefined;
  /** Shown instead of the body when there are no rows. */
  readonly empty?: ReactNode;
  readonly initialSort?: { readonly key: string; readonly direction: "ascending" | "descending" };
}

/** Compares sort values; undefined always sorts last. */
function compareValues(a: string | number | undefined, b: string | number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** A sortable, keyboard-navigable data table. */
export function Table<Row>(props: TableProps<Row>) {
  const [sort, setSort] = useState(props.initialSort);
  const { columns, onRowActivate } = props;

  const sortColumn =
    sort === undefined ? undefined : columns.find((column) => column.key === sort.key);
  const sortValue = sortColumn?.sortValue;
  const rows =
    sort === undefined || sortValue === undefined
      ? props.rows
      : [...props.rows].sort((a, b) => {
          const result = compareValues(sortValue(a), sortValue(b));
          return sort.direction === "ascending" ? result : -result;
        });

  const toggleSort = (key: string) => {
    setSort((current) =>
      current?.key === key && current.direction === "ascending"
        ? { key, direction: "descending" }
        : { key, direction: "ascending" },
    );
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: Row) => {
    const current = event.currentTarget;
    const siblings = [...(current.parentElement?.children ?? [])].filter(
      (element): element is HTMLTableRowElement => element instanceof HTMLTableRowElement,
    );
    const index = siblings.indexOf(current);
    let target: HTMLTableRowElement | undefined;
    if (event.key === "ArrowDown") target = siblings[index + 1];
    else if (event.key === "ArrowUp") target = siblings[index - 1];
    else if (event.key === "Home") target = siblings[0];
    else if (event.key === "End") target = siblings[siblings.length - 1];
    else if ((event.key === "Enter" || event.key === " ") && event.target === current) {
      event.preventDefault();
      onRowActivate?.(row);
      return;
    }
    if (target !== undefined) {
      event.preventDefault();
      target.focus();
    }
  };

  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, row: Row) => {
    // Let links, buttons and inputs inside the row do their own thing.
    if (event.target instanceof Element && event.target.closest("a, button, input, label, select"))
      return;
    onRowActivate?.(row);
  };

  return (
    <div className="table-wrapper">
      <table className={`table ${onRowActivate ? "table-interactive" : ""}`}>
        <caption className={props.showCaption ? "table-caption" : "visually-hidden"}>
          {props.caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const isSorted = sort?.key === column.key;
              const className = [
                column.align === "end" ? "align-end" : "",
                column.hideOnNarrow ? "hide-narrow" : "",
              ]
                .join(" ")
                .trim();
              return (
                <th
                  key={column.key}
                  scope="col"
                  className={className || undefined}
                  aria-sort={isSorted ? sort?.direction : column.sortValue ? "none" : undefined}
                >
                  {column.sortValue === undefined ? (
                    column.header
                  ) : (
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => toggleSort(column.key)}
                    >
                      {column.header}
                      <span className="sort-indicator" aria-hidden="true">
                        {isSorted ? (sort?.direction === "ascending" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="table-empty">
                {props.empty ?? "Nothing here yet."}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={props.rowKey(row)}
                className={props.rowClassName?.(row)}
                tabIndex={onRowActivate ? 0 : undefined}
                onKeyDown={onRowActivate ? (event) => onRowKeyDown(event, row) : undefined}
                onClick={onRowActivate ? (event) => onRowClick(event, row) : undefined}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={
                      [
                        column.align === "end" ? "align-end numeric" : "",
                        column.hideOnNarrow ? "hide-narrow" : "",
                      ]
                        .join(" ")
                        .trim() || undefined
                    }
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
