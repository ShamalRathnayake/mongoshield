/**
 * Pass-through streams that measure what flows through them.
 *
 * - `createDigestStream()` computes the SHA-256 and byte size of a stored file.
 *   The backup engine puts it last in each file's pipeline, right before
 *   `storage.put`, so the digest covers exactly the bytes that were stored
 *   (after compression and encryption). Those values go into the manifest's
 *   `StoredFile` entries and let `verify` check a backup without any keys.
 *
 *     BSON → compress → encrypt → createDigestStream().stream → storage.put
 *
 * - `createCountingStream()` counts items and bytes for progress reporting.
 */

import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { MongoShieldError } from "../errors.ts";

/** Checksum and size of a stored file, as recorded in the manifest. */
export interface FileDigest {
  /** Lowercase hex SHA-256 of every byte that passed through. */
  readonly sha256: string;
  /** Number of bytes that passed through. */
  readonly size: number;
}

/** A pass-through stream plus a way to read its digest once it has finished. */
export interface DigestStream {
  /** Pass-through byte stream; data comes out unchanged. */
  readonly stream: Transform;
  /**
   * The digest of everything written to `stream`.
   * @throws MS_INTERNAL if called before the stream has finished (all data flushed).
   */
  digest(): FileDigest;
}

/** Creates a pass-through stream that computes SHA-256 and size of its data. */
export function createDigestStream(): DigestStream {
  const hash = createHash("sha256");
  let size = 0;
  let result: FileDigest | undefined;

  const stream = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      // A hash can only be finalised once, so compute the result here and keep it.
      result = { sha256: hash.digest("hex"), size };
      callback();
    },
  });

  return {
    stream,
    digest() {
      if (result === undefined) {
        throw new MongoShieldError(
          "MS_INTERNAL",
          "The digest was read before the stream finished.",
          { hint: "Read the digest only after the pipeline that writes the file has completed." },
        );
      }
      return result;
    },
  };
}

/** Running totals of a counting stream. */
export interface StreamCounts {
  /** Chunks (byte streams) or objects (object streams) that passed through. */
  readonly items: number;
  /**
   * Bytes that passed through. Only `Uint8Array`/`Buffer` and string chunks have
   * a size; other objects add to `items` but not to `bytes`.
   */
  readonly bytes: number;
}

/** Options for `createCountingStream()`. */
export interface CountingStreamOptions {
  /** Called after every chunk with the new totals. Keep it cheap: it runs per item. */
  readonly onProgress?: (counts: StreamCounts) => void;
}

/** A pass-through stream plus its running totals. */
export interface CountingStream {
  /** Pass-through stream, in object mode so it works for both bytes and documents. */
  readonly stream: Transform;
  /** The totals so far. Safe to call at any time. */
  counts(): StreamCounts;
}

/**
 * Creates a pass-through stream that counts items and bytes, for progress reporting.
 *
 * It runs in object mode, which also carries Buffers unchanged, so the same stream
 * can sit in a byte pipeline (counting bytes) or after the BSON splitter (counting
 * documents, whose raw Buffers also give a byte count).
 */
export function createCountingStream(options: CountingStreamOptions = {}): CountingStream {
  let items = 0;
  let bytes = 0;

  const stream = new Transform({
    objectMode: true,
    transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback) {
      items += 1;
      bytes += sizeOf(chunk);
      options.onProgress?.({ items, bytes });
      callback(null, chunk);
    },
  });

  return { stream, counts: () => ({ items, bytes }) };
}

/** Byte size of a chunk, or 0 for objects with no natural byte size. */
function sizeOf(chunk: unknown): number {
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  if (typeof chunk === "string") return Buffer.byteLength(chunk, "utf8");
  return 0;
}
