/**
 * The data the document viewer works with, shared by the live data browser and the
 * backup document browser so both feel the same:
 *
 *   ViewerDocument   one document: its Extended JSON text (relaxed, and canonical when
 *                    loaded), the parsed value, a label from its `_id`, a stable key
 *   SortState        the table's sort (one field, ascending or descending)
 *   ViewerSelection  documents ticked for an action (the backup browser's "Restore selected")
 *
 * Pure functions only; the components live in components/document-viewer.tsx.
 */

import { documentIdLabel, isJsonObject, type JsonValue, parseDocument } from "./ejson.ts";

/** One document in the viewer. */
export interface ViewerDocument {
  /** Unique within the page and stable across re-renders (React key). */
  readonly key: string;
  /** Relaxed Extended JSON, as the server sent it. */
  readonly text: string;
  /** Canonical Extended JSON, when the page was read with `ejson=canonical`. */
  readonly canonical?: string;
  /** The parsed document; undefined when the text is not JSON (shown raw). */
  readonly value: JsonValue | undefined;
  /** `ObjectId("65f…")`, `"(no _id)"`, …, for headings and accessible names. */
  readonly label: string;
  /** The `_id` as Extended JSON text, when the document has one (selection, restore). */
  readonly idJson?: string;
}

/** Builds viewer documents from the page's texts (and canonical texts, same order). */
export function toViewerDocuments(
  texts: readonly string[],
  canonical?: readonly (string | undefined)[],
): ViewerDocument[] {
  const seen = new Map<string, number>();
  return texts.map((text, index) => {
    const value = parseDocument(text);
    const id = value !== undefined && isJsonObject(value) ? value._id : undefined;
    const idJson = id === undefined ? undefined : JSON.stringify(id);
    // Keys from the `_id` keep rows stable when a page reloads; duplicates get a suffix.
    const base = idJson ?? `#${index}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const canonicalText = canonical?.[index];
    return {
      key: count === 0 ? base : `${base}~${count}`,
      text,
      value,
      label: documentIdLabel(value),
      ...(idJson === undefined ? {} : { idJson }),
      ...(canonicalText === undefined ? {} : { canonical: canonicalText }),
    };
  });
}

/** The table's sort: one field, 1 ascending or -1 descending. */
export interface SortState {
  readonly path: string;
  readonly direction: 1 | -1;
}

/** Clicking a column header cycles: not sorted → ascending → descending → not sorted. */
export function nextSort(current: SortState | undefined, path: string): SortState | undefined {
  if (current?.path !== path) return { path, direction: 1 };
  if (current.direction === 1) return { path, direction: -1 };
  return undefined;
}

/**
 * Reads a sort from the Sort box's JSON, when it is a single field (what the table can
 * show in its headers); a compound sort shows no header arrow.
 */
export function sortStateOf(sortJson: string | undefined): SortState | undefined {
  if (sortJson === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(sortJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    const [first] = entries;
    if (entries.length !== 1 || first === undefined) return undefined;
    const [path, direction] = first;
    return direction === 1 || direction === -1 ? { path, direction } : undefined;
  } catch {
    return undefined;
  }
}

/** The Sort box's JSON for a sort state (blank for none). */
export function sortJsonOf(sort: SortState | undefined): string {
  return sort === undefined ? "" : JSON.stringify({ [sort.path]: sort.direction });
}

/** Ticking documents for an action. */
export interface ViewerSelection {
  readonly isSelected: (document: ViewerDocument) => boolean;
  readonly canSelect: (document: ViewerDocument) => boolean;
  readonly toggle: (document: ViewerDocument) => void;
}
