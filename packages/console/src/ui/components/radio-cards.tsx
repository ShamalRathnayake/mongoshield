/**
 * RadioCards: a choice between a few options, each shown as a card with a title and a
 * one-line explanation, built from real radio buttons in a `<fieldset>`.
 *
 * Used where a select box would hide the explanation people need to choose well, e.g.
 * "Restore as" in the restore wizard or how a storage location authenticates. Native
 * radios give the keyboard behaviour for free (Tab into the group, arrow keys between
 * options), and the selected card is marked by the filled radio dot AND a highlighted
 * border, so colour is never the only cue.
 */

import { type ReactNode, useId } from "react";
import "./radio-cards.css";

/** One option of a `RadioCards` group. */
export interface RadioCardOption<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
  /** A short explanation under the label, announced with the option. */
  readonly description?: ReactNode;
  /** Shown but not choosable; say why in `description`. */
  readonly disabled?: boolean;
}

/** Props for `RadioCards`. */
export interface RadioCardsProps<Value extends string> {
  /** The question the options answer; becomes the fieldset's legend. */
  readonly legend: ReactNode;
  /** Hides the legend visually (screen readers still read it) when a heading already says it. */
  readonly hideLegend?: boolean;
  readonly value: Value;
  readonly options: readonly RadioCardOption<Value>[];
  readonly onValue: (value: Value) => void;
  /** Extra explanation under the legend. */
  readonly hint?: ReactNode;
}

/** A group of radio buttons drawn as cards (see the file header). */
export function RadioCards<Value extends string>(props: RadioCardsProps<Value>) {
  // One name per group, so the browser treats the radios as one choice.
  const name = useId();
  const hintId = `${name}-hint`;
  return (
    <fieldset
      className="radio-cards"
      aria-describedby={props.hint === undefined ? undefined : hintId}
    >
      <legend className={props.hideLegend === true ? "visually-hidden" : "field-label"}>
        {props.legend}
      </legend>
      {props.hint === undefined ? null : (
        <p id={hintId} className="field-hint">
          {props.hint}
        </p>
      )}
      <div className="radio-cards-grid">
        {props.options.map((option) => {
          const labelId = `${name}-${option.value}-label`;
          const descriptionId = `${name}-${option.value}-description`;
          return (
            <label
              key={option.value}
              className="radio-card"
              data-disabled={option.disabled === true || undefined}
            >
              <input
                type="radio"
                className="radio-card-input"
                name={name}
                value={option.value}
                checked={props.value === option.value}
                disabled={option.disabled}
                // Named by the label only; the explanation is its description, so it is
                // read after the name instead of making the name long.
                aria-labelledby={labelId}
                aria-describedby={option.description === undefined ? undefined : descriptionId}
                onChange={() => props.onValue(option.value)}
              />
              <span className="radio-card-text">
                <span id={labelId} className="radio-card-label">
                  {option.label}
                </span>
                {option.description === undefined ? null : (
                  <span id={descriptionId} className="radio-card-description">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
