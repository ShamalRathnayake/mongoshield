/**
 * The chart view: one field of the sample as a simple chart, without any charting
 * library (plain HTML bars, so every bar is a real button with a name).
 *
 * - A field with a handful of distinct values (status, plan, a boolean) is a horizontal
 *   bar chart of how many sampled documents have each value, most common first, with the
 *   count at each bar's tip.
 * - Numbers and dates are a histogram over their range.
 * - Clicking a bar adds it to the filter (equals, or the bar's range), like everywhere
 *   else in the viewer.
 *
 * It is one series, so there is no legend: the heading says what is counted. Counts are
 * of the sample (the heading says so), never presented as totals of the collection.
 */

import { useId } from "react";
import { formatNumber } from "../format.ts";
import { isCategorical, type SchemaField, type SchemaSummary } from "../schema.ts";
import { SelectField } from "./field.tsx";
import { Histogram, percent } from "./schema-view.tsx";
import type { QuickFilterHandler } from "./value-menu.tsx";

/** Fields that make a readable chart: a handful of values, or a numeric / date range. */
export function chartableFields(summary: SchemaSummary): SchemaField[] {
  const usable = summary.fields.filter(
    (field) => field.path !== "_id" && (isCategorical(field) || field.range !== undefined),
  );
  // Few-valued fields first: "documents by status" is the chart most people want.
  return [
    ...usable.filter((field) => isCategorical(field)),
    ...usable.filter((field) => !isCategorical(field)),
  ];
}

/** Props for `ChartView`. */
export interface ChartViewProps {
  readonly summary: SchemaSummary;
  readonly sampleDescription: string;
  /** The remembered field; falls back to the first chartable one. */
  readonly field: string | undefined;
  readonly onField: (path: string) => void;
  readonly onQuickFilter?: QuickFilterHandler | undefined;
}

/** The chart view (see the file header). */
export function ChartView(props: ChartViewProps) {
  const headingId = useId();
  const fields = chartableFields(props.summary);
  const field = fields.find((candidate) => candidate.path === props.field) ?? fields[0];
  if (field === undefined) {
    return (
      <div className="empty-state">
        <p className="empty-state-title">Nothing to chart</p>
        <p className="empty-state-text">
          The sample has no field with a few distinct values, numbers or dates.
        </p>
      </div>
    );
  }
  // Prefer bars for few-valued fields, even numeric ones (e.g. a rating from 1 to 5).
  const asBars = isCategorical(field) || field.range === undefined;
  return (
    <section className="chart-view" aria-labelledby={headingId}>
      <div className="chart-controls">
        <SelectField
          label="Field"
          value={field.path}
          options={fields.map((candidate) => ({ value: candidate.path, label: candidate.path }))}
          onValue={props.onField}
        />
      </div>
      <h3 id={headingId} className="chart-title">
        {asBars ? `Documents by ${field.path}` : `Distribution of ${field.path}`}
        <span className="muted chart-subtitle"> · {props.sampleDescription}</span>
      </h3>
      {asBars ? (
        <ValueBars
          field={field}
          onQuickFilter={props.onQuickFilter}
          sampleSize={props.summary.sampleSize}
        />
      ) : field.range === undefined ? null : (
        <Histogram
          path={field.path}
          range={field.range}
          onQuickFilter={props.onQuickFilter}
          height={180}
          showCounts
        />
      )}
    </section>
  );
}

/** Horizontal bars: one per value, longest first, count at the tip. */
function ValueBars(props: {
  field: SchemaField;
  sampleSize: number;
  onQuickFilter?: QuickFilterHandler | undefined;
}) {
  const { field, onQuickFilter } = props;
  const max = Math.max(1, ...field.topValues.map((entry) => entry.count));
  return (
    <ol className="value-bars" aria-label={`Documents by ${field.path}`}>
      {field.topValues.map((entry) => {
        const share = props.sampleSize === 0 ? 0 : entry.count / props.sampleSize;
        const label = `${entry.text}: ${formatNumber(entry.count)} (${percent(share)})`;
        const bar = (
          <>
            <span className="value-bar-label">{entry.text}</span>
            <span className="value-bar-track">
              <span className="value-bar-fill" style={{ width: `${(entry.count / max) * 100}%` }} />
              <span className="value-bar-count numeric">{formatNumber(entry.count)}</span>
            </span>
          </>
        );
        return (
          <li key={entry.text}>
            {onQuickFilter === undefined ? (
              <span className="value-bar" title={label}>
                {bar}
              </span>
            ) : (
              <button
                type="button"
                className="value-bar"
                title={`${label}. Click to filter on it.`}
                aria-label={`${field.path} ${label}. Filter on this value`}
                onClick={() =>
                  onQuickFilter({ path: field.path, op: "equals", value: entry.value })
                }
              >
                {bar}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
