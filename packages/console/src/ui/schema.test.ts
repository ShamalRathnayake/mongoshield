/**
 * Unit tests for schema.ts: field statistics from a sample (presence, type distribution,
 * common values, cardinality), number and date ranges with histograms, fields of
 * documents inside arrays, and the display order of nested fields.
 */

import { describe, expect, it } from "vitest";
import type { JsonValue } from "./ejson.ts";
import {
  analyzeSchema,
  cardinalityHint,
  DISTINCT_LIMIT,
  fieldPaths,
  histogram,
  isCategorical,
  rangeOf,
  type SchemaField,
} from "./schema.ts";

/** The analysed field at a path (fails the test when missing). */
function field(documents: readonly (JsonValue | undefined)[], path: string): SchemaField {
  const found = analyzeSchema(documents).fields.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`no field ${path}`);
  return found;
}

describe("analyzeSchema", () => {
  const sample: JsonValue[] = [
    { _id: 1, status: "paid", total: 10, address: { city: "Colombo" }, tags: ["a"] },
    { _id: 2, status: "paid", total: { $numberDecimal: "20.5" }, address: { city: "Berlin" } },
    { _id: 3, status: "open", total: null, items: [{ sku: "A" }, { sku: "B" }] },
    { _id: 4, status: 7, items: [{ sku: "A" }, "not a document"] },
  ];

  it("counts the sample and skips values that are not documents", () => {
    const summary = analyzeSchema([...sample, undefined, "text", [1]]);
    expect(summary.sampleSize).toBe(4);
  });

  it("reports presence and the types of each field, most common first", () => {
    const status = field(sample, "status");
    expect(status.documents).toBe(4);
    expect(status.presence).toBe(1);
    expect(status.types).toEqual([
      { type: "string", count: 3 },
      { type: "number", count: 1 },
    ]);
    const total = field(sample, "total");
    expect(total.presence).toBe(0.75);
    expect(total.types.map((entry) => entry.type).sort()).toEqual(["decimal", "null", "number"]);
  });

  it("lists common values with counts, and how many distinct values there are", () => {
    const status = field(sample, "status");
    expect(status.topValues[0]).toMatchObject({ text: "paid", count: 2, value: "paid" });
    expect(status.distinct).toBe(3);
    expect(cardinalityHint(status)).toBe("3 distinct values");
    expect(isCategorical(status)).toBe(true);
    expect(cardinalityHint(field(sample, "_id"))).toBe("Unique in the sample");
  });

  it("puts nested fields right after their parent", () => {
    const paths = fieldPaths(analyzeSchema(sample));
    expect(paths.indexOf("address.city")).toBe(paths.indexOf("address") + 1);
    expect(paths.indexOf("items.sku")).toBe(paths.indexOf("items") + 1);
    expect(fieldPaths(undefined)).toEqual([]);
  });

  it("analyses fields of documents inside arrays, counting each document once", () => {
    const sku = field(sample, "items.sku");
    expect(sku.inArray).toBe(true);
    expect(sku.documents).toBe(2);
    expect(sku.values).toBe(3);
    expect(sku.topValues[0]).toMatchObject({ text: "A", count: 2 });
    expect(sku.name).toBe("sku");
    expect(sku.depth).toBe(1);
  });

  it("computes number ranges across numeric types", () => {
    const total = field(sample, "total");
    expect(total.range).toMatchObject({ kind: "number", min: 10, max: 20.5, count: 2 });
  });

  it("computes date ranges", () => {
    const dates = [
      { at: { $date: "2026-01-01T00:00:00.000Z" } },
      { at: { $date: "2026-01-31T00:00:00.000Z" } },
      { at: { $date: "invalid" } },
    ];
    const at = field(dates, "at");
    expect(at.range?.kind).toBe("date");
    expect(at.range?.min).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(at.range?.count).toBe(2);
  });

  it("stops counting distinct values at the limit and calls them many", () => {
    const documents = Array.from({ length: DISTINCT_LIMIT + 5 }, (_, index) => ({
      n: `v${index}`,
    }));
    const n = field(documents, "n");
    expect(n.distinctCapped).toBe(true);
    expect(n.distinct).toBe(DISTINCT_LIMIT);
    expect(cardinalityHint(n)).toBe("Many distinct values");
    expect(isCategorical(n)).toBe(false);
  });

  it("describes one-valued fields and fields without comparable values", () => {
    expect(cardinalityHint(field([{ a: 1 }, { a: 1 }], "a"))).toBe("One value in the sample");
    expect(cardinalityHint(field([{ a: { b: 1 } }], "a"))).toBe("No comparable values");
  });

  it("returns an empty summary for an empty sample", () => {
    expect(analyzeSchema([])).toEqual({ sampleSize: 0, fields: [] });
  });
});

describe("histograms", () => {
  it("is undefined without values, and one bin when every value is the same", () => {
    expect(rangeOf("number", [])).toBeUndefined();
    expect(histogram([4, 4, 4], 4, 4)).toEqual([{ from: 4, to: 4, count: 3 }]);
  });

  it("uses one bin per value for small whole-number ranges (ratings, counts)", () => {
    const bins = histogram([1, 2, 2, 5], 1, 5);
    expect(bins.map((bin) => bin.count)).toEqual([1, 2, 0, 0, 1]);
    expect(bins[0]).toMatchObject({ from: 1, to: 2 });
  });

  it("spreads other values over twelve even bins, the maximum in the last one", () => {
    const values = [0, 0.5, 6, 11.9, 12];
    const bins = histogram(values, 0, 12);
    expect(bins).toHaveLength(12);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(values.length);
    expect(bins[11]).toMatchObject({ to: 12, count: 2 });
    expect(bins[0]?.count).toBe(2);
  });
});
