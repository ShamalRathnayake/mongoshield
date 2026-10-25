// Time-series buckets ↔ measurements.
//
// test/fixtures/mongodump/timeseries/mongodb-<version>/ holds, for MongoDB 7.0.32 and
// 8.0.13 (and `mixed` only for 5.3.2, 6.0.20 and 7.0.2): <collection>.buckets.bson (the system.buckets documents mongodump dumps),
// <collection>.measurements.bson (what `find` on the time-series collection returned
// for them, in bucket order) and <collection>.options.json (listCollections options).
// `mixed` has every BSON type, sparse fields, embedded documents and arrays; `runs`
// long runs of equal or evenly spaced values; `unordered` out-of-order inserts
// (version 3 buckets on 8.0, uncompressed version 1 buckets on 7.0). MongoDB 5.3 writes
// embedded documents in the legacy interleaved format (control byte 0xF0, arrays
// as single values); 6.0 and later use 0xF1 / 0xF2.

/** Every fixture: version directory → collections. */
const FIXTURES: Record<string, readonly string[]> = {
  "mongodb-5.3": ["mixed"],
  "mongodb-6.0": ["mixed"],
  "mongodb-7.0.2": ["mixed"],
  "mongodb-7.0": ["mixed", "runs", "unordered"],
  "mongodb-8.0": ["mixed", "runs", "unordered"],
};

import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fc from "fast-check";
import {
  Binary,
  BSON,
  Decimal128,
  type Document,
  Double,
  Int32,
  Long,
  ObjectId,
  Timestamp,
} from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import type { CollectionMetadata } from "../format/metadata.ts";
import type { ColumnValue } from "./bson-column.ts";
import { BsonType } from "./raw-bson.ts";
import { fixturePath, splitBson } from "./test-fixtures.ts";
import {
  BucketPacker,
  compareValues,
  createBucketPacker,
  createBucketUnpacker,
  MAX_BUCKET_MEASUREMENTS,
  type TimeSeriesSettings,
  timeSeriesSettings,
  unpackBucket,
} from "./timeseries-buckets.ts";

function fixture(version: string, collection: string, kind: "buckets" | "measurements"): Buffer[] {
  return splitBson(readFileSync(fixturePath(`timeseries/${version}/${collection}.${kind}.bson`)));
}

function fixtureSettings(version: string, collection: string): TimeSeriesSettings {
  const text = readFileSync(
    fixturePath(`timeseries/${version}/${collection}.options.json`),
    "utf8",
  );
  return timeSeriesSettings(metadataWith(BSON.EJSON.parse(text, { relaxed: false })), collection);
}

function metadataWith(options: Document): CollectionMetadata {
  return { collectionName: "m", type: "timeseries", options, indexes: [] };
}

const SETTINGS: TimeSeriesSettings = {
  timeField: "t",
  metaField: "meta",
  roundingSeconds: 60,
  maxSpanSeconds: 3600,
  hasCollation: false,
};

const BASE = Date.UTC(2026, 0, 1);

/** Marks a measurement without a meta field. */
const NO_META = Symbol("no meta");

function raw(document: Document): Buffer {
  return Buffer.from(BSON.serialize(document));
}

function parse(document: Buffer): Document {
  return BSON.deserialize(document, { promoteValues: false, bsonRegExp: true });
}

/** All buckets of `measurements`, through the packer. */
function pack(measurements: readonly Buffer[], settings = SETTINGS): Buffer[] {
  const packer = new BucketPacker(settings, "app.m");
  const buckets: Buffer[] = [];
  for (const measurement of measurements) {
    const bucket = packer.add(measurement);
    if (bucket !== undefined) buckets.push(bucket);
  }
  const last = packer.finish();
  if (last !== undefined) buckets.push(last);
  expect(packer.buckets).toBe(buckets.length);
  return buckets;
}

