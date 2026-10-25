/**
 * A modal dialog with a focus trap.
 *
 * While open: focus moves into the dialog (to the element marked `data-autofocus`, else
 * the first focusable element), Tab and Shift+Tab cycle inside it, Escape closes it, and
 * the rest of the page is hidden from assistive technology (`aria-modal`). On close,
 * focus returns to whatever was focused before, so keyboard users don't lose their place.
 *
 * Written by hand rather than with `<dialog>.showModal()` because jsdom (used by the
 * tests) does not implement it, and the behaviour here is small enough to own.
 */

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

/** Elements that can take keyboard focus. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The focusable elements inside `container`, in tab order. */
export function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.closest("[inert]"),
  );
}

/** Props for `Dialog`. */
export interface DialogProps {
  readonly open: boolean;
  readonly title: ReactNode;
  /** Called on Escape, on the close button and on a click outside. */
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Buttons at the bottom, e.g. Cancel / Save. */
  readonly footer?: ReactNode;
  /** `drawer`: a full-height panel on the right (the document detail panel). */
  readonly size?: "normal" | "wide" | "drawer";
  /** Optional explanation shown under the title and announced with it. */
  readonly description?: ReactNode;
  /**
   * Extra keys for the whole dialog (after Escape and Tab, which the dialog handles), e.g.
   * the detail panel's [ and ] for the previous and next document.
   */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/** A modal dialog rendered into `document.body`. Renders nothing while closed. */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return createPortal(<OpenDialog {...props} />, document.body);
}

function OpenDialog(props: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  // Focus the dialog on open and restore focus on close.
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel !== null) {
      const preferred = panel.querySelector<HTMLElement>("[data-autofocus]");
      const target = preferred ?? focusableElements(panel)[0] ?? panel;
      target.focus();
    }
    return () => previouslyFocused?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") {
      props.onKeyDown?.(event);
      return;
    }
    if (panelRef.current === null) return;
    const focusable = focusableElements(panelRef.current);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      // Nothing focusable: keep focus on the panel itself.
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    // Wrap around at either end instead of letting focus escape to the page behind.
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    // Clicking the backdrop is a mouse shortcut; keyboard users close with Escape.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above.
    <div
      className={`dialog-backdrop ${props.size === "drawer" ? "dialog-backdrop-drawer" : ""}`}
      onMouseDown={(event) => {
        // Only a press that starts on the backdrop closes; dragging out of a text field does not.
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        className={`dialog ${props.size === "wide" ? "dialog-wide" : props.size === "drawer" ? "dialog-drawer" : ""}`}
        onKeyDown={onKeyDown}
      >
        <header className="dialog-header">
          <h2 id={titleId} className="dialog-title">
            {props.title}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={props.onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {props.description === undefined ? null : (
          <p id={descriptionId} className="dialog-description">
            {props.description}
          </p>
        )}
        <div className="dialog-body">{props.children}</div>
        {props.footer === undefined ? null : (
          <footer className="dialog-footer">{props.footer}</footer>
        )}
      </div>
    </div>
  );
}
