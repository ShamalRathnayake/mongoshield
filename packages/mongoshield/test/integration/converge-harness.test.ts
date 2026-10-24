// The randomized harness of docs/specs/CONSISTENCY.md: concurrent writers make every
// kind of change (inserts, $set/$unset/$inc/$rename, array pushes and truncations,
// pipeline updates, replacements, deletes, $out) across several collections while a
// deliberately slow converge backup runs. The backup is restored into another
// database and every collection is compared, byte for byte, with the source as it
// was at the end of the window (T1, read with a snapshot read at that cluster time).
//
// Each iteration uses its own seed, so a failure can be replayed:
//   CONVERGE_HARNESS_SEED=<seed> CONVERGE_HARNESS_ITERATIONS=1 vitest run converge-harness
// The writers run concurrently, so a seed fixes the operations but not their exact
// interleaving with the backup.

import { setTimeout as sleep } from "node:timers/promises";
import type { Db, Document } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import { firstDifference, rawDocuments, slowStorage } from "./converge-test-utils.ts";

const ITERATIONS = Number(process.env.CONVERGE_HARNESS_ITERATIONS ?? 10);
const FIRST_SEED = Number(process.env.CONVERGE_HARNESS_SEED ?? 20_261_021);

/** Collections the writers change; `summary` is rebuilt by `$out` from `c0`. */
const COLLECTIONS = ["c0", "c1", "c2", "c3"];
const ALL_COLLECTIONS = [...COLLECTIONS, "summary"];
const INITIAL_DOCUMENTS = 200;
const WRITERS = 3;
/** Delay before each data file is stored: makes the backup window long. */
const STORE_DELAY_MS = 250;

/** Test documents: any fields, with numeric or string `_id`s. */
interface TestDocument {
  _id?: number | string;
  n?: number;
  arr?: number[];
  tags?: string[];
  [field: string]: unknown;
}

const client = useMongoClient();
const databases: string[] = [];
const results: IterationResult[] = [];

interface IterationResult {
  readonly seed: number;
  readonly passed: boolean;
  readonly events: number;
  readonly writes: number;
  readonly backupMs: number;
  readonly restoreMs: number;
}

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
  const passed = results.filter((result) => result.passed).length;
  const lines = results.map(
    (result) =>
      `  seed ${result.seed}: ${result.passed ? "pass" : "FAIL"}, ${result.writes} writes, ${result.events} events, backup ${result.backupMs} ms, restore ${result.restoreMs} ms`,
  );
  // CONVERGE_HARNESS_REPORT=1 prints the pass rate and timings of every iteration.
  if (process.env.CONVERGE_HARNESS_REPORT === "1") {
    process.stdout.write(
      `converge harness: ${passed}/${results.length} passed\n${lines.join("\n")}\n`,
    );
  }
});

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
class Dice {
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

/** Ids writers pick from: the initial ones plus a few that writers insert. */
function someId(dice: Dice): number {
  return dice.integer(INITIAL_DOCUMENTS + 40);
}

/** One random write. Writes that the source itself rejects are part of the game. */
async function randomWrite(db: Db, dice: Dice, nextId: () => number): Promise<void> {
  const collection = db.collection<TestDocument>(dice.pick(COLLECTIONS));
  const id = someId(dice);
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
    default:
      // Rebuild `summary` with $out: a scratch collection renamed over it.
      await db
        .collection<TestDocument>("c0")
        .aggregate([
          { $match: { n: { $lt: dice.integer(500) } } },
          { $project: { n: 1 } },
          { $out: "summary" },
        ])
        .toArray();
  }
}

/** Starts writers that run until `stop()`, and returns how many writes they made. */
function startWriters(db: Db, seed: number): { stop: () => Promise<number> } {
  let running = true;
  let writes = 0;
  const loops = Array.from({ length: WRITERS }, async (_, writer) => {
    const dice = new Dice(seed * 31 + writer);
    let counter = 0;
    const nextId = () => 1_000_000 * (writer + 1) + counter++;
    while (running) {
      try {
        await randomWrite(db, dice, nextId);
      } catch {
        // e.g. $push to a field that is no longer an array: the source refuses it too.
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

/** Runs one backup → restore → compare cycle. */
async function runIteration(seed: number): Promise<IterationResult> {
  const source = uniqueDb("cvh_src");
  const target = uniqueDb("cvh_dst");
  databases.push(source, target);
  const db = client().db(source);
  const dice = new Dice(seed);
  for (const name of ALL_COLLECTIONS) {
    await db
      .collection<TestDocument>(name)
      .insertMany(Array.from({ length: INITIAL_DOCUMENTS }, (_, id) => dice.document(id)));
  }

  const writers = startWriters(db, seed);
  // Let the writers get going before the window opens.
  await sleep(50);
  const storage = slowStorage(memoryStorage(), STORE_DELAY_MS);
  const backupStarted = performance.now();
  let writes = 0;
  let manifest: Manifest;
  try {
    ({ manifest } = await runBackup(backupContext(client(), storage), {
      include: [`${source}.*`],
      consistency: "converge",
      parallelism: 2,
    }));
  } finally {
    // The writers keep going for a moment after T1: those changes must NOT be restored.
    writes = await writers.stop();
  }
  const backupMs = Math.round(performance.now() - backupStarted);
  const to = manifest.consistency.to;
  if (to === undefined) throw new Error("converge backup without consistency.to");

  const restoreStarted = performance.now();
  await runRestore(
    { client: client(), storage, logger: silentLogger },
    { backup: manifest.id, rename: { [`${source}.*`]: `${target}.*` } },
  );
  const restoreMs = Math.round(performance.now() - restoreStarted);

  const differences: string[] = [];
  for (const name of ALL_COLLECTIONS) {
    const expected = await rawDocuments(client(), source, name, to);
    const actual = await rawDocuments(client(), target, name);
    const difference = firstDifference(expected, actual);
    if (difference !== undefined) differences.push(`${name}: ${difference}`);
  }
  const result: IterationResult = {
    seed,
    passed: differences.length === 0,
    events: manifest.changes?.events ?? 0,
    writes,
    backupMs,
    restoreMs,
  };
  results.push(result);
  expect(differences, `seed ${seed}`).toEqual([]);
  // Usually ~1,000 events; far fewer when the machine is busy (e.g. the full suite).
  expect(result.events).toBeGreaterThan(0);
  return result;
}

describe("converge harness", () => {
  const seeds = Array.from({ length: ITERATIONS }, (_, index) => FIRST_SEED + index);
  it.each(seeds)(
    "restores the source exactly as of T1 under concurrent writes (seed %i)",
    async (seed) => {
      await runIteration(seed);
    },
    120_000,
  );
});
