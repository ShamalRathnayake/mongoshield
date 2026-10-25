/**
 * NamespacePicker: the databases and collections of a connection as a checkbox tree,
 * for choosing what a backup plan includes.
 *
 *   [▾] [■] shop        4 of 6 collections · 14.6M documents
 *         [✓] users     48,210
 *         [ ] sessions  902,113
 *   [▸] [ ] analytics   0 of 2 collections · 8,760 documents
 *
 * - A database checkbox is tri-state: ticked (all), mixed (some, the native
 *   `indeterminate` state, announced as "mixed") or empty. Its row also says "4 of 6
 *   collections", so the state is never shown by the box alone.
 * - The search box narrows the tree to matching database and collection names, and
 *   "Select all" / "Select none" then act on what is shown.
 * - The choices are include patterns (see namespace-picks.ts): a ticked database is
 *   "shop.*", single collections are "shop.users".
 *
 * The parent loads the tree (`GET /api/connections/:id/namespaces`) and passes it in
 * with its loading and error state, so the same load can feed other views.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { DatabaseNode } from "../../shared/api.ts";
import { formatNumber, plural } from "../format.ts";
import {
  databaseState,
  documentsIn,
  filterTree,
  isPicked,
  type PickState,
  pickedCount,
  pickedTotals,
  setCollectionPicked,
  setDatabasePicked,
  setShownPicked,
  unknownPicks,
} from "../namespace-picks.ts";
import { Button } from "./button.tsx";
import { ErrorNotice, Loading, Notice } from "./layout.tsx";
import "./namespace-picker.css";

/** Props for `NamespacePicker`. */
export interface NamespacePickerProps {
  /** The connection's databases; undefined until loaded. */
  readonly tree: readonly DatabaseNode[] | undefined;
  readonly loading: boolean;
  /** The load error, shown with a retry button. */
  readonly error: unknown;
  readonly onRetry: () => void;
  /** The current choices as include patterns. */
  readonly picks: readonly string[];
  readonly onPicks: (picks: string[]) => void;
  /** A validation message, e.g. "Choose at least one…". */
  readonly message?: string | undefined;
  /** Names the group of checkboxes for screen readers. */
  readonly legend: string;
}

/** The picker, with its loading, error and empty states. */
export function NamespacePicker(props: NamespacePickerProps) {
  if (props.error !== undefined) {
    return (
      <ErrorNotice
        error={props.error}
        onRetry={props.onRetry}
        title="Could not list the databases of this connection"
      />
    );
  }
  // While a new connection's tree loads, the previous one is not shown (it would be
  // the wrong connection's databases).
  if (props.loading || props.tree === undefined) {
    return props.loading ? (
      <Loading label="Listing databases…" />
    ) : (
      <p className="muted">Choose a connection to see its databases.</p>
    );
  }
  if (props.tree.length === 0) {
    return <p className="muted">This connection has no user databases yet.</p>;
  }
  return <PickerTree {...props} tree={props.tree} />;
}

/** The search box, the bulk buttons, the tree and the summary. */
function PickerTree(props: NamespacePickerProps & { readonly tree: readonly DatabaseNode[] }) {
  const { tree, picks, onPicks } = props;
  const [query, setQuery] = useState("");
  const pickSet = new Set(picks);
  // Small trees open fully; larger ones open only the partly chosen databases.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        tree
          .filter((database) => tree.length <= 3 || databaseState(database, pickSet) === "some")
          .map((database) => database.name),
      ),
  );
  const searchId = useId();
  const messageId = useId();

  const shown = filterTree(tree, query);
  const searching = query.trim() !== "";
  const totals = pickedTotals(tree, picks);
  const unknown = unknownPicks(tree, picks);

  /** Opens or closes one database's collection list. */
  const toggleExpanded = (name: string) => {
    const next = new Set(expanded);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpanded(next);
  };

  return (
    <fieldset
      className="ns-picker"
      aria-describedby={props.message === undefined ? undefined : messageId}
    >
      <legend className="visually-hidden">{props.legend}</legend>

      <div className="ns-picker-toolbar">
        <label htmlFor={searchId} className="visually-hidden">
          Search databases and collections
        </label>
        <input
          id={searchId}
          type="search"
          className="input ns-picker-search"
          placeholder="Search databases and collections"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button size="small" onClick={() => onPicks(setShownPicked(tree, picks, shown, true))}>
          {searching ? "Select shown" : "Select all"}
        </Button>
        <Button size="small" onClick={() => onPicks(setShownPicked(tree, picks, shown, false))}>
          {searching ? "Clear shown" : "Select none"}
        </Button>
      </div>

      <p className="ns-picker-summary" aria-live="polite">
        <strong className="numeric">{totals.collections}</strong> of{" "}
        {plural(totals.total, "collection")} chosen, about{" "}
        <span className="numeric">{formatNumber(totals.documents)}</span> documents.
      </p>

      {shown.length === 0 ? (
        <p className="muted">Nothing matches "{query.trim()}".</p>
      ) : (
        <ul className="ns-picker-list">
          {shown.map((shownDatabase) => {
            // The full database (the search may show only some collections).
            const database =
              tree.find((candidate) => candidate.name === shownDatabase.name) ?? shownDatabase;
            return (
              <DatabaseRow
                key={database.name}
                database={database}
                shownCollections={shownDatabase.collections}
                picks={pickSet}
                open={searching || expanded.has(database.name)}
                onToggleOpen={searching ? undefined : () => toggleExpanded(database.name)}
                onDatabase={(on) => onPicks(setDatabasePicked(tree, picks, database, on))}
                onCollection={(name, on) =>
                  onPicks(setCollectionPicked(tree, picks, database, name, on))
                }
              />
            );
          })}
        </ul>
      )}

      {unknown.length === 0 ? null : (
        <Notice tone="warning" title="Not on this connection">
          <p>
            Also chosen, but not found on this connection now:{" "}
            {unknown.map((pick, index) => (
              <span key={pick}>
                {index === 0 ? "" : ", "}
                <code>{pick}</code>
              </span>
            ))}
            . They are still backed up if they appear.
          </p>
          <Button
            size="small"
            onClick={() => onPicks(picks.filter((pick) => !unknown.includes(pick)))}
          >
            Remove {unknown.length === 1 ? "it" : "them"}
          </Button>
        </Notice>
      )}

      {props.message === undefined ? null : (
        <p id={messageId} className="field-error" role="alert">
          <span aria-hidden="true">! </span>
          {props.message}
        </p>
      )}
    </fieldset>
  );
}