function unpackAll(buckets: readonly Buffer[], settings = SETTINGS): Buffer[] {
  return buckets.flatMap((bucket) => unpackBucket(bucket, settings, "app.m"));
}

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("unpackBucket on real dumps", () => {
  for (const [version, collections] of Object.entries(FIXTURES)) {
    for (const collection of collections) {
      it(`rebuilds the measurements find returned (${version}, ${collection})`, () => {
        const settings = fixtureSettings(version, collection);
        const buckets = fixture(version, collection, "buckets");
        const measurements = buckets.flatMap((bucket) =>
          unpackBucket(bucket, settings, collection),
        );
        expect(measurements).toEqual(fixture(version, collection, "measurements"));
      });
    }
  }

  it("covers uncompressed, compressed and unsorted buckets", () => {
    const versions = new Set<number>();
    for (const [version, collections] of Object.entries(FIXTURES)) {
      for (const collection of collections) {
        for (const bucket of fixture(version, collection, "buckets"))
          versions.add(parse(bucket).control.version.valueOf());
      }
    }
    expect([...versions].sort()).toEqual([1, 2, 3]);
  });

  it("covers every interleaved format: legacy 0xF0, 0xF1 and array-rooted 0xF2", () => {
    const controls = new Set<number>();
    for (const [version, collections] of Object.entries(FIXTURES)) {
      for (const collection of collections) {
        for (const bucket of fixture(version, collection, "buckets")) {
          for (const column of Object.values(parse(bucket).data as Record<string, unknown>)) {
            if (column instanceof Binary && column.sub_type === 7)
              controls.add(column.buffer[0] ?? 0);
          }
        }
      }
    }
    expect([0xf0, 0xf1, 0xf2].filter((control) => controls.has(control))).toEqual([
      0xf0, 0xf1, 0xf2,
    ]);
  });

  it("streams buckets into measurements", async () => {
    const settings = fixtureSettings("mongodb-8.0", "runs");
    const output: Buffer[] = [];
    await pipeline(
      Readable.from(fixture("mongodb-8.0", "runs", "buckets")),
      createBucketUnpacker(settings, "runs"),
      new Writable({
        objectMode: true,
        write(measurement: Buffer, _encoding, callback) {
          output.push(measurement);
          callback();
        },
      }),
    );
    expect(output).toEqual(fixture("mongodb-8.0", "runs", "measurements"));
  });
});

describe("unpackBucket on damaged buckets", () => {
  const time = new Date(BASE);
  const valid = {
    _id: new ObjectId(),
    control: { version: 1, min: { t: time }, max: { t: time } },
    data: { t: { "0": time } },
  };

  it.each([
    ["no control", { _id: 1, data: { t: { "0": time } } }, "MS_INTEGRITY_FAILED"],
    ["no data", { _id: 1, control: { version: 1 } }, "MS_INTEGRITY_FAILED"],
    ["an unknown version", { ...valid, control: { version: 4 } }, "MS_FORMAT_UNSUPPORTED"],
    ["no time field", { ...valid, data: { v: { "0": 1 } } }, "MS_INTEGRITY_FAILED"],
    [
      "a field that is not a document",
      { ...valid, data: { t: { "0": time }, v: 5 } },
      "MS_INTEGRITY_FAILED",
    ],
    [
      "a position that is not a number",
      { ...valid, data: { t: { "0": time }, v: { x: 1 } } },
      "MS_INTEGRITY_FAILED",
    ],
    [
      "more values than measurements",
      { ...valid, data: { t: { "0": time }, v: { "3": 1 } } },
      "MS_INTEGRITY_FAILED",
    ],
    ["a gap in the time field", { ...valid, data: { t: { "1": time } } }, "MS_INTEGRITY_FAILED"],
    ["a meta value without metaField", { ...valid, meta: 1 }, "MS_INTEGRITY_FAILED"],
    [
      "a compressed field that is not a column",
      {
        ...valid,
        control: { version: 2, min: {}, max: {}, count: 1 },
        data: { t: new Binary(Buffer.from([0]), 0) },
      },
      "MS_INTEGRITY_FAILED",
    ],
  ] as const)("refuses a bucket with %s", (_name, bucket, code) => {
    const settings = { ...SETTINGS, metaField: undefined };
    const error = failure(() => unpackBucket(raw(bucket), settings, "app.m"));
    expect(isMongoShieldError(error, code)).toBe(true);
  });

  it("reports a damaged bucket as a stream error", async () => {
    const run = pipeline(
      Readable.from([raw({ _id: 1 })]),
      createBucketUnpacker(SETTINGS, "app.m"),
      new Writable({ objectMode: true, write: (_chunk, _encoding, callback) => callback() }),
    );
    await expect(run).rejects.toMatchObject({ code: "MS_INTEGRITY_FAILED" });
  });
});

