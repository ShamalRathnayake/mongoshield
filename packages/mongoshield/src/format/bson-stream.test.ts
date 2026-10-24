import { Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fc from "fast-check";
import {
  Binary,
  BSON,
  BSONRegExp,
  BSONSymbol,
  Code,
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
import { isMongoShieldError } from "../errors.ts";
import {
  createBsonDeserializer,
  createBsonSerializer,
  createBsonSplitter,
  DEFAULT_MAX_DOCUMENT_BYTES,
  LOSSLESS_DESERIALIZE_OPTIONS,
} from "./bson-stream.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Writes `input` into the given streams (piped in order) and collects what comes out. */
async function runThrough<T>(input: readonly unknown[], ...streams: Transform[]): Promise<T[]> {
  const output: T[] = [];
  const collector = new Writable({
    objectMode: true,
    write(item: T, _encoding, callback) {
      output.push(item);
      callback();
    },
  });
  await pipeline([Readable.from(input), ...streams, collector]);
  return output;
}

async function caughtError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** Splits `data` into chunks at the given cut points (taken modulo the length). */
function cutAt(data: Buffer, cuts: readonly number[]): Buffer[] {
  const positions = [...new Set(cuts.map((cut) => cut % (data.length + 1)))].sort((a, b) => a - b);
  const chunks: Buffer[] = [];
  let start = 0;
  for (const position of positions) {
    chunks.push(data.subarray(start, position));
    start = position;
  }
  chunks.push(data.subarray(start));
  return chunks.filter((chunk) => chunk.length > 0);
}

function serialize(document: Document): Buffer {
  return Buffer.from(BSON.serialize(document));
}

// ---------------------------------------------------------------------------
// Arbitraries: documents covering every BSON type that can round-trip exactly
// ---------------------------------------------------------------------------

/** cstring field names: anything without NUL. DBRef field names are left out on purpose. */
const fieldName = fc
  .string({ unit: "binary", maxLength: 8 })
  .filter((name) => !name.includes("\0") && !["$ref", "$id", "$db", "__proto__"].includes(name));

const int32 = fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }).map((value) => new Int32(value));
const double = fc.oneof(
  fc.double().map((value) => new Double(value)), // includes NaN, ±Infinity and -0
  fc.integer().map((value) => new Double(value)), // integral doubles must stay doubles
  fc.constant(new Double(-0)),
);
const long = fc
  .bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n })
  .map((value) => Long.fromBigInt(value));
const decimal128 = fc.uint8Array({ minLength: 16, maxLength: 16 }).map((b) => new Decimal128(b));
const binary = fc
  .tuple(
    fc.uint8Array({ maxLength: 32 }),
    // 0 generic, 1 function, 2 old binary, 3 old UUID, 4 UUID, 5 MD5, 6 encrypted,
    // 7 compressed column, 8 sensitive, 0x80 user-defined. (9, vector, validates its content.)
    fc.constantFrom(0, 1, 2, 3, 4, 5, 6, 7, 8, 0x80),
  )
  .map(([bytes, subtype]) => new Binary(bytes, subtype));
const uuid = fc.uint8Array({ minLength: 16, maxLength: 16 }).map((b) => new Binary(b, 4));
const objectId = fc.uint8Array({ minLength: 12, maxLength: 12 }).map((b) => new ObjectId(b));
const date = fc.date({ noInvalidDate: true });
const timestamp = fc
  .tuple(fc.nat({ max: 2 ** 32 - 1 }), fc.nat({ max: 2 ** 32 - 1 }))
  .map(([t, i]) => new Timestamp({ t, i }));
const regexPattern = fc.string({ maxLength: 10 }).filter((pattern) => !pattern.includes("\0"));
const bsonRegExp = fc
  .tuple(regexPattern, fc.subarray(["i", "l", "m", "s", "u", "x"]))
  .map(([pattern, flags]) => new BSONRegExp(pattern, flags.join("")));
const jsRegExp = fc
  .tuple(fc.constantFrom("a+b", "^x$", "[0-9]{3}"), fc.subarray(["i", "m", "s", "u"]))
  .map(([pattern, flags]) => new RegExp(pattern, flags.join("")));
const code = fc.string({ maxLength: 20 }).map((source) => new Code(source));
const string = fc.string({ unit: "binary", maxLength: 20 });

