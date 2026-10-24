/**
 * A tiny zstd frame walker: it finds frame boundaries in a compressed byte stream
 * without decompressing anything. It works around two problems in Node's zstd
 * decompressor (seen in Node 24):
 *
 * 1. Truncation goes unnoticed. A stream that stops in the middle of a frame just
 *    ends, emitting whatever could be decoded, so a truncated `users.bson.zst`
 *    would restore part of a collection without any error. (gzip does not have
 *    this problem: zlib reports "unexpected end of file".) The walker knows
 *    whether the input ended exactly between two frames.
 *
 * 2. Several frames in one chunk can break it. When one input chunk holds the end
 *    of a frame plus only the beginning of the next frame, the decompressor fails
 *    with "Premature close". Node's own compressor produces such multi-frame
 *    output (it can end a stream with a small extra empty frame), so ordinary
 *    reads with arbitrary chunk sizes hit this. The walker reports where frames
 *    end inside each chunk, so `./index.ts` can hand the decompressor one frame
 *    at a time.
 *
 * It only reads the few header bytes that say how long each piece of a frame is,
 * and skips over the rest, so it costs almost nothing.
 *
 * Frame layout (RFC 8878, section 3.1), all integers little-endian:
 *
 *   Zstandard frame
 *     Magic_Number             4 bytes   28 B5 2F FD  (0xFD2FB528)
 *     Frame_Header_Descriptor  1 byte    flags, see `parseFrameHeaderDescriptor`
 *     Window_Descriptor        0-1 byte  absent when Single_Segment_flag is set
 *     Dictionary_ID            0-4 bytes
 *     Frame_Content_Size       0-8 bytes
 *     Block...                 one or more, the last one has Last_Block = 1
 *       Block_Header           3 bytes   bit 0 Last_Block, bits 1-2 Block_Type,
 *                                        bits 3-23 Block_Size
 *       Block_Content          Block_Size bytes (or 1 byte for RLE blocks)
 *     Content_Checksum         0-4 bytes present when Content_Checksum_flag is set
 *
 *   Skippable frame (may appear between frames; we never write them, but they are valid)
 *     Magic_Number             4 bytes   0x184D2A50 to 0x184D2A5F
 *     Frame_Size               4 bytes
 *     User_Data                Frame_Size bytes
 */

import { MongoShieldError } from "../errors.ts";

/** Magic number that starts every zstd frame (bytes `28 B5 2F FD` on disk). */
export const ZSTD_FRAME_MAGIC = 0xfd2fb528;

/** Skippable frames use magic numbers 0x184D2A50..0x184D2A5F; the low 4 bits are free. */
const SKIPPABLE_FRAME_MAGIC_BASE = 0x184d2a50;
const SKIPPABLE_FRAME_MAGIC_MASK = 0xfffffff0;

/** Block_Type values from the block header. */
const BLOCK_TYPE_RLE = 1;
const BLOCK_TYPE_RESERVED = 3;

/** Size of the optional XXH64-based content checksum at the end of a frame. */
const CONTENT_CHECKSUM_BYTES = 4;

/**
 * What the walker does next. A step either needs the next `length` bytes
 * (a small fixed-size header field) or skips `length` bytes it does not care about
 * (block contents, the bulk of the data).
 */
type Step =
  | { readonly kind: "read"; readonly length: number; readonly onBytes: (bytes: Buffer) => Step }
  | { readonly kind: "skip"; readonly length: number; readonly next: () => Step };

/** Header fields are at most 4 bytes long, so a tiny scratch buffer is enough. */
const MAX_READ_LENGTH = 4;

/**
 * Tracks frame boundaries in a zstd byte stream fed to it chunk by chunk.
 *
 *   const walker = new ZstdFrameWalker();
 *   const frameEnds = walker.consume(chunk);  // for every compressed chunk, in order
 *   walker.assertEndedCleanly();              // when the input ends
 */
