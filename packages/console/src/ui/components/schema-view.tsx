/**
 * The schema view: what a sample of the collection says about each field (schema.ts does
 * the counting).
 *
 *   address.city                                            in 100% of the sample
 *   ████████████████████████████████████████████  String 100%
 *   Colombo · 100   Berlin · 100                            2 distinct values
 *
 *   total                                                   in 96%
 *   ██████████████████████████████████░░░░░░░░░░  Decimal128 90% · Null 10%
 *   min 9.00 · max 408.99   ▁▂▅▇▆▃▂▁ (histogram)
 *
 * Everything is clickable to build the filter: a field name adds "has the field", a value
 * adds "equals", a histogram bar adds its range. The type bar uses one color per type
 * family (`--type-*` tokens) and always comes with a legend of names and percentages, so
 * color is never the only clue.
 */

import { BSON_TYPE_LABELS, type BsonType } from "../bson.ts";
import type { JsonValue } from "../ejson.ts";
import { formatCompact, formatNumber } from "../format.ts";
import type { QuickFilter } from "../quick-filter.ts";
import {
  cardinalityHint,
  type HistogramBin,
  type RangeStats,
  type SchemaField,
  type SchemaSummary,
} from "../schema.ts";
import { typeGroup } from "./bson-value.tsx";
import { Icon } from "./icons.tsx";
import type { QuickFilterHandler } from "./value-menu.tsx";

