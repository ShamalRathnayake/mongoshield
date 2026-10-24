import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { createCountingStream, createDigestStream, type StreamCounts } from "./hashing.ts";

/** Pipes `input` through `stream` and returns what came out. */
async function runThrough(
  input: readonly unknown[],
  stream: NodeJS.ReadWriteStream,
): Promise<unknown[]> {
  const output: unknown[] = [];
  const collector = new Writable({
    objectMode: true,
    write(item: unknown, _encoding, callback) {
      output.push(item);
      callback();
    },
  });
  await pipeline([Readable.from(input), stream, collector]);
  return output;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("createDigestStream", () => {
  it("passes data through unchanged and reports its SHA-256 and size", async () => {
    const chunks = [Buffer.from("hello "), Buffer.from("world")];
    const { stream, digest } = createDigestStream();
    const output = await runThrough(chunks, stream);
    expect(Buffer.concat(output as Buffer[])).toEqual(Buffer.from("hello world"));
    expect(digest()).toEqual({ sha256: sha256(Buffer.from("hello world")), size: 11 });
  });

  it("reports the digest of empty input", async () => {
    const { stream, digest } = createDigestStream();
    await runThrough([], stream);
    expect(digest()).toEqual({ sha256: sha256(Buffer.alloc(0)), size: 0 });
  });

  it("throws if the digest is read before the stream has finished", () => {
    const { stream, digest } = createDigestStream();
    stream.write(Buffer.from("partial"));
    let caught: unknown;
    try {
      digest();
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_INTERNAL")).toBe(true);
    stream.destroy();
  });

  it("matches node:crypto for any data split into any chunks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ maxLength: 512 }), { maxLength: 10 }),
        async (parts) => {
          const { stream, digest } = createDigestStream();
          await runThrough(
            parts.map((part) => Buffer.from(part)),
            stream,
          );
          const all = Buffer.concat(parts);
          expect(digest()).toEqual({ sha256: sha256(all), size: all.length });
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("createCountingStream", () => {
  it("counts chunks and bytes of a byte stream", async () => {
    const { stream, counts } = createCountingStream();
    const output = await runThrough([Buffer.from("abc"), new Uint8Array(5), "é"], stream);
    expect(output).toHaveLength(3);
    expect(counts()).toEqual({ items: 3, bytes: 10 });
  });

  it("counts objects, which have no byte size", async () => {
    const { stream, counts } = createCountingStream();
    const documents = [{ a: 1 }, { b: 2 }];
    expect(await runThrough(documents, stream)).toEqual(documents);
    expect(counts()).toEqual({ items: 2, bytes: 0 });
  });

  it("reports progress after every item", async () => {
    const updates: StreamCounts[] = [];
    const { stream } = createCountingStream({ onProgress: (counts) => updates.push(counts) });
    await runThrough([Buffer.from("ab"), Buffer.from("c")], stream);
    expect(updates).toEqual([
      { items: 1, bytes: 2 },
      { items: 2, bytes: 3 },
    ]);
  });

  it("starts at zero", () => {
    expect(createCountingStream().counts()).toEqual({ items: 0, bytes: 0 });
  });
});
