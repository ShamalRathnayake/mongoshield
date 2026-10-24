/**
 * React state shared by the two document browsers (live data and backups):
 *
 *   useDocumentQuery   the query boxes, their checks, the applied query, quick filters,
 *                      header sorting, filter chips and the per-collection history
 *   useSample          the sample behind the schema/chart views and field suggestions,
 *                      loaded only when needed, through the connection's pacer
 *
 * Keeping them here means both pages validate, remember and filter in exactly the same
 * way, and the page components only wire requests to the viewer.
 */

import { useMemo, useRef, useState } from "react";
import type { DocumentSample } from "../shared/api.ts";
import { useLoad } from "./context.tsx";
import { checkFilter, parseDocument } from "./ejson.ts";
import { checkProjection, checkSort } from "./live-query.ts";
import type { Pacer } from "./pacer.ts";
import {
  addCondition,
  type ConditionChip,
  describeConditions,
  type QuickFilter,
  removeCondition,
} from "./quick-filter.ts";
import { analyzeSchema, type SchemaSummary } from "./schema.ts";
import { type HistoryEntry, loadPrefs, rememberQuery } from "./view-prefs.ts";
import { nextSort, type SortState, sortJsonOf, sortStateOf } from "./viewer-model.ts";

/** The query boxes' text. */
export interface QueryText {
  readonly filter: string;
  readonly projection: string;
  readonly sort: string;
}

/** The checked query that the documents are read with (compact JSON, or absent). */
export interface AppliedQuery {
  readonly filter: string | undefined;
  readonly projection: string | undefined;
  readonly sort: string | undefined;
}

const EMPTY_TEXT: QueryText = { filter: "", projection: "", sort: "" };
const EMPTY_APPLIED: AppliedQuery = { filter: undefined, projection: undefined, sort: undefined };

/** What `useDocumentQuery` returns. */
export interface DocumentQueryState {
  readonly text: QueryText;
  readonly setText: (text: QueryText) => void;
  readonly problems: Partial<Record<keyof QueryText, string>>;
  readonly applied: AppliedQuery;
  /** Checks the boxes (or the given text) and applies them; false when a box has a problem. */
  readonly apply: (text?: QueryText) => boolean;
  /** Clears every box and the applied query. */
  readonly reset: () => void;
  /** Adds a clicked value to the filter and applies it; returns a problem message, if any. */
  readonly quickFilter: (filter: QuickFilter) => string | undefined;
  /** The applied filter's conditions as chips, and removing one. */
  readonly chips: readonly ConditionChip[];
  readonly removeChip: (path: string) => void;
  /** The table header sort (one field) and cycling it from a header click. */
  readonly sort: SortState | undefined;
  readonly sortBy: (path: string) => void;
  readonly history: readonly HistoryEntry[];
  readonly applyHistory: (entry: HistoryEntry) => void;
}

/**
 * The query state of one collection.
 *
 * @param scope the preferences scope (history is stored per collection).
 * @param options.sortAndProjection false for backups (only a filter).
 * @param options.onApplied called after every applied change (pages reset their paging).
 */