export class ZstdFrameWalker {
  /** The step currently waiting for bytes. */
  #step: Step;
  /** Bytes of the current "read" step collected so far. */
  readonly #scratch = Buffer.alloc(MAX_READ_LENGTH);
  #scratchFilled = 0;
  /** Bytes of the current "skip" step still to skip. */
  #skipRemaining = 0;
  /** Number of frames seen from start to end. */
  #completedFrames = 0;
  /** Total bytes consumed, used in error messages. */
  #offset = 0;

  constructor() {
    // Set here rather than in the field list: the step refers to `#onMagicNumber`,
    // which is itself a field and only exists once the field initializers have run.
    this.#step = this.#expectFrameStart();
  }

  /**
   * Feeds the next chunk of compressed bytes and returns the positions in `chunk`
   * right after each frame that ended inside it (in increasing order).
   * Throws `MS_INTEGRITY_FAILED` on bytes that cannot be zstd.
   */
  consume(chunk: Uint8Array): number[] {
    const frameEnds: number[] = [];
    let position = 0;
    while (position < chunk.length) {
      const framesBefore = this.#completedFrames;
      const step = this.#step;
      if (step.kind === "skip") {
        const take = Math.min(this.#skipRemaining, chunk.length - position);
        position += take;
        this.#skipRemaining -= take;
        if (this.#skipRemaining === 0) this.#enter(step.next());
      } else {
        const take = Math.min(step.length - this.#scratchFilled, chunk.length - position);
        this.#scratch.set(chunk.subarray(position, position + take), this.#scratchFilled);
        this.#scratchFilled += take;
        position += take;
        if (this.#scratchFilled === step.length) {
          const bytes = this.#scratch.subarray(0, step.length);
          this.#scratchFilled = 0;
          this.#enter(step.onBytes(bytes));
        }
      }
      // Step transitions happen at `position`, so any frame they finished ends there.
      if (this.#completedFrames !== framesBefore) frameEnds.push(position);
    }
    this.#offset += chunk.length;
    return frameEnds;
  }

  /**
   * Throws `MS_INTEGRITY_FAILED` unless the input consisted of whole frames.
   * Empty input is also an error: compressing even zero bytes produces one frame.
   */
  assertEndedCleanly(): void {
    const betweenFrames = this.#isAtFrameStart() && this.#scratchFilled === 0;
    if (betweenFrames && this.#completedFrames > 0) return;
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      this.#offset === 0
        ? "The zstd data is empty."
        : `The zstd data ends in the middle of a frame after ${this.#offset} bytes; it was truncated.`,
      { hint: "The stored file is incomplete. Verify the backup or restore from another one." },
    );
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /** Moves to `step`, resolving zero-length skips immediately. */
  #enter(step: Step): void {
    let current = step;
    while (current.kind === "skip" && current.length === 0) current = current.next();
    this.#step = current;
    if (current.kind === "skip") this.#skipRemaining = current.length;
  }

  #isAtFrameStart(): boolean {
    const step = this.#step;
    return step.kind === "read" && step.onBytes === this.#onMagicNumber;
  }

  #expectFrameStart(): Step {
    return { kind: "read", length: 4, onBytes: this.#onMagicNumber };
  }

  /** Arrow function so `#isAtFrameStart` can compare it by identity. */
  readonly #onMagicNumber = (bytes: Buffer): Step => {
    const magic = bytes.readUInt32LE(0);
    if (magic === ZSTD_FRAME_MAGIC) {
      return { kind: "read", length: 1, onBytes: (descriptor) => this.#onDescriptor(descriptor) };
    }
    if ((magic & SKIPPABLE_FRAME_MAGIC_MASK) === SKIPPABLE_FRAME_MAGIC_BASE) {
      return { kind: "read", length: 4, onBytes: (size) => this.#skipUserData(size) };
    }
    throw this.#corrupt(`unknown frame magic number 0x${magic.toString(16)}`);
  };

  #skipUserData(sizeBytes: Buffer): Step {
    return { kind: "skip", length: sizeBytes.readUInt32LE(0), next: () => this.#frameDone() };
  }

  #onDescriptor(bytes: Buffer): Step {
    const header = parseFrameHeaderDescriptor(bytes.readUInt8(0));
    if (header.reservedBitSet) throw this.#corrupt("reserved bit set in the frame header");
    return {
      kind: "skip",
      length: header.remainingHeaderBytes,
      next: () => this.#expectBlockHeader(header.hasChecksum),
    };
  }

  #expectBlockHeader(hasChecksum: boolean): Step {
    return {
      kind: "read",
      length: 3,
      onBytes: (bytes) => this.#onBlockHeader(bytes, hasChecksum),
    };
  }

  #onBlockHeader(bytes: Buffer, hasChecksum: boolean): Step {
    // 24-bit little-endian value: bit 0 last block, bits 1-2 type, bits 3-23 size.
    const value = bytes.readUIntLE(0, 3);
    const isLastBlock = (value & 0b1) === 1;
    const blockType = (value >>> 1) & 0b11;
    const blockSize = value >>> 3;
    if (blockType === BLOCK_TYPE_RESERVED) throw this.#corrupt("reserved block type");

    // An RLE block stores a single byte that is repeated Block_Size times.
    const contentLength = blockType === BLOCK_TYPE_RLE ? 1 : blockSize;
    const afterContent = isLastBlock
      ? (): Step => ({
          kind: "skip",
          length: hasChecksum ? CONTENT_CHECKSUM_BYTES : 0,
          next: () => this.#frameDone(),
        })
      : (): Step => this.#expectBlockHeader(hasChecksum);
    return { kind: "skip", length: contentLength, next: afterContent };
  }

  #frameDone(): Step {
    this.#completedFrames += 1;
    return this.#expectFrameStart();
  }