const scalar = fc.oneof(
  int32,
  double,
  long,
  decimal128,
  binary,
  uuid,
  objectId,
  date,
  timestamp,
  bsonRegExp,
  jsRegExp,
  code,
  string,
  fc.boolean(),
  fc.constant(null),
  fc.constant(new MinKey()),
  fc.constant(new MaxKey()),
  string.map((value) => new BSONSymbol(value)),
);

const { document } = fc.letrec<{ value: unknown; document: Document }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    scalar,
    tie("document"),
    fc.array(tie("value"), { maxLength: 4 }),
    fc
      .tuple(fc.string({ maxLength: 10 }), tie("document"))
      .map(([source, scope]) => new Code(source, scope)),
  ),
  document: fc.dictionary(fieldName, tie("value"), { maxKeys: 5 }),
}));

// ---------------------------------------------------------------------------
// Splitter
// ---------------------------------------------------------------------------

describe("createBsonSplitter", () => {
  const documents = [{ a: 1 }, {}, { name: "x".repeat(1000), nested: { list: [1, 2, 3] } }];
  const raw = documents.map(serialize);
  const fileBytes = Buffer.concat(raw);

  it("emits one raw Buffer per document, byte for byte", async () => {
    const output = await runThrough<Buffer>([fileBytes], createBsonSplitter());
    expect(output).toEqual(raw);
  });

  it("handles documents split across chunks of every size, down to single bytes", async () => {
    for (const size of [1, 2, 3, 4, 5, 7, 100, 1024]) {
      const chunks: Buffer[] = [];
      for (let start = 0; start < fileBytes.length; start += size) {
        chunks.push(fileBytes.subarray(start, start + size));
      }
      expect(await runThrough<Buffer>(chunks, createBsonSplitter())).toEqual(raw);
    }
  });

  it("emits nothing for empty input", async () => {
    expect(await runThrough<Buffer>([], createBsonSplitter())).toEqual([]);
  });

  it("does not copy documents that lie inside one chunk", async () => {
    const [first] = await runThrough<Buffer>([fileBytes], createBsonSplitter());
    expect(first?.buffer).toBe(fileBytes.buffer);
  });

  it("joins a large document arriving in many small chunks", async () => {
    const big = serialize({ blob: new Binary(Buffer.alloc(5 * 1024 * 1024, 1)) });
    const chunks: Buffer[] = [];
    for (let start = 0; start < big.length; start += 997)
      chunks.push(big.subarray(start, start + 997));
    const output = await runThrough<Buffer>(chunks, createBsonSplitter());
    expect(output).toHaveLength(1);
    expect(output[0]?.equals(big)).toBe(true);
  });

  it("uses a 64 MiB document limit by default", () => {
    expect(DEFAULT_MAX_DOCUMENT_BYTES).toBe(64 * 1024 * 1024);
  });

  it("rejects a length prefix larger than maxDocumentBytes", async () => {
    const error = await caughtError(
      runThrough([fileBytes], createBsonSplitter({ maxDocumentBytes: 100 })),
    );
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect((error as Error).message).toMatch(/length 1\d{3} at byte \d+ \(document #3\)/);
  });

  it("accepts documents exactly at maxDocumentBytes", async () => {
    const [first] = raw;
    const output = await runThrough<Buffer>(
      [first],
      createBsonSplitter({ maxDocumentBytes: first?.length ?? 0 }),
    );
    expect(output).toEqual([first]);
  });

  it("rejects a length prefix that is split across chunks and too large", async () => {
    const bogus = Buffer.from([0xff, 0xff, 0xff, 0x7f, 0]);
    const error = await caughtError(
      runThrough([bogus.subarray(0, 2), bogus.subarray(2)], createBsonSplitter()),
    );
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
  });

  it.each([
    ["negative", -1],
    ["zero", 0],
    ["below the 5-byte minimum", 4],
  ])("rejects a %s length prefix", async (_label, length) => {
    const bytes = Buffer.alloc(8);
    bytes.writeInt32LE(length, 0);
    const error = await caughtError(runThrough([bytes], createBsonSplitter()));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
  });

  it("rejects a document that does not end in 0x00", async () => {
    const bad = Buffer.from(serialize({ a: 1 }));
    bad[bad.length - 1] = 0x01;
    for (const chunks of [[bad], [bad.subarray(0, 6), bad.subarray(6)]]) {
      const error = await caughtError(runThrough(chunks, createBsonSplitter()));
      expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
      expect((error as Error).message).toMatch(/does not end with a 0x00 byte/);
    }
  });

  it.each([1, 3, 4, 10])(
    "rejects input truncated %d bytes into the last document",
    async (keep) => {
      const truncated = Buffer.concat([
        raw[0] ?? Buffer.alloc(0),
        (raw[2] ?? Buffer.alloc(0)).subarray(0, keep),
      ]);
      const error = await caughtError(runThrough([truncated], createBsonSplitter()));
      expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
      expect((error as Error).message).toMatch(/document #2.*truncated/);
    },
  );

  it.each([0, 4, 2.5])("rejects maxDocumentBytes %d", (maxDocumentBytes) => {
    expect(() => createBsonSplitter({ maxDocumentBytes })).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Deserializer and serializer
// ---------------------------------------------------------------------------

describe("createBsonDeserializer", () => {
  it("keeps BSON types instead of promoting them to JavaScript values", async () => {
    const input = serialize({
      double: new Double(1),
      int: new Int32(1),
      long: Long.fromNumber(1),
      binary: new Binary(Buffer.from("x"), 0),
      regex: new BSONRegExp("a", "i"),
    });
    const [parsed] = await runThrough<Document>([input], createBsonDeserializer());
    expect(parsed?.double).toBeInstanceOf(Double);
    expect(parsed?.int).toBeInstanceOf(Int32);
    expect(parsed?.long).toBeInstanceOf(Long);
    expect(parsed?.binary).toBeInstanceOf(Binary);
    expect(parsed?.regex).toBeInstanceOf(BSONRegExp);
  });

  it("re-serializes an integral double as a double, not an int32", async () => {
    const input = serialize({ value: new Double(1) });
    const [output] = await runThrough<Buffer>(
      [input],
      createBsonDeserializer(),
      createBsonSerializer(),
    );
    expect(output).toEqual(input);
    // Element type 0x01 is double; 0x10 would be int32.
    expect(output?.[4]).toBe(0x01);
  });

  it("documents the options it uses", () => {
    expect(LOSSLESS_DESERIALIZE_OPTIONS).toMatchObject({ promoteValues: false, bsonRegExp: true });
  });

  it("fails with MS_INTEGRITY_FAILED on a malformed document", async () => {
    // A valid length and terminator around an element of unknown type 0x77.
    const malformed = Buffer.from([0x0a, 0, 0, 0, 0x77, 0x61, 0, 0, 0, 0]);
    const error = await caughtError(runThrough([malformed], createBsonDeserializer()));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect((error as Error).message).toMatch(/document #1 is malformed/);
  });

  it("rejects strings that are not valid UTF-8 instead of altering them", async () => {
    const invalid = Buffer.from([16, 0, 0, 0, 0x02, 0x61, 0, 2, 0, 0, 0, 0xff, 0, 0]);
    invalid.writeInt32LE(invalid.length, 0);
    const error = await caughtError(runThrough([invalid], createBsonDeserializer()));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
  });
});

describe("createBsonSerializer", () => {
  it("serializes documents to Buffers, allowing $ and dots in field names", async () => {
    const [output] = await runThrough<Buffer>([{ "a.b": 1, $c: 2 }], createBsonSerializer());
    expect(Buffer.isBuffer(output)).toBe(true);
    expect(BSON.deserialize(output ?? Buffer.alloc(0))).toEqual({ "a.b": 1, $c: 2 });
  });

  it("fails with MS_INTERNAL when a document cannot be serialized", async () => {
    const circular: Document = { name: "loop" };
    circular.self = circular;
    const error = await caughtError(runThrough([circular], createBsonSerializer()));
    expect(isMongoShieldError(error, "MS_INTERNAL")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("BSON stream properties", () => {
  it("split → deserialize → serialize reproduces every document byte for byte", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(document, { maxLength: 6 }),
        fc.array(fc.nat(), { maxLength: 10 }),
        async (documents, cuts) => {
          const original = documents.map(serialize);
          const chunks = cutAt(Buffer.concat(original), cuts);
          const output = await runThrough<Buffer>(
            chunks,
            createBsonSplitter(),
            createBsonDeserializer(),
            createBsonSerializer(),
          );
          expect(output).toEqual(original);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("the splitter alone returns the exact input documents for any chunking", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(document, { maxLength: 6 }),
        fc.array(fc.nat(), { maxLength: 20 }),
        async (documents, cuts) => {
          const original = documents.map(serialize);
          const output = await runThrough<Buffer>(
            cutAt(Buffer.concat(original), cuts),
            createBsonSplitter(),
          );
          expect(output).toEqual(original);
        },
      ),
      { numRuns: 200 },
    );
  });
});