/** "42%" for a share of 0–1; tiny non-zero shares read "<1%" rather than "0%". */
export function percent(share: number): string {
  if (share > 0 && share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/** A number or date bound for labels: dates as their day (or time within one day). */
export function boundLabel(kind: RangeStats["kind"], value: number, span: number): string {
  if (kind === "number") {
    return Number.isInteger(value)
      ? formatNumber(value)
      : value.toPrecision(4).replace(/\.?0+$/, "");
  }
  const iso = new Date(value).toISOString();
  // Within two days the time matters; otherwise the date is enough.
  return span < 2 * 24 * 3600 * 1000 ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}

/** The Extended JSON value of a bound, for a range filter (`{"$date": …}` for dates). */
export function boundValue(kind: RangeStats["kind"], value: number): JsonValue {
  return kind === "date" ? { $date: new Date(value).toISOString() } : value;
}

/** The quick filter of one histogram bar (the last bar includes its upper bound). */
export function binFilter(path: string, range: RangeStats, index: number): QuickFilter {
  const bin = range.bins[index] as HistogramBin;
  const last = index === range.bins.length - 1;
  return {
    path,
    op: "range",
    from: boundValue(range.kind, bin.from),
    to: boundValue(range.kind, bin.to),
    inclusive: last,
  };
}

/**
 * A small histogram: one button per bar (height = count), so every bar can be focused,
 * has its range and count as its name and tooltip, and filters on click.
 */
export function Histogram(props: {
  path: string;
  range: RangeStats;
  onQuickFilter?: QuickFilterHandler | undefined;
  /** Bar area height in pixels. */
  height?: number;
  /** Shows the bounds under the bars (min left, max right). */
  showAxis?: boolean;
  /** Writes each bar's count on its cap (the chart view; the schema view's are too small). */
  showCounts?: boolean;
}) {
  const { range, path } = props;
  const height = props.height ?? 40;
  const max = Math.max(1, ...range.bins.map((bin) => bin.count));
  const span = range.max - range.min;
  return (
    <figure className="histogram" aria-label={`Distribution of ${path}`}>
      <div className="histogram-bars" style={{ height }}>
        {range.bins.map((bin, index) => {
          const label = `${boundLabel(range.kind, bin.from, span)} to ${boundLabel(range.kind, bin.to, span)}: ${formatNumber(bin.count)}`;
          // Leave room above the tallest bar for its count label.
          const room = props.showCounts === true ? height - 18 : height;
          const barHeight = bin.count === 0 ? 0 : Math.max(3, (bin.count / max) * room);
          return props.onQuickFilter === undefined ? (
            <span key={bin.from} className="histogram-bar" title={label}>
              {props.showCounts === true && bin.count > 0 ? (
                <span className="histogram-count">{formatCompact(bin.count)}</span>
              ) : null}
              <span className="histogram-fill" style={{ height: barHeight }} />
            </span>
          ) : (
            <button
              key={bin.from}
              type="button"
              className="histogram-bar"
              title={`${label}. Click to filter on this range.`}
              aria-label={`${path} ${label}. Filter on this range`}
              onClick={() => props.onQuickFilter?.(binFilter(path, range, index))}
            >
              {props.showCounts === true && bin.count > 0 ? (
                <span className="histogram-count" aria-hidden="true">
                  {formatCompact(bin.count)}
                </span>
              ) : null}
              <span className="histogram-fill" style={{ height: barHeight }} />
            </button>
          );
        })}
      </div>
      {props.showAxis === false ? null : (
        <figcaption className="histogram-axis">
          <span>{boundLabel(range.kind, range.min, span)}</span>
          <span>{boundLabel(range.kind, range.max, span)}</span>
        </figcaption>
      )}
    </figure>
  );
}

/** The share of each type as one stacked bar, with a legend that names every segment. */
export function TypeBar(props: { field: SchemaField }) {
  const { field } = props;
  const total = field.values;
  return (
    <div className="type-bar-wrap">
      <div className="type-bar" aria-hidden="true">
        {field.types.map((entry) => (
          <span
            key={entry.type}
            className={`type-bar-segment type-fill-${typeGroup(entry.type)} ${entry.type === "array" ? "type-fill-array" : ""}`}
            style={{ flexGrow: entry.count }}
            title={`${BSON_TYPE_LABELS[entry.type]} ${percent(entry.count / total)}`}
          />
        ))}
      </div>
      <ul className="type-legend" aria-label={`Types of ${field.path}`}>
        {field.types.map((entry) => (
          <li key={entry.type}>
            <span
              className={`type-swatch type-fill-${typeGroup(entry.type)} ${entry.type === "array" ? "type-fill-array" : ""}`}
              aria-hidden="true"
            />
            {BSON_TYPE_LABELS[entry.type as BsonType]} {percent(entry.count / total)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Props for `SchemaView`. */
export interface SchemaViewProps {
  readonly summary: SchemaSummary;
  /** "a random sample of 200 documents", for the heading. */
  readonly sampleDescription: string;
  readonly onQuickFilter?: QuickFilterHandler | undefined;
  readonly onResample?: (() => void) | undefined;
  readonly resampling?: boolean;
}

/** The schema view (see the file header). */
export function SchemaView(props: SchemaViewProps) {
  const { summary, onQuickFilter } = props;
  return (
    <section className="schema-view" aria-label="Schema">
      <div className="schema-head">
        <p className="muted">
          {summary.fields.length} {summary.fields.length === 1 ? "field" : "fields"} in{" "}
          {props.sampleDescription}.
          {onQuickFilter === undefined ? "" : " Click a field or value to filter on it."}
        </p>
        {props.onResample === undefined ? null : (
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={props.onResample}
            disabled={props.resampling === true}
          >
            <Icon name="refresh" size={14} />
            {props.resampling === true ? "Sampling…" : "Sample again"}
          </button>
        )}
      </div>
      <div className="table-wrapper schema-table-wrapper">
        <table className="table schema-table">
          <caption className="visually-hidden">Fields of the sample</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Types</th>
              <th scope="col">In the sample</th>
              <th scope="col">Values</th>
            </tr>
          </thead>
          <tbody>
            {summary.fields.map((field) => (
              <tr key={field.path}>
                <th scope="row" className="schema-cell-field">
                  {/* Nested fields are indented under their parent. */}
                  <span
                    style={{ paddingLeft: `calc(${field.depth} * var(--space-4))` }}
                    className="schema-field-label"
                  >
                    {onQuickFilter === undefined ? (
                      <span className="schema-field-name">{field.path}</span>
                    ) : (
                      <button
                        type="button"
                        className="schema-field-name schema-link"
                        title={`Show documents that have ${field.path}`}
                        onClick={() => onQuickFilter({ path: field.path, op: "exists" })}
                      >
                        {field.path}
                      </button>
                    )}
                    {field.inArray ? <span className="schema-note">in array elements</span> : null}
                  </span>
                </th>
                <td className="schema-cell-types">
                  <TypeBar field={field} />
                </td>
                <td className="schema-cell-presence">
                  <span className="presence-meter" aria-hidden="true">
                    <span style={{ width: `${Math.max(1, Math.round(field.presence * 100))}%` }} />
                  </span>
                  <span className="numeric">{percent(field.presence)}</span>
                  <span className="muted numeric"> ({formatCompact(field.documents)})</span>
                </td>
                <td className="schema-cell-values">
                  {field.range === undefined ? (
                    <ValueChips field={field} onQuickFilter={onQuickFilter} />
                  ) : (
                    <div className="schema-range">
                      <Histogram
                        path={field.path}
                        range={field.range}
                        onQuickFilter={onQuickFilter}
                        height={28}
                      />
                    </div>
                  )}
                  <span className="schema-cardinality">{cardinalityHint(field)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Values shown as chips per field (the most common first). */
const CHIPS_SHOWN = 6;
/** Examples shown for fields whose every value is different (ids, emails). */
const EXAMPLES_SHOWN = 3;

/** The most common values of a field as chips; each one filters on click. */
function ValueChips(props: { field: SchemaField; onQuickFilter?: QuickFilterHandler | undefined }) {
  const { field, onQuickFilter } = props;
  // Unique fields (ids, emails) have no "common" values: show a few examples instead.
  const unique = !field.distinctCapped && field.distinct === field.values && field.values > 1;
  const values = field.topValues.slice(0, unique ? EXAMPLES_SHOWN : CHIPS_SHOWN);
  if (values.length === 0) return null;
  return (
    <ul
      className="value-chips"
      aria-label={unique ? `Examples of ${field.path}` : `Common values of ${field.path}`}
    >
      {values.map((entry) => (
        <li key={entry.text}>
          {onQuickFilter === undefined ? (
            <span className="chip">
              {entry.text}
              {unique ? null : <span className="chip-count">{formatCompact(entry.count)}</span>}
            </span>
          ) : (
            <button
              type="button"
              className="chip chip-button"
              title={`Show documents where ${field.path} is ${entry.text}`}
              onClick={() => onQuickFilter({ path: field.path, op: "equals", value: entry.value })}
            >
              {entry.text}
              {unique ? null : <span className="chip-count">{formatCompact(entry.count)}</span>}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
