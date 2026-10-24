import { Binary, BSONRegExp, Decimal128, Double, Int32, Long, UUID } from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import {
  type CollectionMetadata,
  formatCollectionUuid,
  parseCollectionMetadata,
  serializeCollectionMetadata,
} from "./metadata.ts";

const USERS: CollectionMetadata = {
  collectionName: "users",
  type: "collection",
  options: {
    validator: { email: new BSONRegExp("@", "i") },
    collation: { locale: "en", strength: new Int32(2) },
  },
  indexes: [
    { v: new Int32(2), key: { _id: new Int32(1) }, name: "_id_" },
    {
      v: new Int32(2),
      key: { createdAt: new Int32(-1) },
      name: "createdAt_-1",
      expireAfterSeconds: Long.fromNumber(3600),
      partialFilterExpression: {
        createdAt: { $gte: new Date("2026-01-01T00:00:00Z") },
        score: { $gt: new Double(1) },
        price: { $lt: Decimal128.fromString("9.99") },
      },
    },
  ],
  uuid: "0f3b0c2e9d7a4c1b8e6f5a4d3c2b1a09",
};

function errorFrom(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("serializeCollectionMetadata", () => {
  it("writes canonical Extended JSON with fields in mongodump's order", () => {
    const text = serializeCollectionMetadata(USERS);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "options",
      "indexes",
      "uuid",
      "collectionName",
      "type",
    ]);
    expect(text).not.toContain("\n");
    expect(text).toContain('"v":{"$numberInt":"2"}');
    expect(text).toContain('"expireAfterSeconds":{"$numberLong":"3600"}');
    expect(text).toContain('"$gt":{"$numberDouble":"1.0"}');
    expect(text).toContain('"$date":{"$numberLong":"1767225600000"}');
    expect(text).toContain('"$regularExpression":{"pattern":"@","options":"i"}');
  });

  it("matches the shape mongodump writes for a plain collection", () => {
    const text = serializeCollectionMetadata({
      collectionName: "test",
      type: "collection",
      options: {},
      indexes: [{ v: new Int32(2), key: { _id: new Int32(1) }, name: "_id_" }],
      uuid: "8a3d0b6e2f1c4b5a9e7d6c5b4a392817",
    });
    expect(text).toBe(
      '{"options":{},"indexes":[{"v":{"$numberInt":"2"},"key":{"_id":{"$numberInt":"1"}},"name":"_id_"}],' +
        '"uuid":"8a3d0b6e2f1c4b5a9e7d6c5b4a392817","collectionName":"test","type":"collection"}',
    );
  });

  it("omits the uuid when it is unknown, like mongodump", () => {
    const { uuid: _uuid, ...withoutUuid } = USERS;
    expect(JSON.parse(serializeCollectionMetadata(withoutUuid))).not.toHaveProperty("uuid");
  });

  it.each(["0F3B0C2E9D7A4C1B8E6F5A4D3C2B1A09", "0f3b0c2e-9d7a-4c1b-8e6f-5a4d3c2b1a09", "abc"])(
    "refuses to write the malformed uuid %s",
    (uuid) => {
      const error = errorFrom(() => serializeCollectionMetadata({ ...USERS, uuid }));
      expect(isMongoShieldError(error, "MS_INTERNAL")).toBe(true);
    },
  );
});

