// Unit tests for aligning a restored collection with a chain's newest metadata
// (restore-metadata.ts) and for which chain member a restore takes its state from
// (restore-plan.ts `planningEntries`, `stateMemberOf`).

import { Int32 } from "mongodb";
import { describe, expect, it } from "vitest";
import { idAt, makeChainBase, makeIncremental } from "../catalog/test-fixtures.ts";
import type { NamespaceEntry } from "../format/manifest.ts";
import { parseExtendedJson } from "../format/ordered-json.ts";
import { indexChanges, optionChanges } from "./restore-metadata.ts";
import { planningEntries, stateMemberOf } from "./restore-plan.ts";

const SHA = "0".repeat(64);

function entry(
  collection: string,
  type: NamespaceEntry["type"],
  content?: NamespaceEntry["content"],
): NamespaceEntry {
  return {
    ns: `app.${collection}`,
    db: "app",
    collection,
    type,
    documents: content === "metadata" ? 0 : 1,
    bytesRaw: 0,
    files: content === "metadata" ? [] : [{ key: `app/${collection}.bson`, size: 1, sha256: SHA }],
    metadata: { key: `app/${collection}.metadata.json`, size: 1, sha256: SHA },
    ...(content === undefined ? {} : { content }),
  };
}

describe("optionChanges", () => {
  it("lists the modifiable options that differ, in stored field order", () => {
    const stored = parseExtendedJson('{"validator":{"b":1,"2":1}}', { relaxed: false }) as never;
    const reordered = parseExtendedJson('{"validator":{"2":1,"b":1}}', { relaxed: false }) as never;
    expect(optionChanges(stored, stored)).toEqual([]);
    // The same keys in another order are another validator.
    expect(optionChanges(stored, reordered)).toEqual(["validator"]);
    expect(optionChanges({}, { expireAfterSeconds: new Int32(60), capped: true })).toEqual([
      "expireAfterSeconds",
    ]);
    expect(optionChanges({ validator: { a: 1 }, validationAction: "warn" }, {})).toEqual([
      "validator",
      "validationAction",
    ]);
  });
});

describe("indexChanges", () => {
  it("aligns TTL and hidden flags of indexes both sides have", () => {
    const existing = [
      { name: "ttl", key: { t: 1 }, expireAfterSeconds: 60 },
      { name: "b_1", key: { b: 1 } },
      { name: "gone", key: { g: 1 }, hidden: true },
    ];
    const latest = [
      { name: "ttl", key: { t: 1 }, expireAfterSeconds: new Int32(120) },
      { name: "b_1", key: { b: 1 }, hidden: true },
      { name: "new", key: { n: 1 }, expireAfterSeconds: 5 },
      { key: { x: 1 } },
    ];
    expect(indexChanges(existing, latest)).toEqual([
      { name: "ttl", field: "expireAfterSeconds", value: 120 },
      { name: "b_1", field: "hidden", value: true },
    ]);
  });
});

describe("the state member of a chain", () => {
  const base = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000, {
    namespaces: [
      entry("orders", "collection"),
      entry("old_view", "view"),
      entry("old_ts", "timeseries"),
    ],
  });
  const first = makeIncremental(idAt("2026-10-20T01:00:00Z"), base, 2000, {
    namespaces: [
      entry("orders", "collection", "metadata"),
      entry("new_view", "view", "metadata"),
      entry("metrics", "timeseries", "full"),
    ],
  });
  const second = makeIncremental(idAt("2026-10-20T02:00:00Z"), first, 3000);

  it("is the newest incremental that ends at or before the restore's time", () => {
    expect(stateMemberOf([first, second], undefined)?.id).toBe(second.id);
    expect(stateMemberOf([first, second], { t: 2500, i: 0 })?.id).toBe(first.id);
    expect(stateMemberOf([first, second], { t: 1500, i: 0 })).toBeUndefined();
  });

  it("gives the base's collections and the member's views, time series and metadata", () => {
    const planning = planningEntries(base, first);
    expect(planning.entries.map((item) => item.collection)).toEqual([
      "metrics",
      "new_view",
      "orders",
    ]);
    expect(planning.owners).toEqual(
      new Map([
        ["app.metrics", first.id],
        ["app.new_view", first.id],
      ]),
    );
    expect([...planning.latestMetadata.keys()]).toEqual(["app.orders"]);
    expect(planningEntries(base, undefined).entries).toBe(base.namespaces);
  });
});
