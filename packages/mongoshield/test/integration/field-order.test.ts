// Integration tests: every path that writes backed-up or copied documents keeps their
// stored field order, byte for byte, including field names that look like integers
// ("0", "7"), which JavaScript objects would move first (src/format/field-order.ts).
// Documents are random (test/helpers/ordered-documents.ts): integer-like names at any
// position and depth, in arrays of documents and in embedded-document `_id`s. Each
// path is checked by comparing the raw BSON of the source and the target.

import fc from "fast-check";
import type { Document } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { runCopy } from "../../src/copy/copy.ts";
import { runBackup } from "../../src/engine/backup.ts";
import { restoreDocuments } from "../../src/engine/find-restore.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { restoreTenant } from "../../src/extras/tenant-restore.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { planPointInTimeRestore, replayJournal } from "../../src/journal/index.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { BackupOptions } from "../../src/types.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import {
  documentSet,
  embeddedDocument,
  type OrderedDocument,
  sortedBytes,
  storedValue,
} from "../helpers/ordered-documents.ts";
import { backupContext } from "./backup-test-utils.ts";
import { hookedStorage, isDataFileOf } from "./converge-test-utils.ts";
import { startTestJournal, waitForJournalToCatchUp } from "./journal-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

/** A fresh database name, dropped after the file. */
function newDatabase(prefix: string): string {
  const name = uniqueDb(prefix);
  databases.push(name);
  return name;
}

/** Property runs per path: each run is a backup and a restore against the server. */
const RUNS = 4;

/**
 * fast-check options for these properties. `endOnFailure` reports the first failing
 * input instead of shrinking it: every shrink step is another backup and restore, and
 * shrinking would run into the test timeout and hide the counterexample.
 */
const PROPERTY_OPTIONS = { numRuns: RUNS, endOnFailure: true } as const;

/** Generated documents per collection. */
const SOME_DOCUMENTS = { min: 3, max: 25 };

/** The documents of a collection as raw BSON, in a canonical order. */
async function rawOf(
  database: string,
  collection: string,
  filter: Document = {},
): Promise<Buffer[]> {
  const raw: Uint8Array[] = [];
  const cursor = client().db(database).collection(collection).find(filter, { raw: true });
  for await (const document of cursor) raw.push(document as unknown as Uint8Array);
  return sortedBytes(raw);
}

/** Expects `target.collection` to hold exactly the bytes `source.collection` holds. */
async function expectSameBytes(
  source: string,
  target: string,
  collection: string,
  filter: Document = {},
): Promise<void> {
  const expected = await rawOf(source, collection, filter);
  const actual = await rawOf(target, collection, filter);
  expect(actual.length).toBe(expected.length);
  expect(actual.every((bytes, index) => bytes.equals(expected[index] ?? Buffer.alloc(0)))).toBe(
    true,
  );
}

/** Inserts generated documents as they are (Maps keep their field order). */
async function seed(database: string, collection: string, documents: OrderedDocument[]) {
  await client().db(database).collection(collection).insertMany(documents);
}

/** Changes every target document, so an upsert has something to replace. */
async function scribble(database: string, collection: string): Promise<void> {
  await client()
    .db(database)
    .collection(collection)
    .updateMany({}, { $set: { scribbled: true } });
}

async function backup(
  storage: MemoryStorage,
  database: string,
  options: Partial<BackupOptions> = {},
): Promise<Manifest> {
  const result = await runBackup(backupContext(client(), storage), {
    include: [`${database}.*`],
    parallelism: 1,
    ...options,
  });
  if (result.status !== "complete") throw new Error("expected a complete backup");
  return result.manifest;
}

function context(storage: MemoryStorage) {
  return { client: client(), storage, logger: silentLogger };
}

