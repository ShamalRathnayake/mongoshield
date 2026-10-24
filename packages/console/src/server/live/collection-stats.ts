/**
 * Sizes and indexes of a live collection for `GET /api/live/:id/collection`, from ONE
 * `$collStats` call (plus `listIndexes`).
 *
 * One call, not one per question: on Atlas Free/Flex clusters every command counts
 * against a throttle of about 100 operations per second, so the page asks once and
 * reads both the collection sizes and the per-index sizes from the same reply.
 *
 * `$collStats` is optional. When MongoDB refuses it, the collection is still browsable
 * and the page says why the sizes are missing instead of failing:
 *
 *   - Atlas Free and Flex clusters refuse it with code 8000 `AtlasError`
 *     (`isAtlasRefusal`); that refusal also proves the cluster is a shared tier.
 *   - Users without the `collStats` privilege get code 13 `Unauthorized` (or another
 *     server error): the message names the missing privilege.
 */

import { BSON, type Collection, type Document } from "mongodb";
import { isAtlasRefusal } from "mongoshield";
import type { LiveCollectionInfo, LiveIndexView } from "../../shared/api.ts";

/** Shown when an Atlas shared tier refuses `$collStats`. */
export const ATLAS_STATS_UNAVAILABLE =
  "Atlas Free and Flex clusters do not report collection sizes.";
/** Shown when MongoDB refuses `$collStats` for any other reason (usually privileges). */
export const PRIVILEGE_STATS_UNAVAILABLE =
  "Your MongoDB user may not read collection statistics ($collStats).";

/** The part of {@link LiveCollectionInfo} this module fills. */
export type CollectionStats = Pick<
  LiveCollectionInfo,
  | "sizeBytes"
  | "storageSizeBytes"
  | "averageDocumentBytes"
  | "totalIndexBytes"
  | "indexes"
  | "statsUnavailable"
> & {
  /** True when Atlas refused `$collStats`: the cluster is a shared tier. */
  readonly atlasRefused: boolean;
};

/**
 * Reads the stats and indexes of a collection (not a view: views have neither).
 * `listIndexes` failing is still an error (it is needed to browse sensibly and every
 * reading role has it); `$collStats` failing is not.
 */
export async function collectionStatsOf(
  collection: Collection<Document>,
): Promise<CollectionStats> {
  let shards: Document[] | undefined;
  let refusal: unknown;
  try {
    // One document per shard on a sharded cluster, one in total otherwise.
    shards = await collection.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
  } catch (error) {
    refusal = error;
  }
  const indexes = await indexesOf(collection, shards ?? []);
  if (shards === undefined) {
    const atlasRefused = isAtlasRefusal(refusal);
    return {
      indexes,
      statsUnavailable: atlasRefused ? ATLAS_STATS_UNAVAILABLE : PRIVILEGE_STATS_UNAVAILABLE,
      atlasRefused,
    };
  }
  return { ...storageStatsOf(shards), indexes, atlasRefused: false };
}

/** Collection sizes from the `$collStats` reply, summed over shards. */
function storageStatsOf(
  shards: readonly Document[],
): Pick<
  LiveCollectionInfo,
  "sizeBytes" | "storageSizeBytes" | "averageDocumentBytes" | "totalIndexBytes"
> {
  let sizeBytes = 0;
  let storageSizeBytes = 0;
  let totalIndexBytes = 0;
  let count = 0;
  for (const shard of shards) {
    const storageStats: unknown = shard.storageStats;
    sizeBytes += numberField(storageStats, "size");
    storageSizeBytes += numberField(storageStats, "storageSize");
    totalIndexBytes += numberField(storageStats, "totalIndexSize");
    count += numberField(storageStats, "count");
  }
  return {
    sizeBytes,
    storageSizeBytes,
    totalIndexBytes,
    averageDocumentBytes: count === 0 ? 0 : Math.round(sizeBytes / count),
  };
}

/** The indexes of a collection, with their sizes when the `$collStats` reply has them. */
async function indexesOf(
  collection: Collection<Document>,
  shards: readonly Document[],
): Promise<LiveIndexView[]> {
  const sizes = new Map<string, number>();
  for (const shard of shards) {
    const indexSizes: unknown = Reflect.get(Object(shard.storageStats), "indexSizes");
    for (const [name, size] of Object.entries(Object(indexSizes))) {
      if (typeof size === "number") sizes.set(name, (sizes.get(name) ?? 0) + size);
    }
  }
  const indexes = await collection.listIndexes().toArray();
  return indexes.map((index): LiveIndexView => {
    const name = String(index.name);
    const size = sizes.get(name);
    return {
      name,
      key: BSON.EJSON.stringify(index.key, { relaxed: true }),
      unique: index.unique === true,
      sparse: index.sparse === true,
      hidden: index.hidden === true,
      ...(typeof index.expireAfterSeconds === "number"
        ? { expireAfterSeconds: index.expireAfterSeconds }
        : {}),
      ...(index.partialFilterExpression === undefined
        ? {}
        : {
            partialFilter: BSON.EJSON.stringify(index.partialFilterExpression, { relaxed: true }),
          }),
      ...(size === undefined ? {} : { sizeBytes: size }),
    };
  });
}

/** A numeric field of an unknown object, or 0. */
function numberField(value: unknown, name: string): number {
  const field: unknown = Reflect.get(Object(value), name);
  return typeof field === "number" ? field : 0;
}