/** One database: expand button, tri-state checkbox, counts, and its collections. */
function DatabaseRow(props: {
  database: DatabaseNode;
  /** The collections to list (all of them, or the ones the search matched). */
  shownCollections: DatabaseNode["collections"];
  picks: ReadonlySet<string>;
  open: boolean;
  /** Undefined while searching: matches are always shown open. */
  onToggleOpen: (() => void) | undefined;
  onDatabase: (on: boolean) => void;
  onCollection: (collection: string, on: boolean) => void;
}) {
  const { database, picks } = props;
  const listId = useId();
  const count = pickedCount(database, picks);
  const state = databaseState(database, picks);
  const hasCollections = database.collections.length > 0;

  return (
    <li className="ns-picker-database">
      <div className="ns-picker-row">
        {/* The expand button keeps its place even when it cannot be used, so the rows line up. */}
        {hasCollections && props.onToggleOpen !== undefined ? (
          <button
            type="button"
            className="ns-picker-expand"
            aria-expanded={props.open}
            aria-controls={listId}
            aria-label={`${props.open ? "Hide" : "Show"} collections in ${database.name}`}
            onClick={props.onToggleOpen}
          >
            <span aria-hidden="true">{props.open ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span className="ns-picker-expand" aria-hidden="true" />
        )}
        <TriStateCheckbox
          state={state}
          label={database.name}
          className="ns-picker-name"
          onChecked={props.onDatabase}
        />
        <span className="ns-picker-meta">
          {hasCollections
            ? `${count} of ${plural(database.collections.length, "collection")}`
            : "No collections yet"}{" "}
          · {formatNumber(documentsIn(database))} documents
        </span>
      </div>
      {hasCollections && props.open ? (
        <ul id={listId} className="ns-picker-collections">
          {props.shownCollections.map((collection) => (
            <li key={collection.name} className="ns-picker-row">
              <TriStateCheckbox
                state={isPicked(picks, database.name, collection.name) ? "all" : "none"}
                label={collection.name}
                // The database name as well, so "users" in two databases can be told apart.
                accessibleLabel={`${database.name}.${collection.name}`}
                className="ns-picker-name"
                onChecked={(on) => props.onCollection(collection.name, on)}
              />
              {collection.type === "collection" ? null : (
                <span className="badge badge-neutral">{collection.type}</span>
              )}
              <span className="ns-picker-meta numeric">
                {formatNumber(collection.estimatedDocuments)}
                <span className="visually-hidden"> documents</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * A native checkbox with a label, that can also show "some" (the native indeterminate
 * state, which browsers announce as "mixed"). Clicking a mixed box ticks everything.
 */
function TriStateCheckbox(props: {
  state: PickState;
  label: string;
  /** A fuller name for screen readers, when the visible label alone is ambiguous. */
  accessibleLabel?: string;
  className?: string;
  onChecked: (checked: boolean) => void;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  // `indeterminate` is a property, not an attribute, so it is set after rendering.
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = props.state === "some";
  }, [props.state]);
  return (
    <span className="ns-picker-check">
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className="checkbox"
        checked={props.state === "all"}
        aria-label={props.accessibleLabel}
        onChange={(event) => props.onChecked(event.target.checked)}
      />
      <label htmlFor={id} className={props.className}>
        {props.label}
      </label>
    </span>
  );
}
