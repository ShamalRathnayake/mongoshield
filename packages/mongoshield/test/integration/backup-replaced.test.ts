// Collections dropped or replaced (`$out`) while a backup reads them: the cursor dies
// with QueryPlanKilled ("collection dropped"). Converge keeps what it read and the
// replayed window rebuilds the collection exactly; mode none reads a replaced
// collection again and leaves a dropped one out with a manifest warning; snapshot
// reads are unaffected (the snapshot still holds the collection).

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { referencedKeys } from "../../src/engine/backup-orphans.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { verifyBackup } from "../../src/engine/verify.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { BackupOptions } from "../../src/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import {
  type AnyDocument,
  collectionNames,
  firstDifference,
  hookedStorage,
  isDataFileOf,
  midWriteStorage,
  rawDocuments,
} from "./converge-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

function newDatabase(prefix: string): string {
  const name = uniqueDb(prefix);
  databases.push(name);
  return name;
}

/**
 * Far more than the dump buffers before storage takes the first bytes (20 MiB, not
 * compressible, so compressed chunks leave early), so its cursor still needs getMores
 * when the collection is changed.
 */
async function seed(database: string): Promise<void> {
  const db = client().db(database);
  await db
    .collection<AnyDocument>("a")
    .insertMany(
      Array.from({ length: 2000 }, (_, n) => ({ _id: n, pad: randomBytes(5000).toString("hex") })),
    );
  await db
    .collection<AnyDocument>("b")
    .insertMany(Array.from({ length: 50 }, (_, n) => ({ _id: n, from: "b" })));
}

/**
 * Storage that runs `change` once, after the first bytes of `a`'s data file: the
 * dump's cursor is part-way through `a` and needs getMores for the rest.
 */
function changingStorage(change: () => Promise<void>): MemoryStorage {
  let done = false;
  return midWriteStorage(
    memoryStorage(),
    (key) => isDataFileOf(key, "a"),
    async () => {
      if (done) return;
      done = true;
      await change();
    },
  );
}

async function backup(storage: MemoryStorage, database: string, options: Partial<BackupOptions>) {
  const result = await runBackup(backupContext(client(), storage), {
    include: [`${database}.*`],
    parallelism: 1,
    ...options,
  });
  if (result.status !== "complete") throw new Error("expected a complete backup");
  return result.manifest;
}

async function restoreInto(storage: MemoryStorage, id: string, source: string, target: string) {
  await runRestore(
    { client: client(), storage, logger: silentLogger },
    { backup: id, rename: { [`${source}.*`]: `${target}.*` } },
  );
}

async function expectSame(source: string, target: string): Promise<void> {
  const names = await collectionNames(client(), source);
  expect(await collectionNames(client(), target)).toEqual(names);
  for (const name of names) {
    const difference = firstDifference(
      await rawDocuments(client(), source, name),
      await rawDocuments(client(), target, name),
    );
    expect(difference, name).toBeUndefined();
  }
}

/** Replaces `a` with `b`'s documents, the way an aggregation's `$out` does. */
async function outOverA(database: string): Promise<void> {
  await client()
    .db(database)
    .collection("b")
    .aggregate([{ $out: "a" }])
    .toArray();
}

describe("a collection replaced or dropped during a converge backup", () => {
  for (const [what, change] of [
    ["replaced by $out", outOverA],
    [
      "dropped",
      (database: string) =>
        client()
          .db(database)
          .collection("a")
          .drop()
          .then(() => {}),
    ],
  ] as const) {
    it(`restores exactly when it is ${what} mid-dump`, async () => {
      const source = newDatabase("rpl_cv");
      const target = newDatabase("rpl_cv_dst");
      await seed(source);
      const storage = changingStorage(() => change(source));
      const manifest = await backup(storage, source, { consistency: "converge" });
      // Recorded normally, with what was read before the cursor died.
      expect(manifest.namespaces.map((entry) => entry.collection)).toContain("a");
      await restoreInto(storage, manifest.id, source, target);
      await expectSame(source, target);
    });
  }
});

