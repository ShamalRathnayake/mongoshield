import { Double, Int32 } from "mongodb";
import { describe, expect, it } from "vitest";
import type { DataFile } from "../format/manifest.ts";
import { diffDocuments, partsThatMayHold, sameBsonValue } from "./history.ts";

describe("diffDocuments", () => {
  it("lists changed, removed and added fields, descending into embedded documents", () => {
    const before = { _id: 1, name: "Ada", address: { city: "Oslo", zip: "0150" }, fax: "x" };
    const after = { _id: 1, name: "Ada L.", address: { city: "Oslo", zip: "0151" }, phone: "y" };
    expect(diffDocuments(before, after)).toEqual([
      { path: "name", kind: "changed", before: "Ada", after: "Ada L." },
      { path: "address.zip", kind: "changed", before: "0150", after: "0151" },
      { path: "fax", kind: "removed", before: "x" },
      { path: "phone", kind: "added", after: "y" },
    ]);
  });

  it("compares arrays as a whole and BSON types exactly", () => {
    expect(diffDocuments({ tags: ["a"] }, { tags: ["a", "b"] })).toHaveLength(1);
    expect(diffDocuments({ n: new Int32(1) }, { n: new Double(1) })).toHaveLength(1);
    expect(diffDocuments({ n: new Int32(1) }, { n: new Int32(1) })).toEqual([]);
  });

  it("treats identical documents as unchanged", () => {
    expect(sameBsonValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
  });
});

describe("partsThatMayHold", () => {
  const file = (key: string, range?: DataFile["range"]): DataFile => ({
    key,
    size: 1,
    sha256: "0".repeat(64),
    ...(range ? { range } : {}),
  });
  const parts = [
    file("p0", { from: { $minKey: 1 }, to: { $numberInt: "100" } }),
    file("p1", { from: { $numberInt: "100" }, to: { $numberInt: "200" } }),
    file("p2", { from: { $numberInt: "200" }, to: { $maxKey: 1 } }),
  ];

  it("keeps only the part whose _id range holds the id", () => {
    expect(partsThatMayHold(parts, 50).map((part) => part.key)).toEqual(["p0"]);
    expect(partsThatMayHold(parts, 100).map((part) => part.key)).toEqual(["p1"]);
    expect(partsThatMayHold(parts, 5000).map((part) => part.key)).toEqual(["p2"]);
  });

  it("orders values of different types as the _id index does", () => {
    // Strings sort after numbers, so a string id lives in the last part.
    expect(partsThatMayHold(parts, "ada").map((part) => part.key)).toEqual(["p2"]);
  });

  it("keeps parts without a range", () => {
    expect(partsThatMayHold([file("only")], 1)).toHaveLength(1);
  });
});
