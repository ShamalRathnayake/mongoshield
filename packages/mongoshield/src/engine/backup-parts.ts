/**
 * Splitting large collections into parts: contiguous `_id` ranges, each dumped into
 * its own file, in parallel, and resumable one at a time.
 *
 *   $collStats ─▶ size > partSizeBytes? ─▶ $sample ~20 _ids per wanted part, sorted
 *              ─▶ boundaries at even intervals ─▶ [MinKey, b1) [b1, b2) … [bn, MaxKey]
 *
 * Why `min()`/`max()` index bounds instead of `{ _id: { $gte, $lt } }`: query
 * comparisons are type-bracketed, so `{ $gte: ObjectId(…), $lt: "abc" }` matches
 * NOTHING in a collection whose `_id`s mix ObjectIds and strings, and those
 * documents would silently be missing from the backup. Index bounds compare in
 * plain BSON order, exactly like `$sort`, so every document falls into exactly one
 * part whatever the types. They require a hint, which also makes the plan stable.
 *
 * Why boundaries are kept in their exact BSON types (`promoteValues: false`): a
 * Long `_id` above 2^53 or an Int32 that became a double would move a boundary,
 * and a resumed run must cut the collection exactly where the first run did.
 *
 * Why in their exact field ORDER too (src/format/field-order.ts): an embedded-document
 * `_id` with integer-like field names (`{ b: 1, "1": 2 }`) is a different value once
 * JavaScript lists "1" first, and reordering does not keep the sort order: sampled
 * boundaries could come out of order, so parts would overlap (documents dumped twice)
 * and a resumed run would cut elsewhere. So `_id`s are sampled as raw BSON and parsed
 * in stored order, sent to the server in that order (`valueInStoredOrder`), and
 * written to checkpoints and the manifest as order-keeping Extended JSON
 * (`toCanonical`, src/format/ordered-json.ts).
 *
 * Collections without a plain `{ _id: 1 }` index (time series, capped collections
 * created without one, clustered collections) are never split.
 * See docs/specs/PARTS-AND-RESUME.md.
 */

import type { MongoClient, ReadPreference } from "mongodb";
import { deserializeInStoredOrder } from "../format/field-order.ts";
import type { PartRange } from "../format/manifest.ts";
import {
  fromExtendedJson,
  stringifyJsonInStoredOrder,
  toExtendedJson,
} from "../format/ordered-json.ts";
import type { Logger } from "../logger.ts";
import type { CollectionSpec } from "../mongo/index.ts";

/** Collections above this many raw bytes are split, unless `partSizeBytes` says otherwise. */
export const DEFAULT_PART_SIZE_BYTES = 256 * 1024 * 1024;

/** Sampled `_id`s per wanted part: enough for parts of roughly even size. */
export const SAMPLES_PER_PART = 20;

/** At most this many `_id`s are sampled per collection, however large it is. */
export const MAX_SAMPLES = 100_000;

/** The index every split part is read through. */
export const ID_INDEX = { _id: 1 } as const;

/** What the planner learns about a collection from `$collStats`. */
export interface CollectionStats {
  /** Uncompressed size of all documents (BSON bytes), summed over shards. */
  readonly sizeBytes: number;
  /** `sizeBytes / count`, or `undefined` for an empty collection. */
  readonly averageDocumentBytes: number | undefined;
}

/**
 * One bound of a part. `undefined` means "open" (the first part's lower bound and
 * the last part's upper bound); otherwise `value` is an `_id` in its exact BSON type.
 */
export type PartBound = { readonly value: unknown } | undefined;

/** The `_id` range of one part. Both ends `undefined` for a collection that is not split. */
export interface PartBounds {
  /** Inclusive. */
  readonly lower: PartBound;
  /** Exclusive. */
  readonly upper: PartBound;
}

/**
 * True when the collection can be split: a regular collection with a plain
 * `{ _id: 1 }` index. Clustered collections are left alone: their `_id` index is the
 * collection itself, and `min()`/`max()` hints on it are not something to rely on.
 */
export function canSplit(spec: CollectionSpec): boolean {
  if (spec.type !== "collection") return false;
  if (spec.options.clusteredIndex !== undefined) return false;
  return spec.indexes.some((index) => isIdIndexKey(index.key));
}

function isIdIndexKey(key: unknown): boolean {
  if (typeof key !== "object" || key === null) return false;
  const fields = Object.entries(key);
  if (fields.length !== 1) return false;
  const [field, direction] = fields[0] ?? [];
  return field === "_id" && Number(direction) === 1;
}

/** How many parts a collection of `sizeBytes` needs (at least 1). */
export function wantedPartCount(sizeBytes: number, partSizeBytes: number): number {
  if (!(sizeBytes > partSizeBytes)) return 1;
  return Math.ceil(sizeBytes / partSizeBytes);
}

/**
 * Picks `parts - 1` boundaries from `sortedIds` (sampled `_id`s in ascending BSON
 * order) at even intervals. Repeated values are dropped, so there may be fewer
 * boundaries than asked for (a part per distinct boundary, never an empty
 * duplicate range). Pure, for unit tests.
 */
export function chooseBoundaries(sortedIds: readonly unknown[], parts: number): unknown[] {
  if (parts <= 1 || sortedIds.length === 0) return [];
  const boundaries: unknown[] = [];
  let previousKey: string | undefined;
  for (let part = 1; part < parts; part++) {
    const index = Math.floor((part * sortedIds.length) / parts);
    const value = sortedIds[index];
    if (value === undefined) continue;
    const key = canonicalKey(value);
    if (key === previousKey) continue;
    boundaries.push(value);
    previousKey = key;
  }
  return boundaries;
}

