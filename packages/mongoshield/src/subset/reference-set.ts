/**
 * The sets of referenced values that subsetting follows, kept in temporary
 * collections in the TARGET deployment.
 *
 * Why on the server and not in memory: a subset of a large database can reference
 * millions of users or products. Holding those ids in a JavaScript `Set` would make
 * memory grow with the data, which MongoShield never allows. A collection keyed by
 * the value deduplicates for free (`_id` is unique), costs the client nothing, and
 * is read back in `$in` batches of `batchSize` values, so the client only ever holds
 * one batch. The alternative, re-reading the source with `$group` per round, would put
 * extra aggregation load on the (often production) source; the target is ours to use.
 *
 * Each set is one collection named `__mongoshield_subset_<run>_<n>` in the target
 * database of the namespace it selects from (where the user can already write), with
 * documents `{ _id: <value>, round: <n> }`. Values found while following round n are
 * stored with round n + 1, so following is breadth-first and terminates: a value
 * already in the set (pending or done) is never added again, which also makes
 * reference cycles (users.managerId → users._id) safe.
 *
 * The values are SOURCE values (read before masking), because they are used to query
 * the source. They live in the target only while the copy runs: `dropAll()` removes
 * them on success, failure and abort alike.
 *
 * Values keep their stored field order (src/format/field-order.ts): an embedded
 * document referenced by value (`{ b: 1, "1": 2 }`) is written to the set, read back
 * and used in `$in` in that order. In JavaScript order it would be another value,
 * matching nothing in the source.
 */

import {
  type Db,
  type Document,
  MongoBulkWriteError,
  type MongoClient,
  type WriteConcernSettings,
  type WriteError,
} from "mongodb";
import { commandWriteConcern } from "../engine/restore-collections.ts";
import { throwIfAborted } from "../errors.ts";
import { deserializeInStoredOrder, valueInStoredOrder } from "../format/field-order.ts";
import type { Logger } from "../logger.ts";
import { collectPathValues } from "../mask/paths.ts";
import { bsonTag } from "../mask/values.ts";
import type { CompiledFollow } from "./config.ts";

/** Duplicate key: the value is already in the set. */
const DUPLICATE_KEY_CODE = 11000;

/** Prefix of temporary collection names, so leftovers are easy to recognise. */
export const TEMP_COLLECTION_PREFIX = "__mongoshield_subset_";

/** One set: the referenced values of one `to` side (`ns` + `path`). */
export interface ReferenceSet {
  /** Source namespace whose documents the values select. */
  readonly ns: string;
  /** Field the values are matched against (`_id`, `email`, …). */
  readonly path: string;
  /** Temporary collection holding the values, in the target. */
  readonly database: string;
  readonly collection: string;
}

/** Options for `ReferenceSets`. */
export interface ReferenceSetsOptions {
  /** The target deployment. */
  readonly client: MongoClient;
  readonly follows: readonly CompiledFollow[];
  /** Target database of a source namespace (after rename): where its set is kept. */
  readonly databaseFor: (sourceNs: string) => string;
  /** Unique per copy run, so concurrent copies never share a set. */
  readonly runId: string;
  readonly writeConcern?: WriteConcernSettings | undefined;
  readonly logger: Logger;
}

/** Every reference set of one copy run. */
export class ReferenceSets {
  readonly #client: MongoClient;
  readonly #follows: readonly CompiledFollow[];
  readonly #sets = new Map<string, ReferenceSet>();
  readonly #writeConcern: WriteConcernSettings | undefined;
  readonly #logger: Logger;
  /** The round newly found values are stored with. */
  #round = 0;

