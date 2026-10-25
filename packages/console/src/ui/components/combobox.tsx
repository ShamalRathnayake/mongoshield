/**
 * ComboboxField: a text box that suggests known values while still accepting anything
 * typed. For values that usually come from a known set but may also be new or partial:
 * a plan name (pick an existing plan to update it, or type a new one), a search term
 * (pick a known target, or type part of one), a number with common presets.
 *
 *   Plan name
 *   [ Nightly pro          ▾ ]
 *     ┌──────────────────────────────────┐
 *     │ Nightly production   updates it  │  ← options matching what was typed
 *     └──────────────────────────────────┘
 *
 * It follows the WAI-ARIA "combobox with list autocomplete, manual selection" pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/):
 *
 * - The input has `role="combobox"`, `aria-expanded`, `aria-controls` (the listbox) and
 *   `aria-activedescendant` (the highlighted option). Focus stays in the input; the
 *   options are only highlighted, so screen readers announce them as the arrows move.
 * - Typing opens the list, narrowed to the options containing the text.
 * - Down / Up arrow open the list and move the highlight (wrapping around); Alt+Down
 *   opens it without moving. Enter takes the highlighted option; with none highlighted it
 *   does nothing special, so a surrounding form still submits. Escape closes the list
 *   (and only the list, never a surrounding dialog). Tab closes it and moves on.
 * - The ▾ button shows every option (it is skipped by Tab, as the pattern suggests,
 *   because the arrow keys already open the list from the input).
 *
 * Styling uses design tokens only (combobox.css), so it follows the dark and light themes.
 */

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { Field } from "./field.tsx";
import { Icon } from "./icons.tsx";
import "./combobox.css";

/** One suggestion. */
export interface ComboboxOption {
  /** What goes into the box when the option is chosen. */
  readonly value: string;
  /** Shown instead of `value` in the list, when it reads better (e.g. "1,000"). */
  readonly label?: string;
  /** A short muted note at the end of the option, e.g. "default" or "updates it". */
  readonly description?: string;
}

/**
 * The options whose value or label contains `text`, ignoring case. An empty text, or a
 * text equal to an option (just chosen), matches everything: the person is browsing,
 * not narrowing.
 */
export function matchingOptions(
  options: readonly ComboboxOption[],
  text: string,
): readonly ComboboxOption[] {
  const query = text.trim().toLowerCase();
  if (query === "") return options;
  // The box already holds an exact choice: offer every option so it is easy to switch.
  if (options.some((option) => option.value.toLowerCase() === query)) return options;
  return options.filter(
    (option) =>
      option.value.toLowerCase().includes(query) ||
      (option.label ?? "").toLowerCase().includes(query),
  );
}

/** Props for `ComboboxField`. */
export interface ComboboxFieldProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly className?: string | undefined;
  readonly value: string;
  readonly onValue: (value: string) => void;
  /** The suggestions; anything else may still be typed. */
  readonly options: readonly ComboboxOption[];
  /**
   * Names the list for screen readers, e.g. "Existing plans". Plain text because the
   * label may be a ReactNode; it should not repeat the label word for word, or a
   * "find by label" lookup would match both.
   */
  readonly listLabel: string;
  readonly placeholder?: string;
  readonly inputMode?: "text" | "numeric" | "search";
  /** Monospace text, for identifiers such as namespaces. */
  readonly mono?: boolean;
  readonly disabled?: boolean;
  /** One-click values under the control, above the hint (a `FillSuggestions`). */
  readonly suggestions?: ReactNode;
}