/**
 * The ranges defined by `boundaries`: `[open, b1) [b1, b2) … [bn, open]`.
 * No boundaries means one unsplit part.
 */
export function boundsFromBoundaries(boundaries: readonly unknown[]): PartBounds[] {
  const bounds: PartBounds[] = [];
  let lower: PartBound;
  for (const boundary of boundaries) {
    bounds.push({ lower, upper: { value: boundary } });
    lower = { value: boundary };
  }
  bounds.push({ lower, upper: undefined });
  return bounds;
}

/**
 * The manifest's `range` for a part: canonical Extended JSON, with `$minKey` /
 * `$maxKey` for the open ends.
 */
export function toPartRange(bounds: PartBounds): PartRange {
  return {
    from: bounds.lower === undefined ? { $minKey: 1 } : toCanonical(bounds.lower.value),
    to: bounds.upper === undefined ? { $maxKey: 1 } : toCanonical(bounds.upper.value),
  };
}

/**
 * A BSON value as canonical Extended JSON (exact types survive a round trip). The
 * stored field order of documents is recorded on the result, so files written with
 * `stringifyJsonInStoredOrder` keep it (see the file header).
 */
export function toCanonical(value: unknown): unknown {
  return toExtendedJson(value, { relaxed: false });
}

/**
 * The inverse of `toCanonical`, also for values read with `parseJsonInStoredOrder`
 * (their recorded order is kept).
 */
export function fromCanonical(value: unknown): unknown {
  return fromExtendedJson(value, { relaxed: false });
}

/** A string that is equal for equal BSON values (used to drop repeated boundaries). */
function canonicalKey(value: unknown): string {
  return stringifyJsonInStoredOrder(toCanonical(value));
}

/** Where and how planning reads. */
export interface PlanReadOptions {
  readonly client: MongoClient;
  readonly readPreference: ReadPreference;
  readonly logger: Logger;
  readonly signal: AbortSignal | undefined;
}

/**
 * Reads the collection's size from `$collStats` (summed over shards). Returns
 * `undefined` when the statistics cannot be read (missing privilege, a collection
 * dropped meanwhile): the collection is then simply not split.
 */
export async function readCollectionStats(
  spec: CollectionSpec,
  options: PlanReadOptions,
): Promise<CollectionStats | undefined> {
  try {
    const cursor = options.client
      .db(spec.db)
      .collection(spec.name)
      .aggregate([{ $collStats: { storageStats: {} } }], {
        readPreference: options.readPreference,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    let sizeBytes = 0;
    let count = 0;
    // One document per shard (one in total on a replica set).
    for await (const shard of cursor) {
      const storageStats: unknown = shard.storageStats;
      sizeBytes += numberField(storageStats, "size");
      count += numberField(storageStats, "count");
    }
    return { sizeBytes, averageDocumentBytes: count > 0 ? sizeBytes / count : undefined };
  } catch (error) {
    options.logger.debug("Could not read collection statistics; not splitting it", {
      ns: spec.ns,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Samples up to `count` `_id`s and returns them in ascending BSON order (the server
 * sorts, so mixed types are ordered exactly as the `_id` index orders them).
 * `$sample` reads random documents through a random cursor when the sample is
 * small compared to the collection, which is cheap.
 */
export async function sampleSortedIds(
  spec: CollectionSpec,
  count: number,
  options: PlanReadOptions,
): Promise<unknown[]> {
  const cursor = options.client
    .db(spec.db)
    .collection(spec.name)
    .aggregate([{ $sample: { size: count } }, { $project: { _id: 1 } }, { $sort: { _id: 1 } }], {
      readPreference: options.readPreference,
      allowDiskUse: true,
      // Raw, then parsed losslessly in stored order: exact types and field order.
      raw: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  const ids: unknown[] = [];
  // Bounded by `count` (at most MAX_SAMPLES small documents), so collecting is fine.
  for await (const raw of cursor) {
    if (raw instanceof Uint8Array) ids.push(deserializeInStoredOrder(raw)._id);
  }
  return ids;
}

/**
 * Plans the parts of one collection: the boundaries to cut at (empty when the
 * collection is not split) and its average document size (for batch sizes).
 */
export async function planCollectionParts(
  spec: CollectionSpec,
  partSizeBytes: number,
  options: PlanReadOptions,
): Promise<{ readonly boundaries: unknown[]; readonly averageDocumentBytes: number | undefined }> {
  // Views have no data; time series statistics describe buckets, not measurements.
  if (spec.type !== "collection") return { boundaries: [], averageDocumentBytes: undefined };
  const stats = await readCollectionStats(spec, options);
  const averageDocumentBytes = stats?.averageDocumentBytes;
  if (stats === undefined || !canSplit(spec)) return { boundaries: [], averageDocumentBytes };

  const parts = wantedPartCount(stats.sizeBytes, partSizeBytes);
  if (parts <= 1) return { boundaries: [], averageDocumentBytes };
  const samples = Math.min(MAX_SAMPLES, parts * SAMPLES_PER_PART);
  const sortedIds = await sampleSortedIds(spec, samples, options);
  const boundaries = chooseBoundaries(sortedIds, parts);
  options.logger.debug("Splitting collection into parts", {
    ns: spec.ns,
    sizeBytes: stats.sizeBytes,
    parts: boundaries.length + 1,
  });
  return { boundaries, averageDocumentBytes };
}

/** Reads a numeric field from an unknown object, or 0. */
function numberField(value: unknown, field: string): number {
  if (typeof value !== "object" || value === null) return 0;
  const raw: unknown = Reflect.get(value, field);
  const number = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(number) ? number : 0;
}
