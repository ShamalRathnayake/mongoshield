// Integration tests for what verify finds in a manifest that does not match its files:
// totals that do not add up, a metadata file that describes another collection, and a
// converge backup's changes file whose event count, order or window disagrees with the
// manifest (deep mode).

import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { verifyBackup } from "../../src/engine/verify.ts";
import { manifestKey } from "../../src/format/layout.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { serializeManifest } from "../../src/format/manifest-io.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { writeTestBackup } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import { hookedStorage, isDataFileOf } from "./converge-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

/** Stores an edited copy of the manifest in place of the original. */
async function rewrite(
  storage: MemoryStorage,
  manifest: Manifest,
  edit: (m: Manifest) => Manifest,
) {
  await storage.put(
    manifestKey(manifest.id),
    Buffer.from(serializeManifest(edit(manifest)), "utf8"),
  );
}

function verify(storage: MemoryStorage, id: string, mode: "fast" | "deep" = "fast") {
  return verifyBackup({ storage, logger: silentLogger }, { backup: id, mode });
}

describe("verifying the manifest against the files", () => {
  it("reports totals that do not add up", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.a", documents: [{ _id: 1 }] }],
    });
    await rewrite(storage, manifest, (m) => ({
      ...m,
      totals: { ...m.totals, documents: 5, namespaces: 3 },
    }));
    const report = await verify(storage, manifest.id);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      { subject: "manifest.json", problem: expect.stringContaining("totals.documents is 5") },
      { subject: "manifest.json", problem: expect.stringContaining("totals.namespaces is 3") },
    ]);
  });

  it("reports a metadata file that describes another collection (deep)", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [
        { ns: "app.a", documents: [{ _id: 1 }] },
        { ns: "app.b", documents: [{ _id: 2 }] },
      ],
    });
    const [a, b] = manifest.namespaces;
    if (a === undefined || b === undefined) throw new Error("two namespaces expected");
    await rewrite(storage, manifest, (m) => ({
      ...m,
      namespaces: [{ ...a, metadata: b.metadata }, b],
    }));
    const report = await verify(storage, manifest.id, "deep");
    expect(report.problems).toEqual([
      {
        subject: b.metadata.key,
        problem: 'It describes collection "b", but the manifest lists collection "a".',
      },
    ]);
  });
});

describe("verifying a converge backup's changes file (deep)", () => {
  async function convergeBackup(): Promise<{ storage: MemoryStorage; manifest: Manifest }> {
    const database = uniqueDb("vmcv");
    databases.push(database);
    for (const name of ["a", "b"]) {
      await client()
        .db(database)
        .collection(name)
        .insertMany(Array.from({ length: 20 }, (_, n) => ({ n })));
    }
    let changed = false;
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (changed || !isDataFileOf(key, "b")) return;
      changed = true;
      await client()
        .db(database)
        .collection("a")
        .updateMany({}, { $set: { touched: true } });
    });
    const result = await runBackup(backupContext(client(), storage), {
      include: [`${database}.*`],
      consistency: "converge",
      parallelism: 1,
    });
    if (result.status !== "complete") throw new Error("expected a complete backup");
    expect(result.manifest.changes?.events).toBeGreaterThan(0);
    return { storage, manifest: result.manifest };
  }

  it("passes when the events match the manifest", async () => {
    const { storage, manifest } = await convergeBackup();
    expect((await verify(storage, manifest.id, "deep")).problems).toEqual([]);
  });

  it("reports an event count, a window start and a window end that disagree with the events", async () => {
    const { storage, manifest } = await convergeBackup();
    const changes = manifest.changes;
    const { from, to } = manifest.consistency;
    if (changes === undefined || from === undefined || to === undefined)
      throw new Error("converge");
    const key = changes.key;

    await rewrite(storage, manifest, (m) => ({
      ...m,
      changes: { ...changes, events: changes.events + 1 },
    }));
    expect((await verify(storage, manifest.id, "deep")).problems).toEqual([
      {
        subject: key,
        problem: `The changes file holds ${changes.events} events, but the manifest records ${changes.events + 1}.`,
      },
    ]);

    // A window that starts after the events, or ends before them.
    const late = { t: to.t + 3600, i: 1 };
    await rewrite(storage, manifest, (m) => ({
      ...m,
      consistency: { ...m.consistency, from: late, to: late },
    }));
    expect((await verify(storage, manifest.id, "deep")).problems).toEqual([
      {
        subject: key,
        problem: expect.stringContaining(
          "is earlier than the one before it or the start of the window",
        ),
      },
    ]);
    const early = { t: from.t - 3600, i: 1 };
    await rewrite(storage, manifest, (m) => ({
      ...m,
      consistency: { ...m.consistency, from: early, to: early },
    }));
    expect((await verify(storage, manifest.id, "deep")).problems).toEqual([
      { subject: key, problem: expect.stringContaining("is after the end of the window") },
    ]);
  });
});