describe("stored field order", () => {
  it("survives backup and restore, also when upserting over existing documents", async () => {
    await fc.assert(
      fc.asyncProperty(documentSet(SOME_DOCUMENTS), async (documents) => {
        const source = newDatabase("fo_src");
        const target = newDatabase("fo_dst");
        await seed(source, "docs", documents);
        const storage = memoryStorage();
        const manifest = await backup(storage, source);
        const rename = { [`${source}.*`]: `${target}.*` };

        await runRestore(context(storage), { backup: manifest.id, rename });
        await expectSameBytes(source, target, "docs");

        await scribble(target, "docs");
        await runRestore(context(storage), { backup: manifest.id, rename, mode: "upsert" });
        await expectSameBytes(source, target, "docs");
      }),
      PROPERTY_OPTIONS,
    );
  });

  it("survives copy, also when upserting over existing documents", async () => {
    await fc.assert(
      fc.asyncProperty(documentSet(SOME_DOCUMENTS), async (documents) => {
        const source = newDatabase("fo_csrc");
        const target = newDatabase("fo_cdst");
        await seed(source, "docs", documents);
        const options = { include: [`${source}.*`], rename: { [`${source}.*`]: `${target}.*` } };
        const copyContext = { source: client(), target: client(), logger: silentLogger };

        await runCopy(copyContext, options);
        await expectSameBytes(source, target, "docs");

        await scribble(target, "docs");
        await runCopy(copyContext, { ...options, mode: "upsert" });
        await expectSameBytes(source, target, "docs");
      }),
      PROPERTY_OPTIONS,
    );
  });

  it("survives single-document restore (find --restore), inserting and upserting", async () => {
    await fc.assert(
      fc.asyncProperty(documentSet(SOME_DOCUMENTS), async (documents) => {
        const source = newDatabase("fo_fsrc");
        const target = newDatabase("fo_fdst");
        await seed(source, "docs", documents);
        const storage = memoryStorage();
        const manifest = await backup(storage, source);
        await client().db(target).createCollection("docs");
        const request = {
          backup: manifest.id,
          namespace: `${source}.docs`,
          targetNamespace: `${target}.docs`,
          filter: {},
        };

        const inserted = await restoreDocuments(context(storage), request);
        expect(inserted.inserted).toBe(documents.length);
        await expectSameBytes(source, target, "docs");

        await scribble(target, "docs");
        const upserted = await restoreDocuments(context(storage), { ...request, mode: "upsert" });
        expect(upserted.replaced).toBe(documents.length);
        await expectSameBytes(source, target, "docs");
      }),
      PROPERTY_OPTIONS,
    );
  });

  it("survives tenant restore", async () => {
    const tenant = () =>
      fc.constantFrom<[string, unknown]>(["tenant", "acme"], ["tenant", "globex"]);
    await fc.assert(
      fc.asyncProperty(documentSet(SOME_DOCUMENTS, { extra: tenant }), async (documents) => {
        const source = newDatabase("fo_tsrc");
        const target = newDatabase("fo_tdst");
        await seed(source, "docs", documents);
        const storage = memoryStorage();
        const manifest = await backup(storage, source);

        await restoreTenant(context(storage), {
          backup: manifest.id,
          tenantFilter: { tenant: "acme" },
          include: [`${source}.docs`],
          rename: { [`${source}.*`]: `${target}.*` },
        });
        await expectSameBytes(source, target, "docs", { tenant: "acme" });
      }),
      PROPERTY_OPTIONS,
    );
  });

  it("survives converge replay of inserts, replaces and updates made during the backup", async () => {
    /** What happens to `a` while `b` is being dumped (after `a`'s dump). */
    const windowChanges = fc.record({
      inserted: documentSet({ min: 1, max: 5 }, { firstIndex: 1000 }),
      replacements: fc.array(fc.tuple(fc.nat(), embeddedDocument), { maxLength: 4 }),
      updates: fc.array(fc.tuple(fc.nat(), embeddedDocument, storedValue), { maxLength: 4 }),
    });
    await fc.assert(
      fc.asyncProperty(
        documentSet(SOME_DOCUMENTS),
        windowChanges,
        async (documents, { inserted, replacements, updates }) => {
          const source = newDatabase("fo_vsrc");
          const target = newDatabase("fo_vdst");
          await seed(source, "a", documents);
          await seed(source, "b", documents);
          const ids = documents.map((document) => document.get("_id"));
          const idAt = (n: number): Document => ({ _id: ids[n % ids.length] });

          let changed = false;
          const storage = hookedStorage(memoryStorage(), async (key) => {
            if (changed || !isDataFileOf(key, "b")) return;
            changed = true;
            const a = client().db(source).collection("a");
            await a.insertMany(inserted);
            for (const [n, body] of replacements) await a.replaceOne(idAt(n), body);
            for (const [n, value, other] of updates) {
              // A new or changed embedded document, and an integer-like field name.
              await a.updateOne(idAt(n), { $set: { sub: value, "9": other } });
            }
          });
          const manifest = await backup(storage, source, { consistency: "converge" });
          expect(changed).toBe(true);

          const rename = { [`${source}.*`]: `${target}.*` };
          await runRestore(context(storage), { backup: manifest.id, rename });
          await expectSameBytes(source, target, "a");
          await expectSameBytes(source, target, "b");

          // find --restore shows documents as of the end of the window: backed-up
          // documents with the window's changes applied in memory.
          const single = newDatabase("fo_vone");
          await client().db(single).createCollection("a");
          await restoreDocuments(context(storage), {
            backup: manifest.id,
            namespace: `${source}.a`,
            targetNamespace: `${single}.a`,
            filter: {},
          });
          await expectSameBytes(source, single, "a");
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it("survives point-in-time recovery: a base backup plus the journal replayed", async () => {
    const changes = fc.record({
      inserted: documentSet({ min: 1, max: 6 }, { firstIndex: 1000 }),
      replacements: fc.array(fc.tuple(fc.nat(), embeddedDocument), { maxLength: 4 }),
      updates: fc.array(fc.tuple(fc.nat(), embeddedDocument), { maxLength: 4 }),
    });
    await fc.assert(
      fc.asyncProperty(
        documentSet(SOME_DOCUMENTS),
        changes,
        async (documents, { inserted, replacements, updates }) => {
          const source = newDatabase("fo_jsrc");
          const target = newDatabase("fo_jdst");
          await seed(source, "a", documents);
          const ids = documents.map((document) => document.get("_id"));
          const idAt = (n: number): Document => ({ _id: ids[n % ids.length] });
          const storage = memoryStorage();
          const journal = await startTestJournal(client(), storage, source);
          try {
            await backup(storage, source, { consistency: "converge" });
            const a = client().db(source).collection("a");
            await a.insertMany(inserted);
            for (const [n, body] of replacements) await a.replaceOne(idAt(n), body);
            for (const [n, value] of updates) {
              await a.updateOne(idAt(n), { $set: { sub: value } });
            }
            const at = await waitForJournalToCatchUp(client(), storage);

            const plan = await planPointInTimeRestore(storage, at);
            const rename = { [`${source}.*`]: `${target}.*` };
            await runRestore(context(storage), { backup: plan.baseBackupId, rename });
            await replayJournal({
              client: client(),
              storage,
              from: plan.baseTime,
              to: plan.at,
              rename,
              baseNamespaces: plan.baseNamespaces,
            });
            await expectSameBytes(source, target, "a");
          } finally {
            await journal.stop();
          }
        },
      ),
      { ...PROPERTY_OPTIONS, numRuns: 2 },
    );
  });
});
