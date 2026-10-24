/**
 * Simulates Deno's `node:zlib`, whose zstd streams call the native codec through
 * `_handle[kNativeWrite]` and let a codec error THROW from `process.nextTick`
 * instead of failing the stream (see `routeThrownCodecErrors` in ./index.ts).
 *
 * `node:zlib` is mocked so `createZstdDecompress` returns a small stream built
 * the same way. Without the guard, the throw below would be an uncaught
 * exception (Vitest fails the run on those); with it, the pipeline must reject
 * with MS_INTEGRITY_FAILED like a real Node.js zstd error.
 */

import { Readable, type TransformCallback, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";

/** How the fake codec behaves for the next stream created. */
const codec = vi.hoisted(() => ({ mode: "ok" as "ok" | "throw-later" | "throw-now" }));

vi.mock("node:zlib", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:zlib")>();
  // Imported here: the mock factory runs before the file's own imports.
  const { Transform } = await import("node:stream");

  /** The private symbol Deno stores the native write method under. */
  const kNativeWrite = Symbol("kNativeWrite");

  /** A zstd "decompressor" that passes bytes through, calling its codec like Deno does. */
  class DenoLikeZstdDecompress extends Transform {
    readonly _handle: Record<symbol, (chunk: Uint8Array) => number>;

    constructor() {
      super();
      const mode = codec.mode;
      this._handle = {
        [kNativeWrite]: () => {
          if (mode !== "ok") throw new Error("Zstd decompress error: Data corruption detected");
          return 0;
        },
      };
    }

    /** Real zlib streams define `_flush`; the frame guard in ./index.ts wraps it. */
    override _flush(done: TransformCallback): void {
      done();
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
      const handle = this._handle;
      if (codec.mode === "throw-now") {
        // Deno's first write per chunk: inside a try/catch that destroys the stream.
        try {
          handle[kNativeWrite]?.(chunk);
        } catch (error) {
          this.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        done(null, chunk);
        return;
      }
      // Deno's follow-up writes once the output buffer is full: from nextTick,
      // with no try/catch around the native call.
      process.nextTick(() => {
        handle[kNativeWrite]?.(chunk);
        if (this.destroyed) done();
        else done(null, chunk);
      });
    }
  }

  return { ...original, createZstdDecompress: () => new DenoLikeZstdDecompress() };
});

const { zstdCompressSync } = await import("node:zlib");
const { createDecompressor } = await import("./index.ts");

/** Runs `input` through a zstd decompressor and returns the output bytes. */
async function decompress(input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([input]),
    createDecompressor("zstd"),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
  );
  return Buffer.concat(chunks);
}

describe("zstd codec errors thrown outside the stream (Deno)", () => {
  // Real zstd bytes, so the frame guard in front of the codec accepts them.
  const frame = zstdCompressSync(Buffer.from("hello zstd"));

  it("passes data through untouched when the codec does not throw", async () => {
    codec.mode = "ok";
    // The fake codec passes its input through, so the output is the frame itself.
    expect(await decompress(frame)).toEqual(frame);
  });

  it("fails the stream with MS_INTEGRITY_FAILED when the codec throws from nextTick", async () => {
    codec.mode = "throw-later";
    await expect(decompress(frame)).rejects.toMatchObject({
      code: "MS_INTEGRITY_FAILED",
      message: expect.stringContaining("Data corruption detected"),
    });
  });

  it("maps a codec error thrown during the first write to MS_INTEGRITY_FAILED too", async () => {
    codec.mode = "throw-now";
    await expect(decompress(frame)).rejects.toMatchObject({ code: "MS_INTEGRITY_FAILED" });
  });
});
