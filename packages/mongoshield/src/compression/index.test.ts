import { randomBytes } from "node:crypto";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import {
  type Compression,
  createCompressor,
  createDecompressor,
  DEFAULT_GZIP_LEVEL,
  DEFAULT_ZSTD_LEVEL,
  defaultCompression,
  detectCompression,
  isZstdAvailable,
} from "./index.ts";

/** Pushes `chunks` through `stream` and returns everything it outputs. */
async function runThrough(stream: Transform, chunks: readonly Uint8Array[]): Promise<Buffer> {
  const output: Buffer[] = [];
  await pipeline(Readable.from(chunks), stream, async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) output.push(chunk);
  });
  return Buffer.concat(output);
}

/** Splits `data` into chunks at the given (unsorted, possibly out-of-range) cut points. */
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

async function compress(compression: Compression, data: Buffer, level?: number): Promise<Buffer> {
  return runThrough(
    createCompressor(compression, level === undefined ? {} : { level }),
    data.length > 0 ? [data] : [],
  );
}

/** Highly compressible but not trivial: repeated text with a counter. */
function sampleData(lines = 5000): Buffer {
  const text = Array.from({ length: lines }, (_, index) => `{"_id": ${index}, "name": "user"}\n`);
  return Buffer.from(text.join(""));
}

const ALL: readonly Compression[] = ["zstd", "gzip", "none"];

describe("isZstdAvailable and defaultCompression", () => {
  it("reports zstd as available on this Node.js version", () => {
    expect(isZstdAvailable()).toBe(true);
  });

  it("defaults to zstd when it is available", () => {
    expect(defaultCompression()).toBe("zstd");
  });
});

describe("createCompressor / createDecompressor", () => {
  it.each(ALL)("round-trips data with %s", async (compression) => {
    const data = sampleData();
    const compressed = await compress(compression, data);
    expect(await runThrough(createDecompressor(compression), [compressed])).toEqual(data);
  });

  it.each(ALL)("round-trips empty input with %s", async (compression) => {
    const compressed = await compress(compression, Buffer.alloc(0));
    expect(await runThrough(createDecompressor(compression), [compressed])).toEqual(
      Buffer.alloc(0),
    );
  });

  it("actually compresses with zstd and gzip, and passes bytes through unchanged with none", async () => {
    const data = sampleData();
    expect((await compress("zstd", data)).length).toBeLessThan(data.length / 5);
    expect((await compress("gzip", data)).length).toBeLessThan(data.length / 5);
    expect(await compress("none", data)).toEqual(data);
  });

  it("writes output the standard zstd and gzip decoders can read", async () => {
    const data = sampleData();
    expect(zlib.zstdDecompressSync(await compress("zstd", data))).toEqual(data);
    expect(zlib.gunzipSync(await compress("gzip", data))).toEqual(data);
  });

  it("uses zstd level 3 and gzip level 6 by default", async () => {
    const data = sampleData();
    expect(DEFAULT_ZSTD_LEVEL).toBe(3);
    expect(DEFAULT_GZIP_LEVEL).toBe(6);
    expect(await compress("zstd", data)).toEqual(await compress("zstd", data, 3));
    expect(await compress("gzip", data)).toEqual(await compress("gzip", data, 6));
  });

  it("applies the requested level", async () => {
    const data = Buffer.concat([sampleData(), randomBytes(1000), sampleData()]);
    const fastest = await compress("zstd", data, 1);
    const smallest = await compress("zstd", data, 19);
    expect(smallest.length).toBeLessThan(fastest.length);
    expect((await compress("gzip", data, 0)).length).toBeGreaterThan(data.length);
    expect((await compress("gzip", data, 9)).length).toBeLessThan(data.length / 5);
  });

  it("adds a content checksum to zstd frames", async () => {
    const compressed = await compress("zstd", sampleData());
    // Byte 4 is the Frame_Header_Descriptor; bit 2 is Content_Checksum_flag.
    expect((compressed[4] ?? 0) & 0b100).toBe(0b100);
  });

  it("ignores the level for none", async () => {
    expect(await compress("none", Buffer.from("abc"), 99)).toEqual(Buffer.from("abc"));
  });

  it.each([
    ["zstd", 0],
    ["zstd", 23],
    ["zstd", 2.5],
    ["gzip", -1],
    ["gzip", 10],
  ] as const)("rejects %s level %d", (compression, level) => {
    expect(() => createCompressor(compression, { level })).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
  });

  it("decompresses several concatenated zstd frames", async () => {
    const first = await compress("zstd", Buffer.from("hello "));
    const second = await compress("zstd", Buffer.from("world"));
    const output = await runThrough(createDecompressor("zstd"), [first, second]);
    expect(output.toString()).toBe("hello world");
  });

  it("decompresses zstd input cut anywhere, even inside a second frame", async () => {
    // Two frames: what Node's compressor writes when input arrives in several chunks.
    // Node's decompressor alone fails with "Premature close" when one chunk holds
    // the end of the first frame and only part of the second.
    const compressed = Buffer.concat([
      await compress("zstd", Buffer.from("first")),
      await compress("zstd", Buffer.from("second")),
    ]);
    for (let cut = 1; cut < compressed.length; cut += 1) {
      const chunks = [compressed.subarray(0, cut), compressed.subarray(cut)];
      const output = await runThrough(createDecompressor("zstd"), chunks);
      expect(output.toString()).toBe("firstsecond");
    }
  });

  it("skips zstd skippable frames", async () => {
    // Magic 0x184D2A50 (little-endian), then a 4-byte size, then that many bytes.
    const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
    const frame = await compress("zstd", Buffer.from("data"));
    const output = await runThrough(createDecompressor("zstd"), [skippable, frame]);
    expect(output.toString()).toBe("data");
  });
});

