/**
 * Unit tests for the collection stats with fake collections: one `$collStats` call
 * serves sizes and index sizes (summed over shards), and a refusal (Atlas code 8000, or
 * Unauthorized code 13) leaves the sizes out with a reason in words instead of failing.
 */

import { type Collection, type Document, MongoServerError } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import {
  ATLAS_STATS_UNAVAILABLE,
  collectionStatsOf,
  PRIVILEGE_STATS_UNAVAILABLE,
} from "./collection-stats.ts";

/** Two indexes, as `listIndexes` returns them. */
const INDEXES: Document[] = [
  { v: 2, key: { _id: 1 }, name: "_id_" },
  {
    v: 2,
    key: { email: 1 },
    name: "email_1",
    unique: true,
    sparse: true,
    hidden: true,
    expireAfterSeconds: 60,
    partialFilterExpression: { active: true },
  },
];

/** A fake collection whose `$collStats` answers `stats` (or throws it, if an error). */
function fakeCollection(stats: Document[] | Error) {
  const aggregate = vi.fn(() => ({
    toArray: async () => {
      if (stats instanceof Error) throw stats;
      return stats;
    },
  }));
  const collection = {
    aggregate,
    listIndexes: () => ({ toArray: async () => INDEXES }),
  } as unknown as Collection<Document>;
  return { collection, aggregate };
}

describe("collection stats", () => {
  it("reads sizes and index sizes from one $collStats call, summed over shards", async () => {
    const shard = (size: number) => ({
      storageStats: {
        size,
        storageSize: size / 2,
        totalIndexSize: 30,
        count: 10,
        indexSizes: { _id_: 10, email_1: 20, ignored: "not a number" },
      },
    });
    const { collection, aggregate } = fakeCollection([shard(1000), shard(3000)]);
    const stats = await collectionStatsOf(collection);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({
      sizeBytes: 4000,
      storageSizeBytes: 2000,
      totalIndexBytes: 60,
      averageDocumentBytes: 200,
      atlasRefused: false,
    });
    expect(stats.statsUnavailable).toBeUndefined();
    expect(stats.indexes).toEqual([
      {
        name: "_id_",
        key: '{"_id":1}',
        unique: false,
        sparse: false,
        hidden: false,
        sizeBytes: 20,
      },
      {
        name: "email_1",
        key: '{"email":1}',
        unique: true,
        sparse: true,
        hidden: true,
        expireAfterSeconds: 60,
        partialFilter: '{"active":true}',
        sizeBytes: 40,
      },
    ]);
  });

  it("reports an average of 0 for an empty collection, and 0 for missing numbers", async () => {
    const { collection } = fakeCollection([{ storageStats: {} }]);
    expect(await collectionStatsOf(collection)).toMatchObject({
      sizeBytes: 0,
      averageDocumentBytes: 0,
    });
  });

  it("explains an Atlas refusal (code 8000) instead of failing, and flags the shared tier", async () => {
    const { collection } = fakeCollection(
      new MongoServerError({
        message: "$collStats is not allowed in this atlas tier",
        code: 8000,
        codeName: "AtlasError",
      }),
    );
    const stats = await collectionStatsOf(collection);
    expect(stats.statsUnavailable).toBe(ATLAS_STATS_UNAVAILABLE);
    expect(stats.atlasRefused).toBe(true);
    expect(stats.sizeBytes).toBeUndefined();
    expect(stats.storageSizeBytes).toBeUndefined();
    // Indexes are still listed, without sizes.
    expect(stats.indexes.map((index) => [index.name, index.sizeBytes])).toEqual([
      ["_id_", undefined],
      ["email_1", undefined],
    ]);
  });

  it("explains a privilege refusal (code 13) without blaming Atlas", async () => {
    const { collection } = fakeCollection(
      new MongoServerError({
        message: "not authorized on app to execute command { aggregate: ... }",
        code: 13,
        codeName: "Unauthorized",
      }),
    );
    const stats = await collectionStatsOf(collection);
    expect(stats.statsUnavailable).toBe(PRIVILEGE_STATS_UNAVAILABLE);
    expect(stats.atlasRefused).toBe(false);
    expect(stats.averageDocumentBytes).toBeUndefined();
  });
});
