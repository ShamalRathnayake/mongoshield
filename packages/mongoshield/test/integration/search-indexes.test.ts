// Integration tests for Atlas Search / Vector Search index definitions against the
// local test server, which (like every server outside Atlas) has no Atlas Search:
// backups must not notice, and restoring definitions must skip them with a warning
// while restoring everything else. The Atlas side (listing and creating) is covered
// with a faked collection API in the unit tests next to the source.

import { describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { resolveBackupKey } from "../../src/format/layout.ts";
import type { SearchIndexDefinition } from "../../src/format/metadata.ts";
import type { LogFields, Logger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { writeTestBackup } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { entryFor, readObject } from "./backup-test-utils.ts";

const client = useMongoClient();

/** A logger that remembers every message, so tests can check what was (not) said. */
function recordingLogger(): Logger & { readonly warnings: string[] } {
  const warnings: string[] = [];
  const ignore = (_message: string, _fields?: LogFields): void => {};
  return {
    warnings,
    debug: ignore,
    info: ignore,
    error: ignore,
    warn: (message) => warnings.push(message),
  };
}

const DEFINITIONS: SearchIndexDefinition[] = [
  { name: "default", type: "search", definition: { mappings: { dynamic: true } } },
  {
    name: "embeddings",
    type: "vectorSearch",
    definition: {
      fields: [{ type: "vector", path: "embedding", numDimensions: 3, similarity: "cosine" }],
    },
  },
];

describe("search indexes on a server without Atlas Search", () => {
  it("backs up silently, writing metadata files without searchIndexes", async () => {
    const database = uniqueDb("srch");
    await client()
      .db(database)
      .collection("products")
      .insertMany([{ name: "a" }, { name: "b" }]);
    await client().db(database).collection("products").createIndex({ name: 1 });

    const storage = memoryStorage();
    const logger = recordingLogger();
    const result = await runBackup(
      { client: client(), storage, logger, compression: "gzip", encryption: undefined },
      { include: [`${database}.*`], consistency: "none" },
    );

    expect(logger.warnings).toEqual([]);
    const entry = entryFor(result.manifest, `${database}.products`);
    const metadata = await readObject(storage, resolveBackupKey(result.id, entry.metadata.key));
    expect(metadata.toString("utf8")).not.toContain("searchIndexes");
  });

  it("restores the collection and skips its search indexes with a warning", async () => {
    const source = uniqueDb("srcs");
    const target = uniqueDb("srct");
    const storage = memoryStorage();
    await writeTestBackup(storage, {
      namespaces: [
        {
          ns: `${source}.products`,
          documents: [{ _id: 1, name: "a" }],
          indexes: [
            { v: 2, key: { _id: 1 }, name: "_id_" },
            { v: 2, key: { name: 1 }, name: "name_1" },
          ],
          searchIndexes: DEFINITIONS,
        },
      ],
    });

    const logger = recordingLogger();
    const result = await runRestore(
      { client: client(), storage, logger },
      { backup: "latest", rename: { [`${source}.*`]: `${target}.*` } },
    );

    expect(result.documentsRestored).toBe(1);
    const indexes = await client().db(target).collection("products").listIndexes().toArray();
    expect(indexes.map((index) => index.name).sort()).toEqual(["_id_", "name_1"]);
    expect(result.searchIndexes).toEqual({
      created: [],
      notCreated: [
        { ns: `${target}.products`, name: "default" },
        { ns: `${target}.products`, name: "embeddings" },
      ],
    });
    expect(logger.warnings.some((warning) => warning.includes("Atlas Search"))).toBe(true);
  });

  it("does not touch search indexes with skipSearchIndexes", async () => {
    const source = uniqueDb("srss");
    const target = uniqueDb("srst");
    const storage = memoryStorage();
    await writeTestBackup(storage, {
      namespaces: [
        { ns: `${source}.products`, documents: [{ _id: 1 }], searchIndexes: DEFINITIONS },
      ],
    });

    const logger = recordingLogger();
    const result = await runRestore(
      { client: client(), storage, logger },
      {
        backup: "latest",
        rename: { [`${source}.*`]: `${target}.*` },
        skipSearchIndexes: true,
      },
    );

    expect(result.documentsRestored).toBe(1);
    expect(result.searchIndexes).toBeUndefined();
    expect(logger.warnings).toEqual([]);
  });
});