describe("decompressing damaged input", () => {
  async function expectIntegrityError(compression: Compression, input: Buffer): Promise<void> {
    const error = await runThrough(createDecompressor(compression), [input]).catch(
      (caught: unknown) => caught,
    );
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
  }

  it.each(["zstd", "gzip"] as const)("rejects truncated %s data", async (compression) => {
    const compressed = await compress(compression, sampleData());
    await expectIntegrityError(compression, compressed.subarray(0, compressed.length - 5));
    await expectIntegrityError(compression, compressed.subarray(0, 10));
  });

  it("rejects zstd data cut exactly after the last block, before the checksum", async () => {
    const compressed = await compress("zstd", sampleData());
    await expectIntegrityError("zstd", compressed.subarray(0, compressed.length - 4));
  });

  it.each(["zstd", "gzip"] as const)("rejects empty %s input", async (compression) => {
    await expectIntegrityError(compression, Buffer.alloc(0));
  });

  it.each(["zstd", "gzip"] as const)("rejects data that is not %s", async (compression) => {
    await expectIntegrityError(compression, Buffer.from("definitely not compressed data"));
  });

  it.each(["zstd", "gzip"] as const)("rejects %s data with flipped bytes", async (compression) => {
    const compressed = await compress(compression, sampleData());
    const damaged = Buffer.from(compressed);
    for (let index = 20; index < 40; index += 1) damaged[index] = (damaged[index] ?? 0) ^ 0xff;
    await expectIntegrityError(compression, damaged);
  });

  it("rejects zstd data followed by trailing garbage", async () => {
    const compressed = await compress("zstd", sampleData());
    await expectIntegrityError("zstd", Buffer.concat([compressed, Buffer.from("garbage")]));
  });

  it("keeps the original zlib error as the cause", async () => {
    const error = await runThrough(createDecompressor("gzip"), [Buffer.from("nope")]).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MongoShieldError);
    expect((error as MongoShieldError).cause).toMatchObject({ code: "Z_DATA_ERROR" });
  });

  it("does not rewrite errors that come from elsewhere in the pipeline", async () => {
    const failure = new MongoShieldError("MS_ABORTED");
    async function* failingSource(): AsyncGenerator<Buffer> {
      yield await compress("zstd", Buffer.from("x"));
      throw failure;
    }
    const error = await pipeline(failingSource(), createDecompressor("zstd"), async (source) => {
      for await (const _ of source);
    }).catch((caught: unknown) => caught);
    expect(error).toBe(failure);
  });
});

describe("detectCompression", () => {
  it("recognises zstd, zstd skippable frames and gzip by their magic bytes", async () => {
    expect(detectCompression(await compress("zstd", Buffer.from("x")))).toBe("zstd");
    expect(detectCompression(Buffer.from([0x5f, 0x2a, 0x4d, 0x18, 0]))).toBe("zstd");
    expect(detectCompression(await compress("gzip", Buffer.from("x")))).toBe("gzip");
  });

  it("returns undefined for unknown or too-short input", () => {
    expect(detectCompression(Buffer.from([0x05, 0, 0, 0, 0]))).toBeUndefined();
    expect(detectCompression(Buffer.from("age-encryption.org/v1"))).toBeUndefined();
    expect(detectCompression(Buffer.from([0x28, 0xb5, 0x2f]))).toBeUndefined();
    expect(detectCompression(Buffer.from([0x1f]))).toBeUndefined();
    expect(detectCompression(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("compression properties", () => {
  it("round-trips random data split at random chunk boundaries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Compression>("zstd", "gzip", "none"),
        fc.uint8Array({ maxLength: 4096 }),
        fc.array(fc.nat(), { maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 8 }),
        async (compression, bytes, inputCuts, compressedCuts) => {
          const data = Buffer.from(bytes);
          const compressed = await runThrough(
            createCompressor(compression),
            cutAt(data, inputCuts),
          );
          expect(detectCompression(compressed)).toBe(
            compression === "none" ? detectCompression(data) : compression,
          );
          const restored = await runThrough(
            createDecompressor(compression),
            cutAt(compressed, compressedCuts),
          );
          expect(restored).toEqual(data);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("detects any truncation of zstd data", async () => {
    const compressed = await compress("zstd", Buffer.concat([sampleData(200), randomBytes(300)]));
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: compressed.length - 1 }), async (length) => {
        const error = await runThrough(createDecompressor("zstd"), [
          compressed.subarray(0, length),
        ]).catch((caught: unknown) => caught);
        expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
