// Integration tests: `find` (and everything built on it: single-document restore,
// tenant restore, document history) reads a converge backup as it was at the END of
// its window, by overlaying the recorded changes on the dumped documents
// (src/engine/find-window.ts). The reference is the source itself after the backup:
// what find returns must equal it byte for byte, exactly as a full restore would.

import { BSON, type Document } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { compileFilter } from "../../src/engine/filter.ts";
import { findInBackup, matchingDocuments, openNamespace } from "../../src/engine/find.ts";
import { restoreDocuments } from "../../src/engine/find-restore.ts";
import { documentHistory } from "../../src/extras/history.ts";
import { restoreTenant } from "../../src/extras/tenant-restore.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { type Logger, silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";
import { hookedStorage, isDataFileOf, rawDocuments } from "./converge-test-utils.ts";

const client = useMongoClient();
const source = uniqueDb("fw_src");
let storage: MemoryStorage;
let manifest: Manifest;

/** Test documents: numeric or string `_id`s and any fields. */
interface TestDocument {
  _id?: number | string;
  [field: string]: unknown;
}

/** `count` documents per collection, `_id` 0…count-1, each with a tenant. */
async function seed(collection: string, count: number): Promise<void> {
  await client()
    .db(source)
    .collection<TestDocument>(collection)
    .insertMany(
      Array.from({ length: count }, (_, n) => ({
        _id: n,
        n,
        tenant: n % 2 === 0 ? "acme" : "globex",
        nested: { x: n, y: [n, n + 1] },
        tags: ["a", "b", "c", "d"],
      })),
    );
}

/** Every kind of change, made while `b` is being dumped (`a` is done, `c` not read yet). */
async function changeDuringBackup(): Promise<void> {
  const db = client().db(source);
  for (const name of ["a", "c"]) {
    const collection = db.collection<TestDocument>(name);
    await collection.insertMany([{ _id: 1000, n: 1000, tenant: "acme", added: true }]);
    await collection.deleteMany({ _id: { $in: [1, 2, 3] } });
    await collection.updateMany({ _id: { $lt: 20 } }, { $set: { "nested.x": -1, extra: "yes" } });
    await collection.updateOne({ _id: 7 }, { $push: { tags: "e" } } as Document);
    await collection.updateOne({ _id: 8 }, [{ $set: { tags: { $slice: ["$tags", 2] } } }]);
    await collection.updateOne({ _id: 9 }, { $unset: { tenant: "" } });
    await collection.replaceOne({ _id: 10 }, { replaced: true, tenant: "globex" });
    await collection.updateOne({ _id: 11 }, { $set: { tenant: "acme" } });
    // Inserted and changed again inside the window; and inserted, then deleted.
    await collection.insertOne({ _id: "late", tenant: "acme", v: 1 });
    await collection.updateOne({ _id: "late" }, { $inc: { v: 1 } } as Document);
    await collection.insertOne({ _id: "gone", tenant: "acme" });
    await collection.deleteOne({ _id: "gone" });
  }
  await db.collection<TestDocument>("adoomed").drop();
  // A dumped collection renamed over another dumped one, then changed under its new name.
  await db.collection<TestDocument>("arenamed").updateOne({ _id: 0 }, { $set: { before: true } });
  await db.collection<TestDocument>("arenamed").rename("atarget", { dropTarget: true });
  await db.collection<TestDocument>("atarget").updateOne({ _id: 1 }, { $set: { after: true } });
  // `$out` fills a scratch collection and renames it over `asummary`.
  await db
    .collection<TestDocument>("b")
    .aggregate([{ $match: { n: { $lt: 5 } } }, { $out: "asummary" }])
    .toArray();
}

beforeAll(async () => {
  // Dumped in name order: every `a…` collection is stored before the changes
  // (made while `b` is dumped), so only the overlay can show its final state.
  for (const name of ["a", "adoomed", "arenamed", "asummary", "atarget", "b", "c"]) {
    await seed(name, name === "atarget" ? 3 : 60);
  }
  let changed = false;
  storage = hookedStorage(memoryStorage(), async (key) => {
    if (changed || !isDataFileOf(key, "b")) return;
    changed = true;
    await changeDuringBackup();
  });
  const result = await runBackup(backupContext(client(), storage), {
    include: [`${source}.*`],
    consistency: "converge",
    parallelism: 1,
  });
  if (result.status !== "complete") throw new Error("expected a complete backup");
  manifest = result.manifest;
  expect(changed).toBe(true);
  expect(manifest.changes?.events).toBeGreaterThan(50);
});

afterAll(async () => {
  await client().db(source).dropDatabase();
});

/** Everything find returns for `filter`, as raw BSON sorted by `_id`. */
async function foundRaw(collection: string, filter: Document = {}): Promise<Buffer[]> {
  const found: Document[] = [];
  for await (const document of findInBackup(
    { storage, logger: silentLogger },
    { backup: manifest.id, namespace: `${source}.${collection}`, filter },
  )) {
    found.push(document);
  }
  return sortedRaw(found);
}

