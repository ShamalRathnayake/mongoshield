/**
 * The restore wizard's "What to restore" picker: the backup's namespaces grouped by
 * database.
 *
 * - Each database is a group with a "whole database" checkbox that is checked (all of
 *   its collections), unchecked (none) or mixed (some; drawn as a dash and announced as
 *   "mixed"), and a "2 of 4 selected" count.
 * - A search box narrows the list by database or collection name; "Select all" and
 *   "Select none" act on what is shown, so "search orders, select all" picks every
 *   orders collection.
 * - Everything is a native checkbox or button, so Tab, Space and Enter work as usual.
 *
 * When restoring selected documents the namespace is fixed by the document browser, so
 * every control is disabled but still shows what will be restored. The selection logic
 * itself lives in ../namespace-selection.ts.
 */

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/button.tsx";
import { CheckboxField, TextField } from "../components/field.tsx";
import { plural } from "../format.ts";
import type { ManifestNamespace } from "../manifest.ts";
import {
  filterGroups,
  type GroupState,
  groupByDatabase,
  groupState,
  setChosen,
} from "../namespace-selection.ts";
import { splitNamespace } from "../namespaces.ts";
import "./restore-wizard.css";

/** Props for `RestoreNamespacePicker`. */
export interface RestoreNamespacePickerProps {
  /** The backup's namespaces with their document counts and types (from the manifest). */
  readonly entries: readonly Pick<ManifestNamespace, "ns" | "documents" | "type">[];
  readonly chosen: ReadonlySet<string>;
  readonly onChosen: (chosen: Set<string>) => void;
  /** True when restoring selected documents: the choice is fixed. */
  readonly disabled: boolean;
  /** Shown above the list, e.g. "Choose at least one namespace." */
  readonly error?: string | undefined;
}

/** The grouped, searchable namespace checklist (see the file header). */
export function RestoreNamespacePicker(props: RestoreNamespacePickerProps) {
  const { chosen, onChosen, disabled } = props;
  const [query, setQuery] = useState("");
  const groups = groupByDatabase(props.entries);
  const shown = filterGroups(groups, query);
  const shownNamespaces = shown.flatMap((group) => group.entries.map((entry) => entry.ns));
  const filtering = query.trim() !== "";
  // "(3 shown)" tells people the buttons act on the search results only.
  const shownSuffix = filtering ? ` (${shownNamespaces.length} shown)` : "";

  return (
    <div className="ns-picker">
      {props.error === undefined ? null : (
        <p className="field-error" role="alert">
          <span aria-hidden="true">! </span>
          {props.error}
        </p>
      )}
      <div className="ns-picker-toolbar">
        <TextField
          className="ns-picker-search"
          label="Find a database or collection"
          type="search"
          value={query}
          onValue={setQuery}
          spellCheck={false}
          autoComplete="off"
          placeholder="e.g. orders"
          disabled={disabled}
        />
        <div className="ns-picker-buttons">
          <Button
            size="small"
            disabled={disabled || shownNamespaces.length === 0}
            onClick={() => onChosen(setChosen(chosen, shownNamespaces, true))}
          >
            Select all{shownSuffix}
          </Button>
          <Button
            size="small"
            disabled={disabled || shownNamespaces.length === 0}
            onClick={() => onChosen(setChosen(chosen, shownNamespaces, false))}
          >
            Select none{shownSuffix}
          </Button>
        </div>
        {/* A live count, so screen reader users hear the effect of the buttons. */}
        <p className="ns-picker-total muted" aria-live="polite">
          {chosen.size} of {plural(props.entries.length, "collection")} selected
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="muted">No database or collection matches “{query.trim()}”.</p>
      ) : (
        <div className="ns-picker-groups">
          {shown.map((group) => (
            <DatabaseGroupBox
              key={group.database}
              database={group.database}
              // The whole-database checkbox covers ALL its collections, even hidden ones:
              // it says "whole database", and a search should not change what that means.
              allNamespaces={
                groups
                  .find((candidate) => candidate.database === group.database)
                  ?.entries.map((entry) => entry.ns) ?? []
              }
              entries={group.entries}
              chosen={chosen}
              onChosen={onChosen}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One database: its tri-state checkbox, count and collection checkboxes. */
function DatabaseGroupBox(props: {
  database: string;
  allNamespaces: readonly string[];
  entries: RestoreNamespacePickerProps["entries"];
  chosen: ReadonlySet<string>;
  onChosen: (chosen: Set<string>) => void;
  disabled: boolean;
}) {
  const { database, allNamespaces, chosen, onChosen, disabled } = props;
  const headingId = useId();
  const countId = useId();
  const state = groupState(allNamespaces, chosen);
  const selectedCount = allNamespaces.filter((ns) => chosen.has(ns)).length;
  return (
    // A fieldset named by the database (its legend would be styled as a section
    // title by styles.css, and the heading here is the checkbox's own label).
    <fieldset className="ns-picker-group" aria-labelledby={headingId}>
      <div className="ns-picker-group-header">
        <TriStateCheckbox
          state={state}
          disabled={disabled}
          describedBy={countId}
          // A mixed or empty group becomes fully chosen; a full one is cleared.
          onChange={() => onChosen(setChosen(chosen, allNamespaces, state !== "all"))}
          label={
            <>
              <span id={headingId} className="mono ns-picker-database">
                {database}
              </span>{" "}
              <span className="visually-hidden">(whole database)</span>
            </>
          }
        />
        <span id={countId} className="muted ns-picker-count">
          {selectedCount} of {plural(allNamespaces.length, "collection")} selected
        </span>
      </div>
      <div className="checkbox-grid ns-picker-collections">
        {props.entries.map((entry) => (
          <CheckboxField
            key={entry.ns}
            // Visually just the collection; announced as the full namespace.
            label={<span className="mono">{splitNamespace(entry.ns).collection}</span>}
            accessibleLabel={entry.ns}
            hint={describeEntry(entry)}
            checked={chosen.has(entry.ns)}
            disabled={disabled}
            onChecked={(checked) => onChosen(setChosen(chosen, [entry.ns], checked))}
          />
        ))}
      </div>
    </fieldset>
  );
}

/** "48,210 documents", or the type for views and time series (which have no count). */
function describeEntry(entry: RestoreNamespacePickerProps["entries"][number]): string {
  if (entry.type === "view") return "View";
  // `plural` formats the number too: "48,210 documents".
  const documents = plural(entry.documents, "document");
  return entry.type === "timeseries" ? `Time series · ${documents}` : documents;
}

/**
 * A checkbox that can also be "mixed". Browsers only expose that through the
 * `indeterminate` property (there is no attribute), so it is set after each render;
 * `aria-checked="mixed"` says the same to assistive technology that reads attributes.
 */
function TriStateCheckbox(props: {
  state: GroupState;
  label: ReactNode;
  disabled: boolean;
  describedBy: string;
  onChange: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = props.state === "some";
  }, [props.state]);
  return (
    <span className="ns-picker-tristate">
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className="checkbox"
        checked={props.state === "all"}
        aria-checked={props.state === "some" ? "mixed" : undefined}
        aria-describedby={props.describedBy}
        disabled={props.disabled}
        onChange={props.onChange}
      />
      <label htmlFor={id} className="field-label">
        {props.label}
      </label>
    </span>
  );
}
