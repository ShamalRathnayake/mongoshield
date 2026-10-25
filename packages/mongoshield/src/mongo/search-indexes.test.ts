// Unit tests for listing Atlas Search index definitions. The local test server has
// no Atlas Search, so the listing API is faked here; the "unsupported server" path
// is also covered against a real server in test/integration/search-indexes.test.ts.

import { type Document, MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import type { LogFields, Logger } from "../logger.ts";
import {
  isSearchIndexUnsupported,
  listSearchIndexDefinitions,
  type SearchIndexSupport,
  toSearchIndexDefinition,
} from "./search-indexes.ts";

/** A logger that remembers its warnings. */
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

/** A collection whose `listSearchIndexes` returns `result` or throws it. */
function fakeCollection(result: Document[] | Error) {
  let calls = 0;
  return {
    calls: () => calls,
    listSearchIndexes: () => ({
      toArray: async () => {
        calls += 1;
        if (result instanceof Error) throw result;
        return result;
      },
    }),
  };
}

const notAtlas = new MongoServerError({
  message: "$listSearchIndexes stage is only allowed on MongoDB Atlas",
  code: 6047401,
  codeName: "Location6047401",
});

describe("listSearchIndexDefinitions", () => {
  it("keeps name, type and the latest definition, not the status fields", async () => {
    const collection = fakeCollection([
      {
        id: "6650a1",
        name: "default",
        type: "search",
        status: "READY",
        queryable: true,
        latestDefinitionVersion: { version: 2 },
        latestDefinition: { mappings: { dynamic: true } },
        statusDetail: [],
      },
      {
        name: "vectors",
        type: "vectorSearch",
        status: "BUILDING",
        latestDefinition: { fields: [{ type: "vector", path: "v", numDimensions: 3 }] },
      },
    ]);
    const support: SearchIndexSupport = { supported: undefined };
    const definitions = await listSearchIndexDefinitions(collection, {
      ns: "app.products",
      support,
      logger: recordingLogger(),
    });
    expect(definitions).toEqual([
      { name: "default", type: "search", definition: { mappings: { dynamic: true } } },
      {
        name: "vectors",
        type: "vectorSearch",
        definition: { fields: [{ type: "vector", path: "v", numDimensions: 3 }] },
      },
    ]);
    expect(support.supported).toBe(true);
  });

  it("treats a server without Atlas Search as having none, silently, and asks it only once", async () => {
    const collection = fakeCollection(notAtlas);
    const logger = recordingLogger();
    const support: SearchIndexSupport = { supported: undefined };
    const context = { ns: "app.products", support, logger };

    expect(await listSearchIndexDefinitions(collection, context)).toEqual([]);
    expect(await listSearchIndexDefinitions(collection, context)).toEqual([]);
    expect(collection.calls()).toBe(1);
    expect(support.supported).toBe(false);
    expect(logger.warnings).toEqual([]);
  });

  it("warns but does not fail when listing fails for another reason", async () => {
    const unauthorized = new MongoServerError({ message: "not authorized", code: 13 });
    const logger = recordingLogger();
    const definitions = await listSearchIndexDefinitions(fakeCollection(unauthorized), {
      ns: "app.products",
      support: { supported: undefined },
      logger,
    });
    expect(definitions).toEqual([]);
    expect(logger.warnings).toHaveLength(1);
  });

  it("skips, with a warning, an index of a type it cannot recreate", async () => {
    const logger = recordingLogger();
    const definitions = await listSearchIndexDefinitions(
      fakeCollection([{ name: "future", type: "somethingNew", latestDefinition: {} }]),
      { ns: "app.products", support: { supported: undefined }, logger },
    );
    expect(definitions).toEqual([]);
    expect(logger.warnings).toHaveLength(1);
  });
});

describe("toSearchIndexDefinition", () => {
  it("treats an index without a type as a search index (older Atlas versions)", () => {
    expect(
      toSearchIndexDefinition({ name: "default", latestDefinition: { mappings: {} } }),
    ).toEqual({
      name: "default",
      type: "search",
      definition: { mappings: {} },
    });
  });

  it("returns undefined without a name or definition", () => {
    expect(toSearchIndexDefinition({ latestDefinition: {} })).toBeUndefined();
    expect(toSearchIndexDefinition({ name: "default" })).toBeUndefined();
  });
});

describe("isSearchIndexUnsupported", () => {
  it("recognises the errors of servers without Atlas Search", () => {
    expect(isSearchIndexUnsupported(notAtlas)).toBe(true);
    expect(isSearchIndexUnsupported(new MongoServerError({ message: "x", code: 59 }))).toBe(true);
    expect(
      isSearchIndexUnsupported(
        new MongoServerError({ message: "x", codeName: "SearchNotEnabled" }),
      ),
    ).toBe(true);
  });

  it("does not mistake other failures for missing support", () => {
    expect(isSearchIndexUnsupported(new MongoServerError({ message: "x", code: 13 }))).toBe(false);
    expect(isSearchIndexUnsupported(new Error("network"))).toBe(false);
  });
});

describe("listSearchIndexDefinitions on Atlas Free and Flex", () => {
  it("warns once and stops asking when the tier refuses the listing", async () => {
    const refusal = new MongoServerError({
      errmsg: "$listSearchIndexes is not allowed in this atlas tier",
      code: 8000,
      codeName: "AtlasError",
    });
    const collection = fakeCollection(refusal);
    const logger = recordingLogger();
    const support: SearchIndexSupport = { supported: undefined };
    for (const ns of ["app.a", "app.b", "app.c"]) {
      expect(await listSearchIndexDefinitions(collection, { ns, support, logger })).toEqual([]);
    }
    expect(collection.calls()).toBe(1);
    expect(support.supported).toBe(false);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain("Atlas cluster tier refused");
  });
});