export function useDocumentQuery(
  scope: string,
  options: { sortAndProjection: boolean; onApplied: () => void },
): DocumentQueryState {
  const [text, setText] = useState<QueryText>(EMPTY_TEXT);
  const [problems, setProblems] = useState<Partial<Record<keyof QueryText, string>>>({});
  const [applied, setApplied] = useState<AppliedQuery>(EMPTY_APPLIED);
  const [history, setHistory] = useState<readonly HistoryEntry[]>(
    () => loadPrefs(scope).history ?? [],
  );
  // The latest callback, so a page may pass a new function each render.
  const onAppliedRef = useRef(options.onApplied);
  onAppliedRef.current = options.onApplied;

  const apply = (next: QueryText = text): boolean => {
    setText(next);
    const filter = checkFilter(next.filter);
    const projection = options.sortAndProjection
      ? checkProjection(next.projection)
      : ({ ok: true, value: undefined } as const);
    const sort = options.sortAndProjection
      ? checkSort(next.sort)
      : ({ ok: true, value: undefined } as const);
    setProblems({
      ...(filter.ok ? {} : { filter: filter.message }),
      ...(projection.ok ? {} : { projection: projection.message }),
      ...(sort.ok ? {} : { sort: sort.message }),
    });
    if (!filter.ok || !projection.ok || !sort.ok) return false;
    const query: AppliedQuery = {
      filter: filter.filter,
      projection: projection.value,
      sort: sort.value,
    };
    setApplied(query);
    setHistory(
      rememberQuery(scope, {
        ...(query.filter === undefined ? {} : { filter: query.filter }),
        ...(query.sort === undefined ? {} : { sort: query.sort }),
        ...(query.projection === undefined ? {} : { projection: query.projection }),
      }),
    );
    onAppliedRef.current();
    return true;
  };

  const reset = () => {
    setText(EMPTY_TEXT);
    setProblems({});
    setApplied(EMPTY_APPLIED);
    onAppliedRef.current();
  };

  const quickFilter = (filter: QuickFilter): string | undefined => {
    const edit = addCondition(text.filter, filter);
    if (!edit.ok) {
      setProblems({ ...problems, filter: edit.message });
      return edit.message;
    }
    apply({ ...text, filter: edit.text });
    return undefined;
  };

  const removeChip = (path: string) => {
    // Chips describe the applied filter, so edit that one (the box may hold unapplied text).
    const edit = removeCondition(applied.filter ?? "", path);
    if (edit.ok) apply({ ...text, filter: edit.text });
  };

  const sort = sortStateOf(applied.sort);
  const sortBy = (path: string) => apply({ ...text, sort: sortJsonOf(nextSort(sort, path)) });

  const applyHistory = (entry: HistoryEntry) =>
    apply({
      filter: entry.filter ?? "",
      sort: entry.sort ?? "",
      projection: entry.projection ?? "",
    });

  return {
    text,
    setText,
    problems,
    applied,
    apply,
    reset,
    quickFilter,
    chips: describeConditions(applied.filter),
    removeChip,
    sort,
    sortBy,
    history,
    applyHistory,
  };
}

/** What `useSample` returns: the sample, its analysis and how to read it again. */
export interface SampleLoad {
  readonly sample: DocumentSample | undefined;
  readonly summary: SchemaSummary | undefined;
  readonly loading: boolean;
  readonly error: unknown;
  readonly reload: () => void;
}

/**
 * Loads a sample when `enabled` (the schema or chart view is open, or the filter box asked
 * for field suggestions), through `pacer`, and analyses it. `key` identifies the sample
 * (collection and filter): a new key reads a new sample, the same key keeps the old one.
 */
export function useSample(
  key: string,
  enabled: boolean,
  pacer: Pacer,
  load: (signal: AbortSignal) => Promise<DocumentSample>,
): SampleLoad {
  // Once wanted, a key stays loaded even when the view changes away and back.
  const [wantedKey, setWantedKey] = useState<string | undefined>(undefined);
  if (enabled && wantedKey !== key) setWantedKey(key);
  const active = wantedKey === key || enabled;
  const state = useLoad(active ? `sample:${key}` : "", (signal) =>
    pacer.run(() => load(signal), signal),
  );
  const summary = useMemo(
    () =>
      state.data === undefined
        ? undefined
        : analyzeSchema(state.data.documents.map((text) => parseDocument(text))),
    [state.data],
  );
  return {
    sample: state.data,
    summary,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

/** "a random sample of 200 documents" / "the first 200 documents of the backup". */
export function describeSample(sample: DocumentSample | undefined, filtered: boolean): string {
  if (sample === undefined) return "a sample";
  const count = sample.documents.length;
  const noun = count === 1 ? "document" : "documents";
  const matching = filtered ? " matching the filter" : "";
  return sample.method === "random"
    ? `a random sample of ${count} ${noun}${matching}`
    : `the first ${count} ${noun}${matching} in the backup`;
}
