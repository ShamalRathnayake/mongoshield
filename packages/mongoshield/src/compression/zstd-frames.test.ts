import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { ZstdFrameWalker } from "./zstd-frames.ts";

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** Encodes a 3-byte block header: bit 0 last block, bits 1-2 type, bits 3-23 size. */
function blockHeader(last: boolean, type: number, size: number): number[] {
  const value = (last ? 1 : 0) | (type << 1) | (size << 3);
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

/**
 * A hand-built frame: single segment with a 1-byte content size (descriptor 0x20),
 * one raw block holding "hi", then one last RLE block repeating "!" three times.
 */
const HAND_BUILT_FRAME = Buffer.from([
  ...MAGIC,
  0x20, // Single_Segment_flag set, so no Window_Descriptor and a 1-byte FCS
  5, // Frame_Content_Size
  ...blockHeader(false, 0, 2),
  0x68,
  0x69,
  ...blockHeader(true, 1, 3),
  0x21,
]);

function walkInPieces(data: Buffer, pieceSize: number): number[] {
  const walker = new ZstdFrameWalker();
  const frameEnds: number[] = [];
  for (let start = 0; start < data.length; start += pieceSize) {
    for (const end of walker.consume(data.subarray(start, start + pieceSize))) {
      frameEnds.push(start + end);
    }
  }
  walker.assertEndedCleanly();
  return frameEnds;
}

function expectCorrupt(action: () => void): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(isMongoShieldError(caught, "MS_INTEGRITY_FAILED")).toBe(true);
}

describe("ZstdFrameWalker", () => {
  it("reports where each frame ends, however the input is chunked", () => {
    const first = zstdCompressSync(Buffer.from("hello"));
    const second = zstdCompressSync(Buffer.alloc(10_000, 7));
    const data = Buffer.concat([first, HAND_BUILT_FRAME, second]);
    const expected = [first.length, first.length + HAND_BUILT_FRAME.length, data.length];
    for (const pieceSize of [1, 2, 3, 7, 64, data.length]) {
      expect(walkInPieces(data, pieceSize)).toEqual(expected);
    }
  });

  it("understands frames with a checksum, a dictionary id and a window descriptor", () => {
    const frame = Buffer.from([
      ...MAGIC,
      0b0100_0101, // FCS flag 1 (2 bytes), checksum, dictionary id flag 1 (1 byte)
      0x00, // Window_Descriptor
      0x09, // Dictionary_ID
      0x00,
      0x00, // Frame_Content_Size
      ...blockHeader(true, 0, 0),
      0xaa,
      0xbb,
      0xcc,
      0xdd, // Content_Checksum
    ]);
    expect(walkInPieces(frame, 1)).toEqual([frame.length]);
  });

  it("skips skippable frames", () => {
    const skippable = Buffer.from([0x5a, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 0xff, 0xff]);
    expect(walkInPieces(Buffer.concat([skippable, HAND_BUILT_FRAME]), 3)).toEqual([
      skippable.length,
      skippable.length + HAND_BUILT_FRAME.length,
    ]);
  });

  it("rejects input that ends inside a frame, at any point", () => {
    for (let length = 1; length < HAND_BUILT_FRAME.length; length += 1) {
      const walker = new ZstdFrameWalker();
      walker.consume(HAND_BUILT_FRAME.subarray(0, length));
      expectCorrupt(() => walker.assertEndedCleanly());
    }
  });

  it("rejects empty input", () => {
    expectCorrupt(() => new ZstdFrameWalker().assertEndedCleanly());
  });

  it("rejects an unknown magic number", () => {
    expectCorrupt(() => new ZstdFrameWalker().consume(Buffer.from("BSON")));
  });

  it("rejects a frame header with the reserved bit set", () => {
    expectCorrupt(() => new ZstdFrameWalker().consume(Buffer.from([...MAGIC, 0b0000_1000])));
  });

  it("rejects the reserved block type", () => {
    const frame = Buffer.from([...MAGIC, 0x20, 0, ...blockHeader(true, 3, 0)]);
    expectCorrupt(() => new ZstdFrameWalker().consume(frame));
  });
});
