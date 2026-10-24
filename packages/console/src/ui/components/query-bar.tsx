/**
 * The query bar of the document viewer: filter, sort and projection as Extended JSON,
 * made simple.
 *
 * - Typing a key suggests field names from the sample (and operators after `$`); ↑/↓
 *   choose, Enter or Tab accepts, Escape closes the list (autocomplete.ts). The sample
 *   behind it is requested only when the filter box is first focused, after a short
 *   pause (the viewer paces it; Atlas shared tiers are throttled).
 * - "Pick…" next to Sort and Projection opens a picker that writes the JSON for you.
 * - Enter in any box applies the query.
 * - History lists this collection's recent queries; choosing one applies it again.
 * - The applied filter's conditions show as chips with × to remove one at a time.
 * - Problems are shown under the box that has them, in words, before any request.
 */

import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  applyCompletion,
  type CompletionContext,
  completionContext,
  suggestionsFor,
} from "../autocomplete.ts";
import type { ConditionChip } from "../quick-filter.ts";
import type { HistoryEntry } from "../view-prefs.ts";
import { Button } from "./button.tsx";
import { SelectField } from "./field.tsx";
import { Icon } from "./icons.tsx";
import { Menu, Popover, usePopover } from "./popover.tsx";

/** The three query boxes. */
export interface QueryText {
  readonly filter: string;
  readonly projection: string;
  readonly sort: string;
}

/** A problem per box, in words. */
export type QueryProblems = Partial<Record<keyof QueryText, string>>;

/** Props for `QueryBar`. */
export interface QueryBarProps {
  readonly text: QueryText;
  readonly onText: (text: QueryText) => void;
  readonly problems: QueryProblems;
  readonly onApply: () => void;
  readonly onReset: () => void;
  /** Field paths for suggestions and pickers. */
  readonly fields: readonly string[];
  /** Called (debounced by the caller) when suggestions would help: the filter box got focus. */
  readonly onWantFields?: (() => void) | undefined;
  /** False for backups (read in storage order, no projection). */
  readonly sortAndProjection: boolean;
  readonly pageSize: string;
  readonly pageSizes: readonly string[];
  readonly onPageSize: (size: string) => void;
  readonly history: readonly HistoryEntry[];
  readonly onHistory: (entry: HistoryEntry) => void;
  readonly chips: readonly ConditionChip[];
  readonly onRemoveChip: (path: string) => void;
  /** While a query runs: shows "Cancel" instead of nothing. */
  readonly busy: boolean;
  readonly onCancel?: (() => void) | undefined;
  /** Something to show at the end of the button row (e.g. the export button). */
  readonly extra?: ReactNode;
}

