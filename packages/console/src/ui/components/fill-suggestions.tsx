/**
 * FillSuggestions: a row of one-click values under a text field, so people can fill a
 * field by clicking instead of typing:
 *
 *   Name
 *   [                         ]
 *   ✦ Suggestions: [Production cluster] [cluster0] [Staging]
 *   (the hint)
 *
 * - Each suggestion is a real button; clicking it fills the field (the page decides
 *   how: replace the value, or append to it).
 * - The suggestion that equals the field's current value is marked as chosen (pressed),
 *   with a check mark as well as the colour.
 * - Empty and duplicate suggestions are dropped, and the row hides itself when none are
 *   left, so pages can pass whatever they can think of without filtering first.
 * - The group is named after the field ("Suggestions for Name"), so screen reader users
 *   know what the buttons fill.
 */

import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";
import "./fill-suggestions.css";

/** One suggestion: the value it fills in, and optionally what the chip says instead. */
export interface FillSuggestion {
  readonly value: string;
  /** What the chip shows; the value itself when absent. */
  readonly label?: ReactNode;
  /** A tooltip explaining the suggestion, e.g. where it came from. */
  readonly hint?: string;
}

/** Props for `FillSuggestions`. */
export interface FillSuggestionsProps {
  /** The label of the field the suggestions fill, for the group's accessible name. */
  readonly field: string;
  /** Suggestions as plain values or with labels; empty and repeated values are dropped. */
  readonly items: readonly (FillSuggestion | string | undefined)[];
  /** Called with the clicked suggestion's value. */
  readonly onPick: (value: string) => void;
  /** The field's current value, to mark the matching suggestion as chosen. */
  readonly current?: string;
  /** The word before the chips (default "Suggestions"). */
  readonly lead?: string;
  /** Show values in the mono font (connection strings, paths, ids). */
  readonly mono?: boolean;
}

/** Turns the mixed input list into unique, non-empty suggestions. */
export function uniqueSuggestions(
  items: readonly (FillSuggestion | string | undefined)[],
): FillSuggestion[] {
  const seen = new Set<string>();
  const result: FillSuggestion[] = [];
  for (const item of items) {
    if (item === undefined) continue;
    const suggestion = typeof item === "string" ? { value: item } : item;
    const key = suggestion.value.trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    result.push(suggestion);
  }
  return result;
}

/** The row of suggestion chips (see the file header). */
export function FillSuggestions(props: FillSuggestionsProps) {
  const items = uniqueSuggestions(props.items);
  if (items.length === 0) return null;
  const current = props.current?.trim();
  return (
    // A fieldset is a group by itself; its aria-label names it after the field.
    <fieldset className="fill-suggestions" aria-label={`Suggestions for ${props.field}`}>
      <span className="fill-suggestions-lead" aria-hidden="true">
        <Icon name="sparkle" size={13} />
        {props.lead ?? "Suggestions"}:
      </span>
      {items.map((item) => {
        const chosen = current !== undefined && current === item.value.trim();
        return (
          <button
            key={item.value}
            type="button"
            className={`fill-suggestion${props.mono === true ? " fill-suggestion-mono" : ""}`}
            aria-pressed={chosen}
            title={item.hint}
            onClick={() => props.onPick(item.value)}
          >
            {chosen ? <Icon name="check" size={12} /> : null}
            {item.label ?? item.value}
          </button>
        );
      })}
    </fieldset>
  );
}
