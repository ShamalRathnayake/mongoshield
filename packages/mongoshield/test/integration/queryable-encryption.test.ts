// Integration tests for Queryable Encryption (QE) collections (src/engine/backup-qe.ts),
// against the real test replica set. The server side of QE needs no encryption library:
// a collection is created with `encryptedFields`, its state collections are created the
// way drivers create them (clustered on `_id`), and encrypted values are ordinary BSON
// (binary subtype 6). The tests check what a restore needs:
//   - the restored collection keeps its `encryptedFields` (the raw `create` is used, so
//     the server does not get fresh, empty state collections from a driver helper);
//   - the state collections come back with their contents, next to the data;
//   - a backup whose selection leaves the state collections out warns about it.

import { Binary, type Document, UUID } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import type { LogFields, Logger } from "../../src/logger.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { TEST_COMPRESSION } from "../helpers/compression.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import type { AnyDocument } from "./converge-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("qe");
const restored = uniqueDb("qe_restored");

/** The state collections drivers create for `patients` (MongoDB 7.0+). */
const STATE_COLLECTIONS = ["enxcol_.patients.esc", "enxcol_.patients.ecoc"];

/** A logger that keeps every warning. */
function warningLogger(): Logger & { readonly warnings: string[] } {
  const warnings: string[] = [];
  return {
    ...silentLogger,
    warnings,
    warn: (message: string, _fields?: LogFields) => {
      warnings.push(message);
    },
  };
}

/** The `listCollections` options of every collection in `db`, by name. */
async function collectionOptions(db: string): Promise<Map<string, Document>> {
  const infos = await client().db(db).listCollections().toArray();
  return new Map(infos.map((info) => [info.name, "options" in info ? info.options : {}]));
}

beforeAll(async () => {
  const db = client().db(database);
  for (const name of STATE_COLLECTIONS) {
    await db.command({ create: name, clusteredIndex: { key: { _id: 1 }, unique: true } });
  }
  await db.command({
    create: "patients",
    encryptedFields: {
      fields: [
        { path: "ssn", bsonType: "string", keyId: new UUID(), queries: { queryType: "equality" } },
      ],
    },
  });
  // Stand-ins for an encrypted value (BSON binary subtype 6) and the tags the server
  // keeps next to it. QE collections have an implicit validator that only real
  // payloads pass, so the stand-ins are written like a restore writes documents: with
  // bypassDocumentValidation.
  await db.collection<AnyDocument>("patients").insertOne(
    {
      _id: 1,
      name: "Ada",
      ssn: new Binary(Buffer.alloc(48, 1), 6),
      __safeContent__: [new Binary(Buffer.alloc(32, 9), 0)],
    },
    { bypassDocumentValidation: true },
  );
  await db
    .collection<{ _id: Binary }>("enxcol_.patients.esc")
    .insertOne({ _id: new Binary(Buffer.alloc(32, 1)) });
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await client().db(restored).dropDatabase();
});

describe("backing up and restoring a Queryable Encryption collection", () => {
  it("restores it with its encryptedFields and its state collections", async () => {
    const storage = memoryStorage();
    const logger = warningLogger();
    const result = await runBackup(
      { client: client(), storage, logger, compression: TEST_COMPRESSION, encryption: undefined },
      { include: [`${database}.*`] },
    );
    expect(result.warnings ?? []).toEqual([]);
    expect(logger.warnings.filter((line) => line.includes("Queryable Encryption"))).toEqual([]);

    await runRestore(
      { client: client(), storage, logger: silentLogger },
      { backup: "latest", rename: { [`${database}.*`]: `${restored}.*` } },
    );
    const before = await collectionOptions(database);
    const after = await collectionOptions(restored);
    expect(after.get("patients")?.encryptedFields).toEqual(before.get("patients")?.encryptedFields);
    for (const name of STATE_COLLECTIONS) {
      expect(after.get(name)?.clusteredIndex).toBeDefined();
    }
    const esc = await client().db(restored).collection("enxcol_.patients.esc").countDocuments();
    expect(esc).toBe(1);
    const patient = await client()
      .db(restored)
      .collection<AnyDocument>("patients")
      .findOne({ _id: 1 });
    expect(patient?.ssn).toBeInstanceOf(Binary);
    expect((patient?.ssn as Binary | undefined)?.sub_type).toBe(6);
  });

  it("warns when the selection leaves the state collections out", async () => {
    const storage = memoryStorage();
    const logger = warningLogger();
    const result = await runBackup(
      { client: client(), storage, logger, compression: TEST_COMPRESSION, encryption: undefined },
      { include: [`${database}.patients`] },
    );
    const warning = `${database}.patients uses Queryable Encryption`;
    expect(result.warnings?.some((line) => line.startsWith(warning))).toBe(true);
    expect(logger.warnings.some((line) => line.startsWith(warning))).toBe(true);
  });
});
