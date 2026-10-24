import fc from "fast-check";
import {
  BSON,
  type Document,
  Int32,
  Long,
  MaxKey,
  MinKey,
  type MongoClient,
  ObjectId,
  ReadPreference,
} from "mongodb";
import { describe, expect, it } from "vitest";
import { valueInStoredOrder } from "../format/field-order.ts";
import { parseJsonInStoredOrder, stringifyJsonInStoredOrder } from "../format/ordered-json.ts";
import { silentLogger } from "../logger.ts";
import type { CollectionSpec } from "../mongo/index.ts";
import {
  boundsFromBoundaries,
  canSplit,
  chooseBoundaries,
  fromCanonical,
  planCollectionParts,
  readCollectionStats,
  toCanonical,
  toPartRange,
  wantedPartCount,
} from "./backup-parts.ts";

const MIB = 1024 * 1024;

function spec(overrides: Partial<CollectionSpec>): CollectionSpec {
  return {
    ns: "app.orders",
    db: "app",
    name: "orders",
    type: "collection",
    options: {},
    indexes: [{ v: 2, key: { _id: 1 }, name: "_id_" }],
    estimatedDocuments: 0,
    ...overrides,
  };
}

describe("wantedPartCount", () => {
  it("keeps collections up to partSizeBytes in one part", () => {
    expect(wantedPartCount(0, 256 * MIB)).toBe(1);
    expect(wantedPartCount(256 * MIB, 256 * MIB)).toBe(1);
  });

  it("asks for one part per partSizeBytes, rounding up", () => {
    expect(wantedPartCount(256 * MIB + 1, 256 * MIB)).toBe(2);
    expect(wantedPartCount(1000 * MIB, 256 * MIB)).toBe(4);
  });
});

describe("chooseBoundaries", () => {
  it("takes boundaries at even intervals of the sorted samples", () => {
    const samples = Array.from({ length: 100 }, (_, index) => index);
    expect(chooseBoundaries(samples, 4)).toEqual([25, 50, 75]);
  });

  it("returns no boundaries for one part or no samples", () => {
    expect(chooseBoundaries([1, 2, 3], 1)).toEqual([]);
    expect(chooseBoundaries([], 5)).toEqual([]);
  });

  it("drops repeated values, so no two parts share a range", () => {
    expect(chooseBoundaries([1, 1, 1, 1, 2, 2, 2, 2], 8)).toEqual([1, 2]);
  });

  it("produces strictly increasing boundaries from any sorted sample", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 300 }),
        fc.integer({ min: 1, max: 40 }),
        (values, parts) => {
          const sorted = [...values].sort((a, b) => a - b);
          const boundaries = chooseBoundaries(sorted, parts) as number[];
          expect(boundaries.length).toBeLessThanOrEqual(Math.max(0, parts - 1));
          for (let index = 1; index < boundaries.length; index++) {
            expect(boundaries[index] ?? 0).toBeGreaterThan(boundaries[index - 1] ?? 0);
          }
        },
      ),
    );
  });

  it("compares boundaries by exact BSON value, not by JavaScript identity", () => {
    const id = new ObjectId();
    const copy = new ObjectId(id.toHexString());
    expect(chooseBoundaries([id, copy, copy, copy], 4)).toHaveLength(1);
  });
});

describe("boundsFromBoundaries", () => {
  it("opens the first part at the bottom and the last at the top", () => {
    expect(boundsFromBoundaries([10, 20])).toEqual([
      { lower: undefined, upper: { value: 10 } },
      { lower: { value: 10 }, upper: { value: 20 } },
      { lower: { value: 20 }, upper: undefined },
    ]);
  });

  it("describes an unsplit collection as one open range", () => {
    expect(boundsFromBoundaries([])).toEqual([{ lower: undefined, upper: undefined }]);
  });
});

describe("part ranges", () => {
  it("records open ends as $minKey / $maxKey and keeps exact types", () => {
    const [first, last] = boundsFromBoundaries([new Int32(5)]);
    expect(first && toPartRange(first)).toEqual({ from: { $minKey: 1 }, to: { $numberInt: "5" } });
    expect(last && toPartRange(last)).toEqual({ from: { $numberInt: "5" }, to: { $maxKey: 1 } });
  });

  it("round-trips boundary values through canonical Extended JSON", () => {
    const big = Long.fromString("9007199254740993");
    const values = [
      new Int32(7),
      big,
      "text",
      new ObjectId(),
      { a: 1 },
      new MinKey(),
      new MaxKey(),
    ];
    for (const value of values) {
      expect(toCanonical(fromCanonical(toCanonical(value)))).toEqual(toCanonical(value));
    }
    expect(String(fromCanonical(toCanonical(big)))).toBe("9007199254740993");
  });
});

