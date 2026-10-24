// Property tests: the in-process filter evaluator (src/engine/filter.ts) must select
// exactly the documents that `collection.find(filter)` selects on a real server, for
// random documents and random filters built from the supported operators.
//
// Documents are read back as raw BSON and deserialized like a backup's documents
// (LOSSLESS_DESERIALIZE_OPTIONS), so the evaluator sees Int32 / Long / Double /
// Decimal128 objects exactly as find() over a backup would.

import fc from "fast-check";
import {
  Binary,
  BSON,
  BSONRegExp,
  BSONSymbol,
  Decimal128,
  type Document,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "mongodb";
import { describe, expect, it } from "vitest";
import { compileFilter } from "../../src/engine/filter.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "../../src/format/bson-stream.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** Each run inserts up to 25 random documents and compares 10 random filters. */
const PROPERTY_RUNS = Number(process.env.FIND_PROPERTY_RUNS ?? 150);

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Scalars chosen to hit the interesting comparisons: across numeric types, NaN, -0, … */
const scalars: readonly unknown[] = [
  new Int32(0),
  new Int32(1),
  new Int32(-1),
  new Int32(2),
  new Double(1),
  new Double(1.5),
  new Double(-0),
  new Double(Number.NaN),
  new Double(Number.POSITIVE_INFINITY),
  Long.fromNumber(1),
  Long.fromString("9007199254740993"),
  new Double(9007199254740992),
  Decimal128.fromString("1.0"),
  Decimal128.fromString("1.5"),
  Decimal128.fromString("-Infinity"),
  "",
  "a",
  "ab",
  "b",
  "B",
  "é",
  "😀",
  "",
  new BSONSymbol("a"),
  true,
  false,
  null,
  new Date(0),
  new Date(1_700_000_000_000),
  new ObjectId("64b7f0000000000000000001"),
  new ObjectId("64b7f0000000000000000002"),
  new Timestamp({ t: 1, i: 2 }),
  new Binary(Buffer.from("ab"), 0),
  new Binary(Buffer.from("b"), 4),
  new BSONRegExp("a", "i"),
  new MinKey(),
  new MaxKey(),
  // Plain JavaScript values, as hand-written filters use them.
  1,
  -0.5,
  /^a/i,
];

const scalar = fc.constantFrom(...scalars);
const fieldName = fc.constantFrom("a", "b", "c");

/** Values nested at most two levels deep: scalars, arrays and small documents. */
const value: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { arbitrary: scalar, weight: 4 },
    { arbitrary: fc.array(tie("value"), { maxLength: 3 }), weight: 2 },
    { arbitrary: fc.dictionary(fieldName, tie("value"), { maxKeys: 3 }), weight: 2 },
  ),
})).value;

const documentBody = fc.dictionary(fieldName, value, { maxKeys: 3 });

const path = fc.constantFrom(
  "a",
  "b",
  "c",
  "a.b",
  "a.c",
  "a.0",
  "a.1",
  "a.b.c",
  "a.0.b",
  "b.a",
  "a.b.0",
);

const comparison = fc.constantFrom("$eq", "$ne", "$gt", "$gte", "$lt", "$lte");
const typeName = fc.constantFrom(
  "double",
  "string",
  "object",
  "array",
  "binData",
  "objectId",
  "bool",
  "date",
  "null",
  "regex",
  "int",
  "timestamp",
  "long",
  "decimal",
  "number",
  "symbol",
  "minKey",
  "maxKey",
);
const regexPattern = fc.constantFrom("^a", "b", ".", "^$", "é", "^.$", "A", "a|b");

