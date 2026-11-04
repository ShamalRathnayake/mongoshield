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

/**
 * True on a Node.js without zstd (before 22.15 / 23.8). Tests that must run the
 * zstd codec skip there; gzip and none are still covered on every version.
 */
const ZSTD_UNAVAILABLE = !isZstdAvailable();

/** True if `compression` cannot run on this Node.js, so its test case is skipped. */
function unavailable(compression: Compression): boolean {
  return compression === "zstd" && ZSTD_UNAVAILABLE;
}

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

/** The compressions this Node.js can run: all three, or gzip and none before Node 22.15. */
const RUNNABLE: readonly Compression[] = ALL.filter((compression) => !unavailable(compression));

/** True if this Node.js version is one whose `node:zlib` ships zstd (22.15+ in 22.x, 23.8+). */
function nodeVersionHasZstd(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major === 22) return minor >= 15;
  if (major === 23) return minor >= 8;
  return major > 23;
}

describe("isZstdAvailable and defaultCompression", () => {
  it("reports zstd as available exactly on the Node.js versions that ship it", () => {
    expect(isZstdAvailable()).toBe(nodeVersionHasZstd());
  });

  // The gzip fallback is covered by zstd-unavailable.test.ts and by the line below.
  it.skipIf(ZSTD_UNAVAILABLE)("defaults to zstd when it is available", () => {
    expect(defaultCompression()).toBe("zstd");
  });
});