describe("canSplit", () => {
  it("splits regular collections with an _id index", () => {
    expect(canSplit(spec({}))).toBe(true);
  });

  it("never splits views, time series, clustered or _id-less collections", () => {
    expect(canSplit(spec({ type: "view", indexes: [] }))).toBe(false);
    expect(canSplit(spec({ type: "timeseries" }))).toBe(false);
    expect(canSplit(spec({ options: { clusteredIndex: { key: { _id: 1 }, unique: true } } }))).toBe(
      false,
    );
    expect(canSplit(spec({ options: { capped: true, size: 4096 }, indexes: [] }))).toBe(false);
  });
});

describe("canSplit with unusual _id indexes", () => {
  it("only accepts an ascending single-field _id key", () => {
    const withKey = (key: unknown) => spec({ indexes: [{ v: 2, key, name: "k" }] });
    expect(canSplit(withKey({ _id: -1 }))).toBe(false);
    expect(canSplit(withKey({ _id: "hashed" }))).toBe(false);
    expect(canSplit(withKey({ _id: 1, other: 1 }))).toBe(false);
    expect(canSplit(withKey(null))).toBe(false);
    expect(canSplit(withKey("_id"))).toBe(false);
    expect(canSplit(withKey({ _id: new Int32(1) }))).toBe(true);
  });
});

describe("planning parts from collection statistics", () => {
  /** A fake client: `$collStats` yields `stats` (or throws), `$sample` yields `ids`. */
  function fakeClient(stats: readonly Document[] | Error, ids: readonly unknown[] = []) {
    const fake = {
      db: () => ({
        collection: () => ({
          aggregate: (pipeline: Document[]) => {
            const isStats = pipeline[0] !== undefined && "$collStats" in pipeline[0];
            return (async function* () {
              if (isStats) {
                if (stats instanceof Error) throw stats;
                yield* stats;
              } else {
                // Asked for raw documents, as the driver returns them with `raw: true`.
                for (const id of ids) yield BSON.serialize({ _id: id });
              }
            })();
          },
        }),
      }),
    };
    return fake as unknown as MongoClient;
  }

  const options = (client: MongoClient) => ({
    client,
    readPreference: ReadPreference.primary,
    logger: silentLogger,
    signal: undefined,
  });

  it("sums the shards and tolerates missing or odd numbers", async () => {
    const client = fakeClient([
      { storageStats: { size: 1000, count: 10 } },
      { storageStats: { size: "500", count: Long.fromNumber(5) } },
      { storageStats: { size: "not a number" } },
      { storageStats: null },
    ]);
    expect(await readCollectionStats(spec({}), options(client))).toEqual({
      sizeBytes: 1500,
      averageDocumentBytes: 100,
    });
    const empty = await readCollectionStats(spec({}), options(fakeClient([])));
    expect(empty).toEqual({ sizeBytes: 0, averageDocumentBytes: undefined });
  });

  it("does not split a collection whose statistics cannot be read", async () => {
    const client = fakeClient(new Error("not authorized"));
    expect(await readCollectionStats(spec({}), options(client))).toBeUndefined();
    expect(await planCollectionParts(spec({}), MIB, options(client))).toEqual({
      boundaries: [],
      averageDocumentBytes: undefined,
    });
  });

  it("samples embedded-document _ids in their stored field order", async () => {
    // `{ b, "1" }`: JavaScript would list "1" first, which is another `_id` value.
    const ids = Array.from(
      { length: 40 },
      (_, index) =>
        new Map<string, unknown>([
          ["b", new Int32(index)],
          ["1", new Int32(0)],
        ]),
    );
    const large = fakeClient([{ storageStats: { size: 4 * MIB, count: 40 } }], ids);
    const { boundaries } = await planCollectionParts(spec({}), MIB, options(large));
    expect(boundaries).toHaveLength(3);
    for (const boundary of boundaries) {
      const ordered = valueInStoredOrder(boundary);
      expect(ordered instanceof Map ? [...ordered.keys()] : undefined).toEqual(["b", "1"]);
    }
    // And they keep it through the canonical Extended JSON of checkpoints.
    const text = stringifyJsonInStoredOrder(toCanonical(boundaries[0]));
    expect(text).toBe('{"b":{"$numberInt":"10"},"1":{"$numberInt":"0"}}');
    const back = fromCanonical(parseJsonInStoredOrder(text));
    expect(BSON.serialize({ value: valueInStoredOrder(back) })).toEqual(
      BSON.serialize({ value: ids[10] }),
    );
  });

  it("splits a large collection at sampled _ids, and leaves small ones whole", async () => {
    const ids = Array.from({ length: 40 }, (_, index) => new Int32(index));
    const large = fakeClient([{ storageStats: { size: 4 * MIB, count: 40 } }], ids);
    const planned = await planCollectionParts(spec({}), MIB, options(large));
    // In their exact BSON types.
    expect(planned.boundaries).toEqual([new Int32(10), new Int32(20), new Int32(30)]);
    const small = fakeClient([{ storageStats: { size: 100, count: 1 } }], ids);
    expect((await planCollectionParts(spec({}), MIB, options(small))).boundaries).toEqual([]);
    const views = await planCollectionParts(spec({ type: "view" }), MIB, options(large));
    expect(views).toEqual({ boundaries: [], averageDocumentBytes: undefined });
  });
});
