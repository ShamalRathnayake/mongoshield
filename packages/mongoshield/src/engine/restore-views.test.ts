// Unit tests for views under rename rules: viewOn and every collection a pipeline
// reads ($lookup, $graphLookup, $unionWith, $merge, $out), also inside nested
// pipelines ($facet, $lookup / $unionWith sub-pipelines). The server side is covered by
// test/integration/restore-types.test.ts.

import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { compileRenameMap } from "./restore-rename.ts";
import { renameView, type ViewLocation } from "./restore-views.ts";

/** A view in `app`, restored into the database the rules give `app.*`. */
function location(rules: Record<string, string>, targetDatabase = "app"): ViewLocation {
  return { sourceDatabase: "app", targetDatabase, rename: compileRenameMap(rules) };
}

describe("renameView", () => {
  it("follows renames of viewOn and of every stage that reads a collection", () => {
    const rules = { "app.orders": "app.orders_old", "app.users": "app.people" };
    const renamed = renameView(
      {
        viewOn: "orders",
        pipeline: [
          { $match: { status: "open" } },
          { $lookup: { from: "users", localField: "u", foreignField: "_id", as: "user" } },
          {
            $graphLookup: {
              from: "orders",
              startWith: "$p",
              connectFromField: "p",
              connectToField: "_id",
              as: "tree",
            },
          },
          { $unionWith: "users" },
          { $unionWith: { coll: "orders", pipeline: [{ $limit: 1 }] } },
        ],
      },
      location(rules),
    );
    expect(renamed.viewOn).toBe("orders_old");
    expect(renamed.pipeline).toEqual([
      { $match: { status: "open" } },
      { $lookup: { from: "people", localField: "u", foreignField: "_id", as: "user" } },
      {
        $graphLookup: {
          from: "orders_old",
          startWith: "$p",
          connectFromField: "p",
          connectToField: "_id",
          as: "tree",
        },
      },
      { $unionWith: "people" },
      { $unionWith: { coll: "orders_old", pipeline: [{ $limit: 1 }] } },
    ]);
    expect(renamed.unfollowed).toEqual([]);
  });

  it("rewrites nested pipelines: $facet, $lookup with a pipeline, $unionWith inside them", () => {
    const renamed = renameView(
      {
        viewOn: "a",
        pipeline: [
          {
            $facet: {
              recent: [{ $lookup: { from: "b", pipeline: [{ $unionWith: "c" }], as: "bs" } }],
              all: [{ $unionWith: { coll: "b" } }],
            },
          },
          {
            $lookup: {
              from: "c",
              let: { id: "$_id" },
              pipeline: [
                { $lookup: { from: "b", as: "deep" } },
                { $facet: { x: [{ $unionWith: "a" }] } },
              ],
              as: "cs",
            },
          },
        ],
      },
      location({ "app.a": "app.a2", "app.b": "app.b2", "app.c": "app.c2" }),
    );
    expect(renamed.viewOn).toBe("a2");
    expect(renamed.pipeline).toEqual([
      {
        $facet: {
          recent: [{ $lookup: { from: "b2", pipeline: [{ $unionWith: "c2" }], as: "bs" } }],
          all: [{ $unionWith: { coll: "b2" } }],
        },
      },
      {
        $lookup: {
          from: "c2",
          let: { id: "$_id" },
          pipeline: [
            { $lookup: { from: "b2", as: "deep" } },
            { $facet: { x: [{ $unionWith: "a2" }] } },
          ],
          as: "cs",
        },
      },
    ]);
  });

  it("follows a whole-database rename (names stay, the database changes with the view)", () => {
    const renamed = renameView(
      { viewOn: "orders", pipeline: [{ $lookup: { from: "users", as: "u" } }] },
      location({ "app.*": "staging.*" }, "staging"),
    );
    expect(renamed.viewOn).toBe("orders");
    expect(renamed.pipeline).toEqual([{ $lookup: { from: "users", as: "u" } }]);
    expect(renamed.unfollowed).toEqual([]);
  });

  it("keeps names whose collection moved to another database, and reports each one", () => {
    const renamed = renameView(
      {
        viewOn: "orders",
        pipeline: [{ $lookup: { from: "users", as: "u" } }, { $unionWith: "orders" }],
      },
      location({ "app.users": "other.users", "app.orders": "app.orders2" }),
    );
    expect(renamed.viewOn).toBe("orders2");
    expect(renamed.pipeline).toEqual([
      { $lookup: { from: "users", as: "u" } },
      { $unionWith: "orders2" },
    ]);
    expect(renamed.unfollowed).toEqual([
      { field: "$lookup.from", collection: "users", restoredTo: "other.users" },
    ]);
  });

  it("reports a viewOn whose source left the view's database", () => {
    const renamed = renameView(
      { viewOn: "orders", pipeline: [] },
      location({ "app.orders": "archive.orders" }),
    );
    expect(renamed.viewOn).toBe("orders");
    expect(renamed.unfollowed).toEqual([
      { field: "viewOn", collection: "orders", restoredTo: "archive.orders" },
    ]);
  });

  it("renames $merge and $out targets, in every form they take", () => {
    const rules = location({ "app.out": "app.out2", "reports.daily": "reports_r.daily" });
    const renamed = renameView(
      {
        viewOn: "x",
        pipeline: [
          { $merge: "out" },
          { $merge: { into: "out", whenMatched: "replace" } },
          { $merge: { into: { db: "reports", coll: "daily" } } },
          { $out: "out" },
          { $out: { db: "reports", coll: "daily" } },
          { $merge: { on: "_id" } },
        ],
      },
      rules,
    );
    expect(renamed.pipeline).toEqual([
      { $merge: "out2" },
      { $merge: { into: "out2", whenMatched: "replace" } },
      { $merge: { into: { db: "reports_r", coll: "daily" } } },
      { $out: "out2" },
      { $out: { db: "reports_r", coll: "daily" } },
      { $merge: { on: "_id" } },
    ]);
  });

  it("accepts $lookup from { db, coll } and leaves odd shapes alone", () => {
    const id = new ObjectId();
    const renamed = renameView(
      {
        viewOn: 42,
        pipeline: [
          { $lookup: { from: { db: "app", coll: "a" }, as: "x" } },
          { $lookup: { pipeline: [{ $documents: [{ id }] }], as: "docs" } },
          { $lookup: "not a document" },
          { $graphLookup: { startWith: "$x" } },
          { $unionWith: 7 },
          { $unionWith: { pipeline: [{ $unionWith: "a" }] } },
          { $facet: "nope" },
          { $merge: 3 },
          { $merge: { into: { db: 1 } } },
          { $out: 5 },
          { $out: { db: "app" } },
          "not a stage",
          { $match: { at: new Date(0) } },
        ],
      },
      location({ "app.a": "app.a2" }),
    );
    expect(renamed.viewOn).toBe(42);
    expect(renamed.pipeline).toEqual([
      { $lookup: { from: { db: "app", coll: "a2" }, as: "x" } },
      { $lookup: { pipeline: [{ $documents: [{ id }] }], as: "docs" } },
      { $lookup: "not a document" },
      { $graphLookup: { startWith: "$x" } },
      { $unionWith: 7 },
      { $unionWith: { pipeline: [{ $unionWith: "a2" }] } },
      { $facet: "nope" },
      { $merge: 3 },
      { $merge: { into: { db: 1 } } },
      { $out: 5 },
      { $out: { db: "app" } },
      "not a stage",
      { $match: { at: new Date(0) } },
    ]);
  });

  it("returns a missing or malformed pipeline unchanged", () => {
    expect(renameView({ viewOn: "a", pipeline: undefined }, location({})).pipeline).toBeUndefined();
    expect(renameView({ viewOn: "a", pipeline: "x" }, location({})).pipeline).toBe("x");
  });
});
