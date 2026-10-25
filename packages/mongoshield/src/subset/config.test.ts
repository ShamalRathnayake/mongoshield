import { describe, expect, it } from "vitest";
import { compileSubset, DEFAULT_FOLLOW_BATCH_SIZE, type SubsetConfig } from "./config.ts";

const namespaces = [
  { ns: "app.orders", type: "collection" },
  { ns: "app.users", type: "collection" },
  { ns: "app.events.2026", type: "collection" },
  { ns: "app.events", type: "collection" },
  { ns: "app.big_orders", type: "view" },
] as const;

describe("compileSubset", () => {
  it("describes how each namespace is selected", () => {
    const subset = compileSubset(
      {
        filters: { "app.orders": { total: { $gt: 10 } }, "app.events": {} },
        follow: [
          { from: "app.orders.userId", to: "app.users._id" },
          { from: "app.users.referrerId", to: "app.events.userId" },
        ],
      },
      namespaces,
    );
    expect(subset.selectionOf("app.orders")).toBe("filtered");
    expect(subset.selectionOf("app.users")).toBe("referenced");
    expect(subset.selectionOf("app.events")).toBe("filtered+referenced");
    expect(subset.selectionOf("app.events.2026")).toBe("all");
    expect(subset.batchSize).toBe(DEFAULT_FOLLOW_BATCH_SIZE);
    expect(subset.outgoing("app.orders").map((follow) => follow.to.ns)).toEqual(["app.users"]);
  });

  it("splits string endpoints at the longest copied namespace, so collection names may contain dots", () => {
    const subset = compileSubset(
      { follow: [{ from: "app.events.2026.userId", to: "app.users._id" }] },
      namespaces,
    );
    expect(subset.follows[0]?.from).toMatchObject({ ns: "app.events.2026", path: "userId" });
  });

  it("accepts explicit { ns, path } endpoints and array paths", () => {
    const subset = compileSubset(
      {
        follow: [
          {
            from: { ns: "app.events", path: "items.*.userId" },
            to: { ns: "app.users", path: "_id" },
          },
        ],
      },
      namespaces,
    );
    expect(subset.follows[0]).toMatchObject({
      from: { ns: "app.events", segments: ["items", "*", "userId"] },
      setKey: "app.users|_id",
    });
  });

  it.each<[string, SubsetConfig, RegExp]>([
    [
      "a filter on a namespace not copied",
      { filters: { "app.nope": {} } },
      /"app.nope", which is not being copied/,
    ],
    ["a filter on a view", { filters: { "app.big_orders": {} } }, /views hold no documents/],
    [
      "a filter that is not a document",
      { filters: { "app.orders": [] as never } },
      /must be a query document/,
    ],
    [
      "an endpoint outside the copied namespaces",
      { follow: [{ from: "shop.orders.userId", to: "app.users._id" }] },
      /does not start with a copied namespace/,
    ],
    [
      "a wildcard in the queried side",
      { follow: [{ from: "app.orders.userId", to: "app.users.ids.*" }] },
      /cannot use \*/,
    ],
    ["a bad batch size", { batchSize: 0 }, /batchSize/],
  ])("rejects %s", (_label, config, message) => {
    expect(() => compileSubset(config, namespaces)).toThrow(message);
  });
});

describe("compileSubset with time series", () => {
  const withMetrics = [...namespaces, { ns: "app.metrics", type: "timeseries" }] as const;

  it("refuses a time series that is both filtered and followed into", () => {
    expect(() =>
      compileSubset(
        {
          filters: { "app.metrics": { at: { $gte: new Date("2026-01-01") } } },
          follow: [{ from: "app.orders.metricId", to: "app.metrics._id" }],
        },
        withMetrics,
      ),
    ).toThrow(/time series "app\.metrics" has a filter AND is followed into/);
  });

  it("refuses a time series followed into through two fields", () => {
    expect(() =>
      compileSubset(
        {
          follow: [
            { from: "app.orders.metricId", to: "app.metrics._id" },
            { from: "app.users.hostName", to: "app.metrics.meta.host" },
          ],
        },
        withMetrics,
      ),
    ).toThrow(/followed into through several fields \(_id, meta\.host\)/);
  });

  it("accepts a time series selected one way, by several rules on one field", () => {
    const subset = compileSubset(
      {
        follow: [
          { from: "app.orders.host", to: "app.metrics.meta.host" },
          { from: "app.users.host", to: "app.metrics.meta.host" },
        ],
      },
      withMetrics,
    );
    expect(subset.selectionOf("app.metrics")).toBe("referenced");
  });
});
