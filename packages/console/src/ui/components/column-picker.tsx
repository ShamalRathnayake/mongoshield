/**
 * The table's column picker: a popover listing every field path of the page, to show or
 * hide columns and change their order (Move up / Move down, so it works without a mouse;
 * dragging headers in the table does the same). "Reset columns" goes back to the
 * document order with everything shown and default widths.
 */

import { useState } from "react";
import { Button } from "./button.tsx";
import { Icon } from "./icons.tsx";
import { Popover, usePopover } from "./popover.tsx";

/** Props for `ColumnPicker`. */
export interface ColumnPickerProps {
  /** Every column path in display order (visible and hidden). */
  readonly columns: readonly string[];
  readonly hidden: ReadonlySet<string>;
  readonly onChange: (order: readonly string[], hidden: ReadonlySet<string>) => void;
  readonly onReset: () => void;
}

/** Moves `path` one step up (-1) or down (+1) in `order`. */
export function moveColumn(order: readonly string[], path: string, step: -1 | 1): string[] {
  const next = [...order];
  const index = next.indexOf(path);
  const target = index + step;
  if (index === -1 || target < 0 || target >= next.length) return next;
  next.splice(index, 1);
  next.splice(target, 0, path);
  return next;
}

/** Moves `path` to just before `before` (dropping a dragged header on another one). */
export function moveColumnBefore(order: readonly string[], path: string, before: string): string[] {
  const next = order.filter((candidate) => candidate !== path);
  const index = next.indexOf(before);
  next.splice(index === -1 ? next.length : index, 0, path);
  return next;
}

/** The "Columns" button and its popover. */
export function ColumnPicker(props: ColumnPickerProps) {
  const popover = usePopover();
  const [search, setSearch] = useState("");
  const visibleCount = props.columns.filter((path) => !props.hidden.has(path)).length;
  const shown = props.columns.filter((path) => path.toLowerCase().includes(search.toLowerCase()));

  const toggle = (path: string) => {
    const hidden = new Set(props.hidden);
    if (hidden.has(path)) hidden.delete(path);
    else hidden.add(path);
    props.onChange(props.columns, hidden);
  };

  return (
    <>
      <Button
        size="small"
        onClick={popover.open}
        aria-haspopup="dialog"
        aria-expanded={popover.anchor !== undefined}
      >
        <Icon name="columns" size={14} />
        Columns ({visibleCount}/{props.columns.length})
      </Button>
      {popover.anchor === undefined ? null : (
        <Popover anchor={popover.anchor} label="Columns" onClose={popover.close} className="picker">
          <div className="picker-body">
            <label className="field">
              <span className="field-label">Find a column</span>
              <input
                className="input"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                data-autofocus
              />
            </label>
            <ul className="picker-list">
              {shown.map((path, index) => (
                <li key={path} className="picker-row">
                  <label className="picker-option">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={!props.hidden.has(path)}
                      onChange={() => toggle(path)}
                    />
                    <span className="mono">{path}</span>
                  </label>
                  <span className="picker-move">
                    <button
                      type="button"
                      className="button-icon-tiny"
                      aria-label={`Move ${path} up`}
                      disabled={search !== "" || index === 0}
                      onClick={() =>
                        props.onChange(moveColumn(props.columns, path, -1), props.hidden)
                      }
                    >
                      <Icon name="arrowUp" size={12} />
                    </button>
                    <button
                      type="button"
                      className="button-icon-tiny"
                      aria-label={`Move ${path} down`}
                      disabled={search !== "" || index === shown.length - 1}
                      onClick={() =>
                        props.onChange(moveColumn(props.columns, path, 1), props.hidden)
                      }
                    >
                      <Icon name="arrowDown" size={12} />
                    </button>
                  </span>
                </li>
              ))}
              {shown.length === 0 ? <li className="muted">No matching columns.</li> : null}
            </ul>
            <div className="picker-actions">
              <Button
                size="small"
                onClick={() => {
                  props.onReset();
                  popover.close();
                }}
              >
                Reset columns
              </Button>
              <Button size="small" variant="primary" onClick={popover.close}>
                Done
              </Button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