describe("parseCollectionMetadata", () => {
  it("round-trips every BSON type exactly", () => {
    const text = serializeCollectionMetadata(USERS);
    const parsed = parseCollectionMetadata(text);
    expect(parsed).toEqual(USERS);
    expect(parsed.indexes[0]?.v).toBeInstanceOf(Int32);
    expect(serializeCollectionMetadata(parsed)).toBe(text);
  });

  it("reads views and time-series collections", () => {
    for (const type of ["view", "timeseries"] as const) {
      const metadata: CollectionMetadata = {
        collectionName: "v",
        type,
        options: { viewOn: "users", pipeline: [{ $match: { a: new Int32(1) } }] },
        indexes: [],
      };
      expect(parseCollectionMetadata(serializeCollectionMetadata(metadata))).toEqual(metadata);
    }
  });

  it("fills in what mongodump may omit: options, indexes and type", () => {
    expect(parseCollectionMetadata('{"collectionName":"old"}')).toEqual({
      collectionName: "old",
      type: "collection",
      options: {},
      indexes: [],
    });
  });

  it("accepts an uppercase uuid and normalises it to lowercase", () => {
    const parsed = parseCollectionMetadata(
      '{"indexes":[],"uuid":"0F3B0C2E9D7A4C1B8E6F5A4D3C2B1A09","collectionName":"u","type":"collection"}',
    );
    expect(parsed.uuid).toBe("0f3b0c2e9d7a4c1b8e6f5a4d3c2b1a09");
  });

  it("ignores unknown extra fields from newer mongodump versions", () => {
    const parsed = parseCollectionMetadata('{"collectionName":"u","somethingNew":true}');
    expect(parsed).not.toHaveProperty("somethingNew");
  });

  it.each([
    ["not JSON", "{nope"],
    ["not an object", "[]"],
    ["missing collectionName", '{"indexes":[]}'],
    ["an empty collectionName", '{"collectionName":""}'],
    ["indexes that are not documents", '{"collectionName":"u","indexes":[1]}'],
    ["a malformed uuid", '{"collectionName":"u","uuid":"xyz"}'],
  ])("reports %s as MS_INTEGRITY_FAILED", (_label, text) => {
    const error = errorFrom(() => parseCollectionMetadata(text, "app/users.metadata.json"));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect((error as Error).message).toContain("app/users.metadata.json");
  });

  it("reports an unknown collection type as MS_FORMAT_UNSUPPORTED", () => {
    const error = errorFrom(() =>
      parseCollectionMetadata('{"collectionName":"u","type":"hologram"}'),
    );
    expect(isMongoShieldError(error, "MS_FORMAT_UNSUPPORTED")).toBe(true);
  });
});

describe("formatCollectionUuid", () => {
  it("formats a UUID as 32 lowercase hex characters without dashes", () => {
    const uuid = new UUID("0f3b0c2e-9d7a-4c1b-8e6f-5a4d3c2b1a09");
    expect(formatCollectionUuid(uuid)).toBe("0f3b0c2e9d7a4c1b8e6f5a4d3c2b1a09");
  });

  it("rejects binaries that are not 16 bytes", () => {
    const error = errorFrom(() => formatCollectionUuid(new Binary(Buffer.alloc(8), 4)));
    expect(isMongoShieldError(error, "MS_INTERNAL")).toBe(true);
  });
});

describe("search index definitions", () => {
  const withSearch: CollectionMetadata = {
    collectionName: "products",
    type: "collection",
    options: {},
    indexes: [{ v: new Int32(2), key: { _id: new Int32(1) }, name: "_id_" }],
    searchIndexes: [
      { name: "default", type: "search", definition: { mappings: { dynamic: true } } },
      {
        name: "embeddings",
        type: "vectorSearch",
        definition: {
          fields: [
            {
              type: "vector",
              path: "embedding",
              numDimensions: new Int32(3),
              similarity: "cosine",
            },
          ],
        },
      },
    ],
  };

  it("round-trips search and vector search indexes with their exact BSON types", () => {
    const text = serializeCollectionMetadata(withSearch);
    expect(parseCollectionMetadata(text)).toEqual(withSearch);
    expect(serializeCollectionMetadata(parseCollectionMetadata(text))).toBe(text);
  });

  it("writes searchIndexes after mongodump's fields, so the rest stays mongodump's shape", () => {
    const text = serializeCollectionMetadata(withSearch);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "options",
      "indexes",
      "collectionName",
      "type",
      "searchIndexes",
    ]);
  });

  it("leaves the field out when there are no search indexes", () => {
    const text = serializeCollectionMetadata({ ...withSearch, searchIndexes: [] });
    expect(text).not.toContain("searchIndexes");
    expect(parseCollectionMetadata(text).searchIndexes).toBeUndefined();
  });

  it("reports an unknown search index type as MS_FORMAT_UNSUPPORTED", () => {
    const text = JSON.stringify({
      collectionName: "products",
      searchIndexes: [{ name: "x", type: "hybridSearch", definition: {} }],
    });
    const error = errorFrom(() => parseCollectionMetadata(text));
    expect(isMongoShieldError(error, "MS_FORMAT_UNSUPPORTED")).toBe(true);
  });

  it("reports a malformed search index as MS_INTEGRITY_FAILED", () => {
    const text = JSON.stringify({ collectionName: "products", searchIndexes: [{ name: "x" }] });
    const error = errorFrom(() => parseCollectionMetadata(text));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
  });
});
