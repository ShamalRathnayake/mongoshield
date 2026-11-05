/**
 * Tests for cutting upload bodies into chunks (chunks.ts): exact sizes, the `last`
 * flag, empty bodies, backpressure (the source is not read ahead of the consumer),
 * provider size rules, aborts and source errors.
 */

import { Readable } from "node:stream";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../../errors.ts";
import {
  assertValidChunkSize,
  DROPBOX_MAX_CHUNK,
  GOOGLE_DRIVE_CHUNK_MULTIPLE,
  readChunks,
  type UploadChunk,
} from "./chunks.ts";

async function collect(chunks: AsyncIterable<UploadChunk>): Promise<UploadChunk[]> {
  const all: UploadChunk[] = [];
  for await (const chunk of chunks) all.push(chunk);
  return all;
}

/** A stream of the given piece sizes, filled with a running byte counter. */
function piecesStream(sizes: readonly number[]): { stream: Readable; bytes: Buffer } {
  let counter = 0;
  const pieces = sizes.map((size) => {
    const piece = Buffer.alloc(size);
    for (let index = 0; index < size; index++) piece[index] = counter++ & 0xff;
    return piece;
  });
  return { stream: Readable.from(pieces), bytes: Buffer.concat(pieces) };
}

describe("readChunks", () => {
  it("yields full chunks and a shorter last one, with offsets", async () => {
    const { stream, bytes } = piecesStream([3, 4, 1, 2]);
    const chunks = await collect(readChunks(stream, { chunkSize: 4 }));
    expect(chunks.map((chunk) => [chunk.offset, chunk.bytes.length, chunk.last])).toEqual([
      [0, 4, false],
      [4, 4, false],
      [8, 2, true],
    ]);
    expect(Buffer.concat(chunks.map((chunk) => chunk.bytes))).toEqual(bytes);
  });

  it("marks a final chunk of exactly chunkSize as last", async () => {
    const { stream } = piecesStream([4, 4]);
    const chunks = await collect(readChunks(stream, { chunkSize: 4 }));
    expect(chunks.map((chunk) => [chunk.bytes.length, chunk.last])).toEqual([
      [4, false],
      [4, true],
    ]);
  });

  it("yields one empty last chunk for an empty body", async () => {
    expect(await collect(readChunks(Readable.from([]), { chunkSize: 4 }))).toEqual([
      { bytes: Buffer.alloc(0), offset: 0, last: true },
    ]);
    expect(await collect(readChunks(new Uint8Array(0), { chunkSize: 4 }))).toEqual([
      { bytes: Buffer.alloc(0), offset: 0, last: true },
    ]);
  });

  it("cuts an in-memory buffer without copying", async () => {
    const body = Buffer.from("abcdefghij");
    const chunks = await collect(readChunks(body, { chunkSize: 4 }));
    expect(chunks.map((chunk) => chunk.bytes.toString())).toEqual(["abcd", "efgh", "ij"]);
    expect(chunks.map((chunk) => chunk.last)).toEqual([false, false, true]);
    expect(chunks[0]?.bytes.buffer).toBe(body.buffer);
  });

  it("splits a piece larger than several chunks", async () => {
    const { stream } = piecesStream([10]);
    const chunks = await collect(readChunks(stream, { chunkSize: 3 }));
    expect(chunks.map((chunk) => chunk.bytes.length)).toEqual([3, 3, 3, 1]);
  });

  it("reassembles any body exactly, for any piece and chunk sizes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 20 }),
        fc.integer({ min: 1, max: 16 }),
        async (sizes, chunkSize) => {
          const { stream, bytes } = piecesStream(sizes);
          const chunks = await collect(readChunks(stream, { chunkSize }));
          expect(Buffer.concat(chunks.map((chunk) => chunk.bytes))).toEqual(bytes);
          expect(chunks.filter((chunk) => chunk.last)).toHaveLength(1);
          expect(chunks.at(-1)?.last).toBe(true);
          for (const chunk of chunks.slice(0, -1)) expect(chunk.bytes.length).toBe(chunkSize);
        },
      ),
    );
  });

  it("does not read the source ahead of the consumer (backpressure)", async () => {
    let produced = 0;
    async function* source() {
      for (let index = 0; index < 100; index++) {
        produced += 1;
        yield Buffer.alloc(1024);
      }
    }
    const iterator = readChunks(Readable.from(source(), { highWaterMark: 1 }), { chunkSize: 4096 });
    const first = await iterator.next();
    expect(first.value?.bytes.length).toBe(4096);
    // One chunk of 4 pieces, one piece of look-ahead and the stream's small buffer.
    expect(produced).toBeLessThan(10);
    await iterator.return(undefined);
  });

  it("passes a source error through", async () => {
    async function* failing() {
      yield Buffer.from("abc");
      throw new Error("source failed");
    }
    await expect(collect(readChunks(Readable.from(failing()), { chunkSize: 2 }))).rejects.toThrow(
      "source failed",
    );
  });

  it("stops with MS_ABORTED when the signal fires", async () => {
    const controller = new AbortController();
    const { stream } = piecesStream([4, 4, 4]);
    const chunks = readChunks(stream, { chunkSize: 4, signal: controller.signal });
    await chunks.next();
    controller.abort();
    const error = await chunks.next().catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    const before = await collect(
      readChunks(Buffer.from("x"), { chunkSize: 4, signal: AbortSignal.abort() }),
    ).catch((reason: unknown) => reason);
    expect(isMongoShieldError(before, "MS_ABORTED")).toBe(true);
  });
});

describe("assertValidChunkSize", () => {
  it("accepts the provider rules' own sizes", () => {
    assertValidChunkSize({
      chunkSize: 32 * GOOGLE_DRIVE_CHUNK_MULTIPLE,
      multipleOf: GOOGLE_DRIVE_CHUNK_MULTIPLE,
    });
    assertValidChunkSize({ chunkSize: DROPBOX_MAX_CHUNK, maxChunkSize: DROPBOX_MAX_CHUNK });
  });

  it.each([
    [{ chunkSize: 0 }, "a positive whole number"],
    [{ chunkSize: 1.5 }, "a positive whole number"],
    [{ chunkSize: 1000, multipleOf: GOOGLE_DRIVE_CHUNK_MULTIPLE }, "a multiple of 256 KiB"],
    [{ chunkSize: DROPBOX_MAX_CHUNK + 1, maxChunkSize: DROPBOX_MAX_CHUNK }, "at most 150 MiB"],
  ])("refuses %j", (options, hint) => {
    let caught: unknown;
    try {
      assertValidChunkSize(options);
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_CONFIG_INVALID")).toBe(true);
    expect(isMongoShieldError(caught) && caught.hint).toContain(hint);
  });
});
