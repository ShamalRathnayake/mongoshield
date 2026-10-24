// Diff (src/extras/diff.ts) of converge backups: each side is compared in its state at
// the END of its backup window (T1), with the changes recorded during the backup
// overlaid on the dumped documents. The reference is a plain backup taken right after
// each converge backup, while nothing changes: it holds exactly the T1 state, so a
// diff of the two plain backups is what the diff of the converge backups must say.

import { type Document, Int32 } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../../src/engine/backup.ts";
import { type DiffResult, diffBackups, type NamespaceDiff } from "../../../src/extras/diff.ts";
import { silentLogger } from "../../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../../src/storage/memory.ts";
import { uniqueDb, useMongoClient } from "../../helpers/mongo.ts";
import { backupContext } from "../backup-test-utils.ts";
import { hookedStorage, isDataFileOf } from "../converge-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("diff_cv");
let storage: MemoryStorage;

/** Backup ids: converge (window with writes) and plain (the same T1 state). */
const ids = { convergeA: "", plainA: "", convergeB: "", plainB: "" };

interface TestDocument {
  _id: number | string;
  [field: string]: unknown;
}

function collection(name: string) {
  return client().db(database).collection<TestDocument>(name);
}

/** `count` documents with `_id` 0…count-1. */
async function seed(name: string, count: number): Promise<void> {
  await collection(name).insertMany(
    Array.from({ length: count }, (_, n) => ({ _id: n, n, tags: ["x", "y", "z"] })),
  );
}

/**
 * Writes to `a` (already dumped, so only the window has them) and `c` (not dumped
 * yet, so its dump has them too), made while `b` is being dumped. `round` makes the
 * writes of the two backups differ.
 */
async function writeDuringWindow(round: number): Promise<void> {
  for (const name of ["a", "c"]) {
    const target = collection(name);
    await target.insertOne({ _id: `new-${round}`, round });
    await target.deleteMany({ _id: { $in: [round, round + 10] } });
    await target.updateMany({ n: { $gte: 20, $lt: 25 } }, { $set: { [`r${round}`]: true } });
    await target.updateOne({ _id: 30 + round }, { $push: { tags: `t${round}` } } as Document);
    await target.replaceOne({ _id: 40 + round }, { replaced: round });
    // Inserted and deleted inside the window: on neither side.
    await target.insertOne({ _id: `gone-${round}` });
    await target.deleteOne({ _id: `gone-${round}` });
  }
  // A document whose field names JavaScript would reorder ("0" before "b"), changed in
  // the window: re-encoded from the overlay, it must keep its stored order.
  await collection("a").updateOne(
    { _id: 50 },
    { $set: { [`b${round}`]: 1, "0": new Int32(round) } },
  );
}

/** A converge backup with `writeDuringWindow(round)` in its window, then a plain one. */
async function backupPair(round: number): Promise<{ converge: string; plain: string }> {
  let written = false;
  const hooked = hookedStorage(storage, async (key) => {
    if (written || !isDataFileOf(key, "b")) return;
    written = true;
    await writeDuringWindow(round);
  });
  const converge = await runBackup(backupContext(client(), hooked), {
    include: [`${database}.*`],
    consistency: "converge",
    parallelism: 1,
  });
  if (converge.status !== "complete") throw new Error("expected a complete converge backup");
  expect(written).toBe(true);
  expect(converge.manifest.changes?.events).toBeGreaterThan(10);
  const plain = await runBackup(backupContext(client(), storage), {
    include: [`${database}.*`],
    consistency: "none",
  });
  if (plain.status !== "complete") throw new Error("expected a complete plain backup");
  return { converge: converge.manifest.id, plain: plain.manifest.id };
}

beforeAll(async () => {
  storage = memoryStorage();
  // Dumped in name order: `a`, then `b` (writes happen here), then `c`.
  for (const name of ["a", "b", "c"]) await seed(name, 60);
  await collection("a").updateOne({ _id: 50 }, { $set: { b: 1, "0": new Int32(0) } });

  const first = await backupPair(1);
  ids.convergeA = first.converge;
  ids.plainA = first.plain;
  // Between the backups: changes that are in both B backups' dumps.
  await collection("b").updateMany({ n: { $lt: 5 } }, { $set: { between: true } });
  const second = await backupPair(2);
  ids.convergeB = second.converge;
  ids.plainB = second.plain;
}, 180_000);

afterAll(async () => {
  await client().db(database).dropDatabase();
});

/** A diff without timing and with sorted examples, for comparing two diffs. */
function comparable(result: DiffResult): unknown {
  const sortIds = (values: readonly unknown[]) => values.map((value) => String(value)).sort();
  return {
    identical: result.identical,
    namespaces: result.namespaces.map((namespace: NamespaceDiff) => ({
      ...namespace,
      examples: {
        added: sortIds(namespace.examples.added),
        removed: sortIds(namespace.examples.removed),
        changed: sortIds(namespace.examples.changed),
      },
    })),
  };
}

async function diff(from: string, to: string, maxRecordsInMemory?: number): Promise<DiffResult> {
  return diffBackups(
    { storage, logger: silentLogger },
    {
      from,
      to,
      examples: 1000,
      ...(maxRecordsInMemory === undefined ? {} : { maxRecordsInMemory }),
    },
  );
}

describe("diffBackups of converge backups", () => {
  it("compares each converge backup in its state at the end of its window", async () => {
    const expected = await diff(ids.plainA, ids.plainB);
    const actual = await diff(ids.convergeA, ids.convergeB);
    expect(comparable(actual)).toEqual(comparable(expected));
    // The windows' writes are what the diff reports, not the dumps.
    const a = actual.namespaces.find((namespace) => namespace.namespace === `${database}.a`);
    expect(a?.documents).toMatchObject({ added: 1, removed: 2 });
    expect(a?.examples.added).toEqual(["new-2"]);
  });

  it("gives the same answer when comparing through spill files", async () => {
    const expected = await diff(ids.plainA, ids.plainB);
    const actual = await diff(ids.convergeA, ids.convergeB, 10);
    expect(actual.spilled).toBe(true);
    expect(comparable(actual)).toEqual(comparable(expected));
  });

  it("finds a converge backup identical to a plain backup of its T1 state", async () => {
    for (const [converge, plain] of [
      [ids.convergeA, ids.plainA],
      [ids.convergeB, ids.plainB],
    ] as const) {
      const result = await diff(converge, plain);
      const differing = result.namespaces.filter((namespace) => !namespace.identical);
      expect(differing).toEqual([]);
      expect(result.identical).toBe(true);
    }
  });

  it("compares a converge backup with a plain one in either direction", async () => {
    const expected = await diff(ids.plainA, ids.plainB);
    expect(comparable(await diff(ids.convergeA, ids.plainB))).toEqual(comparable(expected));
    expect(comparable(await diff(ids.plainA, ids.convergeB))).toEqual(comparable(expected));
  });
});