describe("timeSeriesSettings", () => {
  it("uses the granularity presets", () => {
    for (const [granularity, roundingSeconds, maxSpanSeconds] of [
      ["seconds", 60, 3600],
      ["minutes", 3600, 86_400],
      ["hours", 86_400, 2_592_000],
      [undefined, 60, 3600],
      ["fortnights", 60, 3600],
    ] as const) {
      const settings = timeSeriesSettings(
        metadataWith({ timeseries: { timeField: "t", granularity } }),
        "x",
      );
      expect(settings).toMatchObject({
        roundingSeconds,
        maxSpanSeconds,
        metaField: undefined,
        hasCollation: false,
      });
    }
  });

  it("prefers explicit bucket seconds, in any numeric type", () => {
    for (const value of [7200, new Int32(7200), Long.fromNumber(7200), new Double(7200)]) {
      const settings = timeSeriesSettings(
        metadataWith({
          timeseries: {
            timeField: "t",
            metaField: "m",
            bucketRoundingSeconds: value,
            bucketMaxSpanSeconds: value,
          },
        }),
        "x",
      );
      expect(settings).toMatchObject({
        roundingSeconds: 7200,
        maxSpanSeconds: 7200,
        metaField: "m",
      });
    }
  });

  it("notices a non-simple collation", () => {
    const withCollation = (collation: Document) =>
      timeSeriesSettings(metadataWith({ timeseries: { timeField: "t" }, collation }), "x")
        .hasCollation;
    expect(withCollation({ locale: "fr" })).toBe(true);
    expect(withCollation({ locale: "simple" })).toBe(false);
  });

  it("refuses metadata without a time field", () => {
    const error = failure(() => timeSeriesSettings(metadataWith({ timeseries: {} }), "app.m"));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect(
      isMongoShieldError(
        failure(() => timeSeriesSettings(metadataWith({}), "app.m")),
        "MS_INTEGRITY_FAILED",
      ),
    ).toBe(true);
  });
});