/** One operator applied to a field: `{ $gt: 1 }`, `{ $in: [...] }`, … */
const fieldOperators: fc.Arbitrary<Document> = fc.letrec<{ operators: Document }>((tie) => ({
  operators: fc.oneof(
    { depthSize: "small" },
    fc.tuple(comparison, value).map(([operator, operand]) => ({ [operator]: operand })),
    fc.array(value, { maxLength: 3 }).map((items) => ({ $in: items })),
    fc.array(value, { maxLength: 3 }).map((items) => ({ $nin: items })),
    fc.boolean().map((exists) => ({ $exists: exists })),
    typeName.map((type) => ({ $type: type })),
    fc.array(typeName, { minLength: 1, maxLength: 2 }).map((types) => ({ $type: types })),
    fc
      .tuple(regexPattern, fc.constantFrom("", "i"))
      .map(([pattern, options]) =>
        options === "" ? { $regex: pattern } : { $regex: pattern, $options: options },
      ),
    fc.integer({ min: 0, max: 3 }).map((size) => ({ $size: size })),
    fc.constantFrom(1, 2, 3, 4, 8, 10, 16, 18, 19).map((code) => ({ $type: code })),
    fc.constantFrom(0, 1).map((exists) => ({ $exists: exists })),
    fc
      .array(
        fc.oneof(
          scalar,
          regexPattern.map((pattern) => new BSONRegExp(pattern)),
        ),
        {
          maxLength: 3,
        },
      )
      .map((items) => ({ $in: items })),
    regexPattern.map((pattern) => ({ $not: new BSONRegExp(pattern, "i") })),
    fc
      .tuple(comparison, scalar, comparison, scalar)
      .map(([first, low, second, high]) => ({ $elemMatch: { [first]: low, [second]: high } })),
    tie("operators").map((inner) => ({ $elemMatch: inner })),
    fc.tuple(comparison, scalar, comparison, scalar).map(([first, low, second, high]) => ({
      [first]: low,
      [second]: high,
    })),
    fc.tuple(comparison, scalar).map(([operator, operand]) => ({
      $elemMatch: { [operator]: operand },
    })),
    tie("operators").map((inner) => ({ $not: inner })),
  ),
})).operators;

/** A filter document: field conditions, possibly combined with $and / $or / $nor. */
const filter: fc.Arbitrary<Document> = fc.letrec<{ filter: Document }>((tie) => ({
  filter: fc.oneof(
    { depthSize: "small", maxDepth: 2 },
    {
      arbitrary: fc.tuple(path, value).map(([field, operand]) => ({ [field]: operand })),
      weight: 2,
    },
    {
      arbitrary: fc
        .tuple(path, fieldOperators)
        .map(([field, operators]) => ({ [field]: operators })),
      weight: 4,
    },
    fc
      .tuple(path, tie("filter"))
      .map(([field, inner]) => ({ [field.split(".")[0] ?? "a"]: { $elemMatch: inner } })),
    fc
      .tuple(
        fc.constantFrom("$and", "$or", "$nor"),
        fc.array(tie("filter"), { minLength: 1, maxLength: 3 }),
      )
      .map(([operator, clauses]) => ({ [operator]: clauses })),
  ),
})).filter;

// ---------------------------------------------------------------------------
// Running both
// ---------------------------------------------------------------------------

/** The `_id`s the server returns for `filter`, or undefined when it rejects the filter. */
async function serverMatches(collectionName: string, database: string, query: Document) {
  try {
    const found = await client()
      .db(database)
      .collection(collectionName)
      .find(query, { projection: { _id: 1 } })
      .toArray();
    return found.map((document) => Number(document._id)).sort((x, y) => x - y);
  } catch {
    return undefined;
  }
}

/** The stored documents, deserialized exactly like a backup's documents. */
async function storedDocuments(database: string, collectionName: string): Promise<Document[]> {
  const raw = await client()
    .db(database)
    .collection(collectionName)
    .find({}, { raw: true })
    .toArray();
  return raw.map((bytes) =>
    BSON.deserialize(bytes as unknown as Uint8Array, LOSSLESS_DESERIALIZE_OPTIONS),
  );
}

function evaluatorMatches(documents: readonly Document[], query: Document): number[] {
  const matches = compileFilter(query);
  return documents
    .filter((document) => matches(document))
    .map((document) => Number(document._id))
    .sort((x, y) => x - y);
}

describe("filter evaluator vs. the server", () => {
  it("selects the same documents as collection.find for random documents and filters", async () => {
    const database = uniqueDb("filter");
    const collectionName = "docs";
    let compared = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.array(documentBody, { minLength: 1, maxLength: 25 }),
        fc.array(filter, { minLength: 10, maxLength: 10 }),
        async (bodies, queries) => {
          const collection = client().db(database).collection(collectionName);
          await collection.deleteMany({});
          await collection.insertMany(
            bodies.map((body, index): Document => ({ ...body, _id: index })),
          );
          const documents = await storedDocuments(database, collectionName);

          for (const query of queries) {
            const expected = await serverMatches(collectionName, database, query);
            if (expected === undefined) continue; // the server rejected the filter
            compared += 1;
            const actual = evaluatorMatches(documents, query);
            if (actual.join(",") !== expected.join(",")) {
              throw new Error(
                `filter ${BSON.EJSON.stringify(query)}\nserver ${expected.join(",")}\nevaluator ${actual.join(",")}\ndocuments ${BSON.EJSON.stringify(documents)}`,
              );
            }
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
    expect(compared).toBeGreaterThan(PROPERTY_RUNS * 7);
  }, 300_000);
});
