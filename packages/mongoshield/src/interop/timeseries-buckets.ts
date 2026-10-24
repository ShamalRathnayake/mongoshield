/**
 * Converting between time-series *buckets* (what mongodump dumps and mongorestore
 * restores) and *measurements* (what a MongoShield backup stores, exactly what a
 * `find` on the time-series collection returns).
 *
 * A time-series collection `<db>.<name>` is a view over the hidden collection
 * `<db>.system.buckets.<name>`, whose documents ("buckets") each hold up to 1000
 * measurements of one `metaField` value within one time window (the server's
 * src/mongo/db/timeseries/README.md):
 *
 *   { _id: ObjectId(<seconds of control.min.<time>> …),
 *     control: { version: 1 | 2 | 3, min: {…}, max: {…}, count?: n, closed?: bool },
 *     meta: <the metaField value, shared by every measurement>,
 *     data: { <field>: <its values, one per measurement>, … } }
 *
 * `data` comes in two forms:
 *
 *   version 1   uncompressed: data.<field> is a document { "0": v0, "1": v1, … }
 *   version 2/3 compressed: data.<field> is a BSONColumn (binary subtype 7, see
 *               bson-column.ts); 3 means the measurements are not sorted by time
 *
 * Import (`unpackBucket`): every measurement is rebuilt as the server's `find`
 * returns it: the time field first, then the meta field, then the other fields in
 * the bucket's `data` order (checked byte for byte against MongoDB 7.0 and 8.0).
 *
 * Export (`BucketPacker`): no database is available, so buckets are computed
 * here, in the uncompressed version 1 form that every server reads (mongorestore
 * inserts them into `system.buckets.<name>` unchanged, and the server compresses a
 * bucket when it next writes to it). The hard part is `control.min` / `control.max`:
 * queries use them to skip buckets, so a wrong bound silently hides measurements.
 * The server computes them field by field with BSON ordering, recursing into
 * embedded documents and arrays, using the collection's collation for strings. To
 * stay exactly right without reimplementing all of that, a bucket only combines
 * measurements whose values can be ordered simply and exactly: for every field, all
 * values in the bucket have the same BSON type, and it is one of int32, int64,
 * double, date, timestamp, ObjectId, bool, or string (only without a collation).
 * A field with any other value (an embedded document, an array, decimal128, …)
 * appears in at most one measurement of a bucket, where its bounds are the value
 * itself. Measurements that cannot join the open bucket start a new one, so the
 * result is correct for any data, merely less compact for unusual data.
 */

import { randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { type Document, Double, Int32, Long } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import type { CollectionMetadata } from "../format/metadata.ts";
import { type ColumnValue, type DecodedColumn, decodeBsonColumn } from "./bson-column.ts";
import { BsonType, buildDocument, type RawElement, readElements } from "./raw-bson.ts";

/** Binary subtype of a BSONColumn. */
const COLUMN_SUBTYPE = 7;

/** The server's default `timeseriesBucketMaxCount`: measurements per bucket. */
export const MAX_BUCKET_MEASUREMENTS = 1000;

/** The server's default `timeseriesBucketMaxSize` (125 KiB): data bytes per bucket. */
export const MAX_BUCKET_DATA_BYTES = 125 * 1024;

/** MongoDB's document size limit, which a bucket must stay within to be inserted. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/** `granularity` presets: bucketRoundingSeconds and bucketMaxSpanSeconds (README "Bucketing Parameters"). */
const GRANULARITY_SECONDS: ReadonlyMap<string, { rounding: number; maxSpan: number }> = new Map([
  ["seconds", { rounding: 60, maxSpan: 3600 }],
  ["minutes", { rounding: 3600, maxSpan: 86_400 }],
  ["hours", { rounding: 86_400, maxSpan: 2_592_000 }],
]);

/** The server's default granularity. */
const DEFAULT_GRANULARITY = { rounding: 60, maxSpan: 3600 };

/** ObjectId timestamps are unsigned 32-bit seconds since the epoch. */
const MAX_OBJECT_ID_SECONDS = 2 ** 32 - 1;

/** What the conversions need from a time-series collection's options. */
export interface TimeSeriesSettings {
  readonly timeField: string;
  readonly metaField: string | undefined;
  /** Bucket start times are rounded down to a multiple of this. */
  readonly roundingSeconds: number;
  /** A bucket covers at most this long, from its rounded start. */
  readonly maxSpanSeconds: number;
  /** True when the collection has a non-simple default collation (strings then compare by it). */
  readonly hasCollation: boolean;
}

/**
 * The time-series settings of a collection's metadata.
 *
 * @throws MS_INTEGRITY_FAILED when `options.timeseries` is missing or malformed
 */
export function timeSeriesSettings(metadata: CollectionMetadata, ns: string): TimeSeriesSettings {
  const options = asDocument(metadata.options.timeseries);
  const timeField = options?.timeField;
  if (options === undefined || typeof timeField !== "string" || timeField === "") {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `The metadata of the time-series collection ${ns} has no options.timeseries.timeField.`,
      { hint: "The metadata file is damaged; take the dump again." },
    );
  }
  const metaField = typeof options.metaField === "string" ? options.metaField : undefined;
  const granularity = typeof options.granularity === "string" ? options.granularity : "seconds";
  const preset = GRANULARITY_SECONDS.get(granularity) ?? DEFAULT_GRANULARITY;
  const collation = asDocument(metadata.options.collation);
  return {
    timeField,
    metaField,
    roundingSeconds: positiveNumber(options.bucketRoundingSeconds) ?? preset.rounding,
    maxSpanSeconds: positiveNumber(options.bucketMaxSpanSeconds) ?? preset.maxSpan,
    hasCollation: collation !== undefined && collation.locale !== "simple",
  };
}

