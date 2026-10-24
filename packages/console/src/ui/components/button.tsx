/**
 * Buttons and button-styled links. Every action in the UI goes through these so focus
 * styles, the busy state and the danger styling are consistent.
 */

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

/** Visual weight: one `primary` per view, `danger` for destructive actions. */
export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

/** Props for `Button`: a native button plus variant, size and busy state. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: "normal" | "small";
  /** Shows a spinner and disables the button while an action runs. */
  readonly busy?: boolean;
  /** The underlying `<button>`, e.g. to move focus to it. */
  readonly ref?: Ref<HTMLButtonElement>;
}

function buttonClass(variant: ButtonVariant, size: "normal" | "small", extra?: string): string {
  return ["button", `button-${variant}`, size === "small" ? "button-small" : "", extra ?? ""]
    .filter((name) => name !== "")
    .join(" ");
}

/**
 * A button. Defaults to `type="button"` so it never submits a form by accident; pass
 * `type="submit"` explicitly for form submit buttons.
 */
export function Button(props: ButtonProps) {
  const {
    variant = "secondary",
    size = "normal",
    busy = false,
    className,
    children,
    disabled,
    type,
    ...rest
  } = props;
  return (
    <button
      {...rest}
      // The type is chosen by the caller and defaults to "button".
      type={type ?? "button"}
      className={buttonClass(variant, size, className)}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** A link styled as a button, for navigation actions ("New plan"). */
export function LinkButton(props: {
  href: string;
  variant?: ButtonVariant;
  size?: "normal" | "small";
  children: ReactNode;
}) {
  return (
    <a
      href={props.href}
      className={buttonClass(props.variant ?? "secondary", props.size ?? "normal")}
    >
      {props.children}
    </a>
  );
}