/** A text box with suggestions (see the file header). */
export function ComboboxField(props: ComboboxFieldProps) {
  const { options, onValue } = props;
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  /** The highlighted option's index in `shown`, or -1 for none (manual selection). */
  const [active, setActive] = useState(-1);
  /** True after the ▾ button: show every option, not only those matching the text. */
  const [showAll, setShowAll] = useState(false);

  const shown = showAll ? options : matchingOptions(options, props.value);
  // The list is only "expanded" when it has something to show.
  const expanded = open && shown.length > 0;
  const optionId = (index: number) => `${listId}-option-${index}`;

  /** Closes the list and forgets the highlight. */
  const close = () => {
    setOpen(false);
    setActive(-1);
    setShowAll(false);
  };

  /** Puts an option's value into the box and closes the list. */
  const choose = (option: ComboboxOption) => {
    onValue(option.value);
    close();
  };

  /** Moves the highlight by `step` (wrapping), opening the list first if needed. */
  const move = (step: 1 | -1) => {
    if (!open) setOpen(true);
    if (shown.length === 0) return;
    // From "nothing highlighted", Down goes to the first option and Up to the last.
    const start = active === -1 ? (step === 1 ? -1 : shown.length) : active;
    setActive((start + step + shown.length) % shown.length);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        // Alt+Down only opens the list, as in a native select.
        if (event.altKey) setOpen(true);
        else move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "Enter": {
        const option = expanded ? shown[active] : undefined;
        // Nothing highlighted: let Enter do its usual thing (e.g. submit the form).
        if (option === undefined) return;
        event.preventDefault();
        choose(option);
        return;
      }
      case "Escape":
        if (!expanded) return;
        event.preventDefault();
        // Escape closes the list only, not the dialog around the field.
        event.stopPropagation();
        close();
        return;
      case "Tab":
        close();
        return;
    }
  };

  return (
    <Field
      label={props.label}
      hint={props.hint}
      error={props.error}
      className={props.className}
      suggestions={props.suggestions}
    >
      {(control) => (
        <div className="combobox">
          <input
            ref={inputRef}
            id={control.id}
            type="text"
            className={
              props.mono === true ? "input combobox-input input-code" : "input combobox-input"
            }
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
            aria-describedby={control.describedBy}
            aria-invalid={control.invalid || undefined}
            autoComplete="off"
            spellCheck={false}
            value={props.value}
            placeholder={props.placeholder}
            inputMode={props.inputMode}
            disabled={props.disabled}
            onChange={(event) => {
              onValue(event.currentTarget.value);
              // Typing narrows the list again and drops the old highlight.
              setOpen(true);
              setShowAll(false);
              setActive(-1);
            }}
            onKeyDown={onKeyDown}
            onBlur={close}
          />
          <button
            type="button"
            className="combobox-toggle"
            // Skipped by Tab: the arrow keys open the list from the input.
            tabIndex={-1}
            aria-label="Show all suggestions"
            aria-controls={listId}
            aria-expanded={expanded}
            disabled={props.disabled === true || options.length === 0}
            // mousedown, not click: keep focus in the input, so blur does not close it again.
            onMouseDown={(event) => {
              event.preventDefault();
              if (expanded && showAll) {
                close();
              } else {
                setOpen(true);
                setShowAll(true);
                setActive(-1);
              }
              inputRef.current?.focus();
            }}
          >
            <Icon name="chevronDown" size={14} />
          </button>
          <ul
            id={listId}
            // The combobox pattern: options are highlighted with aria-activedescendant,
            // never focused, so they are list items carrying ARIA roles.
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: see above.
            role="listbox"
            aria-label={props.listLabel}
            className="combobox-list"
            hidden={!expanded}
          >
            {shown.map((option, index) => (
              // biome-ignore lint/a11y/useFocusableInteractive: highlighted via aria-activedescendant.
              <li
                key={option.value}
                id={optionId(index)}
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: see the list.
                role="option"
                aria-selected={index === active}
                className="combobox-option"
                // mousedown, not click: it comes before the input's blur closes the list.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option);
                }}
              >
                <span className={props.mono === true ? "mono" : undefined}>
                  {option.label ?? option.value}
                </span>
                {option.description === undefined ? null : (
                  <span className="combobox-option-note">{option.description}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Field>
  );
}