describe("a collection replaced or dropped during a backup in mode none", () => {
  it("reads a replaced collection again", async () => {
    const source = newDatabase("rpl_none");
    const target = newDatabase("rpl_none_dst");
    await seed(source);
    const storage = changingStorage(() => outOverA(source));
    const manifest = await backup(storage, source, { consistency: "none" });
    expect(manifest.namespaces.find((entry) => entry.collection === "a")?.documents).toBe(50);
    expect(manifest.consistency.warning).toBeUndefined();
    await restoreInto(storage, manifest.id, source, target);
    await expectSame(source, target);
  });

  it("leaves a dropped collection out, with a warning", async () => {
    const source = newDatabase("rpl_drop");
    await seed(source);
    const storage = changingStorage(() =>
      client()
        .db(source)
        .collection("a")
        .drop()
        .then(() => {}),
    );
    const manifest = await backup(storage, source, { consistency: "none" });
    expect(manifest.namespaces.map((entry) => entry.collection)).toEqual(["b"]);
    expect(manifest.consistency.warning).toContain(`${source}.a`);
    expect(manifest.totals.namespaces).toBe(1);
    expect(storage.keys().some((key) => key.includes("/a."))).toBe(false);
  });
});

describe("a collection dropped before its dump begins, in mode none", () => {
  it("is left out too, not recorded as empty", async () => {
    const source = newDatabase("rpl_early");
    await seed(source);
    const storage = hookedStorage(memoryStorage(), async (key) => {
      if (isDataFileOf(key, "a")) await client().db(source).collection("a").drop();
    });
    const manifest = await backup(storage, source, { consistency: "none" });
    expect(manifest.namespaces.map((entry) => entry.collection)).toEqual(["b"]);
  });
});

describe("a collection dropped during a snapshot backup", () => {
  it("is still read as of the snapshot", async () => {
    const source = newDatabase("rpl_snap");
    await seed(source);
    const expected = await client().db(source).collection("a").countDocuments();
    const storage = changingStorage(() =>
      client()
        .db(source)
        .collection("a")
        .drop()
        .then(() => {}),
    );
    const manifest = await backup(storage, source, { consistency: "snapshot" });
    expect(manifest.namespaces.find((entry) => entry.collection === "a")?.documents).toBe(expected);
  });
});

describe("a split collection dropped while one of its parts is still uploading", () => {
  it("leaves no object the manifest does not reference", async () => {
    const source = newDatabase("rpl_split");
    await seed(source);
    const base = memoryStorage();
    const db = client().db(source);
    let part0Read = false;
    const isPart = (key: string, part: string) => key.includes(`/a.${part}.bson`);
    const metadataGone = () => !base.keys().some((key) => key.endsWith("/a.metadata.json"));
    const storage: MemoryStorage = {
      ...base,
      async put(key, body, options) {
        if (!(body instanceof Readable)) return base.put(key, body, options);
        if (isPart(key, "000")) {
          // Read part 0 completely (its cursor is done), then hold its upload until the
          // dropped collection's files were deleted: it lands after the deletion.
          const chunks: Buffer[] = [];
          for await (const chunk of body) chunks.push(Buffer.from(chunk));
          part0Read = true;
          await waitFor(metadataGone);
          return base.put(key, Buffer.concat(chunks), options);
        }
        if (isPart(key, "001")) {
          // Part 1's cursor is open: dropping the collection now kills it, and the
          // backup leaves the collection out.
          await waitFor(() => part0Read);
          await db.collection("a").drop();
        }
        return base.put(key, body, options);
      },
    };
    const manifest = await backup(storage, source, {
      consistency: "none",
      parallelism: 2,
      partSizeBytes: 8 * 1024 * 1024,
    });
    expect(manifest.namespaces.map((entry) => entry.collection)).toEqual(["b"]);
    const referenced = referencedKeys(manifest);
    const stored = base.keys().filter((key) => key.startsWith(`backups/${manifest.id}/`));
    expect(stored.filter((key) => !referenced.has(key))).toEqual([]);
    expect(stored.some((key) => key.includes("/a."))).toBe(false);
    const verified = await verifyBackup(
      { storage: base, logger: silentLogger },
      { backup: manifest.id },
    );
    expect(verified.ok).toBe(true);
  });
});

/** Polls `condition` every 20 ms, for up to 30 s. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 20) {
    if (waited > 30_000) throw new Error("timed out");
    await sleep(20);
  }
}
