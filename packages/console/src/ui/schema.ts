/**
 * Schema analysis of a sample of documents, for the schema view, the chart view and the
 * filter's field suggestions. Everything is computed in the browser from documents the
 * server already sent (a `$sample` of the collection, or the first documents of a
 * backup), so it costs MongoDB nothing beyond that one sample.
 *
 * For every field path (`address.city`, and `items.sku` for documents inside arrays) it
 * reports:
 *   - presence: in how many sampled documents the field exists,
 *   - types: how often each BSON type occurs (a field can hold several),
 *   - examples and the most common values (strings, booleans, ObjectIds, …),
 *   - a cardinality hint: unique in the sample, a handful of values, or many,
 *   - for numbers and dates: min, max and a small histogram.
 *
 * A sample is a sample: the view always says how many documents it is based on.
 */

import {
  type BsonType,
  bsonTypeOf,
  dateOf,
  isNumericType,
  isPlainObject,
  numberOf,
  shortText,
} from "./bson.ts";
import { isJsonObject, type JsonValue } from "./ejson.ts";

/** How often one type occurs in a field. */
export interface TypeCount {
  readonly type: BsonType;
  readonly count: number;
}

/** One distinct value and how often it occurs (the value is kept for building filters). */
export interface ValueCount {
  readonly value: JsonValue;
  /** `shortText(value)`, also the key that makes values distinct. */
  readonly text: string;
  readonly count: number;
}

/** One bar of a histogram: values in `[from, to)` (the last bar includes `to`). */
export interface HistogramBin {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

/** Range statistics of the numbers or dates of a field (dates as epoch milliseconds). */
export interface RangeStats {
  readonly kind: "number" | "date";
  readonly min: number;
  readonly max: number;
  /** The values counted (a field may hold both numbers and strings). */
  readonly count: number;
  readonly bins: readonly HistogramBin[];
}

/** What the sample says about one field. */
export interface SchemaField {
  /** Dot path, e.g. `address.city`; fields of documents in arrays: `items.sku`. */
  readonly path: string;
  /** The last part of the path (`city`), for indented display. */
  readonly name: string;
  /** Nesting depth: 0 for top-level fields. */
  readonly depth: number;
  /** True when the field lives in documents inside an array (`items.sku`). */
  readonly inArray: boolean;
  /** Sampled documents that have the field (at least once, for array fields). */
  readonly documents: number;
  /** `documents / sample size`, 0–1. */
  readonly presence: number;
  /** Every value seen (several per document for array fields). */
  readonly values: number;
  /** Types by frequency, most common first. */
  readonly types: readonly TypeCount[];
  /** The most common values, most common first (at most {@link TOP_VALUES}). */
  readonly topValues: readonly ValueCount[];
  /** Distinct values seen, counted up to {@link DISTINCT_LIMIT} (`distinctCapped` beyond). */
  readonly distinct: number;
  readonly distinctCapped: boolean;
  /** Number or date statistics, when the field holds numbers or dates. */
  readonly range?: RangeStats;
}

/** The analysis of a whole sample. */
export interface SchemaSummary {
  /** Documents analysed. */
  readonly sampleSize: number;
  /** Fields in display order: document order of first appearance, parents before children. */
  readonly fields: readonly SchemaField[];
}

/** Most common values kept per field. */
export const TOP_VALUES = 12;
/** Distinct values are counted up to this many; beyond, the field has "many" values. */
export const DISTINCT_LIMIT = 500;
/** Bars of a histogram. */
export const HISTOGRAM_BINS = 12;
/** Fields deeper than this are not analysed separately (they are part of their parent). */
const MAX_DEPTH = 6;
/** A field with at most this many distinct values is "a handful" (good for charts). */
export const FEW_VALUES = 12;

/** Types whose values are counted as "the same value" (not numbers or dates, which get ranges). */
const COUNTABLE_TYPES = new Set<BsonType>([
  "string",
  "boolean",
  "objectId",
  "null",
  "uuid",
  "number",
  "int",
  "long",
  "decimal",
  "double",
  "date",
]);

/** The working state of one field while the sample is walked. */
interface Accumulator {
  readonly path: string;
  readonly depth: number;
  readonly inArray: boolean;
  /** Index of the last document counted, so array fields count a document once. */
  lastDocument: number;
  documents: number;
  values: number;
  readonly types: Map<BsonType, number>;
  readonly counts: Map<string, { value: JsonValue; count: number }>;
  distinctCapped: boolean;
  readonly numbers: number[];
  readonly dates: number[];
}

/** Analyses a sample. Documents that are not objects are skipped (and not counted). */
export function analyzeSchema(documents: readonly (JsonValue | undefined)[]): SchemaSummary {
  const fields = new Map<string, Accumulator>();
  let sampleSize = 0;

  const accumulatorFor = (path: string, depth: number, inArray: boolean): Accumulator => {
    let accumulator = fields.get(path);
    if (accumulator === undefined) {
      accumulator = {
        path,
        depth,
        inArray,
        lastDocument: -1,
        documents: 0,
        values: 0,
        types: new Map(),
        counts: new Map(),
        distinctCapped: false,
        numbers: [],
        dates: [],
      };
      fields.set(path, accumulator);
    }
    return accumulator;
  };

  /** Records one value of a field, then walks into documents and arrays of documents. */
  const record = (
    path: string,
    value: JsonValue,
    depth: number,
    inArray: boolean,
    documentIndex: number,
  ) => {
    const field = accumulatorFor(path, depth, inArray);
    if (field.lastDocument !== documentIndex) {
      field.lastDocument = documentIndex;
      field.documents += 1;
    }
    field.values += 1;
    const type = bsonTypeOf(value);
    field.types.set(type, (field.types.get(type) ?? 0) + 1);
    if (COUNTABLE_TYPES.has(type)) countValue(field, value);
    if (isNumericType(type)) {
      const number = numberOf(value);
      if (number !== undefined && Number.isFinite(number)) field.numbers.push(number);
    } else if (type === "date") {
      const date = dateOf(value);
      if (date !== undefined) field.dates.push(date.getTime());
    }
    if (depth >= MAX_DEPTH) return;
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        record(`${path}.${key}`, child, depth + 1, inArray, documentIndex);
      }
    } else if (Array.isArray(value)) {
      // Documents inside arrays: their fields are `path.field` (how MongoDB queries them).
      for (const item of value as readonly JsonValue[]) {
        if (!isPlainObject(item)) continue;
        for (const [key, child] of Object.entries(item)) {
          record(`${path}.${key}`, child, depth + 1, true, documentIndex);
        }
      }
    }
  };

  documents.forEach((document) => {
    if (document === undefined || !isJsonObject(document)) return;
    const documentIndex = sampleSize;
    sampleSize += 1;
    for (const [key, value] of Object.entries(document)) {
      record(key, value, 0, false, documentIndex);
    }
  });

  return {
    sampleSize,
    fields: orderFields([...fields.values()]).map((field) => finish(field, sampleSize)),
  };
}

