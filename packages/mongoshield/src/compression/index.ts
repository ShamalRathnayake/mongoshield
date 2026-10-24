/**
 * Compression streams for backup data files: zstd, gzip or none.
 *
 * The backup engine pipes BSON through `createCompressor()` before encryption,
 * and restore pipes stored bytes through `createDecompressor()` after decryption:
 *
 *   backup:   BSON → createCompressor → (age encrypt) → digest → storage.put
 *   restore:  storage.get → (age decrypt) → createDecompressor → BSON splitter
 *
 * Both sides are built on `node:zlib`, which has zstd since Node 22.15 / 23.8.
 * On older runtimes `defaultCompression()` falls back to gzip, and reading a zstd
 * backup fails with a clear error instead of a crash.
 *
 * Decompressors report damaged input as `MS_INTEGRITY_FAILED`. For zstd that
 * includes truncated input, which Node itself does not detect, and the zstd
 * decompressor is protected from a Node bug with multi-frame input (see `./zstd-frames.ts`).
 *
 * Note: Node's zstd compressor may end a stream with a small extra, empty frame.
 * That is valid zstd (a file may hold any number of concatenated frames) and every
 * zstd reader, including the `zstd` command line tool, handles it.
 *
 * Bun and Deno implement the same `node:zlib` API, zstd included. Deno's version
 * can throw a zstd error outside the stream instead of failing it, which
 * `routeThrownCodecErrors` turns back into a normal stream error (see there).
 */

import { PassThrough, type Transform, type TransformCallback } from "node:stream";
import * as zlib from "node:zlib";
import { type ErrorCode, MongoShieldError } from "../errors.ts";
import type { Compression } from "../format/manifest.ts";
import { ZstdFrameWalker } from "./zstd-frames.ts";

export type { Compression } from "../format/manifest.ts";

/** Options for `createCompressor()`. */
export interface CompressorOptions {
  /**
   * Compression level. zstd accepts 1 (fastest) to 22 (smallest), default 3.
   * gzip accepts 0 (store only) to 9 (smallest), default 6. Ignored for `"none"`.
   */
  readonly level?: number;
}

/**
 * Default zstd level. Level 3 is zstd's own default: it compresses about as well
 * as gzip -6 while being several times faster, which suits large dumps.
 */
export const DEFAULT_ZSTD_LEVEL = 3;

/** Default gzip level, the same as the `gzip` command line tool. */
export const DEFAULT_GZIP_LEVEL = 6;

/** Valid level ranges, inclusive. Negative "fast" zstd levels are deliberately not offered. */
const LEVEL_RANGES = {
  zstd: { min: 1, max: 22 },
  gzip: { min: 0, max: 9 },
} as const;

/** zstd frames start with the magic number 0xFD2FB528, stored little-endian. */
const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd] as const;
/** zstd skippable frames: first byte 0x50-0x5F, then 2A 4D 18. */
const ZSTD_SKIPPABLE_MAGIC_TAIL = [0x2a, 0x4d, 0x18] as const;
/** gzip members start with ID1 = 0x1F, ID2 = 0x8B (RFC 1952). */
const GZIP_MAGIC_BYTES = [0x1f, 0x8b] as const;

const NODE_ZSTD_HINT =
  "zstd needs Node.js 22.15 or 23.8 and later. Upgrade Node.js, or use gzip compression.";

// ---------------------------------------------------------------------------
// Availability and defaults
// ---------------------------------------------------------------------------

/**
 * Returns true if this Node.js runtime can compress and decompress zstd.
 * `node:zlib` gained zstd in Node 22.15 / 23.8; the package supports Node 22.12+.
 */
export function isZstdAvailable(): boolean {
  // A namespace import yields `undefined` for exports the running Node.js lacks,
  // even though the type definitions always declare them.
  return (
    typeof zlib.createZstdCompress === "function" && typeof zlib.createZstdDecompress === "function"
  );
}