/** The query bar (see the file header). */
export function QueryBar(props: QueryBarProps) {
  const { text } = props;
  const history = usePopover();
  const sortPicker = usePopover();
  const projectionPicker = usePopover();

  const pageSize = (
    <SelectField
      label="Per page"
      value={props.pageSize}
      options={props.pageSizes.map((size) => ({ value: size, label: size }))}
      onValue={props.onPageSize}
      className="query-page-size"
    />
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onApply();
  };

  return (
    <form className="query-bar" onSubmit={submit} noValidate aria-label="Query">
      <div className="query-row">
        <JsonQueryInput
          label="Filter (Extended JSON)"
          value={text.filter}
          onValue={(filter) => props.onText({ ...text, filter })}
          placeholder='{"status": "paid"}   Type a field name for suggestions'
          fields={props.fields}
          onFocus={props.onWantFields}
          onEnter={props.onApply}
          error={props.problems.filter}
          className="query-filter"
          icon="filter"
        />
        <div className="query-buttons">
          <Button type="submit" variant="primary">
            Apply
          </Button>
          <Button onClick={props.onReset}>Reset</Button>
          <Button
            onClick={history.open}
            disabled={props.history.length === 0}
            aria-haspopup="menu"
            aria-expanded={history.anchor !== undefined}
            title={props.history.length === 0 ? "No queries yet for this collection" : undefined}
          >
            <Icon name="history" size={14} />
            History
          </Button>
          {props.busy && props.onCancel !== undefined ? (
            <Button variant="ghost" onClick={props.onCancel}>
              Cancel query
            </Button>
          ) : null}
        </div>
        {/* Without sort and projection (backups), the page size fits on the filter's row. */}
        {props.sortAndProjection ? null : pageSize}
      </div>

      {props.sortAndProjection ? (
        <div className="query-row query-row-options">
          <JsonQueryInput
            label="Sort"
            value={text.sort}
            onValue={(sort) => props.onText({ ...text, sort })}
            placeholder='{"_id": -1}'
            fields={props.fields}
            onEnter={props.onApply}
            error={props.problems.sort}
            pickLabel="Pick a sort field"
            onPick={sortPicker.open}
          />
          <JsonQueryInput
            label="Projection"
            value={text.projection}
            onValue={(projection) => props.onText({ ...text, projection })}
            placeholder='{"name": 1, "email": 1}'
            fields={props.fields}
            onEnter={props.onApply}
            error={props.problems.projection}
            pickLabel="Pick fields to show"
            onPick={projectionPicker.open}
          />
          {pageSize}
          {props.extra === undefined ? null : <div className="query-extra">{props.extra}</div>}
        </div>
      ) : null}

      {props.chips.length === 0 ? null : (
        <ul className="filter-chips" aria-label="Applied filter">
          {props.chips.map((chip) => (
            <li key={chip.path} className="filter-chip">
              <span>{chip.label}</span>
              <button
                type="button"
                className="filter-chip-remove"
                aria-label={`Remove the condition on ${chip.path}`}
                onClick={() => props.onRemoveChip(chip.path)}
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {history.anchor === undefined ? null : (
        <Menu
          anchor={history.anchor}
          label="Recent queries"
          onClose={history.close}
          items={props.history.map((entry) => ({
            label: <code className="history-query">{entry.filter ?? "{}"}</code>,
            detail:
              [
                entry.sort === undefined ? "" : `sort ${entry.sort}`,
                entry.projection === undefined ? "" : `projection ${entry.projection}`,
              ]
                .filter((part) => part !== "")
                .join(" · ") || undefined,
            onSelect: () => props.onHistory(entry),
          }))}
        />
      )}
      {sortPicker.anchor === undefined ? null : (
        <SortPicker
          anchor={sortPicker.anchor}
          fields={props.fields}
          onClose={sortPicker.close}
          onPick={(sort) => props.onText({ ...text, sort })}
        />
      )}
      {projectionPicker.anchor === undefined ? null : (
        <ProjectionPicker
          anchor={projectionPicker.anchor}
          fields={props.fields}
          current={text.projection}
          onClose={projectionPicker.close}
          onPick={(projection) => props.onText({ ...text, projection })}
        />
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// One JSON box with field suggestions (an ARIA combobox)
// ---------------------------------------------------------------------------

/** Props for `JsonQueryInput`. */
interface JsonQueryInputProps {
  readonly label: string;
  readonly value: string;
  readonly onValue: (value: string) => void;
  readonly placeholder: string;
  readonly fields: readonly string[];
  readonly onFocus?: (() => void) | undefined;
  readonly onEnter: () => void;
  readonly error?: string | undefined;
  readonly hint?: string;
  readonly className?: string;
  readonly icon?: "filter";
  /** A "Pick…" button next to the box. */
  readonly pickLabel?: string;
  readonly onPick?: (event: { currentTarget: HTMLElement }) => void;
}

/** A one-line JSON box that suggests field names (see the file header). */
function JsonQueryInput(props: JsonQueryInputProps) {
  const id = useId();
  const listId = `${id}-suggestions`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const ref = useRef<HTMLInputElement>(null);
  const [context, setContext] = useState<CompletionContext | undefined>(undefined);
  const [active, setActive] = useState(0);
  /** A caret position to restore after accepting a suggestion. */
  const pendingCaret = useRef<number | undefined>(undefined);
  const suggestions = context === undefined ? [] : suggestionsFor(context, props.fields);
  const open = suggestions.length > 0;

  useEffect(() => {
    const caret = pendingCaret.current;
    if (caret === undefined || ref.current === null) return;
    pendingCaret.current = undefined;
    ref.current.setSelectionRange(caret, caret);
  });

  const update = (value: string, caret: number) => {
    props.onValue(value);
    setContext(completionContext(value, caret));
    setActive(0);
  };

  const accept = (suggestion: string) => {
    if (context === undefined) return;
    const next = applyCompletion(props.value, context, suggestion);
    pendingCaret.current = next.caret;
    props.onValue(next.text);
    setContext(undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const choice = suggestions[active];
        if (choice !== undefined) {
          event.preventDefault();
          accept(choice);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        // Escape here must not also close a surrounding dialog.
        event.stopPropagation();
        setContext(undefined);
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      props.onEnter();
    }
  };

  const describedBy =
    [props.hint === undefined ? "" : hintId, props.error === undefined ? "" : errorId]
      .filter((part) => part !== "")
      .join(" ") || undefined;
  const activeId = open ? `${listId}-${active}` : undefined;

  return (
    <div className={`field json-input ${props.className ?? ""}`}>
      <label htmlFor={id} className="field-label">
        {props.label}
      </label>
      <div className="json-input-row">
        <div className="json-input-box">
          {props.icon === undefined ? null : (
            <span className="json-input-icon" aria-hidden="true">
              <Icon name={props.icon} size={14} />
            </span>
          )}
          {/* An <input>, not a <textarea>: only text inputs may be ARIA comboboxes. */}
          <input
            ref={ref}
            id={id}
            type="text"
            className={`input input-code ${props.icon === undefined ? "" : "input-with-icon"}`}
            spellCheck={false}
            autoComplete="off"
            value={props.value}
            placeholder={props.placeholder}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-invalid={props.error === undefined ? undefined : true}
            aria-describedby={describedBy}
            onChange={(event) =>
              update(
                event.currentTarget.value,
                event.currentTarget.selectionStart ?? event.currentTarget.value.length,
              )
            }
            onKeyDown={onKeyDown}
            onFocus={props.onFocus}
            onBlur={() => setContext(undefined)}
          />
          <ul
            id={listId}
            // The combobox pattern: the options are chosen with aria-activedescendant, not
            // focused, so they are list items with ARIA roles.
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: see above.
            role="listbox"
            // Not named after the box: a label like "Filter …" would also match it.
            aria-label="Matching field names"
            className="suggestions"
            hidden={!open}
          >
            {suggestions.map((suggestion, index) => (
              // biome-ignore lint/a11y/useFocusableInteractive: chosen with aria-activedescendant.
              <li
                key={suggestion}
                id={`${listId}-${index}`}
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: see the list.
                role="option"
                aria-selected={index === active}
                className="suggestion"
                // mousedown, not click: it comes before the textarea's blur closes the list.
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(suggestion);
                }}
              >
                {suggestion}
              </li>
            ))}
          </ul>
        </div>
        {props.onPick === undefined ? null : (
          <Button
            size="small"
            variant="ghost"
            onClick={props.onPick}
            aria-label={props.pickLabel}
            aria-haspopup="dialog"
            title={props.pickLabel}
            className="json-input-pick"
          >
            Pick…
          </Button>
        )}
      </div>
      {props.hint === undefined ? null : (
        <p id={hintId} className="field-hint">
          {props.hint}
        </p>
      )}
      {props.error === undefined ? null : (
        <p id={errorId} className="field-error" role="alert">
          <span aria-hidden="true">! </span>
          {props.error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/** Chooses one field and a direction, and writes `{"field": 1}` / `{"field": -1}`. */
function SortPicker(props: {
  anchor: HTMLElement;
  fields: readonly string[];
  onClose: () => void;
  onPick: (sort: string) => void;
}) {
  const [field, setField] = useState(props.fields[0] ?? "_id");
  const [direction, setDirection] = useState<"1" | "-1">("1");
  const options = (props.fields.length === 0 ? ["_id"] : props.fields).map((path) => ({
    value: path,
    label: path,
  }));
  return (
    <Popover anchor={props.anchor} label="Sort by" onClose={props.onClose} className="picker">
      <div className="picker-body">
        <SelectField label="Field" value={field} options={options} onValue={setField} />
        <SelectField<"1" | "-1">
          label="Order"
          value={direction}
          options={[
            { value: "1", label: "Ascending (A → Z, 0 → 9, oldest first)" },
            { value: "-1", label: "Descending (Z → A, 9 → 0, newest first)" },
          ]}
          onValue={setDirection}
        />
        <div className="picker-actions">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              props.onPick(JSON.stringify({ [field]: Number(direction) }));
              props.onClose();
            }}
          >
            Use this sort
          </Button>
        </div>
      </div>
    </Popover>
  );
}

/** Ticks fields to show, and writes `{"a": 1, "b": 1}`. */
function ProjectionPicker(props: {
  anchor: HTMLElement;
  fields: readonly string[];
  current: string;
  onClose: () => void;
  onPick: (projection: string) => void;
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(props.current);
      if (typeof parsed === "object" && parsed !== null) {
        return new Set(
          Object.entries(parsed)
            .filter(([, on]) => on === 1 || on === true)
            .map(([path]) => path),
        );
      }
    } catch {
      // Nothing usable typed yet: start empty.
    }
    return new Set();
  });
  const [search, setSearch] = useState("");
  const shown = props.fields.filter((path) => path.toLowerCase().includes(search.toLowerCase()));
  const toggle = (path: string) => {
    const next = new Set(chosen);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setChosen(next);
  };
  return (
    <Popover
      anchor={props.anchor}
      label="Fields to show"
      onClose={props.onClose}
      className="picker"
    >
      <div className="picker-body">
        <label className="field">
          <span className="field-label">Find a field</span>
          <input
            className="input"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            data-autofocus
          />
        </label>
        <ul className="picker-list">
          {shown.map((path) => (
            <li key={path}>
              <label className="picker-option">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={chosen.has(path)}
                  onChange={() => toggle(path)}
                />
                <span className="mono">{path}</span>
              </label>
            </li>
          ))}
          {shown.length === 0 ? <li className="muted">No matching fields.</li> : null}
        </ul>
        <div className="picker-actions">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              props.onPick(
                chosen.size === 0
                  ? ""
                  : JSON.stringify(Object.fromEntries([...chosen].map((path) => [path, 1]))),
              );
              props.onClose();
            }}
          >
            {chosen.size === 0
              ? "Show all fields"
              : `Show ${chosen.size} ${chosen.size === 1 ? "field" : "fields"}`}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