describe("createCompressor / createDecompressor", () => {
  // One test per compression (not `it.each`) so the zstd case alone can be skipped
  // on a Node.js without zstd.
  for (const compression of ALL) {
    it.skipIf(unavailable(compression))(`round-trips data with ${compression}`, async () => {
      const data = sampleData();
      const compressed = await compress(compression, data);
      expect(await runThrough(createDecompressor(compression), [compressed])).toEqual(data);
    });

    it.skipIf(unavailable(compression))(`round-trips empty input with ${compression}`, async () => {
      const compressed = await compress(compression, Buffer.alloc(0));
      expect(await runThrough(createDecompressor(compression), [compressed])).toEqual(
        Buffer.alloc(0),
      );
    });
  }

  // Needs the zstd codec itself.
  it.skipIf(ZSTD_UNAVAILABLE)("actually compresses with zstd", async () => {
    const data = sampleData();
    expect((await compress("zstd", data)).length).toBeLessThan(data.length / 5);
  });

  it("actually compresses with gzip, and passes bytes through unchanged with none", async () => {
    const data = sampleData();
    expect((await compress("gzip", data)).length).toBeLessThan(data.length / 5);
    expect(await compress("none", data)).toEqual(data);
  });

  // Needs the zstd codec itself (and `zlib.zstdDecompressSync`, also Node 22.15+).
  it.skipIf(ZSTD_UNAVAILABLE)("writes output the standard zstd decoder can read", async () => {
    const data = sampleData();
    expect(zlib.zstdDecompressSync(await compress("zstd", data))).toEqual(data);
  });

  it("writes output the standard gzip decoder can read", async () => {
    const data = sampleData();
    expect(zlib.gunzipSync(await compress("gzip", data))).toEqual(data);
  });

  it("uses zstd level 3 and gzip level 6 by default", () => {
    expect(DEFAULT_ZSTD_LEVEL).toBe(3);
    expect(DEFAULT_GZIP_LEVEL).toBe(6);
  });

  // Needs the zstd codec itself.
  it.skipIf(ZSTD_UNAVAILABLE)("compresses with zstd level 3 when no level is given", async () => {
    const data = sampleData();
    expect(await compress("zstd", data)).toEqual(await compress("zstd", data, 3));
  });

  it("compresses with gzip level 6 when no level is given", async () => {
    const data = sampleData();
    expect(await compress("gzip", data)).toEqual(await compress("gzip", data, 6));
  });

  // Needs the zstd codec itself.
  it.skipIf(ZSTD_UNAVAILABLE)("applies the requested zstd level", async () => {
    const data = Buffer.concat([sampleData(), randomBytes(1000), sampleData()]);
    const fastest = await compress("zstd", data, 1);
    const smallest = await compress("zstd", data, 19);
    expect(smallest.length).toBeLessThan(fastest.length);
  });

  it("applies the requested gzip level", async () => {
    const data = Buffer.concat([sampleData(), randomBytes(1000), sampleData()]);
    expect((await compress("gzip", data, 0)).length).toBeGreaterThan(data.length);
    expect((await compress("gzip", data, 9)).length).toBeLessThan(data.length / 5);
  });

  // Needs the zstd codec itself.
  it.skipIf(ZSTD_UNAVAILABLE)("adds a content checksum to zstd frames", async () => {
    const compressed = await compress("zstd", sampleData());
    // Byte 4 is the Frame_Header_Descriptor; bit 2 is Content_Checksum_flag.
    expect((compressed[4] ?? 0) & 0b100).toBe(0b100);
  });

  it("ignores the level for none", async () => {
    expect(await compress("none", Buffer.from("abc"), 99)).toEqual(Buffer.from("abc"));
  });

  // Without zstd, createCompressor("zstd") refuses before it looks at the level,
  // so the zstd cases would pass for the wrong reason: they are skipped there.
  for (const [compression, level] of [
    ["zstd", 0],
    ["zstd", 23],
    ["zstd", 2.5],
    ["gzip", -1],
    ["gzip", 10],
  ] as const) {
    it.skipIf(unavailable(compression))(`rejects ${compression} level ${level}`, () => {
      expect(() => createCompressor(compression, { level })).toThrow(
        expect.objectContaining({
          code: "MS_CONFIG_INVALID",
          message: expect.stringContaining("level"),
        }),
      );
    });
  }

  // The zstd frame handling below needs the zstd codec itself.
  it.skipIf(ZSTD_UNAVAILABLE)("decompresses several concatenated zstd frames", async () => {
    const first = await compress("zstd", Buffer.from("hello "));
    const second = await compress("zstd", Buffer.from("world"));
    const output = await runThrough(createDecompressor("zstd"), [first, second]);
    expect(output.toString()).toBe("hello world");
  });

  it.skipIf(ZSTD_UNAVAILABLE)(
    "decompresses zstd input cut anywhere, even inside a second frame",
    async () => {
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
    },
  );

  it.skipIf(ZSTD_UNAVAILABLE)("skips zstd skippable frames", async () => {
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

  // One test per compression so the zstd cases alone skip on a Node.js without zstd
  // (where `createDecompressor("zstd")` refuses with MS_FORMAT_UNSUPPORTED instead).
  for (const compression of ["zstd", "gzip"] as const) {
    it.skipIf(unavailable(compression))(`rejects truncated ${compression} data`, async () => {
      const compressed = await compress(compression, sampleData());
      await expectIntegrityError(compression, compressed.subarray(0, compressed.length - 5));
      await expectIntegrityError(compression, compressed.subarray(0, 10));
    });

    it.skipIf(unavailable(compression))(`rejects empty ${compression} input`, async () => {
      await expectIntegrityError(compression, Buffer.alloc(0));
    });

    it.skipIf(unavailable(compression))(`rejects data that is not ${compression}`, async () => {
      await expectIntegrityError(compression, Buffer.from("definitely not compressed data"));
    });

    it.skipIf(unavailable(compression))(
      `rejects ${compression} data with flipped bytes`,
      async () => {
        const compressed = await compress(compression, sampleData());
        const damaged = Buffer.from(compressed);
        for (let index = 20; index < 40; index += 1) damaged[index] = (damaged[index] ?? 0) ^ 0xff;
        await expectIntegrityError(compression, damaged);
      },
    );
  }

  // Needs the zstd codec itself.
  it.skipIf(ZSTD_UNAVAILABLE)(
    "rejects zstd data cut exactly after the last block, before the checksum",
    async () => {
      const compressed = await compress("zstd", sampleData());
      await expectIntegrityError("zstd", compressed.subarray(0, compressed.length - 4));
    },
  );

  // Needs the zstd codec itself.
  it.skipIf(ZSTD_UNAVAILABLE)("rejects zstd data followed by trailing garbage", async () => {
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

  for (const compression of ["zstd", "gzip"] as const) {
    it.skipIf(unavailable(compression))(
      `does not rewrite errors that come from elsewhere in a ${compression} pipeline`,
      async () => {
        const failure = new MongoShieldError("MS_ABORTED");
        async function* failingSource(): AsyncGenerator<Buffer> {
          yield await compress(compression, Buffer.from("x"));
          throw failure;
        }
        const error = await pipeline(
          failingSource(),
          createDecompressor(compression),
          async (source) => {
            for await (const _ of source);
          },
        ).catch((caught: unknown) => caught);
        expect(error).toBe(failure);
      },
    );
  }
});

describe("detectCompression", () => {
  // Needs the zstd codec to produce a real zstd frame.
  it.skipIf(ZSTD_UNAVAILABLE)("recognises a zstd frame by its magic bytes", async () => {
    expect(detectCompression(await compress("zstd", Buffer.from("x")))).toBe("zstd");
  });

  it("recognises zstd magic bytes, zstd skippable frames and gzip without the zstd codec", async () => {
    // Detection only reads bytes, so it works on a Node.js without zstd too.
    expect(detectCompression(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0]))).toBe("zstd");
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
        // Every compression this Node.js can run (zstd only on 22.15+ / 23.8+).
        fc.constantFrom<Compression>(...RUNNABLE),
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

  // Needs the zstd codec itself.
  it.skipIf(ZSTD_UNAVAILABLE)("detects any truncation of zstd data", async () => {
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
