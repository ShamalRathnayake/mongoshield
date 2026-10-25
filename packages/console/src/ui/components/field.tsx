/**
 * Form fields: a label, the control, an optional hint and an error message, wired
 * together with ids so screen readers announce the hint and error with the control.
 *
 * `Field` is the generic wrapper; `TextField`, `TextAreaField`, `SelectField` and
 * `CheckboxField` cover the controls the console uses.
 */

import {
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useId,
  useState,
} from "react";
import { Icon } from "./icons.tsx";
import "./field.css";

/** Ids and state handed to the control inside a `Field`. */
export interface FieldControl {
  readonly id: string;
  /** Pass as `aria-describedby`; undefined when there is no hint or error. */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

/** Props shared by every field. */
interface FieldBaseProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  /** Shown under the control in the danger color, with a "!" marker. */
  readonly error?: string | undefined;
  readonly className?: string | undefined;
  /**
   * One-click values right under the control, above the hint (a `FillSuggestions`):
   * there they are seen first, instead of after a paragraph of help text.
   */
  readonly suggestions?: ReactNode;
}

/** Wraps any control with a label, hint and error. */
export function Field(props: FieldBaseProps & { children: (control: FieldControl) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [props.hint === undefined ? "" : hintId, props.error === undefined ? "" : errorId]
      .filter((value) => value !== "")
      .join(" ") || undefined;
  return (
    <div className={`field ${props.className ?? ""}`}>
      <label htmlFor={id} className="field-label">
        {props.label}
      </label>
      {props.children({ id, describedBy, invalid: props.error !== undefined })}
      {props.suggestions}
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

/**
 * What the show/hide button calls the field: "password" for "Password", the label as
 * written otherwise ("Show Secret access key"), keeping acronyms such as "URL" intact.
 */
function revealName(label: ReactNode): string {
  if (typeof label !== "string") return "password";
  // Lower-case the first letter only when the second is lower case too ("Password",
  // not "URL").
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/**
 * A single-line text input. `onValue` receives the new string.
 *
 * A `type="password"` field gets an eye button at its right end that shows and hides
 * what was typed (a toggle: `aria-pressed`, named "Show password" / "Hide password"),
 * so people can check a long password or key before saving it.
 */
export function TextField(
  props: FieldBaseProps &
    Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "className"> & {
      readonly value: string;
      readonly onValue: (value: string) => void;
    },
) {
  const { label, hint, error, className, suggestions, value, onValue, ...inputProps } = props;
  const secret = inputProps.type === "password";
  const [revealed, setRevealed] = useState(false);
  const name = revealName(label);
  return (
    <Field label={label} hint={hint} error={error} className={className} suggestions={suggestions}>
      {(control) => {
        const input = (
          <input
            type="text"
            {...inputProps}
            // A revealed secret is a plain text box until hidden again.
            {...(secret && revealed ? { type: "text" } : {})}
            id={control.id}
            className={secret ? "input input-revealable" : "input"}
            value={value}
            aria-describedby={control.describedBy}
            aria-invalid={control.invalid || undefined}
            onChange={(event) => onValue(event.target.value)}
          />
        );
        if (!secret) return input;
        return (
          <div className="input-reveal">
            {input}
            <button
              type="button"
              className="input-reveal-button"
              aria-label={`${revealed ? "Hide" : "Show"} ${name}`}
              aria-pressed={revealed}
              aria-controls={control.id}
              title={revealed ? "Hide" : "Show"}
              disabled={inputProps.disabled}
              onClick={() => setRevealed((shown) => !shown)}
            >
              <Icon name={revealed ? "eyeOff" : "view"} />
            </button>
          </div>
        );
      }}
    </Field>
  );
}

/** A multi-line text input, used for lists (one entry per line) and JSON. */
export function TextAreaField(
  props: FieldBaseProps &
    Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value" | "className"> & {
      readonly value: string;
      readonly onValue: (value: string) => void;
    },
) {
  const { label, hint, error, className, suggestions, value, onValue, ...textareaProps } = props;
  return (
    <Field label={label} hint={hint} error={error} className={className} suggestions={suggestions}>
      {(control) => (
        <textarea
          {...textareaProps}
          id={control.id}
          className="input textarea"
          value={value}
          aria-describedby={control.describedBy}
          aria-invalid={control.invalid || undefined}
          onChange={(event) => onValue(event.target.value)}
        />
      )}
    </Field>
  );
}

/** One option of a `SelectField`. */
export interface SelectOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
}

/** A native select; typed so `onValue` receives one of the option values. */
export function SelectField<Value extends string>(
  props: FieldBaseProps & {
    readonly value: Value;
    readonly options: readonly SelectOption<Value>[];
    readonly onValue: (value: Value) => void;
    readonly disabled?: boolean;
    readonly name?: string;
  },
) {
  const { options, onValue } = props;
  return (
    <Field label={props.label} hint={props.hint} error={props.error} className={props.className}>
      {(control) => (
        <select
          id={control.id}
          name={props.name}
          className="input select"
          value={props.value}
          disabled={props.disabled}
          aria-describedby={control.describedBy}
          aria-invalid={control.invalid || undefined}
          onChange={(event) => {
            // Map back through the options so the value is typed without a cast.
            const chosen = options.find((option) => option.value === event.target.value);
            if (chosen !== undefined) onValue(chosen.value);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** A checkbox with its label to the right, as people expect for toggles. */
export function CheckboxField(props: {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChecked: (checked: boolean) => void;
  readonly hint?: ReactNode;
  readonly disabled?: boolean;
  /**
   * A fuller name for screen readers when the visible label alone is ambiguous, e.g.
   * "shop.orders" for a box that shows only "orders" under its database.
   */
  readonly accessibleLabel?: string;
}) {
  const id = useId();
  return (
    <div className="field field-checkbox">
      <input
        id={id}
        type="checkbox"
        className="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.accessibleLabel}
        aria-describedby={props.hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => props.onChecked(event.target.checked)}
      />
      <div>
        <label htmlFor={id} className="field-label">
          {props.label}
        </label>
        {props.hint === undefined ? null : (
          <p id={`${id}-hint`} className="field-hint">
            {props.hint}
          </p>
        )}
      </div>
    </div>
  );
}

/** Groups related fields under a heading (`<fieldset>` + `<legend>`). */
export function FieldGroup(props: {
  legend: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="field-group">
      <legend>{props.legend}</legend>
      {props.description === undefined ? null : <p className="field-hint">{props.description}</p>}
      {props.children}
    </fieldset>
  );
}
