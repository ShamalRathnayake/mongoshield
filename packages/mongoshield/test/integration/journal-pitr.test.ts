// End-to-end point-in-time recovery: a base backup taken while the application writes,
// a journal recording everything, a "disaster" (deleteMany) at a known cluster time,
// then the base backup restored into another database and the journal replayed up to
// just before the disaster. The result must equal, byte for byte, the source as it
// was at that moment (a snapshot read `atClusterTime`).

import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { readClusterTime } from "../../src/engine/converge-time.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { journalStatus, planPointInTimeRestore, replayJournal } from "../../src/journal/index.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import { collectionNames, firstDifference, rawDocuments } from "./converge-test-utils.ts";
import { startTestJournal, waitForJournalToCatchUp } from "./journal-test-utils.ts";

const client = useMongoClient();
const source = uniqueDb("pitr_src");
const target = uniqueDb("pitr_dst");

afterAll(async () => {
  await client().db(source).dropDatabase();
  await client().db(target).dropDatabase();
});

interface User {
  _id: number;
  name: string;
  email: string;
  visits?: number;
  tags?: string[];
  address?: { city: string; zip?: string };
}

interface Order {
  _id: number;
  user: number;
  qty: number;
  status: string;
}

it("restores a base backup plus the journal to just before a disaster, exactly", async () => {
  const storage = memoryStorage();
  const users = client().db(source).collection<User>("users");
  const orders = client().db(source).collection<Order>("orders");
  await users.insertMany(
    Array.from({ length: 50 }, (_, n) => ({
      _id: n,
      name: `user ${n}`,
      email: `user${n}@example.com`,
      visits: n,
      tags: ["a", "b"],
      address: { city: "Colombo", zip: `${10_000 + n}` },
    })),
  );
  await users.createIndex({ email: 1 }, { unique: true });
  await orders.insertMany(
    Array.from({ length: 50 }, (_, n) => ({ _id: n, user: n % 10, qty: n, status: "new" })),
  );

  const journal = await startTestJournal(client(), storage, source);
  try {
    // The application keeps writing while the base backup runs (its converge window).
    let backingUp = true;
    const writer = (async () => {
      let round = 0;
      while (backingUp) {
        await orders.updateOne({ _id: round % 50 }, { $inc: { qty: 1 } });
        await users.updateOne({ _id: round % 50 }, { $push: { tags: `t${round}` } });
        round += 1;
        await sleep(2);
      }
    })();
    const backup = await runBackup(backupContext(client(), storage), {
      include: [`${source}.*`],
      consistency: "converge",
      parallelism: 1,
    });
    backingUp = false;
    await writer;

    // After the base backup: every kind of change the journal must carry.
    await users.insertMany([
      { _id: 100, name: "new", email: "new@example.com" },
      { _id: 101, name: "newer", email: "newer@example.com", visits: 1 },
    ]);
    await users.updateOne(
      { _id: 1 },
      { $set: { "address.city": "Kandy" }, $unset: { visits: "" } },
    );
    await users.updateOne({ _id: 2 }, { $inc: { visits: 5 }, $pop: { tags: 1 } });
    await users.replaceOne({ _id: 3 }, { name: "replaced", email: "user3@example.com" });
    await users.deleteOne({ _id: 4 });
    await sleep(1100); // a segment boundary or two in the middle of the workload
    await orders.updateMany({ user: 3 }, { $set: { status: "shipped" } });
    await client()
      .db(source)
      .collection<{ _id: number; kind: string }>("events")
      .insertMany([
        { _id: 1, kind: "login" },
        { _id: 2, kind: "logout" },
      ]);
    // `$out` fills a scratch collection and renames it over `summary`.
    await orders
      .aggregate([{ $group: { _id: "$status", total: { $sum: "$qty" } } }, { $out: "summary" }])
      .toArray();
    await orders.deleteOne({ _id: 7 });
    await sleep(1100);
    await users.updateOne({ _id: 5 }, { $set: { email: "changed@example.com" } });
    await orders
      .aggregate([
        { $match: { status: "new" } },
        { $group: { _id: "$user", n: { $sum: 1 } } },
        { $out: "summary" },
      ])
      .toArray();

    // The last good moment, then the disaster, then more writes that must not appear.
    const beforeDisaster = await readClusterTime(client());
    await users.deleteMany({});
    await orders.updateMany({}, { $set: { status: "corrupted" } });
    await waitForJournalToCatchUp(client(), storage);

    // The reference: the source as it was right before the disaster.
    const names = await collectionNames(client(), source);
    expect(names).toEqual(["events", "orders", "summary", "users"]);
    const expected = new Map<string, Buffer[]>();
    for (const name of names) {
      expected.set(name, await rawDocuments(client(), source, name, beforeDisaster));
    }

    const plan = await planPointInTimeRestore(storage, beforeDisaster);
    expect(plan.baseBackupId).toBe(backup.id);
    expect(plan.segments.length).toBeGreaterThan(0);

    const rename = { [`${source}.*`]: `${target}.*` };
    await runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: plan.baseBackupId, rename },
    );
    const replayed = await replayJournal({
      client: client(),
      storage,
      from: plan.baseTime,
      to: plan.at,
      rename,
      baseNamespaces: plan.baseNamespaces,
    });
    expect(replayed.restoredTo).toEqual(beforeDisaster);
    // Inserts, updates, deletes, two `$out` renames (each recorded with its destination's
    // documents) and the collection created after the base backup.
    expect(replayed.events).toBeGreaterThan(20);
    // The two scratch collections, renamed away by the replayed `$out`s.
    expect(replayed.removedTargets).toHaveLength(2);
    expect(replayed.removedTargets.every((ns) => ns.startsWith(`${target}.tmp.agg_out.`))).toBe(
      true,
    );

    expect(await collectionNames(client(), target)).toEqual(names);
    for (const name of names) {
      const actual = await rawDocuments(client(), target, name);
      expect(
        firstDifference(expected.get(name) ?? [], actual),
        `${target}.${name}`,
      ).toBeUndefined();
    }
    // The base restore's indexes are still there.
    const indexes = await client().db(target).collection("users").indexes();
    expect(indexes.some((index) => index.unique === true)).toBe(true);
    expect((await journalStatus(storage)).gaps).toEqual([]);
  } finally {
    await journal.stop();
  }
});
