// Unit tests for preparing index definitions and collection options for restore.

import { Int32 } from "mongodb";
import { describe, expect, it } from "vitest";
import { commandWriteConcern, createOptionsFrom } from "./restore-collections.ts";
import { prepareIndexSpecs, withoutExistingIndexes } from "./restore-indexes.ts";

describe("prepareIndexSpecs", () => {
  it("skips the _id index and clustered indexes", () => {
    const specs = prepareIndexSpecs(
      [
        { v: 2, key: { _id: 1 }, name: "_id_" },
        { v: 2, key: { _id: 1 }, name: "by_id", unique: true, clustered: true },
        { v: 2, key: { a: 1 }, name: "a_1" },
      ],
      {},
    );
    expect(specs).toEqual([{ key: { a: 1 }, name: "a_1" }]);
  });

  it("strips v, ns and background but keeps every other option", () => {
    const index = {
      v: 1,
      ns: "app.users",
      background: true,
      key: { email: 1 },
      name: "email_1",
      unique: true,
      sparse: true,
      partialFilterExpression: { email: { $exists: true } },
      expireAfterSeconds: new Int32(60),
      hidden: true,
    };
    const [spec] = prepareIndexSpecs([index], {});
    expect(spec).toEqual({
      key: { email: 1 },
      name: "email_1",
      unique: true,
      sparse: true,
      partialFilterExpression: { email: { $exists: true } },
      expireAfterSeconds: new Int32(60),
      hidden: true,
    });
  });

  it("keeps text, 2dsphere and wildcard index options unchanged", () => {
    const text = {
      v: 2,
      key: { _fts: "text", _ftsx: 1 },
      name: "body_text",
      weights: { body: 1 },
      default_language: "english",
      language_override: "language",
      textIndexVersion: 3,
    };
    const geo = { v: 2, key: { loc: "2dsphere" }, name: "loc_2dsphere", "2dsphereIndexVersion": 3 };
    const wildcard = {
      v: 2,
      key: { "$**": 1 },
      name: "$**_1",
      wildcardProjection: { secret: 0 },
    };
    const specs = prepareIndexSpecs([text, geo, wildcard], {});
    expect(specs.map((spec) => Object.keys(spec))).toEqual([
      ["key", "name", "weights", "default_language", "language_override", "textIndexVersion"],
      ["key", "name", "2dsphereIndexVersion"],
      ["key", "name", "wildcardProjection"],
    ]);
  });

  it("gives indexes without a collation the simple collation when the collection has a default collation", () => {
    const collation = { locale: "fr", strength: 2 };
    const specs = prepareIndexSpecs(
      [
        { v: 2, key: { a: 1 }, name: "a_1" },
        { v: 2, key: { b: 1 }, name: "b_1", collation },
      ],
      { collation },
    );
    expect(specs).toEqual([
      { key: { a: 1 }, name: "a_1", collation: { locale: "simple" } },
      { key: { b: 1 }, name: "b_1", collation },
    ]);
  });

  it("leaves collations alone when the collection has no default collation", () => {
    expect(prepareIndexSpecs([{ v: 2, key: { a: 1 }, name: "a_1" }], {})).toEqual([
      { key: { a: 1 }, name: "a_1" },
    ]);
  });

  it("does not modify the input documents", () => {
    const index = { v: 2, key: { a: 1 }, name: "a_1" };
    prepareIndexSpecs([index], { collation: { locale: "fr" } });
    expect(index).toEqual({ v: 2, key: { a: 1 }, name: "a_1" });
  });
});

describe("withoutExistingIndexes", () => {
  it("drops specs whose name and key already exist, comparing numbers by value", () => {
    const specs = [
      { key: { meta: 1, time: 1 }, name: "meta_1_time_1" },
      { key: { a: 1 }, name: "a_1" },
    ];
    const existing = [
      { v: 2, key: { meta: new Int32(1), time: new Int32(1) }, name: "meta_1_time_1" },
    ];
    expect(withoutExistingIndexes(specs, existing)).toEqual([{ key: { a: 1 }, name: "a_1" }]);
  });

  it("keeps a spec whose key field order differs (a different compound index)", () => {
    const specs = [{ key: { a: 1, b: 1 }, name: "ab" }];
    expect(withoutExistingIndexes(specs, [{ key: { b: 1, a: 1 }, name: "ab" }])).toEqual(specs);
  });
});

describe("createOptionsFrom", () => {
  it("keeps creation options and removes the ones create() rejects", () => {
    const options = {
      capped: true,
      size: 4096,
      max: 10,
      validator: { a: { $type: "int" } },
      validationLevel: "moderate",
      collation: { locale: "fr" },
      changeStreamPreAndPostImages: { enabled: true },
      autoIndexId: true,
      flags: 1,
      recordPreImages: false,
      timeseriesBucketsMayHaveMixedSchemaData: false,
      temp: false,
    };
    expect(createOptionsFrom(options)).toEqual({
      capped: true,
      size: 4096,
      max: 10,
      validator: { a: { $type: "int" } },
      validationLevel: "moderate",
      collation: { locale: "fr" },
      changeStreamPreAndPostImages: { enabled: true },
    });
  });
});

describe("commandWriteConcern", () => {
  it("translates driver option names to the server's wire names", () => {
    expect(commandWriteConcern({ w: "majority", journal: true, wtimeoutMS: 500 })).toEqual({
      writeConcern: { w: "majority", j: true, wtimeout: 500 },
    });
    expect(commandWriteConcern({ w: 1, fsync: 1 })).toEqual({ writeConcern: { w: 1, j: true } });
  });

  it("adds nothing when no write concern is given", () => {
    expect(commandWriteConcern(undefined)).toEqual({});
    expect(commandWriteConcern({})).toEqual({});
  });
});