  #corrupt(reason: string): MongoShieldError {
    return new MongoShieldError("MS_INTEGRITY_FAILED", `The zstd data is corrupt: ${reason}.`, {
      hint: "The stored file is damaged or is not zstd. Verify the backup or restore from another one.",
    });
  }
}

/** The parts of the Frame_Header_Descriptor byte the walker needs. */
interface FrameHeaderDescriptor {
  /** Bytes between the descriptor and the first block header. */
  readonly remainingHeaderBytes: number;
  /** Whether a 4-byte content checksum follows the last block. */
  readonly hasChecksum: boolean;
  /** Bit 3 must be zero in valid frames. */
  readonly reservedBitSet: boolean;
}

/**
 * Decodes the Frame_Header_Descriptor byte:
 *
 *   bits 7-6  Frame_Content_Size_flag  → FCS field of 0/1, 2, 4 or 8 bytes
 *   bit  5    Single_Segment_flag      → when set, no Window_Descriptor byte,
 *                                        and flag 0 means a 1-byte FCS field
 *   bit  4    unused
 *   bit  3    reserved, must be 0
 *   bit  2    Content_Checksum_flag
 *   bits 1-0  Dictionary_ID_flag       → Dictionary_ID field of 0, 1, 2 or 4 bytes
 */
function parseFrameHeaderDescriptor(descriptor: number): FrameHeaderDescriptor {
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0b0010_0000) !== 0;
  const reservedBitSet = (descriptor & 0b0000_1000) !== 0;
  const hasChecksum = (descriptor & 0b0000_0100) !== 0;
  const dictionaryIdFlag = descriptor & 0b0000_0011;

  const windowDescriptorBytes = singleSegment ? 0 : 1;
  const dictionaryIdBytes = [0, 1, 2, 4][dictionaryIdFlag] ?? 0;
  const contentSizeBytes =
    contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : ([0, 2, 4, 8][contentSizeFlag] ?? 0);

  return {
    remainingHeaderBytes: windowDescriptorBytes + dictionaryIdBytes + contentSizeBytes,
    hasChecksum,
    reservedBitSet,
  };
}
