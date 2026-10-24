/**
 * Copying to the clipboard: `copyText` for any caller, and `CopyButton`, a small button
 * that says "Copied" for two seconds after a successful copy.
 *
 * The Clipboard API can be refused (an insecure http:// origin, browser permissions);
 * the button then says "Copy failed" so the user knows to select the text by hand,
 * instead of silently doing nothing.
 */

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";

/** How long the "Copied" confirmation stays (ms). */
const CONFIRMATION_MS = 2_000;

/** Copies text; resolves true when the browser accepted it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A button that copies `text` (computed on click when a function is given). */
export function CopyButton(props: {
  text: string | (() => string);
  /** The visible label, e.g. "Copy JSON". */
  label: string;
  /** A longer accessible name, e.g. "Copy the value of address.city". */
  ariaLabel?: string;
  /** Icon only (the label becomes the accessible name and the tooltip). */
  iconOnly?: boolean;
  size?: "normal" | "small";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const text = typeof props.text === "function" ? props.text() : props.text;
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), CONFIRMATION_MS);
  };

  const shown = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : props.label;
  const small = props.size !== "normal";
  return (
    <button
      type="button"
      className={`button button-ghost ${small ? "button-small" : ""} ${props.iconOnly ? "button-icon" : ""}`}
      onClick={() => void copy()}
      aria-label={props.iconOnly ? (props.ariaLabel ?? props.label) : props.ariaLabel}
      title={props.iconOnly ? shown : undefined}
    >
      <Icon name={state === "copied" ? "check" : "copy"} size={14} />
      {props.iconOnly ? null : <span>{shown}</span>}
      {/* Announce the outcome to screen readers even for icon-only buttons. */}
      {props.iconOnly && state !== "idle" ? (
        <span className="visually-hidden" role="status">
          {shown}
        </span>
      ) : null}
    </button>
  );
}