// ---------------------------------------------------------------------------
// Import: buckets → measurements
// ---------------------------------------------------------------------------

/**
 * The measurements of one bucket document, as raw BSON documents, in bucket order.
 *
 * @param where names the collection in error messages
 * @throws MS_INTEGRITY_FAILED for a malformed bucket, MS_FORMAT_UNSUPPORTED for a
 *   bucket version or column encoding this code does not know
 */
export function unpackBucket(
  bucket: Buffer,
  settings: TimeSeriesSettings,
  where: string,
): Buffer[] {
  const label = `a bucket of ${where}`;
  const fields = new Map(readElements(bucket, label).map((element) => [element.name, element]));
  const control = documentField(fields, "control", label);
  const data = documentField(fields, "data", label);
  const meta = fields.get("meta");
  if (meta !== undefined && settings.metaField === undefined) {
    throw badBucket(label, "it has a meta value, but the collection has no metaField");
  }

  const controlFields = new Map(
    readElements(control, `${label} (control)`).map((element) => [element.name, element]),
  );
  const version = numberValue(controlFields.get("version"));
  const columns = readDataColumns(data, version, label);
  const time = columns.get(settings.timeField);
  if (time === undefined) throw badBucket(label, `it has no data.${settings.timeField}`);

  const count =
    version === 1 ? time.length : (numberValue(controlFields.get("count")) ?? time.length);
  for (const [name, column] of columns) {
    if (column.length > count) {
      throw badBucket(label, `data.${name} has ${column.length} values for ${count} measurements`);
    }
  }

  const measurements: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const timeValue = time[index];
    if (timeValue === undefined) throw badBucket(label, `measurement ${index} has no time`);
    const elements: [number, string, Buffer][] = [
      [timeValue.type, settings.timeField, timeValue.value],
    ];
    if (meta !== undefined && settings.metaField !== undefined) {
      elements.push([meta.type, settings.metaField, meta.value]);
    }
    for (const [name, column] of columns) {
      if (name === settings.timeField) continue;
      const value = column[index];
      if (value !== undefined) elements.push([value.type, name, value.value]);
    }
    measurements.push(buildDocument(elements));
  }
  return measurements;
}

/**
 * An object-mode stream turning bucket documents into measurement documents, for the
 * import pipelines.
 */
