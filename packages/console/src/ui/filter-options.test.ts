/**
 * Tests for filter-options.ts: counting the loaded values, ordering them, and building
 * the "Any …" + "value (count)" options of the filter selects.
 */

import { describe, expect, it } from "vitest";
import {
  ANY,
  compareText,
  countValues,
  filterOptions,
  matchesChoice,
  withCount,
} from "./filter-options.ts";

describe("compareText", () => {
  it("orders A to Z ignoring case, in plain character order", () => {
    expect(["shop_restored", "Shop.orders", "analytics"].sort(compareText)).toEqual([
      "analytics",
      "Shop.orders",
      "shop_restored",
    ]);
    // Texts equal but for case still get a stable order.
    expect(compareText("Maya", "maya")).toBe(-1);
    expect(compareText("maya", "Maya")).toBe(1);
    expect(compareText("maya", "maya")).toBe(0);
  });
});

describe("countValues", () => {
  it("counts distinct values, skipping undefined and empty ones", () => {
    expect(countValues(["b", undefined, "a", "b", ""])).toEqual([
      { value: "a", count: 1 },
      { value: "b", count: 2 },
    ]);
  });
});

describe("filterOptions", () => {
  it("starts with the no-filter option and labels each value with its count", () => {
    expect(withCount("maya", 3)).toBe("maya (3)");
    expect(filterOptions(["maya", "admin", "maya"], { any: "Anyone" })).toEqual([
      { value: ANY, label: "Anyone" },
      { value: "admin", label: "admin (1)" },
      { value: "maya", label: "maya (2)" },
    ]);
  });

  it("names values, sorts by the name, and keeps the always-offered and chosen values", () => {
    const names: Record<string, string> = { "plan-b": "Archive", "plan-a": "Nightly" };
    expect(
      filterOptions(["plan-a", "plan-b"], {
        any: "Any plan",
        labelFor: (id) => names[id] ?? id,
        always: ["schedule", "plan-a"],
        selected: "plan-gone",
      }),
    ).toEqual([
      { value: ANY, label: "Any plan" },
      { value: "plan-b", label: "Archive (1)" },
      { value: "plan-a", label: "Nightly (1)" },
      { value: "plan-gone", label: "plan-gone (0)" },
      { value: "schedule", label: "schedule (0)" },
    ]);
  });
});

describe("matchesChoice", () => {
  it("lets everything through without a choice, else only the exact value", () => {
    expect(matchesChoice(ANY, undefined)).toBe(true);
    expect(matchesChoice("a", "a")).toBe(true);
    expect(matchesChoice("a", "b")).toBe(false);
    expect(matchesChoice("a", undefined)).toBe(false);
  });
});
