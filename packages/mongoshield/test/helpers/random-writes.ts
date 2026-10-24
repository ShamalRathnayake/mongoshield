// Seeded random writers for consistency tests: concurrent loops that make every kind
// of change MongoDB has (inserts, $set/$unset/$inc/$rename, array pushes and
// truncations, pipeline updates, replacements, deletes, multi-document updates, $out)
// across a handful of collections while a backup runs.
//
// Shared by the randomized converge harness (test/integration/converge-harness.test.ts)
// and the topology suites (test/topology), so every deployment shape is exercised by
// the same workload. A seed fixes the operations, not their interleaving with the
// backup: the writers run concurrently.

import { setTimeout as sleep } from "node:timers/promises";
import type { Db, Document } from "mongodb";

/** Test documents: any fields, with numeric or string `_id`s. */
export interface TestDocument {
  _id?: number | string;
  n?: number;
  arr?: number[];
  tags?: string[];
  [field: string]: unknown;
}

/** What the writers touch. */
export interface WorkloadShape {
  /** Collections the writers change. */
  readonly collections: readonly string[];
  /** Collection that `$out` rebuilds from the first of `collections`; omit to never `$out`. */
  readonly outCollection?: string;
  /** How many documents each collection starts with (ids `0 … initialDocuments-1`). */
  readonly initialDocuments: number;
}

/** mulberry32: a tiny, good-enough seeded PRNG. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Random helpers over one PRNG. */
export class Dice {
  readonly #random: () => number;
  constructor(seed: number) {
    this.#random = createRandom(seed);
  }
  integer(maxExclusive: number): number {
    return Math.floor(this.#random() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.integer(items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }
  /** A document with nested objects, arrays and optional fields. */
  document(id: number): Document {
    const document: Document = {
      _id: id,
      n: this.integer(1000),
      name: `doc ${this.integer(1_000_000)}`,
      nested: { x: this.integer(100), y: [this.integer(9), this.integer(9)] },
      arr: Array.from({ length: this.integer(6) }, () => this.integer(100)),
    };
    if (this.integer(2) === 0) document.o = { "0": { k: 1 }, "1": "one" };
    if (this.integer(3) === 0) document.extra = this.integer(2) === 0 ? 1.5 : "text";
    return document;
  }
}

/** An update document, typed loosely (the driver's types reject dotted paths here). */
function update(document: Document): Document {
  return document;
}

/** Fills every collection of the workload (and the `$out` target) with initial documents. */
export async function seedWorkload(db: Db, shape: WorkloadShape, seed: number): Promise<void> {
  const dice = new Dice(seed);
  const names = [...shape.collections];
  if (shape.outCollection !== undefined) names.push(shape.outCollection);
  for (const name of names) {
    await db
      .collection<TestDocument>(name)
      .insertMany(Array.from({ length: shape.initialDocuments }, (_, id) => dice.document(id)));
  }
}

/** One random write. Writes that the source itself rejects are part of the game. */
export async function randomWrite(
  db: Db,
  dice: Dice,
  shape: WorkloadShape,
  nextId: () => number,
): Promise<void> {
  const collection = db.collection<TestDocument>(dice.pick(shape.collections));
  // Ids writers pick from: the initial ones plus a few that writers insert.
  const id = dice.integer(shape.initialDocuments + 40);
  const filter: Document = { _id: id };
  const kind = dice.integer(14);
  switch (kind) {
    case 0:
    case 1:
      await collection.insertOne(dice.document(nextId()));
      return;
    case 2:
      await collection.updateOne(filter, {
        $set: { "nested.x": dice.integer(100), [`f${dice.integer(4)}`]: dice.integer(9) },
      });
      return;
    case 3:
      await collection.updateOne(filter, {
        $unset: { [dice.pick(["name", "nested.x", "extra", "f1", "o.0"])]: "" },
      });
      return;
    case 4:
      await collection.updateOne(filter, update({ $push: { arr: dice.integer(100) } }));
      return;
    case 5:
      // A pipeline update that truncates an array (change events: truncatedArrays).
      await collection.updateOne(filter, [
        { $set: { arr: { $slice: ["$arr", dice.integer(3)] } } },
      ]);
      return;
    case 6:
      await collection.updateOne(filter, {
        $set: { [`arr.${dice.integer(4)}`]: dice.integer(100) },
      });
      return;
    case 7:
      await collection.replaceOne(filter, dice.document(id), {
        upsert: dice.integer(2) === 0,
      });
      return;
    case 8:
      await collection.deleteOne(filter);
      return;
    case 9:
      await collection.updateOne(filter, update({ $inc: { n: 1, "nested.x": -1 } }));
      return;
    case 10:
      await collection.updateOne(filter, { $rename: { name: "label" } });
      return;
    case 11:
      // Numeric field names in an object: ambiguous paths (disambiguatedPaths).
      await collection.updateOne(filter, { $set: { [`o.${dice.integer(3)}.k`]: dice.integer(9) } });
      return;
    case 12:
      await collection.updateMany(
        { n: { $lt: dice.integer(50) } },
        { $set: { bulk: dice.integer(9) } },
      );
      return;
    default: {
      const first = shape.collections[0];
      if (shape.outCollection === undefined || first === undefined) {
        await collection.insertOne(dice.document(nextId()));
        return;
      }
      // Rebuild the `$out` collection: a scratch collection renamed over it.
      await db
        .collection<TestDocument>(first)
        .aggregate([
          { $match: { n: { $lt: dice.integer(500) } } },
          { $project: { n: 1 } },
          { $out: shape.outCollection },
        ])
        .toArray();
    }
  }
}

/** Running writers; `stop()` waits for them and returns how many writes they made. */
export interface Writers {
  stop(): Promise<number>;
}

/** Starts `count` writers that run until `stop()`. */
export function startWriters(db: Db, shape: WorkloadShape, seed: number, count: number): Writers {
  let running = true;
  let writes = 0;
  const loops = Array.from({ length: count }, async (_, writer) => {
    const dice = new Dice(seed * 31 + writer);
    let counter = 0;
    const nextId = () => 1_000_000 * (writer + 1) + counter++;
    while (running) {
      try {
        await randomWrite(db, dice, shape, nextId);
      } catch {
        // e.g. $push to a field that is no longer an array: the source refuses it too.
        // On multi-node topologies this also absorbs writes refused during an election.
      }
      writes += 1;
      // Yield now and then so the backup's own commands are not starved.
      if (writes % 20 === 0) await sleep(1);
    }
  });
  return {
    stop: async () => {
      running = false;
      await Promise.all(loops);
      return writes;
    },
  };
}