describe("BucketPacker", () => {
  /** A measurement at BASE + `seconds`; `meta` NO_META leaves the meta field out. */
  const measurement = (seconds: number, fields: Document = {}, meta: unknown = "a"): Buffer =>
    raw({ t: new Date(BASE + seconds * 1000), ...(meta === NO_META ? {} : { meta }), ...fields });

  it("builds version 1 buckets that unpack to the same measurements", () => {
    const input = Array.from({ length: 30 }, (_, index) =>
      measurement(index, { _id: new ObjectId(), v: new Int32(index), s: `x${index % 3}` }),
    );
    const buckets = pack(input);
    expect(buckets).toHaveLength(1);
    expect(unpackAll(buckets)).toEqual(input);
    const bucket = parse(buckets[0] ?? Buffer.alloc(0));
    expect(bucket.control.version.valueOf()).toBe(1);
    expect(bucket.control.min.t).toEqual(new Date(BASE));
    expect(bucket.control.max.t).toEqual(new Date(BASE + 29_000));
    expect(bucket.control.min.v.valueOf()).toBe(0);
    expect(bucket.control.max.v.valueOf()).toBe(29);
    expect(bucket.control.min.s).toBe("x0");
    expect(bucket.control.max.s).toBe("x2");
    expect(bucket.meta).toBe("a");
    // The bucket id's timestamp is its rounded start, as the server requires.
    expect(bucket._id.getTimestamp()).toEqual(new Date(BASE));
  });

  it("rounds the bucket start down and starts a new bucket after the maximum span", () => {
    const buckets = pack([measurement(59), measurement(61), measurement(3659), measurement(3661)]);
    expect(buckets.map((bucket) => parse(bucket).control.min.t)).toEqual([
      new Date(BASE),
      new Date(BASE + 3_600_000),
    ]);
    // A measurement before the open bucket's start goes into a new one, too.
    expect(pack([measurement(120), measurement(30)])).toHaveLength(2);
  });

  it("keeps different meta values (and none) apart", () => {
    const buckets = pack([
      measurement(1, {}, "a"),
      measurement(2, {}, "b"),
      measurement(3, {}, NO_META),
      measurement(4, {}, NO_META),
      measurement(5, {}, { x: 1 }),
    ]);
    expect(buckets.map((bucket) => parse(bucket).meta)).toEqual([
      "a",
      "b",
      undefined,
      { x: new Int32(1) },
    ]);
  });

  it("starts a new bucket when a field changes type or holds a value without a simple order", () => {
    expect(
      pack([measurement(1, { v: new Int32(1) }), measurement(2, { v: new Double(1.5) })]),
    ).toHaveLength(2);
    // Embedded documents, arrays, decimals, binary data…: at most one per field and bucket.
    expect(pack([measurement(1, { v: { a: 1 } }), measurement(2, { v: { a: 2 } })])).toHaveLength(
      2,
    );
    expect(
      pack([measurement(1, { v: [1] }), measurement(2, { w: [1] }), measurement(3)]),
    ).toHaveLength(1);
    // With a collation, strings compare by it: they are not combined either.
    const collated = { ...SETTINGS, hasCollation: true };
    expect(pack([measurement(1, { s: "a" }), measurement(2, { s: "B" })], collated)).toHaveLength(
      2,
    );
    expect(pack([measurement(1, { s: "a" }), measurement(2, { s: "B" })])).toHaveLength(1);
  });

  it("keeps each measurement's field order", () => {
    // b before a cannot join a bucket whose columns are a, b; a field new to the
    // bucket can only come after the known ones.
    const input = [
      measurement(1, { a: 1, b: 2 }),
      measurement(2, { a: 1, b: 2 }),
      measurement(3, { b: 2, a: 1 }),
      measurement(4, { a: 1 }),
      measurement(5, { a: 1, c: 3 }),
      measurement(6, { c: 3, a: 1 }),
    ];
    const buckets = pack(input);
    expect(unpackAll(buckets)).toEqual(input);
    expect(buckets).toHaveLength(3);
  });

  it("closes buckets at 1000 measurements and at 125 KiB of data", () => {
    const many = Array.from({ length: MAX_BUCKET_MEASUREMENTS + 1 }, (_, index) =>
      measurement((index % 3000) / 1000),
    );
    expect(pack(many)).toHaveLength(2);
    const large = Array.from({ length: 3 }, (_, index) =>
      measurement(index, { pad: "p".repeat(60 * 1024) }),
    );
    expect(pack(large, { ...SETTINGS, hasCollation: false })).toHaveLength(2);
  });

  it("bounds doubles with NaN below every number and -0 equal to 0", () => {
    const buckets = pack([
      measurement(1, { d: new Double(0) }),
      measurement(2, { d: new Double(Number.NaN) }),
      measurement(3, { d: new Double(-0) }),
      measurement(4, { d: new Double(-1) }),
    ]);
    const { control } = parse(buckets[0] ?? Buffer.alloc(0));
    expect(Number.isNaN(control.min.d.valueOf())).toBe(true);
    expect(Object.is(control.max.d.valueOf(), 0)).toBe(true);
  });

  it("refuses measurements a bucket cannot hold", () => {
    const packer = new BucketPacker(SETTINGS, "app.m");
    expect(
      isMongoShieldError(
        failure(() => packer.add(raw({ t: 5 }))),
        "MS_INTEGRITY_FAILED",
      ),
    ).toBe(true);
    expect(
      isMongoShieldError(
        failure(() => packer.add(raw({ t: new Date(-1000) }))),
        "MS_FORMAT_UNSUPPORTED",
      ),
    ).toBe(true);
    expect(
      isMongoShieldError(
        failure(() => packer.add(raw({ t: new Date(2 ** 33 * 1000) }))),
        "MS_FORMAT_UNSUPPORTED",
      ),
    ).toBe(true);
    // A 6 MiB value appears three times in its bucket (data, min, max): more than 16 MiB.
    packer.add(raw({ t: new Date(BASE), big: "b".repeat(6 * 1024 * 1024) }));
    expect(
      isMongoShieldError(
        failure(() => packer.finish()),
        "MS_FORMAT_UNSUPPORTED",
      ),
    ).toBe(true);
    expect(packer.finish()).toBeUndefined();
  });

  it("streams measurements into buckets, and reports errors on the stream", async () => {
    const buckets: Buffer[] = [];
    const sink = new Writable({
      objectMode: true,
      write(bucket: Buffer, _encoding, callback) {
        buckets.push(bucket);
        callback();
      },
    });
    const input = [measurement(1, {}, "a"), measurement(2, {}, "b")];
    await pipeline(Readable.from(input), createBucketPacker(SETTINGS, "app.m"), sink);
    expect(unpackAll(buckets)).toEqual(input);
    const broken = pipeline(
      Readable.from([raw({ t: 1 })]),
      createBucketPacker(SETTINGS, "app.m"),
      new Writable({ objectMode: true, write: (_chunk, _encoding, callback) => callback() }),
    );
    await expect(broken).rejects.toMatchObject({ code: "MS_INTEGRITY_FAILED" });
    const huge = pipeline(
      Readable.from([raw({ t: new Date(BASE), big: "b".repeat(6 * 1024 * 1024) })]),
      createBucketPacker(SETTINGS, "app.m"),
      new Writable({ objectMode: true, write: (_chunk, _encoding, callback) => callback() }),
    );
    await expect(huge).rejects.toMatchObject({ code: "MS_FORMAT_UNSUPPORTED" });
  });

  it("produces exact bounds and loses nothing, whatever the measurements (property)", () => {
    const value = fc.oneof(
      fc.integer({ min: -1000, max: 1000 }).map((n) => new Int32(n)),
      fc.integer({ min: -1000, max: 1000 }).map((n) => Long.fromNumber(n * 1e9)),
      fc.double({ noDefaultInfinity: false }).map((n) => new Double(n)),
      fc.string({ maxLength: 5 }),
      fc.boolean(),
      fc.integer({ min: 0, max: 1e12 }).map((n) => new Date(n)),
      fc.integer({ min: 0, max: 1000 }).map((n) => new Timestamp({ t: n, i: n % 7 })),
      fc.constant(null),
      fc.integer({ min: 0, max: 99 }).map((n) => Decimal128.fromString(`${n}.5`)),
      fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 3 }),
      fc.record({ x: fc.integer({ min: 0, max: 9 }) }),
    );
    const fields = fc.dictionary(fc.constantFrom("a", "b", "c", "d"), value, { maxKeys: 4 });
    const measurements = fc.array(
      fc.record({
        step: fc.integer({ min: -100, max: 2000 }),
        meta: fc.constantFrom<unknown>("x", "y", NO_META),
        fields,
      }),
      { maxLength: 60 },
    );
    fc.assert(
      fc.property(measurements, (items) => {
        let seconds = 100_000;
        const input = items.map((item) => {
          seconds = Math.max(0, seconds + item.step);
          return measurement(seconds, item.fields, item.meta);
        });
        const buckets = pack(input);
        expect(unpackAll(buckets)).toEqual(input);
        for (const bucket of buckets) expectExactBounds(bucket);
      }),
      { numRuns: 200 },
    );
  });
});

