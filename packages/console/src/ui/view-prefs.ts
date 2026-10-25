/**
 * What the document viewer remembers between visits, per collection, in the browser's
 * localStorage: the chosen view (table, tree, JSON, cards, schema, chart), the table's
 * columns (order, hidden ones, widths), the cards' title and subtitle fields, the chart's
 * field, the query history, and per connection the last opened collection.
 *
 * These are conveniences only: nothing here is a secret or needed for correctness, and
 * every read and write tolerates a missing or blocked localStorage (private windows,
 * strict privacy settings) by falling back to defaults. Values are validated on read,
 * so a hand-edited or outdated entry can never break the page.
 *
 * Keys: `mongoshield.viewer.<scope>` where scope is `live:<connection>:<ns>` or
 * `backup:<storage>:<ns>` (backups of the same namespace share their preferences, so every
 * backup of `shop.orders` opens the same way), and `mongoshield.live.last.<connection>`.
 */

/** The record views of the document viewer. */
export const VIEW_MODES = ["table", "tree", "json", "cards", "schema", "chart"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/** A query the user applied, for the history menu. */
export interface HistoryEntry {
  readonly filter?: string;
  readonly sort?: string;
  readonly projection?: string;
}

/** The table's column layout. */
export interface ColumnPrefs {
  /** Column paths in display order (columns not listed follow in document order). */
  readonly order: readonly string[];
  /** Paths the user hid. */
  readonly hidden: readonly string[];
  /** Widths in pixels by path. */
  readonly widths: Readonly<Record<string, number>>;
}

/** Everything remembered for one collection. */
export interface ViewerPrefs {
  readonly view?: ViewMode;
  readonly columns?: ColumnPrefs;
  readonly cardTitle?: string;
  readonly cardSubtitle?: string;
  readonly chartField?: string;
  /** Newest first, at most {@link HISTORY_LIMIT}. */
  readonly history?: readonly HistoryEntry[];
}

/** Queries kept in the history of one collection. */
export const HISTORY_LIMIT = 15;
/** Widths are kept within these bounds (pixels), whatever was stored. */
const MIN_WIDTH = 60;
const MAX_WIDTH = 1200;

const PREFIX = "mongoshield.viewer.";
const LAST_PREFIX = "mongoshield.live.last.";
/** The view used when a collection has none remembered: the last one used anywhere. */
const LAST_VIEW_KEY = "mongoshield.viewer.lastView";

/** localStorage, or undefined when the browser refuses access to it. */
function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readJson(key: string): unknown {
  try {
    const text = storage()?.getItem(key);
    return text === null || text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked storage: the preference is simply not remembered.
  }
}

/** True for a view mode name. */
export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === "string" && (VIEW_MODES as readonly string[]).includes(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Reads and validates the preferences of one scope. */
export function loadPrefs(scope: string): ViewerPrefs {
  const raw = readJson(PREFIX + scope);
  const fallbackView = readJson(LAST_VIEW_KEY);
  if (typeof raw !== "object" || raw === null) {
    return isViewMode(fallbackView) ? { view: fallbackView } : {};
  }
  const record = raw as Record<string, unknown>;
  const view = isViewMode(record.view)
    ? record.view
    : isViewMode(fallbackView)
      ? fallbackView
      : undefined;
  const columns = record.columns as Record<string, unknown> | undefined;
  const widths: Record<string, number> = {};
  if (typeof columns?.widths === "object" && columns.widths !== null) {
    for (const [path, width] of Object.entries(columns.widths)) {
      if (typeof width === "number" && Number.isFinite(width)) {
        widths[path] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
      }
    }
  }
  const history = Array.isArray(record.history)
    ? record.history
        .filter(
          (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
        )
        .map((entry) => historyEntry(entry))
        .filter((entry) => entry !== undefined)
        .slice(0, HISTORY_LIMIT)
    : undefined;
  const cardTitle = optionalString(record.cardTitle);
  const cardSubtitle = optionalString(record.cardSubtitle);
  const chartField = optionalString(record.chartField);
  return {
    ...(view === undefined ? {} : { view }),
    ...(columns === undefined
      ? {}
      : {
          columns: { order: stringList(columns.order), hidden: stringList(columns.hidden), widths },
        }),
    ...(cardTitle === undefined ? {} : { cardTitle }),
    ...(cardSubtitle === undefined ? {} : { cardSubtitle }),
    ...(chartField === undefined ? {} : { chartField }),
    ...(history === undefined ? {} : { history }),
  };
}

/** A stored history entry, or undefined when it holds nothing usable. */
function historyEntry(entry: Record<string, unknown>): HistoryEntry | undefined {
  const filter = optionalString(entry.filter);
  const sort = optionalString(entry.sort);
  const projection = optionalString(entry.projection);
  if (filter === undefined && sort === undefined && projection === undefined) return undefined;
  return {
    ...(filter === undefined ? {} : { filter }),
    ...(sort === undefined ? {} : { sort }),
    ...(projection === undefined ? {} : { projection }),
  };
}

/** Merges a change into the stored preferences of one scope and returns the result. */
export function updatePrefs(scope: string, change: Partial<ViewerPrefs>): ViewerPrefs {
  const next = { ...loadPrefs(scope), ...change };
  writeJson(PREFIX + scope, next);
  if (change.view !== undefined) writeJson(LAST_VIEW_KEY, change.view);
  return next;
}

/** True when two history entries are the same query. */
function sameQuery(a: HistoryEntry, b: HistoryEntry): boolean {
  return a.filter === b.filter && a.sort === b.sort && a.projection === b.projection;
}

/**
 * Puts a query at the top of a collection's history (moving it up when it is already
 * there). Empty queries are not recorded.
 */
export function rememberQuery(scope: string, entry: HistoryEntry): readonly HistoryEntry[] {
  if (entry.filter === undefined && entry.sort === undefined && entry.projection === undefined) {
    return loadPrefs(scope).history ?? [];
  }
  const previous = (loadPrefs(scope).history ?? []).filter((item) => !sameQuery(item, entry));
  const history = [entry, ...previous].slice(0, HISTORY_LIMIT);
  updatePrefs(scope, { history });
  return history;
}

/** The last collection opened in a connection's data browser. */
export function lastCollection(connectionId: string): string | undefined {
  return optionalString(readJson(LAST_PREFIX + connectionId));
}

/** Remembers the collection just opened. */
export function rememberCollection(connectionId: string, ns: string): void {
  writeJson(LAST_PREFIX + connectionId, ns);
}