export function createBucketUnpacker(settings: TimeSeriesSettings, where: string): Transform {
  return new Transform({
    objectMode: true,
    transform(bucket: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        for (const measurement of unpackBucket(bucket, settings, where)) this.push(measurement);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

/** Every `data` field as a column of values, in `data` order. */
function readDataColumns(
  data: Buffer,
  version: number | undefined,
  label: string,
): Map<string, DecodedColumn> {
  const columns = new Map<string, DecodedColumn>();
  for (const field of readElements(data, `${label} (data)`)) {
    const where = `${label}, field "${field.name}"`;
    if (version === 1) {
      if (field.type !== BsonType.document)
        throw badBucket(where, "an uncompressed field is not a document");
      columns.set(field.name, uncompressedColumn(field.value, where));
    } else if (version === 2 || version === 3) {
      columns.set(field.name, decodeBsonColumn(columnPayload(field, where), where));
    } else {
      throw new MongoShieldError(
        "MS_FORMAT_UNSUPPORTED",
        `${label} has bucket version ${String(version)}, which MongoShield cannot read.`,
        {
          hint: "Known versions are 1, 2 and 3 (MongoDB 5.0 to 8.2). Back the collection up with `mongoshield backup` instead.",
        },
      );
    }
  }
  return columns;
}

/** A version 1 field: `{ "0": v0, "3": v3, … }`, keys being measurement positions. */
function uncompressedColumn(document: Buffer, where: string): DecodedColumn {
  const column: DecodedColumn = [];
  for (const element of readElements(document, where)) {
    if (!/^(0|[1-9][0-9]*)$/.test(element.name)) {
      throw badBucket(where, `"${element.name}" is not a measurement position`);
    }
    column[Number(element.name)] = { type: element.type, value: element.value };
  }
  return column;
}

/** The BSONColumn bytes of a compressed field (binary subtype 7). */
function columnPayload(field: RawElement, where: string): Buffer {
  if (field.type !== BsonType.binary || field.value[4] !== COLUMN_SUBTYPE) {
    throw badBucket(where, "a compressed field is not a BSONColumn (binary subtype 7)");
  }
  return field.value.subarray(5);
}

// ---------------------------------------------------------------------------
// Export: measurements → buckets
// ---------------------------------------------------------------------------

/** How a field's values can be ordered within a bucket (see the file header). */
export type OrderKind =
  | "int32"
  | "int64"
  | "double"
  | "date"
  | "timestamp"
  | "objectId"
  | "boolean"
  | "string"
  | "single";

/** One data field of the bucket being built. */
interface BucketField {
  readonly name: string;
  readonly kind: OrderKind;
  /** Position → value. */
  readonly values: Map<number, ColumnValue>;
  min: ColumnValue;
  max: ColumnValue;
}

/** The bucket being built. */
interface OpenBucket {
  /** The meta element's type and value, compared byte for byte; undefined without meta. */
  readonly meta: ColumnValue | undefined;
  /** Rounded start, in milliseconds since the epoch. */
  readonly startMs: number;
  maxTimeMs: number;
  /** The time field first, then the others in order of first appearance. */
  readonly fields: BucketField[];
  count: number;
  dataBytes: number;
}

/** A measurement taken apart. */
interface Measurement {
  readonly timeMs: number;
  readonly time: ColumnValue;
  readonly meta: ColumnValue | undefined;
  /** The other fields, in document order. */
  readonly fields: readonly RawElement[];
  readonly size: number;
}

/**
 * Turns measurement documents (in backup order) into version 1 bucket documents for
 * mongorestore. Consecutive measurements share a bucket when they can (same meta,
 * same window, the type rules of the file header); memory holds one bucket at most.
 *
 *   const packer = new BucketPacker(settings, ns);
 *   for (const measurement of …) { const bucket = packer.add(measurement); if (bucket) write(bucket); }
 *   const last = packer.finish(); if (last) write(last);
 */
export class BucketPacker {
  readonly #settings: TimeSeriesSettings;
  readonly #where: string;
  #open: OpenBucket | undefined;
  #buckets = 0;

  constructor(settings: TimeSeriesSettings, where: string) {
    this.#settings = settings;
    this.#where = where;
  }

  /** Buckets returned so far. */
  get buckets(): number {
    return this.#buckets;
  }

  /**
   * Adds one measurement. Returns the previous bucket when this one did not fit in it.
   *
   * @throws MS_FORMAT_UNSUPPORTED for measurements a bucket cannot hold: a time outside
   *   1970–2106 (ObjectId seconds), or a measurement too large for a 16 MiB bucket;
   *   MS_INTEGRITY_FAILED for a measurement without a date in its time field
   */
  add(document: Buffer): Buffer | undefined {
    const measurement = parseMeasurement(document, this.#settings, this.#where);
    let finished: Buffer | undefined;
    if (this.#open !== undefined && !tryAdd(this.#open, measurement, this.#settings)) {
      finished = this.#finishOpen();
    }
    if (this.#open === undefined) {
      this.#open = startBucket(measurement, this.#settings, this.#where);
    }
    return finished;
  }

  /** The last bucket, if any measurement is still waiting. */
  finish(): Buffer | undefined {
    return this.#open === undefined ? undefined : this.#finishOpen();
  }

  #finishOpen(): Buffer | undefined {
    const open = this.#open;
    this.#open = undefined;
    if (open === undefined) return undefined;
    this.#buckets += 1;
    return finishBucket(open, this.#settings, this.#where);
  }
}

/** `BucketPacker` as an object-mode stream: measurement documents in, bucket documents out. */
export function createBucketPacker(settings: TimeSeriesSettings, where: string): Transform {
  const packer = new BucketPacker(settings, where);
  return new Transform({
    objectMode: true,
    transform(document: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        const bucket = packer.add(document);
        if (bucket !== undefined) this.push(bucket);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback: TransformCallback) {
      try {
        const bucket = packer.finish();
        if (bucket !== undefined) this.push(bucket);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

function parseMeasurement(
  document: Buffer,
  settings: TimeSeriesSettings,
  where: string,
): Measurement {
  let time: ColumnValue | undefined;
  let meta: ColumnValue | undefined;
  const fields: RawElement[] = [];
  for (const element of readElements(document, `a measurement of ${where}`)) {
    if (element.name === settings.timeField) time = { type: element.type, value: element.value };
    else if (element.name === settings.metaField)
      meta = { type: element.type, value: element.value };
    else fields.push(element);
  }
  if (time?.type !== BsonType.date) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `A measurement of ${where} has no date in its time field "${settings.timeField}".`,
      { hint: "The backup is damaged. Run `mongoshield verify --deep` on it." },
    );
  }
  return {
    timeMs: Number(time.value.readBigInt64LE(0)),
    time,
    meta,
    fields,
    size: document.length,
  };
}

/** A new bucket holding `measurement`, starting at its time rounded down. */
function startBucket(
  measurement: Measurement,
  settings: TimeSeriesSettings,
  where: string,
): OpenBucket {
  const seconds = Math.floor(measurement.timeMs / 1000);
  const startSeconds = seconds - (seconds % settings.roundingSeconds);
  if (seconds < 0 || startSeconds > MAX_OBJECT_ID_SECONDS) {
    throw new MongoShieldError(
      "MS_FORMAT_UNSUPPORTED",
      `A measurement of ${where} is dated ${describeTime(measurement.timeMs)}, which a mongorestore bucket cannot hold (bucket ids store seconds from 1970 to 2106).`,
      {
        hint: "Restore this collection with `mongoshield restore`, or leave it out of the export with --exclude.",
      },
    );
  }
  const bucket: OpenBucket = {
    meta: measurement.meta,
    startMs: startSeconds * 1000,
    maxTimeMs: measurement.timeMs,
    fields: [],
    count: 0,
    dataBytes: 0,
  };
  const added = tryAdd(bucket, measurement, settings);
  if (!added)
    throw new MongoShieldError("MS_INTERNAL", "A new bucket refused its first measurement.");
  return bucket;
}

/**
 * Adds `measurement` to `bucket` if it fits (see the file header); returns false,
 * leaving the bucket unchanged, if it does not.
 */
function tryAdd(
  bucket: OpenBucket,
  measurement: Measurement,
  settings: TimeSeriesSettings,
): boolean {
  if (bucket.count > 0) {
    if (bucket.count >= MAX_BUCKET_MEASUREMENTS) return false;
    if (bucket.dataBytes + measurement.size > MAX_BUCKET_DATA_BYTES) return false;
    if (!sameValue(bucket.meta, measurement.meta)) return false;
    const endMs = bucket.startMs + settings.maxSpanSeconds * 1000;
    if (measurement.timeMs < bucket.startMs || measurement.timeMs >= endMs) return false;
  }

  const candidates: {
    readonly element: ColumnValue & { name: string };
    readonly kind: OrderKind;
  }[] = [
    { element: { name: settings.timeField, ...measurement.time }, kind: "date" },
    ...measurement.fields.map((field) => ({
      element: { name: field.name, type: field.type, value: field.value },
      kind: orderKind(field.type, settings),
    })),
  ];
  // Check everything first, so a refused measurement leaves the bucket untouched.
  let lastPosition = -1;
  let appended = 0;
  for (const { element, kind } of candidates) {
    const position = bucket.fields.findIndex((field) => field.name === element.name);
    if (position < 0) {
      // New fields go to the end, so they must come after every known one.
      lastPosition = bucket.fields.length + appended;
      appended += 1;
      continue;
    }
    const field = bucket.fields[position];
    // A field may only gain values of its own orderable kind, in the bucket's field order.
    if (
      field === undefined ||
      field.kind === "single" ||
      field.kind !== kind ||
      position < lastPosition
    ) {
      return false;
    }
    lastPosition = position;
  }

  const index = bucket.count;
  for (const { element, kind } of candidates) {
    const value: ColumnValue = { type: element.type, value: element.value };
    const field = bucket.fields.find((candidate) => candidate.name === element.name);
    if (field === undefined) {
      bucket.fields.push({
        name: element.name,
        kind,
        values: new Map([[index, value]]),
        min: value,
        max: value,
      });
      continue;
    }
    field.values.set(index, value);
    if (compareValues(kind, value, field.min) < 0) field.min = value;
    if (compareValues(kind, value, field.max) > 0) field.max = value;
  }
  bucket.count += 1;
  bucket.dataBytes += measurement.size;
  bucket.maxTimeMs = Math.max(bucket.maxTimeMs, measurement.timeMs);
  return true;
}

/** The finished version 1 bucket document. */
function finishBucket(bucket: OpenBucket, settings: TimeSeriesSettings, where: string): Buffer {
  const timeMin = Buffer.alloc(8);
  timeMin.writeBigInt64LE(BigInt(bucket.startMs), 0);
  const timeMax = Buffer.alloc(8);
  timeMax.writeBigInt64LE(BigInt(bucket.maxTimeMs), 0);

  const minElements: [number, string, Buffer][] = [[BsonType.date, settings.timeField, timeMin]];
  const maxElements: [number, string, Buffer][] = [[BsonType.date, settings.timeField, timeMax]];
  const dataElements: [number, string, Buffer][] = [];
  for (const field of bucket.fields) {
    if (field.name !== settings.timeField) {
      minElements.push([field.min.type, field.name, field.min.value]);
      maxElements.push([field.max.type, field.name, field.max.value]);
    }
    const positions = [...field.values].map(([position, value]): [number, string, Buffer] => [
      value.type,
      String(position),
      value.value,
    ]);
    dataElements.push([BsonType.document, field.name, buildDocument(positions)]);
  }

  const control = buildDocument([
    [BsonType.int32, "version", int32Bytes(1)],
    [BsonType.document, "min", buildDocument(minElements)],
    [BsonType.document, "max", buildDocument(maxElements)],
  ]);
  const elements: [number, string, Buffer][] = [
    [BsonType.objectId, "_id", bucketId(bucket.startMs)],
    [BsonType.document, "control", control],
  ];
  if (bucket.meta !== undefined) elements.push([bucket.meta.type, "meta", bucket.meta.value]);
  elements.push([BsonType.document, "data", buildDocument(dataElements)]);
  const document = buildDocument(elements);
  if (document.length > MAX_DOCUMENT_BYTES) {
    throw new MongoShieldError(
      "MS_FORMAT_UNSUPPORTED",
      `A measurement of ${where} is too large for a mongorestore bucket (${document.length} bytes with its bounds).`,
      {
        hint: "Restore this collection with `mongoshield restore`, or leave it out of the export with --exclude.",
      },
    );
  }
  return document;
}

/**
 * A bucket `_id`: an ObjectId whose timestamp is the bucket's rounded start (the
 * server relies on that to find buckets by time), and 8 random bytes.
 */
function bucketId(startMs: number): Buffer {
  const id = Buffer.alloc(12);
  id.writeUInt32BE(startMs / 1000, 0);
  randomBytes(8).copy(id, 4);
  return id;
}

/** How values of BSON type `type` are ordered in a bucket. */
function orderKind(type: number, settings: TimeSeriesSettings): OrderKind {
  switch (type) {
    case BsonType.int32:
      return "int32";
    case BsonType.int64:
      return "int64";
    case BsonType.double:
      return "double";
    case BsonType.date:
      return "date";
    case BsonType.timestamp:
      return "timestamp";
    case BsonType.objectId:
      return "objectId";
    case BsonType.boolean:
      return "boolean";
    case BsonType.string:
      // With a collation, the server orders strings by it; only single values are safe then.
      return settings.hasCollation ? "single" : "string";
    default:
      return "single";
  }
}

/**
 * BSON order of two values of the same kind (the server's `compareElementValues`):
 * numbers numerically with NaN below every number, strings by their UTF-8 bytes,
 * ObjectIds by their bytes, timestamps as unsigned 64-bit integers.
 */
export function compareValues(kind: OrderKind, left: ColumnValue, right: ColumnValue): number {
  switch (kind) {
    case "int32":
      return Math.sign(left.value.readInt32LE(0) - right.value.readInt32LE(0));
    case "int64":
    case "date":
      return compareBigInts(left.value.readBigInt64LE(0), right.value.readBigInt64LE(0));
    case "timestamp":
      return compareBigInts(left.value.readBigUInt64LE(0), right.value.readBigUInt64LE(0));
    case "double":
      return compareDoubles(left.value.readDoubleLE(0), right.value.readDoubleLE(0));
    case "boolean":
      return Math.sign((left.value[0] ?? 0) - (right.value[0] ?? 0));
    case "objectId":
      return Buffer.compare(left.value, right.value);
    case "string":
      // Skip the length prefix and the terminating 0x00.
      return Buffer.compare(left.value.subarray(4, -1), right.value.subarray(4, -1));
    case "single":
      return 0;
  }
}

/** A time for an error message; dates beyond JavaScript's range as milliseconds. */
function describeTime(timeMs: number): string {
  const date = new Date(timeMs);
  return Number.isNaN(date.getTime()) ? `${timeMs} ms after 1970` : date.toISOString();
}

function compareBigInts(left: bigint, right: bigint): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareDoubles(left: number, right: number): number {
  const leftNaN = Number.isNaN(left);
  const rightNaN = Number.isNaN(right);
  if (leftNaN || rightNaN) return leftNaN === rightNaN ? 0 : leftNaN ? -1 : 1;
  if (left === right) return 0; // also -0 and 0
  return left < right ? -1 : 1;
}

function sameValue(left: ColumnValue | undefined, right: ColumnValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.type === right.type && left.value.equals(right.value);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function documentField(fields: Map<string, RawElement>, name: string, label: string): Buffer {
  const field = fields.get(name);
  if (field?.type !== BsonType.document) throw badBucket(label, `it has no ${name} document`);
  return field.value;
}

/** An int32, int64 or double element's value as a number, or undefined. */
function numberValue(element: RawElement | undefined): number | undefined {
  if (element === undefined) return undefined;
  if (element.type === BsonType.int32) return element.value.readInt32LE(0);
  if (element.type === BsonType.int64) return Number(element.value.readBigInt64LE(0));
  if (element.type === BsonType.double) return element.value.readDoubleLE(0);
  return undefined;
}

function int32Bytes(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value, 0);
  return bytes;
}

/** A positive number from a metadata option (Int32/Long/Double wrappers or plain). */
function positiveNumber(value: unknown): number | undefined {
  let number: number | undefined;
  if (typeof value === "number") number = value;
  else if (value instanceof Int32 || value instanceof Double) number = value.valueOf();
  else if (value instanceof Long) number = value.toNumber();
  return number !== undefined && Number.isFinite(number) && number > 0 ? number : undefined;
}

function asDocument(value: unknown): Document | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value;
}

function badBucket(where: string, problem: string): MongoShieldError {
  return new MongoShieldError("MS_INTEGRITY_FAILED", `${where} is malformed: ${problem}.`, {
    hint: "The dump is damaged; take it again with mongodump.",
  });
}
