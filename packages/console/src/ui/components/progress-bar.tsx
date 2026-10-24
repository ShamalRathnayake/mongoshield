/**
 * ProgressBar: a labelled native `<progress>` element plus the numbers as text.
 *
 * The native element is used because it needs no inline `style="width: …"` (which the
 * console's strict Content-Security-Policy would block) and screen readers already
 * understand it. Without a known total it shows as indeterminate.
 */

import { useId } from "react";

/** Props for `ProgressBar`. */
export interface ProgressBarProps {
  readonly label: string;
  readonly value: number;
  /** Omit or pass 0 when the total is unknown: the bar becomes indeterminate. */
  readonly max?: number;
  /** Text after the label, e.g. "1,204 of 5,000 documents". */
  readonly detail?: string;
}

/** A progress bar with its label and percentage. */
export function ProgressBar(props: ProgressBarProps) {
  const id = useId();
  const max = props.max ?? 0;
  const known = max > 0;
  // Estimates can be exceeded (documents inserted during a backup), so clamp to 100 %.
  const fraction = known ? Math.min(1, props.value / max) : 0;
  const percent = Math.floor(fraction * 100);
  return (
    <div className="progress">
      <div className="progress-text">
        <label htmlFor={id} className="progress-label">
          {props.label}
        </label>
        <span className="progress-detail numeric">
          {props.detail}
          {known ? ` · ${percent}%` : ""}
        </span>
      </div>
      {known ? (
        <progress id={id} className="progress-bar" value={Math.min(props.value, max)} max={max}>
          {percent}%
        </progress>
      ) : (
        <progress id={id} className="progress-bar" />
      )}
    </div>
  );
}
