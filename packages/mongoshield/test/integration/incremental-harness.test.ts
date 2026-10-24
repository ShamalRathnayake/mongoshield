// Randomized harness for incremental chains: three writers make every kind of change
// (the workload of the converge harness, $out rebuilds included) while a converge full
// backup and then several incrementals are taken, without pausing the writers. Each
// restored member must equal, byte for byte, the source read at that member's end
// (a snapshot read `atClusterTime: consistency.to`).
//
// INCREMENTAL_HARNESS_ITERATIONS and INCREMENTAL_HARNESS_SEED change the runs.

import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { BackupOptions } from "../../src/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { seedWorkload, startWriters, type WorkloadShape } from "../helpers/random-writes.ts";
import { backupContext } from "./backup-test-utils.ts";
import { collectionNames, firstDifference, rawDocuments } from "./converge-test-utils.ts";

const ITERATIONS = Number(process.env.INCREMENTAL_HARNESS_ITERATIONS ?? 3);
const FIRST_SEED = Number(process.env.INCREMENTAL_HARNESS_SEED ?? 20_261_024);
/** Incrementals per chain. */
const INCREMENTALS = 3;
const WORKLOAD: WorkloadShape = {
  collections: ["c0", "c1", "c2"],
  outCollection: "summary",
  initialDocuments: 150,
};

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

async function committed(
  storage: ReturnType<typeof memoryStorage>,
  options: BackupOptions,
): Promise<Manifest> {
  const result = await runBackup(backupContext(client(), storage), { parallelism: 2, ...options });
  if (result.status !== "complete") throw new Error("expected a complete backup");
  return result.manifest;
}

/** Restores `member` and lists every collection that differs from the source at its end. */
async function differencesAfterRestore(
  storage: ReturnType<typeof memoryStorage>,
  member: Manifest,
  source: string,
): Promise<string[]> {
  const target = uniqueDb("ich_dst");
  databases.push(target);
  await runRestore(
    { client: client(), storage, logger: silentLogger },
    { backup: member.id, rename: { [`${source}.*`]: `${target}.*` } },
  );
  const to = member.consistency.to;
  if (to === undefined) throw new Error("a chain member without an end");
  const differences: string[] = [];
  const names = new Set([
    ...(await collectionNames(client(), target)),
    ...WORKLOAD.collections,
    "summary",
  ]);
  for (const name of names) {
    const expected = await rawDocuments(client(), source, name, to);
    const actual = await rawDocuments(client(), target, name);
    const difference = firstDifference(expected, actual);
    if (difference !== undefined) differences.push(`${member.id} ${name}: ${difference}`);
  }
  return differences;
}

describe("incremental harness", () => {
  const seeds = Array.from({ length: ITERATIONS }, (_, index) => FIRST_SEED + index);
  it.each(seeds)(
    "restores every member of a chain taken under concurrent writes (seed %i)",
    async (seed) => {
      const source = uniqueDb("ich_src");
      databases.push(source);
      const db = client().db(source);
      await seedWorkload(db, WORKLOAD, seed);
      const storage = memoryStorage();
      const include = [`${source}.*`];

      const writers = startWriters(db, WORKLOAD, seed, 3);
      const chain: Manifest[] = [];
      try {
        await sleep(50);
        chain.push(await committed(storage, { include, consistency: "converge" }));
        for (let index = 0; index < INCREMENTALS; index += 1) {
          await sleep(150);
          chain.push(await committed(storage, { include, incremental: true }));
        }
      } finally {
        await writers.stop();
      }

      // Every incremental continues the previous member, back to back.
      for (let index = 1; index < chain.length; index += 1) {
        expect(chain[index]?.chain?.parent).toBe(chain[index - 1]?.id);
        expect(chain[index]?.consistency.from).toEqual(chain[index - 1]?.consistency.to);
      }
      const events = chain.slice(1).reduce((sum, member) => sum + (member.changes?.events ?? 0), 0);
      expect(events).toBeGreaterThan(0);

      // The newest member and one in the middle.
      const newest = chain.at(-1);
      const middle = chain[2];
      if (newest === undefined || middle === undefined) throw new Error("chain");
      expect(await differencesAfterRestore(storage, newest, source)).toEqual([]);
      expect(await differencesAfterRestore(storage, middle, source)).toEqual([]);
    },
    180_000,
  );
});