/** Counts one distinct value, up to {@link DISTINCT_LIMIT} distinct values per field. */
function countValue(field: Accumulator, value: JsonValue): void {
  const text = shortText(value);
  const existing = field.counts.get(text);
  if (existing !== undefined) {
    existing.count += 1;
    return;
  }
  if (field.counts.size >= DISTINCT_LIMIT) {
    field.distinctCapped = true;
    return;
  }
  field.counts.set(text, { value, count: 1 });
}

/**
 * Display order: fields as they first appeared, but each field directly followed by its
 * children (`address`, `address.city`, `address.zip`, then the next top-level field).
 */
function orderFields(fields: Accumulator[]): Accumulator[] {
  const ordered: Accumulator[] = [];
  const placed = new Set<string>();
  const place = (field: Accumulator) => {
    if (placed.has(field.path)) return;
    placed.add(field.path);
    ordered.push(field);
    for (const child of fields) {
      if (child.depth === field.depth + 1 && child.path.startsWith(`${field.path}.`)) place(child);
    }
  };
  for (const field of fields) if (field.depth === 0) place(field);
  // Anything left (cannot happen with well-formed paths) goes last rather than missing.
  for (const field of fields) place(field);
  return ordered;
}

/** Turns an accumulator into the reported field. */
function finish(field: Accumulator, sampleSize: number): SchemaField {
  const types = [...field.types.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  const topValues = [...field.counts.entries()]
    .map(([text, entry]) => ({ value: entry.value, text, count: entry.count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, TOP_VALUES);
  const range =
    field.numbers.length >= field.dates.length
      ? rangeOf("number", field.numbers)
      : rangeOf("date", field.dates);
  const parts = field.path.split(".");
  return {
    path: field.path,
    name: parts[parts.length - 1] ?? field.path,
    depth: field.depth,
    inArray: field.inArray,
    documents: field.documents,
    presence: sampleSize === 0 ? 0 : field.documents / sampleSize,
    values: field.values,
    types,
    topValues,
    distinct: field.counts.size,
    distinctCapped: field.distinctCapped,
    ...(range === undefined ? {} : { range }),
  };
}

/** Min, max and an evenly spaced histogram of some values; undefined when there are none. */
export function rangeOf(
  kind: "number" | "date",
  values: readonly number[],
): RangeStats | undefined {
  if (values.length === 0) return undefined;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { kind, min, max, count: values.length, bins: histogram(values, min, max) };
}

/**
 * Evenly spaced bins between min and max. One value repeated (min = max) is one bin.
 * Whole-number fields with a small range get one bin per value instead of fractional bins.
 */
export function histogram(values: readonly number[], min: number, max: number): HistogramBin[] {
  if (min === max) return [{ from: min, to: max, count: values.length }];
  const allIntegers = values.every((value) => Number.isInteger(value));
  const binCount = allIntegers && max - min + 1 <= HISTOGRAM_BINS ? max - min + 1 : HISTOGRAM_BINS;
  const width = allIntegers && binCount === max - min + 1 ? 1 : (max - min) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, index) => ({
    from: min + index * width,
    to: index === binCount - 1 && width !== 1 ? max : min + (index + 1) * width,
    count: 0,
  }));
  const counts = new Array<number>(binCount).fill(0);
  for (const value of values) {
    // The maximum belongs to the last bin (bins are half-open except the last).
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return bins.map((bin, index) => ({ ...bin, count: counts[index] ?? 0 }));
}

/**
 * A plain-language cardinality hint for a field, e.g. "Unique in the sample",
 * "3 distinct values", "Many distinct values".
 */
export function cardinalityHint(field: SchemaField): string {
  if (field.distinct === 0) return "No comparable values";
  if (field.distinctCapped) return "Many distinct values";
  if (field.distinct === field.values && field.values > 1) return "Unique in the sample";
  if (field.distinct === 1) return "One value in the sample";
  return `${field.distinct} distinct values`;
}

/** True when a field's values make a readable bar chart (a handful of distinct values). */
export function isCategorical(field: SchemaField): boolean {
  return !field.distinctCapped && field.distinct > 0 && field.distinct <= FEW_VALUES;
}

/** Field paths of a summary, for autocomplete: top-level first, then by path. */
export function fieldPaths(summary: SchemaSummary | undefined): string[] {
  if (summary === undefined) return [];
  return summary.fields.map((field) => field.path);
}
