/**
 * Popovers: small floating panels anchored to the control that opened them (the column
 * picker, a nested document in a table cell, the value menu with quick filters).
 *
 * - Rendered into `document.body` with fixed positioning, so a scrolling table or a
 *   panel with `overflow: hidden` never clips them. The position is measured from the
 *   anchor when the popover opens and kept inside the window.
 * - Focus moves into the popover, Escape or a click outside closes it, and focus then
 *   returns to the anchor, so keyboard users stay where they were.
 * - `Menu` is a popover with `role="menu"`: ↑/↓/Home/End move between its items.
 */

import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { focusableElements } from "./dialog.tsx";

/** Gap between the anchor and the popover, and the minimum margin to the window edge (px). */
const OFFSET = 6;
const EDGE_MARGIN = 8;

/** Props for `Popover`. */
export interface PopoverProps {
  /** The element the popover hangs below (usually the button that opened it). */
  readonly anchor: HTMLElement;
  readonly onClose: () => void;
  /** Accessible name of the panel. */
  readonly label: string;
  readonly children: ReactNode;
  /** `dialog` (default) for panels with controls, `menu` for a list of actions. */
  readonly role?: "dialog" | "menu";
  readonly className?: string;
  /** Where focus goes on close, when not the anchor (e.g. the table row of a clicked cell). */
  readonly returnFocus?: HTMLElement;
}

/** A floating panel below `anchor`. */
export function Popover(props: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | undefined>(undefined);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const { anchor } = props;
  const returnFocusRef = useRef(props.returnFocus);
  returnFocusRef.current = props.returnFocus;

  // Measure after the first render, when the panel's size is known.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const anchorBox = anchor.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const maxLeft = window.innerWidth - panelBox.width - EDGE_MARGIN;
    const left = Math.max(EDGE_MARGIN, Math.min(anchorBox.left, maxLeft));
    const below = anchorBox.bottom + OFFSET;
    // Open upwards when there is no room below.
    const top =
      below + panelBox.height > window.innerHeight && anchorBox.top > panelBox.height + OFFSET
        ? anchorBox.top - panelBox.height - OFFSET
        : below;
    setPosition({ top, left });
  }, [anchor]);

  // Focus inside on open; give focus back to the anchor on close.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel !== null) {
      const preferred = panel.querySelector<HTMLElement>("[data-autofocus]");
      (preferred ?? focusableElements(panel)[0] ?? panel).focus();
    }
    return () => {
      const target = returnFocusRef.current ?? anchor;
      if (target.isConnected) target.focus();
    };
  }, [anchor]);

  // A press anywhere outside the panel and its anchor closes it.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelRef.current?.contains(target) || anchor.contains(target)) return;
      // A menu opened from inside this popover is a separate portal: still "inside".
      if (target instanceof Element && target.closest(".popover") !== null) return;
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [anchor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (props.role === "menu") moveInMenu(event);
  };

  return createPortal(
    // "dialog" or "menu": both are named and handle keys, which the linter cannot see
    // through the variable.
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: see above.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above.
    <div
      ref={panelRef}
      role={props.role ?? "dialog"}
      aria-label={props.label}
      tabIndex={-1}
      className={`popover ${props.className ?? ""}`}
      // Hidden until measured, so it never flashes at the wrong place.
      style={
        position === undefined
          ? { top: 0, left: 0, visibility: "hidden" }
          : { top: position.top, left: position.left }
      }
      onKeyDown={onKeyDown}
    >
      {props.children}
    </div>,
    document.body,
  );
}

/** Arrow-key movement between the `menuitem`s of a menu. */
function moveInMenu(event: KeyboardEvent<HTMLDivElement>): void {
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
  ];
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
  else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
  else if (event.key === "Home") next = items[0];
  else if (event.key === "End") next = items[items.length - 1];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}

/** One action of a `Menu`. */
export interface MenuItem {
  readonly label: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** A short line under the label, e.g. the filter it adds. */
  readonly detail?: ReactNode;
}

/** A popover menu of actions; choosing one runs it and closes the menu. */
export function Menu(props: {
  anchor: HTMLElement;
  label: string;
  items: readonly MenuItem[];
  onClose: () => void;
  /** Optional heading inside the menu (not an item). */
  header?: ReactNode;
  returnFocus?: HTMLElement;
}) {
  return (
    <Popover
      anchor={props.anchor}
      label={props.label}
      role="menu"
      onClose={props.onClose}
      {...(props.returnFocus === undefined ? {} : { returnFocus: props.returnFocus })}
    >
      {props.header === undefined ? null : (
        <div className="menu-header" role="presentation">
          {props.header}
        </div>
      )}
      {props.items.map((item, index) => (
        <button
          // Menus are rebuilt on every open; the index is a stable key while one is open.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          key={index}
          type="button"
          role="menuitem"
          className="menu-item"
          disabled={item.disabled}
          // The first item takes focus when the menu opens.
          data-autofocus={index === 0 ? true : undefined}
          onClick={() => {
            props.onClose();
            item.onSelect();
          }}
        >
          <span className="menu-item-label">{item.label}</span>
          {item.detail === undefined ? null : (
            <span className="menu-item-detail">{item.detail}</span>
          )}
        </button>
      ))}
    </Popover>
  );
}

/**
 * State for a popover opened from a button: `open(event)` remembers the button as the
 * anchor, `anchor` is set while open, `close()` closes it.
 */
export function usePopover(): {
  anchor: HTMLElement | undefined;
  open: (event: { currentTarget: HTMLElement }) => void;
  close: () => void;
} {
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  return {
    anchor,
    open: (event) => setAnchor(event.currentTarget),
    close: () => setAnchor(undefined),
  };
}
