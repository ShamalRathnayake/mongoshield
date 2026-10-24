// Planning a point-in-time restore when it cannot (fully) use the journal: no base
// backup at all, only base backups newer than the requested time, no journal after
// the base backup, and a restore to exactly a base backup's own time (which needs no
// journal). The error lists what can be restored.

import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { baseTimeOf, planPointInTimeRestore } from "../../src/journal/index.ts";
import { recoverableRanges } from "../../src/journal/plan.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import type { AnyDocument } from "./converge-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("jplan");

afterAll(async () => {
  await client().db(database).dropDatabase();
});

async function planFailure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isMongoShieldError(error, "MS_CHANGE_HISTORY_LOST")) throw new Error(`got ${String(error)}`);
  return error;
}

describe("planPointInTimeRestore without a usable journal", () => {
  it("says there is no base backup", async () => {
    const error = await planFailure(planPointInTimeRestore(memoryStorage(), new Date(1000_000)));
    expect(error.message).toContain("there is no base backup");
    expect(error.message).toContain("nothing (no base backup with a cluster time)");
  });

  it("plans a restore to exactly a base backup, and explains every other refusal", async () => {
    await client().db(database).collection<AnyDocument>("a").insertOne({ _id: 1 });
    const storage = memoryStorage();
    const result = await runBackup(backupContext(client(), storage), {
      include: [`${database}.*`],
      consistency: "converge",
    });
    if (result.status !== "complete") throw new Error("backup failed");
    const baseTime = baseTimeOf(result.manifest);
    if (baseTime === undefined) throw new Error("no base time");

    const exact = await planPointInTimeRestore(storage, baseTime);
    expect(exact.baseBackupId).toBe(result.manifest.id);
    expect(exact.segments).toEqual([]);
    expect(exact.estimatedEvents).toBeUndefined();

    const before = await planFailure(planPointInTimeRestore(storage, { t: 1, i: 0 }));
    expect(before.message).toContain("every base backup is newer than that");
    expect(before.details?.recoverableRanges).toEqual([{ from: baseTime, to: baseTime }]);
    expect(before.message).toContain("(a base backup)");

    const after = await planFailure(planPointInTimeRestore(storage, { t: baseTime.t + 60, i: 0 }));
    expect(after.message).toContain("the journal does not cover the time");
  });
});

describe("baseTimeOf and recoverableRanges", () => {
  const manifest = (consistency: Manifest["consistency"]) => ({ consistency }) as Manifest;

  it("takes the end of a converge window, the snapshot time, and nothing for none", () => {
    expect(
      baseTimeOf(manifest({ mode: "converge", from: { t: 1, i: 0 }, to: { t: 2, i: 0 } })),
    ).toEqual({ t: 2, i: 0 });
    expect(baseTimeOf(manifest({ mode: "snapshot", from: { t: 3, i: 0 } }))).toEqual({
      t: 3,
      i: 0,
    });
    expect(baseTimeOf(manifest({ mode: "none" }))).toBeUndefined();
  });

  it("reaches from the oldest base inside each covered range, and lists the others alone", () => {
    const base = (id: string, t: number) => ({
      id,
      clusterTime: { t, i: 0 },
      completedAt: new Date(t * 1000),
      manifest: manifest({ mode: "snapshot", from: { t, i: 0 } }),
    });
    const ranges = [{ from: { t: 10, i: 0 }, to: { t: 50, i: 0 }, segments: 4 }];
    expect(recoverableRanges([base("c", 40), base("b", 20), base("a", 5)], ranges)).toEqual([
      { from: { t: 5, i: 0 }, to: { t: 5, i: 0 } },
      { from: { t: 20, i: 0 }, to: { t: 50, i: 0 } },
    ]);
    expect(recoverableRanges([], ranges)).toEqual([]);
  });
});
