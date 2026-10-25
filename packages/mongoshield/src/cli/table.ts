/**
 * Plain-text tables for terminal output.
 *
 *   ID                           CREATED                    STATUS
 *   2026-10-20T03-00-04Z_7f3a9c  2026-10-20 05:00 (2h ago)  complete
 *
 * Cells may contain ANSI colors; widths are measured on the visible text.
 * No borders: they make output harder to copy, grep and diff.
 */

import { stripVTControlCharacters } from "node:util";

/** One column: its header and whether numbers in it are right-aligned. */
export interface Column {
  readonly header: string;
  readonly align?: "left" | "right";
}

/** Space between columns. */
const GAP = "  ";

/**
 * Renders rows under headers. Headers are passed through `styleHeader`
 * (usually bold/dim) after padding, so styling never breaks alignment.
 */
export function renderTable(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  styleHeader: (text: string) => string = (text) => text,
): string {
  const headers = columns.map((column) => column.header);
  const widths = columnWidths([headers, ...rows], columns.length);
  const headerLine = trimEnd(
    columns
      .map((column, index) => styleHeader(pad(column.header, widths[index] ?? 0, column.align)))
      .join(GAP),
  );
  return [headerLine, ...renderLines(columns, rows, widths)].join("\n");
}

/** Renders aligned rows without a header line (for help pages and lists). */
export function renderRows(rows: readonly (readonly string[])[]): string {
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const columns: Column[] = Array.from({ length: columnCount }, () => ({ header: "" }));
  return renderLines(columns, rows, columnWidths(rows, columnCount)).join("\n");
}

/** The widest visible cell of each column. */
function columnWidths(rows: readonly (readonly string[])[], columnCount: number): number[] {
  const widths = new Array<number>(columnCount).fill(0);
  for (const row of rows) {
    for (let index = 0; index < columnCount; index++) {
      widths[index] = Math.max(widths[index] ?? 0, visibleLength(row[index] ?? ""));
    }
  }
  return widths;
}

function renderLines(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  widths: readonly number[],
): string[] {
  return rows.map((row) =>
    trimEnd(
      columns
        .map((column, index) => pad(row[index] ?? "", widths[index] ?? 0, column.align))
        .join(GAP),
    ),
  );
}

/** Renders `label  value` pairs with the labels aligned, for summaries. */
export function renderDetails(
  pairs: readonly (readonly [label: string, value: string])[],
  styleLabel: (text: string) => string = (text) => text,
): string {
  let width = 0;
  for (const [label] of pairs) width = Math.max(width, visibleLength(label));
  return pairs
    .map(([label, value]) => `${styleLabel(pad(label, width, "left"))}  ${value}`)
    .join("\n");
}

/** Length as seen on screen: ANSI escape codes take no space. */
function visibleLength(text: string): number {
  return stripVTControlCharacters(text).length;
}

function pad(text: string, width: number, align: Column["align"]): string {
  const padding = " ".repeat(Math.max(0, width - visibleLength(text)));
  return align === "right" ? `${padding}${text}` : `${text}${padding}`;
}

/** Trailing spaces from padding the last column are noise in copied output. */
function trimEnd(line: string): string {
  return line.replace(/ +$/, "");
}