/** The compression new backups use when none is configured: zstd if available, else gzip. */
export function defaultCompression(): Compression {
  return isZstdAvailable() ? "zstd" : "gzip";
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Guesses the compression of a file from its first bytes (pass at least 4).
 * Returns `undefined` when the bytes match no known format, which usually means
 * the data is uncompressed (or still encrypted).
 */
export function detectCompression(firstBytes: Uint8Array): Compression | undefined {
  if (startsWith(firstBytes, ZSTD_MAGIC_BYTES)) return "zstd";
  const isSkippableFrame =
    firstBytes.length >= 4 &&
    ((firstBytes[0] ?? 0) & 0xf0) === 0x50 &&
    startsWith(firstBytes.subarray(1), ZSTD_SKIPPABLE_MAGIC_TAIL);
  if (isSkippableFrame) return "zstd";
  if (startsWith(firstBytes, GZIP_MAGIC_BYTES)) return "gzip";
  return undefined;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

// ---------------------------------------------------------------------------
// Compressors
// ---------------------------------------------------------------------------

/**
 * Creates a stream that compresses bytes with the given algorithm.
 * `"none"` returns a plain pass-through so callers can always build the same pipeline.
 *
 * @throws MS_CONFIG_INVALID for an out-of-range level, or zstd on a runtime without it.
 */
export function createCompressor(
  compression: Compression,
  options: CompressorOptions = {},
): Transform {
  switch (compression) {
    case "zstd": {
      assertZstdAvailable("MS_CONFIG_INVALID");
      const level = resolveLevel("zstd", options.level, DEFAULT_ZSTD_LEVEL);
      const stream = zlib.createZstdCompress({
        params: {
          [zlib.constants.ZSTD_c_compressionLevel]: level,
          // Adds a 4-byte checksum of the uncompressed content to every frame, so
          // decompression detects corruption inside the compressed data. libzstd
          // leaves it off by default; the zstd CLI turns it on, and so do we.
          [zlib.constants.ZSTD_c_checksumFlag]: 1,
        },
      });
      routeThrownCodecErrors(stream);
      return mapZlibErrors(stream, "MS_INTERNAL", "zstd compression failed");
    }
    case "gzip": {
      const level = resolveLevel("gzip", options.level, DEFAULT_GZIP_LEVEL);
      return mapZlibErrors(zlib.createGzip({ level }), "MS_INTERNAL", "gzip compression failed");
    }
    case "none":
      return new PassThrough();
  }
}

/** Validates a user-supplied level, or returns the default. */
function resolveLevel(
  compression: keyof typeof LEVEL_RANGES,
  level: number | undefined,
  defaultLevel: number,
): number {
  if (level === undefined) return defaultLevel;
  const { min, max } = LEVEL_RANGES[compression];
  if (!Number.isInteger(level) || level < min || level > max) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Invalid ${compression} compression level ${String(level)}.`,
      { hint: `Use a whole number from ${min} to ${max}.` },
    );
  }
  return level;
}

// ---------------------------------------------------------------------------
// Decompressors
// ---------------------------------------------------------------------------

/**
 * Creates a stream that decompresses bytes written with `createCompressor()`.
 * Corrupt or truncated input makes the stream fail with `MS_INTEGRITY_FAILED`.
 *
 * @throws MS_FORMAT_UNSUPPORTED for zstd on a runtime without zstd support.
 */
export function createDecompressor(compression: Compression): Transform {
  switch (compression) {
    case "zstd": {
      assertZstdAvailable("MS_FORMAT_UNSUPPORTED");
      const stream = zlib.createZstdDecompress();
      guardZstdFrames(stream);
      routeThrownCodecErrors(stream);
      return mapZlibErrors(stream, "MS_INTEGRITY_FAILED", "The zstd data is corrupt");
    }
    case "gzip":
      // zlib already reports truncated gzip ("unexpected end of file") by itself.
      return mapZlibErrors(zlib.createGunzip(), "MS_INTEGRITY_FAILED", "The gzip data is corrupt");
    case "none":
      return new PassThrough();
  }
}

function assertZstdAvailable(code: ErrorCode): void {
  if (!isZstdAvailable()) {
    throw new MongoShieldError(code, `zstd is not available in Node.js ${process.version}.`, {
      hint: NODE_ZSTD_HINT,
    });
  }
}

/**
 * Puts a `ZstdFrameWalker` in front of Node's zstd decompressor, which
 * (see `./zstd-frames.ts` for the details):
 *
 * - fails the stream at the end if the input stopped in the middle of a frame;
 * - cuts each input chunk at frame boundaries, so the decompressor never sees the
 *   end of one frame together with a partial next frame in one write, which makes
 *   it fail with "Premature close".
 *
 * Node's zlib streams have no hook for this, so we wrap the stream's own
 * `_transform` and `_flush` on this one instance. The wrappers call the original
 * methods, so zlib's buffering and backpressure are untouched: the next piece of
 * a cut chunk is only handed over once zlib has finished the previous one.
 */
function guardZstdFrames(stream: Transform): void {
  const walker = new ZstdFrameWalker();
  const originalTransform = stream._transform.bind(stream);
  const originalFlush = stream._flush.bind(stream);

  stream._transform = (chunk: unknown, encoding: BufferEncoding, callback: TransformCallback) => {
    if (!(chunk instanceof Uint8Array)) {
      originalTransform(chunk, encoding, callback);
      return;
    }
    let pieces: Uint8Array[];
    try {
      pieces = cutAtPositions(chunk, walker.consume(chunk));
    } catch (error) {
      callback(asError(error));
      return;
    }
    transformInSequence(pieces, 0);

    /** Hands `pieces[index]` to zlib, then the next one once zlib is done with it. */
    function transformInSequence(remaining: Uint8Array[], index: number): void {
      const piece = remaining[index];
      if (piece === undefined || index === remaining.length - 1) {
        originalTransform(piece ?? chunk, encoding, callback);
        return;
      }
      originalTransform(piece, encoding, (error) => {
        if (error) callback(error);
        else transformInSequence(remaining, index + 1);
      });
    }
  };

  stream._flush = (callback: TransformCallback) => {
    try {
      walker.assertEndedCleanly();
    } catch (error) {
      callback(asError(error));
      return;
    }
    originalFlush(callback);
  };
}

/**
 * Cuts `chunk` at the given positions, ignoring cuts at its very start or end.
 * Returns `[chunk]` itself when there is nothing to cut, which is the common case.
 */
function cutAtPositions(chunk: Uint8Array, positions: readonly number[]): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  let start = 0;
  for (const position of positions) {
    if (position <= start || position >= chunk.length) continue;
    pieces.push(chunk.subarray(start, position));
    start = position;
  }
  if (start === 0) return [chunk];
  pieces.push(chunk.subarray(start));
  return pieces;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Errors caught by `routeThrownCodecErrors`: they come from the zstd codec, but
 * carry no zlib-style `errno`/`code`, so `isZlibError` recognises them by this set.
 */
const thrownCodecErrors = new WeakSet<Error>();

/**
 * The name of the per-stream method through which Deno's `node:zlib` (checked
 * with 2.5 to 2.9) calls its native zstd codec. It is stored on the stream's
 * `_handle` under a private symbol with this description.
 */
const NATIVE_WRITE_SYMBOL_DESCRIPTION = "kNativeWrite";

/**
 * Makes a zstd codec error that is THROWN by the native write call fail the
 * stream, instead of escaping as an uncaught exception.
 *
 * Why: Node.js and Bun report codec errors through the stream. Deno's polyfill
 * calls its codec through `_handle[kNativeWrite]`, which throws on bad input.
 * The first call for a chunk is inside a try/catch that destroys the stream, but
 * once the output exceeds zlib's 16 KiB buffer the remaining calls run from
 * `process.nextTick` without one. A corrupt zstd file then crashed the process
 * (or, with an `uncaughtException` handler, left the pipeline hanging forever).
 *
 * What: if the stream's handle has such a method (feature detection: Node.js and
 * Bun have none, so this does nothing there), it is wrapped on this one instance.
 * A throw destroys the stream with the error and returns normally; Deno's own
 * code then sees the destroyed stream and completes the pending write callback,
 * so nothing is left waiting.
 */
function routeThrownCodecErrors(stream: Transform): void {
  const handle: unknown = Reflect.get(stream, "_handle");
  if (typeof handle !== "object" || handle === null) return;
  for (const key of Object.getOwnPropertySymbols(handle)) {
    if (key.description !== NATIVE_WRITE_SYMBOL_DESCRIPTION) continue;
    const nativeWrite: unknown = Reflect.get(handle, key);
    if (typeof nativeWrite !== "function") continue;
    Reflect.set(handle, key, function guardedNativeWrite(this: unknown, ...args: unknown[]) {
      try {
        return Reflect.apply(nativeWrite, this, args);
      } catch (thrown) {
        const error = asError(thrown);
        thrownCodecErrors.add(error);
        stream.destroy(error);
        return undefined;
      }
    });
  }
}

/**
 * Makes errors raised by zlib itself surface as `MongoShieldError`s.
 *
 * zlib reports bad input by destroying the stream with a plain Error, and every
 * destroy goes through `_destroy`, whose callback decides which error is emitted.
 * We wrap `_destroy` on this instance and translate only errors that came from
 * zlib (they carry a numeric `errno` and a `Z_…` or `ZSTD_…` code, or were caught
 * by `routeThrownCodecErrors`). Anything else,
 * such as an abort or an error from another stream in the same pipeline, passes
 * through untouched so the real cause is not hidden.
 */
function mapZlibErrors(stream: Transform, code: ErrorCode, message: string): Transform {
  const originalDestroy = stream._destroy.bind(stream);
  stream._destroy = (error, callback) => {
    originalDestroy(error, (finalError) => {
      callback(
        isZlibError(finalError) ? toMongoShieldError(finalError, code, message) : finalError,
      );
    });
  };
  return stream;
}

function isZlibError(error: unknown): error is Error {
  if (!(error instanceof Error) || error instanceof MongoShieldError) return false;
  if (thrownCodecErrors.has(error)) return true;
  const errno: unknown = Reflect.get(error, "errno");
  const errorCode: unknown = Reflect.get(error, "code");
  return (
    typeof errno === "number" &&
    typeof errorCode === "string" &&
    (errorCode.startsWith("Z_") || errorCode.startsWith("ZSTD_"))
  );
}

function toMongoShieldError(error: Error, code: ErrorCode, message: string): MongoShieldError {
  return new MongoShieldError(code, `${message}: ${error.message}.`, {
    cause: error,
    ...(code === "MS_INTEGRITY_FAILED"
      ? { hint: "The stored file is damaged. Verify the backup or restore from another one." }
      : {}),
  });
}