/** Every value of a field lies between the field's control.min and control.max. */
function expectExactBounds(bucket: Buffer): void {
  const { control, data } = BSON.deserialize(bucket, { promoteValues: false, bsonRegExp: true });
  for (const [field, values] of Object.entries(data as Record<string, Document>)) {
    if (field === "t") continue;
    const all = Object.values(values);
    const min = control.min[field];
    const max = control.max[field];
    if (all.length === 1) {
      // One value: it is its own bound (embedded documents and arrays included).
      expect(BSON.EJSON.stringify(min)).toBe(BSON.EJSON.stringify(all[0]));
      expect(BSON.EJSON.stringify(max)).toBe(BSON.EJSON.stringify(all[0]));
      continue;
    }
    // Several values: all of one orderable kind.
    expect(new Set(all.map(kindOf)).size).toBe(1);
    expect(kindOf(all[0])).not.toBe("single");
    const kind = kindOf(all[0]);
    for (const one of all) {
      expect(compareValues(kind, columnValue(min), columnValue(one))).toBeLessThanOrEqual(0);
      expect(compareValues(kind, columnValue(max), columnValue(one))).toBeGreaterThanOrEqual(0);
    }
  }
}

function kindOf(value: unknown): Parameters<typeof compareValues>[0] {
  if (value instanceof Int32) return "int32";
  if (value instanceof Long) return "int64";
  if (value instanceof Double) return "double";
  if (value instanceof Date) return "date";
  if (value instanceof Timestamp) return "timestamp";
  if (value instanceof ObjectId) return "objectId";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "single";
}