function sortedRaw(documents: readonly Document[]): Buffer[] {
  const sorted = [...documents].sort((left, right) => compareIds(left._id, right._id));
  return sorted.map((document) => Buffer.from(BSON.serialize(document)));
}

/** Numbers before strings, like the server sorts them. */
function compareIds(left: unknown, right: unknown): number {
  if (typeof left === typeof right)
    return String(left).localeCompare(String(right), "en", { numeric: true });
  return typeof left === "number" ? -1 : 1;
}

/** The source collection now (the end of the window, as nothing changed since). */
async function sourceRaw(collection: string, filter: Document = {}): Promise<Buffer[]> {
  const documents = await client()
    .db(source)
    .collection(collection)
    .find(filter, { promoteValues: false, promoteBuffers: false, bsonRegExp: true })
    .toArray();
  return sortedRaw(documents);
}

describe("find on a converge backup", () => {
  it("returns every document as it was at the end of the window, byte for byte", async () => {
    for (const name of ["a", "b", "c"]) {
      const expected = await rawDocuments(client(), source, name);
      expect(expected.length).toBeGreaterThan(0);
      expect(await foundRaw(name), name).toEqual(await sourceRaw(name));
    }
  });

  it("evaluates the filter on the final versions: changed, inserted and deleted documents", async () => {
    for (const filter of [
      { extra: "yes" },
      { tenant: "acme" },
      { _id: { $in: [1, 2, 3, "gone"] } },
      { _id: "late" },
      { tags: { $size: 2 } },
      { "tags.4": "e" },
      { replaced: true },
      { "nested.x": { $lt: 0 } },
    ]) {
      expect(await foundRaw("a", filter), JSON.stringify(filter)).toEqual(
        await sourceRaw("a", filter),
      );
    }
  });

  it("sees dropped collections empty and $out targets with their new contents", async () => {
    expect(await foundRaw("adoomed")).toEqual([]);
    expect(await foundRaw("asummary")).toEqual(await sourceRaw("asummary"));
    expect(await foundRaw("asummary")).toHaveLength(5);
  });

  it("follows a rename: the target holds the renamed collection's documents, the source none", async () => {
    expect(await foundRaw("arenamed")).toEqual([]);
    const found = await foundRaw("atarget");
    expect(found).toHaveLength(60);
    expect(found).toEqual(await sourceRaw("atarget"));
  });

  it("gives the same answer when the overlay is split into partitions to bound memory", async () => {
    const context = { client: client(), storage, logger: silentLogger };
    const opened = await openNamespace(context, { backup: manifest.id, namespace: `${source}.a` });
    const infos: Document[] = [];
    const logger: Logger = {
      ...silentLogger,
      info: (message, fields) => infos.push({ message, ...fields }),
    };
    const found: Document[] = [];
    for await (const match of matchingDocuments(opened, compileFilter({}), undefined, {
      logger,
      windowMemoryBytes: 1024,
    })) {
      found.push(match.document);
    }
    expect(sortedRaw(found)).toEqual(await sourceRaw("a"));
    expect(infos.find((info) => info.ns === `${source}.a`)?.passes).toBeGreaterThan(1);
  });
});

describe("recovery built on find, on a converge backup", () => {
  it("restores single documents in their final version, including ones inserted in the window", async () => {
    const target = uniqueDb("fw_doc");
    await client().db(target).createCollection("a");
    const result = await restoreDocuments(
      { client: client(), storage, logger: silentLogger },
      {
        backup: manifest.id,
        namespace: `${source}.a`,
        targetNamespace: `${target}.a`,
        filter: { _id: { $in: [1, 10, "late", "gone"] } },
      },
    );
    expect(result.matched).toBe(2);
    const restored = await client().db(target).collection("a").find().toArray();
    expect(sortedRaw(restored)).toEqual(await sourceRaw("a", { _id: { $in: [10, "late"] } }));
  });

  it("restores a tenant as it was at the end of the window", async () => {
    const target = uniqueDb("fw_ten");
    const result = await restoreTenant(
      { client: client(), storage, logger: silentLogger },
      {
        backup: manifest.id,
        tenantFilter: { tenant: "acme" },
        include: [`${source}.a`],
        rename: { [`${source}.*`]: `${target}.*` },
      },
    );
    expect(result.totals.matched).toBeGreaterThan(0);
    const restored = await client().db(target).collection("a").find().toArray();
    expect(sortedRaw(restored)).toEqual(await sourceRaw("a", { tenant: "acme" }));
  });

  it("shows a document's history with its end-of-window version", async () => {
    const history = await documentHistory(
      { storage, logger: silentLogger },
      { namespace: `${source}.a`, id: 7, journal: false },
    );
    const [version] = history.versions;
    expect(version?.kind).toBe("backup");
    if (version?.kind !== "backup" || version.document === undefined) throw new Error("absent");
    expect(sortedRaw([version.document])).toEqual(await sourceRaw("a", { _id: 7 }));

    const deleted = await documentHistory(
      { storage, logger: silentLogger },
      { namespace: `${source}.a`, id: 2, journal: false },
    );
    expect(deleted.versions[0]).toMatchObject({ kind: "backup", state: "absent" });
  });
});
