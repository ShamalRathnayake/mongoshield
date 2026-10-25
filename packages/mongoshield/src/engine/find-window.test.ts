// Unit tests for the pure parts of the change window overlay (find-window.ts): the
// lineage walk over drops and renames, `_id` keys and partitions. The overlay itself
// runs against real converge backups in test/integration/find-window.test.ts.

import { Double, Int32, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { idKey, lineageOf, partitionOf } from "./find-window.ts";

describe("lineageOf", () => {
  it("starts from the namespace's own dump when nothing moved it", () => {
    expect(lineageOf("app.a", [], 10)).toEqual({
      segments: [{ ns: "app.a", from: 0, to: 10 }],
      base: "app.a",
    });
  });

  it("ignores namespace changes of other collections", () => {
    const lineage = lineageOf(
      "app.a",
      [
        { kind: "drop", index: 1, ns: "app.b" },
        { kind: "dropDatabase", index: 2, db: "other" },
        { kind: "rename", index: 3, from: "app.b", to: "app.c" },
        { kind: "rename", index: 4, from: "app.a", to: "app.a" },
      ],
      10,
    );
    expect(lineage.base).toBe("app.a");
  });

  it("starts empty after a drop, a dropDatabase or a rename away", () => {
    expect(lineageOf("app.a", [{ kind: "drop", index: 3, ns: "app.a" }], 10)).toEqual({
      segments: [{ ns: "app.a", from: 4, to: 10 }],
      base: undefined,
    });
    expect(lineageOf("app.a", [{ kind: "dropDatabase", index: 5, db: "app" }], 10).base).toBe(
      undefined,
    );
    expect(
      lineageOf("app.a", [{ kind: "rename", index: 2, from: "app.a", to: "app.z" }], 10),
    ).toEqual({ segments: [{ ns: "app.a", from: 3, to: 10 }], base: undefined });
  });

  it("follows renames into the namespace back to the collection the documents came from", () => {
    const lineage = lineageOf(
      "app.a",
      [
        { kind: "rename", index: 2, from: "app.x", to: "app.y" },
        { kind: "rename", index: 6, from: "app.y", to: "app.a" },
      ],
      10,
    );
    expect(lineage).toEqual({
      segments: [
        { ns: "app.a", from: 7, to: 10 },
        { ns: "app.y", from: 3, to: 6 },
        { ns: "app.x", from: 0, to: 2 },
      ],
      base: "app.x",
    });
  });

  it("stops at a drop that comes after a rename (a destination recorded as of the rename)", () => {
    const lineage = lineageOf(
      "app.a",
      [
        { kind: "rename", index: 2, from: "app.x", to: "app.a" },
        { kind: "drop", index: 3, ns: "app.a" },
      ],
      10,
    );
    expect(lineage).toEqual({ segments: [{ ns: "app.a", from: 4, to: 10 }], base: undefined });
  });
});

describe("idKey and partitionOf", () => {
  it("tells _ids apart by BSON type and value, and is stable", () => {
    const id = new ObjectId();
    expect(idKey(id)).toBe(idKey(new ObjectId(id.toHexString())));
    expect(idKey(new Int32(1))).not.toBe(idKey(new Double(1)));
    expect(idKey("a")).not.toBe(idKey("b"));
  });

  it("spreads keys over every partition", () => {
    const seen = new Set<number>();
    for (let n = 0; n < 200; n++) {
      const partition = partitionOf(idKey(n), 4);
      expect(partition).toBeGreaterThanOrEqual(0);
      expect(partition).toBeLessThan(4);
      seen.add(partition);
    }
    expect(seen.size).toBe(4);
    expect(partitionOf(idKey(1), 1)).toBe(0);
  });
});