/** A value as the packer sees it: its BSON type and bytes. */
function columnValue(value: unknown): ColumnValue {
  const document = Buffer.from(BSON.serialize({ v: value }));
  const type = document[4] ?? 0;
  return { type, value: document.subarray(7, document.length - 1) };
}

describe("compareValues", () => {
  const ordered: [Parameters<typeof compareValues>[0], unknown, unknown][] = [
    ["int32", new Int32(-5), new Int32(3)],
    ["int64", Long.fromNumber(-5), Long.fromNumber(3)],
    ["date", new Date(-5), new Date(3)],
    ["timestamp", new Timestamp({ t: 1, i: 9 }), new Timestamp({ t: 2, i: 0 })],
    ["double", new Double(Number.NaN), new Double(-1e300)],
    ["double", new Double(-1), new Double(0.5)],
    ["boolean", false, true],
    [
      "objectId",
      new ObjectId("000000000000000000000001"),
      new ObjectId("ff0000000000000000000000"),
    ],
    ["string", "ab", "abc"],
    ["string", "Z", "a"],
  ];
  it.each(ordered)("orders %s values like the server", (kind, low, high) => {
    expect(compareValues(kind, columnValue(low), columnValue(high))).toBe(-1);
    expect(compareValues(kind, columnValue(high), columnValue(low))).toBe(1);
    expect(compareValues(kind, columnValue(low), columnValue(low))).toBe(0);
  });

  it("treats NaN as equal to NaN, -0 as equal to 0, and single values as unordered", () => {
    expect(
      compareValues(
        "double",
        columnValue(new Double(Number.NaN)),
        columnValue(new Double(Number.NaN)),
      ),
    ).toBe(0);
    expect(compareValues("double", columnValue(new Double(-0)), columnValue(new Double(0)))).toBe(
      0,
    );
    expect(compareValues("single", columnValue({ a: 1 }), columnValue({ a: 2 }))).toBe(0);
    expect(BsonType.int32).toBe(0x10);
  });
});

describe("damaged input", () => {
  const buckets = Object.entries(FIXTURES).flatMap(([version, collections]) =>
    collections.flatMap((collection) => fixture(version, collection, "buckets")),
  );
  const measurements = fixture("mongodb-8.0", "mixed", "measurements");
  const settings = fixtureSettings("mongodb-8.0", "mixed");

  it("either converts or fails with a MongoShieldError, never anything else (property)", () => {
    const damage = fc.record({
      bucket: fc.boolean(),
      index: fc.nat(),
      flips: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
        minLength: 1,
        maxLength: 3,
      }),
    });
    fc.assert(
      fc.property(damage, ({ bucket, index, flips }) => {
        const source = bucket ? buckets : measurements;
        const damaged = Buffer.from(source[index % source.length] ?? Buffer.alloc(0));
        for (const [position, byte] of flips) damaged[position % damaged.length] = byte;
        try {
          if (bucket) unpackBucket(damaged, settings, "damaged");
          else {
            const packer = new BucketPacker(settings, "damaged");
            packer.add(damaged);
            packer.finish();
          }
        } catch (error) {
          expect(isMongoShieldError(error)).toBe(true);
        }
      }),
      { numRuns: 3000 },
    );
  });
});
