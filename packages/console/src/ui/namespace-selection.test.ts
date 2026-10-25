/**
 * Unit tests for the namespace picker's selection logic: grouping by database, the
 * search, the tri-state "whole database" state and the immutable set updates.
 */

import { describe, expect, it } from "vitest";
import {
  databasesOf,
  filterGroups,
  groupByDatabase,
  groupState,
  setChosen,
} from "./namespace-selection.ts";

/** Entries the way the wizard passes them: a namespace plus extra data. */
const ENTRIES = [
  { ns: "shop.users", documents: 3 },
  { ns: "analytics.daily", documents: 1 },
  { ns: "shop.orders", documents: 7 },
  { ns: "shop.orders.archive", documents: 2 },
];

describe("groupByDatabase", () => {
  it("groups by the part before the first dot, in order of first appearance", () => {
    expect(groupByDatabase(ENTRIES)).toEqual([
      {
        database: "shop",
        entries: [
          { ns: "shop.users", documents: 3 },
          { ns: "shop.orders", documents: 7 },
          { ns: "shop.orders.archive", documents: 2 },
        ],
      },
      { database: "analytics", entries: [{ ns: "analytics.daily", documents: 1 }] },
    ]);
  });

  it("returns nothing for no namespaces", () => {
    expect(groupByDatabase([])).toEqual([]);
  });
});

describe("filterGroups", () => {
  const groups = groupByDatabase(ENTRIES);

  it("keeps everything for an empty or blank query", () => {
    expect(filterGroups(groups, "")).toEqual(groups);
    expect(filterGroups(groups, "   ")).toEqual(groups);
  });

  it("keeps a whole database whose name matches, case-insensitively", () => {
    const result = filterGroups(groups, "ANALY");
    expect(result).toEqual([groups[1]]);
  });

  it("keeps only the matching collections of other databases", () => {
    const result = filterGroups(groups, "orders");
    expect(result).toEqual([
      {
        database: "shop",
        entries: [
          { ns: "shop.orders", documents: 7 },
          { ns: "shop.orders.archive", documents: 2 },
        ],
      },
    ]);
  });

  it("drops databases with no match", () => {
    expect(filterGroups(groups, "nothing-like-this")).toEqual([]);
  });
});

describe("groupState", () => {
  const shop = ["shop.users", "shop.orders"];

  it("is all, some or none", () => {
    expect(groupState(shop, new Set(shop))).toBe("all");
    expect(groupState(shop, new Set(["shop.users", "analytics.daily"]))).toBe("some");
    expect(groupState(shop, new Set(["analytics.daily"]))).toBe("none");
  });

  it("counts an empty group as none", () => {
    expect(groupState([], new Set(["shop.users"]))).toBe("none");
  });
});

describe("setChosen", () => {
  it("adds and removes without changing the original set", () => {
    const original = new Set(["a.x"]);
    const added = setChosen(original, ["a.y", "a.x"], true);
    expect([...added]).toEqual(["a.x", "a.y"]);
    const removed = setChosen(added, ["a.x"], false);
    expect([...removed]).toEqual(["a.y"]);
    expect([...original]).toEqual(["a.x"]);
  });
});

describe("databasesOf", () => {
  it("lists each database once, in order", () => {
    expect(databasesOf(["shop.a", "crm.b", "shop.c"])).toEqual(["shop", "crm"]);
    expect(databasesOf(new Set<string>())).toEqual([]);
  });
});
