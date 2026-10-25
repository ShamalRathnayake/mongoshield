/**
 * Tests for the checkbox tree's pure helpers: which patterns it can show, how ticking
 * and unticking turns into include patterns, search, and the totals.
 */

import { describe, expect, it } from "vitest";
import type { DatabaseNode } from "../shared/api.ts";
import {
  databaseState,
  documentsIn,
  filterTree,
  isPlainPick,
  normalizePicks,
  pickedCount,
  pickedTotals,
  selectionModeOf,
  setCollectionPicked,
  setDatabasePicked,
  setShownPicked,
  unknownPicks,
} from "./namespace-picks.ts";

/** A collection node with a document count. */
const collection = (name: string, estimatedDocuments = 10) => ({
  name,
  type: "collection" as const,
  estimatedDocuments,
  indexes: 1,
});

/** shop (3 collections), analytics (2) and an empty database. */
const TREE: DatabaseNode[] = [
  {
    name: "shop",
    collections: [collection("users", 100), collection("orders", 200), collection("sessions", 5)],
  },
  { name: "analytics", collections: [collection("daily"), collection("funnel")] },
  { name: "empty", collections: [] },
];
const shop = TREE[0] as DatabaseNode;
const analytics = TREE[1] as DatabaseNode;
const empty = TREE[2] as DatabaseNode;

describe("which patterns the tree can show", () => {
  it.each(["shop.*", "shop.users", "shop.events.2026"])("shows %j", (pattern) => {
    expect(isPlainPick(pattern)).toBe(true);
  });

  it.each(["*", "*.sessions", "app_*.users", "shop.events.*", "shop", "shop.user*"])(
    "leaves %j to the pattern boxes",
    (pattern) => {
      expect(isPlainPick(pattern)).toBe(false);
    },
  );

  it("chooses the mode an existing plan opens in", () => {
    expect(selectionModeOf([], [])).toBe("everything");
    expect(selectionModeOf(["shop.*", "analytics.daily"], [])).toBe("pick");
    expect(selectionModeOf(["shop.*"], ["*.sessions"])).toBe("advanced");
    expect(selectionModeOf([], ["shop.sessions"])).toBe("advanced");
    expect(selectionModeOf(["*.users"], [])).toBe("advanced");
  });
});

describe("ticking and unticking", () => {
  it("ticks a whole database as db.*", () => {
    const picks = setDatabasePicked(TREE, ["shop.users"], shop, true);
    expect(picks).toEqual(["shop.*"]);
    expect(databaseState(shop, new Set(picks))).toBe("all");
    expect(setDatabasePicked(TREE, picks, shop, false)).toEqual([]);
  });

  it("splits a whole database into its other collections when one is unticked", () => {
    const picks = setCollectionPicked(TREE, ["shop.*"], shop, "sessions", false);
    expect(picks).toEqual(["shop.users", "shop.orders"]);
    expect(databaseState(shop, new Set(picks))).toBe("some");
    expect(pickedCount(shop, new Set(picks))).toBe(2);
  });

  it("collapses a database to db.* once all its collections are ticked", () => {
    let picks = setCollectionPicked(TREE, [], analytics, "daily", true);
    expect(picks).toEqual(["analytics.daily"]);
    picks = setCollectionPicked(TREE, picks, analytics, "funnel", true);
    expect(picks).toEqual(["analytics.*"]);
  });

  it("keeps picks in tree order, with unknown ones at the end as they were", () => {
    const picks = normalizePicks(
      TREE,
      new Set(["gone.thing", "analytics.daily", "shop.orders", "old.*"]),
      ["gone.thing", "analytics.daily", "shop.orders", "old.*"],
    );
    expect(picks).toEqual(["shop.orders", "analytics.daily", "gone.thing", "old.*"]);
  });

  it("ticks an empty database as a whole (for collections created later)", () => {
    expect(databaseState(empty, new Set())).toBe("none");
    const picks = setDatabasePicked(TREE, [], empty, true);
    expect(picks).toEqual(["empty.*"]);
    expect(databaseState(empty, new Set(picks))).toBe("all");
  });

  it("finds picks the tree does not have", () => {
    expect(
      unknownPicks(TREE, ["shop.*", "shop.users", "shop.gone", "nowhere.*", "empty.*"]),
    ).toEqual(["shop.gone", "nowhere.*"]);
  });
});

describe("search and bulk selection", () => {
  it("keeps databases whose name matches whole, and matching collections otherwise", () => {
    expect(filterTree(TREE, "")).toHaveLength(3);
    expect(filterTree(TREE, " SHOP ").map((database) => database.name)).toEqual(["shop"]);
    expect(filterTree(TREE, "shop")[0]?.collections).toHaveLength(3);
    const found = filterTree(TREE, "fun");
    expect(found).toEqual([{ name: "analytics", collections: [collection("funnel")] }]);
    expect(filterTree(TREE, "zzz")).toEqual([]);
  });

  it("selects and clears everything shown", () => {
    const all = setShownPicked(TREE, [], TREE, true);
    expect(all).toEqual(["shop.*", "analytics.*", "empty.*"]);
    expect(setShownPicked(TREE, all, TREE, false)).toEqual([]);
  });

  it("selects only the matches while searching", () => {
    const picks = setShownPicked(TREE, [], filterTree(TREE, "fun"), true);
    expect(picks).toEqual(["analytics.funnel"]);
    // A database missing from the tree (stale search results) is skipped.
    expect(setShownPicked(TREE, picks, [{ name: "gone", collections: [] }], true)).toEqual(picks);
  });

  it("counts the chosen collections and their documents", () => {
    expect(pickedTotals(TREE, ["shop.*", "analytics.daily"])).toEqual({
      collections: 4,
      total: 5,
      documents: 315,
    });
    expect(documentsIn(shop)).toBe(305);
  });
});
