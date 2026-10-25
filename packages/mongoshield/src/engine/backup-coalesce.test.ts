import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createCoalescer } from "./backup-coalesce.ts";

/** Runs `pieces` through a coalescer and returns the chunks it emitted. */
async function coalesce(pieces: readonly Uint8Array[], targetBytes: number): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  await pipeline([
    Readable.from(pieces),
    createCoalescer(targetBytes),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  ]);
  return chunks;
}

describe("createCoalescer", () => {
  it("joins small pieces into chunks of at least the target size", async () => {
    const pieces = Array.from({ length: 10 }, (_, index) => Buffer.alloc(30, index));
    const chunks = await coalesce(pieces, 100);
    expect(chunks.map((chunk) => chunk.length)).toEqual([120, 120, 60]);
    expect(Buffer.concat(chunks).equals(Buffer.concat(pieces))).toBe(true);
  });

  it("emits nothing for empty input", async () => {
    expect(await coalesce([], 100)).toEqual([]);
  });

  it("keeps every byte in order, whatever the piece sizes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 64 }), { maxLength: 50 }),
        fc.integer({ min: 1, max: 200 }),
        async (pieces, target) => {
          const chunks = await coalesce(pieces, target);
          expect(Buffer.concat(chunks).equals(Buffer.concat(pieces))).toBe(true);
          for (const chunk of chunks.slice(0, -1))
            expect(chunk.length).toBeGreaterThanOrEqual(target);
        },
      ),
    );
  });
});
