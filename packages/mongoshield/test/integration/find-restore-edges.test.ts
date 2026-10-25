// Integration tests for single-document restore's less common paths (find-restore.ts):
// documents backed up without an `_id`, dry runs into missing targets, upserts with a
// write concern, and write errors that are not duplicates.

import { BSON, type Document } from "mongodb";
import { describe, expect, it } from "vitest";
import type {
  RestoreDocumentsMode,
  RestoreDocumentsOptions,
} from "../../src/engine/find-restore.ts";
import { restoreDocuments } from "../../src/engine/find-restore.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { writeTestBackup } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** Documents with numeric ids, for setting up targets. */
interface NumberedDocument {
  _id?: number;
  [field: string]: unknown;
}

/** A backup of `app.c` with two documents that have an `_id` and one that has none. */
async function backup(): Promise<MemoryStorage> {
  const storage = memoryStorage();
  await writeTestBackup(storage, {
    namespaces: [
      {
        ns: "app.c",
        rawDocuments: [
          BSON.serialize({ _id: 1, n: "x" }),
          BSON.serialize({ _id: 2, n: "y" }),
          BSON.serialize({ n: "no id" }),
        ],
      },
    ],
  });
  return storage;
}

function run(storage: MemoryStorage, target: string, options: Partial<RestoreDocumentsOptions>) {
  return restoreDocuments(
    { client: client(), storage, logger: silentLogger },
    {
      backup: "latest",
      namespace: "app.c",
      targetNamespace: `${target}.c`,
      filter: {},
      ...options,
    },
  );
}

describe("restoreDocuments edge cases", () => {
  it("counts every match as an insert in a dry run into a missing target", async () => {
    const result = await run(await backup(), uniqueDb("fre"), {
      dryRun: true,
      createIfMissing: true,
    });
    expect(result).toMatchObject({ matched: 3, inserted: 3, skipped: 0, createdCollection: false });
  });

  it("counts documents without an _id as new in a dry run", async () => {
    const target = uniqueDb("fre");
    await client().db(target).collection<NumberedDocument>("c").insertOne({ _id: 1 });
    const result = await run(await backup(), target, { dryRun: true, filter: { n: "no id" } });
    expect(result).toMatchObject({ matched: 1, inserted: 1, skipped: 0 });
  });

  it("upserts with a write concern, inserting documents that have no _id", async () => {
    const target = uniqueDb("fre");
    await client().db(target).collection<NumberedDocument>("c").insertOne({ _id: 1, n: "old" });
    const result = await run(await backup(), target, {
      mode: "upsert",
      writeConcern: { w: 1 },
    });
    expect(result).toMatchObject({ matched: 3, replaced: 1, inserted: 2 });
    const restored: Document[] = await client().db(target).collection("c").find().toArray();
    expect(restored.map((document) => document.n).sort()).toEqual(["no id", "x", "y"]);
  });

  it("fails with MS_RESTORE_FAILED when a write fails for another reason than a duplicate", async () => {
    const target = uniqueDb("fre");
    const db = client().db(target);
    await db.createCollection("c", { validator: { n: { $type: "int" } } });
    await db.collection<NumberedDocument>("c").insertOne({ _id: 1, n: 1 });
    const error = await run(await backup(), target, {}).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_RESTORE_FAILED")).toBe(true);
    expect(String(error)).toContain(`Writing documents to ${target}.c failed`);
  });

  it("rejects an unknown mode", async () => {
    // As a script or a config file could pass it, past the type checker.
    const mode = JSON.parse('"merge"') as RestoreDocumentsMode;
    const error = await run(await backup(), uniqueDb("fre"), { mode }).catch(
      (caught: unknown) => caught,
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });
});