  constructor(options: ReferenceSetsOptions) {
    this.#client = options.client;
    this.#follows = options.follows;
    this.#writeConcern = options.writeConcern;
    this.#logger = options.logger;
    for (const follow of options.follows) {
      if (this.#sets.has(follow.setKey)) continue;
      this.#sets.set(follow.setKey, {
        ns: follow.to.ns,
        path: follow.to.path,
        database: options.databaseFor(follow.to.ns),
        collection: `${TEMP_COLLECTION_PREFIX}${options.runId}_${this.#sets.size}`,
      });
    }
  }

  /** Every set, e.g. for privilege checks and plans. */
  get sets(): readonly ReferenceSet[] {
    return [...this.#sets.values()];
  }

  /** Creates the temporary collections with their `round` index. */
  async create(): Promise<void> {
    for (const set of this.#sets.values()) {
      await this.#db(set).command({
        createIndexes: set.collection,
        indexes: [{ key: { round: 1 }, name: "round_1" }],
        ...commandWriteConcern(this.#writeConcern),
      });
    }
  }

  /**
   * Notes the references held by source documents of `sourceNs`. Call with the
   * documents BEFORE masking: the values are needed to query the source.
   */
  async collect(sourceNs: string, documents: readonly Document[]): Promise<void> {
    for (const follow of this.#follows) {
      if (follow.from.ns !== sourceNs) continue;
      const values: unknown[] = [];
      for (const document of documents) {
        for (const value of collectPathValues(document, follow.from.segments)) {
          if (canBeId(value)) values.push(value);
        }
      }
      const set = this.#sets.get(follow.setKey);
      if (set !== undefined && values.length > 0) await this.#add(set, values);
    }
  }

  /** The sets that select documents of `ns`. */
  setsFor(ns: string): ReferenceSet[] {
    return this.sets.filter((set) => set.ns === ns);
  }

  /**
   * Starts following `round`: values found from now on belong to the next round.
   * Returns whether any set has values in `round`.
   */
  async startRound(round: number): Promise<boolean> {
    this.#round = round + 1;
    for (const set of this.#sets.values()) {
      const found = await this.#db(set).collection(set.collection).findOne({ round });
      if (found !== null) return true;
    }
    return false;
  }

  /**
   * The values of `set` in `round`, in batches of `batchSize`: exact BSON types, and
   * documents with their stored field order recorded (pass them through
   * `valueInStoredOrder` when querying with them).
   */
  async *values(
    set: ReferenceSet,
    round: number,
    batchSize: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<unknown[]> {
    // Raw, then parsed losslessly in stored order (see the file header).
    const cursor = this.#db(set)
      .collection(set.collection)
      .find({ round }, { projection: { _id: 1 }, batchSize, raw: true });
    try {
      let batch: unknown[] = [];
      for await (const raw of cursor) {
        if (!(raw instanceof Uint8Array)) continue;
        batch.push(deserializeInStoredOrder(raw)._id);
        if (batch.length >= batchSize) {
          throwIfAborted(signal);
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
    } finally {
      await cursor.close();
    }
  }

  /** Drops every temporary collection. Never throws: failures are logged. */
  async dropAll(): Promise<void> {
    for (const set of this.#sets.values()) {
      try {
        await this.#db(set).collection(set.collection).drop();
      } catch (error) {
        this.#logger.warn("Could not drop a temporary subset collection; drop it by hand", {
          ns: `${set.database}.${set.collection}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Inserts values with the current round; values already in the set are skipped. */
  async #add(set: ReferenceSet, values: readonly unknown[]): Promise<void> {
    // Each value in stored order, so the set holds the stored value (see the header).
    const documents: Document[] = values.map((value) => ({
      _id: valueInStoredOrder(value),
      round: this.#round,
    }));
    try {
      await this.#db(set)
        .collection(set.collection)
        .insertMany(documents, {
          ordered: false,
          forceServerObjectId: true,
          ...(this.#writeConcern ? { writeConcern: this.#writeConcern } : {}),
        });
    } catch (error) {
      if (!(error instanceof MongoBulkWriteError && onlyDuplicates(error.writeErrors))) throw error;
    }
  }

  #db(set: ReferenceSet): Db {
    return this.#client.db(set.database);
  }
}

/**
 * Values that can be an `_id` and can match something: not null/undefined (no
 * reference), not a regex (forbidden as `_id`, and `$in` would treat it as a pattern).
 */
function canBeId(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return bsonTag(value) !== "BSONRegExp" && !(value instanceof RegExp);
}

function onlyDuplicates(errors: WriteError | readonly WriteError[]): boolean {
  const list: readonly WriteError[] = Array.isArray(errors) ? errors : [errors];
  return list.every((item) => item.code === DUPLICATE_KEY_CODE);
}
