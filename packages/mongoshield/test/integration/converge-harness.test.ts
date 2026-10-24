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
import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { seedWorkload, startWriters, type WorkloadShape } from "../helpers/random-writes.ts";
import { backupContext } from "./backup-test-utils.ts";
import { firstDifference, rawDocuments, slowStorage } from "./converge-test-utils.ts";

const ITERATIONS = Number(process.env.CONVERGE_HARNESS_ITERATIONS ?? 10);
const FIRST_SEED = Number(process.env.CONVERGE_HARNESS_SEED ?? 20_261_021);

/** Collections the writers change; `summary` is rebuilt by `$out` from `c0`. */
const COLLECTIONS = ["c0", "c1", "c2", "c3"];
const ALL_COLLECTIONS = [...COLLECTIONS, "summary"];
const INITIAL_DOCUMENTS = 200;
/** The writers' workload (shared with the topology suites, see helpers/random-writes.ts). */
const WORKLOAD: WorkloadShape = {
  collections: COLLECTIONS,
  outCollection: "summary",
  initialDocuments: INITIAL_DOCUMENTS,
};
const WRITERS = 3;
/** Delay before each data file is stored: makes the backup window long. */
const STORE_DELAY_MS = 250;

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

/** Runs one backup → restore → compare cycle. */
async function runIteration(seed: number): Promise<IterationResult> {
  const source = uniqueDb("cvh_src");
  const target = uniqueDb("cvh_dst");
  databases.push(source, target);
  const db = client().db(source);
  await seedWorkload(db, WORKLOAD, seed);

  const writers = startWriters(db, WORKLOAD, seed, WRITERS);
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
