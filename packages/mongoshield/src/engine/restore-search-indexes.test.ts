// Unit tests for recreating Atlas Search indexes on restore, with a faked collection
// API (the local test server has no Atlas Search; the "unsupported target" path is
// also covered against a real server in test/integration/search-indexes.test.ts).

import { type Document, MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import type { SearchIndexDefinition } from "../format/metadata.ts";
import type { LogFields, Logger } from "../logger.ts";
import { restoreSearchIndexes, type SearchIndexTarget } from "./restore-search-indexes.ts";

function recordingLogger(): Logger & { readonly warnings: string[]; readonly infos: string[] } {
  const warnings: string[] = [];
  const infos: string[] = [];
  const ignore = (_message: string, _fields?: LogFields): void => {};
  return {
    warnings,
    infos,
    debug: ignore,
    error: ignore,
    info: (message) => infos.push(message),
    warn: (message) => warnings.push(message),
  };
}

/** An Atlas-like collection: remembers what was created; `existing` are already there. */
function atlasCollection(existing: Document[] = []) {
  const created: Document[][] = [];
  const collection: SearchIndexTarget = {
    listSearchIndexes: () => ({ toArray: async () => existing }),
    createSearchIndexes: async (descriptions) => {
      created.push(descriptions);
      return descriptions.map((description) => description.name);
    },
  };
  return { collection, created };
}

const VECTOR_DEFINITION = {
  fields: [{ type: "vector", path: "v", numDimensions: 3, similarity: "cosine" }],
};

const DEFINITIONS: SearchIndexDefinition[] = [
  { name: "default", type: "search", definition: { mappings: { dynamic: true } } },
  { name: "vectors", type: "vectorSearch", definition: VECTOR_DEFINITION },
];

const context = (logger: Logger) => ({ ns: "app.products", logger });

describe("restoreSearchIndexes", () => {
  it("creates every definition in one call and reports them as building in the background", async () => {
    const { collection, created } = atlasCollection();
    const logger = recordingLogger();
    const outcome = await restoreSearchIndexes(collection, DEFINITIONS, context(logger));

    expect(created).toEqual([
      [
        { name: "default", type: "search", definition: { mappings: { dynamic: true } } },
        { name: "vectors", type: "vectorSearch", definition: VECTOR_DEFINITION },
      ],
    ]);
    expect(outcome).toEqual({ status: "created", created: ["default", "vectors"], existing: [] });
    expect(logger.infos).toContain("Search indexes created; building in the background");
  });

  it("keeps a search index the target already has under the same name", async () => {
    const { collection, created } = atlasCollection([{ name: "default", status: "READY" }]);
    const outcome = await restoreSearchIndexes(collection, DEFINITIONS, context(recordingLogger()));
    expect(created.flat().map((description) => description.name)).toEqual(["vectors"]);
    expect(outcome).toEqual({ status: "created", created: ["vectors"], existing: ["default"] });
  });

  it("skips with a warning when the target has no Atlas Search", async () => {
    const unsupported = new MongoServerError({
      message: "$listSearchIndexes stage is only allowed on MongoDB Atlas",
      code: 6047401,
    });
    const collection: SearchIndexTarget = {
      listSearchIndexes: () => ({
        toArray: async () => {
          throw unsupported;
        },
      }),
      createSearchIndexes: async () => {
        throw new Error("must not be called");
      },
    };
    const logger = recordingLogger();
    const outcome = await restoreSearchIndexes(collection, DEFINITIONS, context(logger));
    expect(outcome).toEqual({ status: "unsupported", notCreated: ["default", "vectors"] });
    expect(logger.warnings).toHaveLength(1);
  });

  it("skips with a warning when only createSearchIndexes is missing", async () => {
    const collection: SearchIndexTarget = {
      listSearchIndexes: () => ({ toArray: async () => [] }),
      createSearchIndexes: async () => {
        throw new MongoServerError({ message: "no such command", code: 59 });
      },
    };
    const outcome = await restoreSearchIndexes(collection, DEFINITIONS, context(recordingLogger()));
    expect(outcome.status).toBe("unsupported");
  });

  it("fails when Atlas refuses a definition", async () => {
    const invalid = new MongoServerError({ message: "Invalid index definition", code: 8 });
    const collection: SearchIndexTarget = {
      listSearchIndexes: () => ({ toArray: async () => [] }),
      createSearchIndexes: async () => {
        throw invalid;
      },
    };
    await expect(
      restoreSearchIndexes(collection, DEFINITIONS, context(recordingLogger())),
    ).rejects.toBe(invalid);
  });
  it("fails when listing the search indexes fails for another reason than missing support", async () => {
    const failure = new MongoServerError({ message: "connection reset", code: 6 });
    const collection: SearchIndexTarget = {
      listSearchIndexes: () => ({
        toArray: async () => {
          throw failure;
        },
      }),
      createSearchIndexes: async () => [],
    };
    await expect(
      restoreSearchIndexes(collection, DEFINITIONS, context(recordingLogger())),
    ).rejects.toBe(failure);
  });

  it("creates nothing when every search index exists already", async () => {
    const { collection, created } = atlasCollection([{ name: "default" }, { name: "vectors" }]);
    const outcome = await restoreSearchIndexes(collection, DEFINITIONS, context(recordingLogger()));
    expect(created).toEqual([]);
    expect(outcome).toEqual({ status: "created", created: [], existing: ["default", "vectors"] });
  });
});
