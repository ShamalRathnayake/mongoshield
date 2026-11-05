/**
 * Cutting an upload body into fixed-size chunks for chunked/resumable upload APIs,
 * with backpressure: the next chunk is only read from the source after the caller
 * has finished with the previous one, so at most one chunk (plus one source piece)
 * is ever held in memory.
 *
 *   for await (const chunk of readChunks(body, { chunkSize: 8 * MIB, multipleOf: GOOGLE_DRIVE_CHUNK_MULTIPLE })) {
 *     await uploadRange(chunk.bytes, chunk.offset, chunk.last ? chunk.offset + chunk.bytes.length : undefined);
 *   }
 *
 * Every chunk but the last is exactly `chunkSize` bytes; the last holds the rest
 * (1 to `chunkSize` bytes) and has `last: true`, so an API that wants the total size
 * on the final request (Drive's `Content-Range: bytes x-y/total`) gets it in time. An
 * empty body yields one empty chunk with `last: true`, so callers need no special
 * case for empty objects. Knowing which chunk is last needs one piece of look-ahead,
 * which is why a chunk is only handed out once more data (or the end) has been seen.
 *
 * Provider rules, as constants below: Google Drive wants chunks in multiples of
 * 256 KiB, Dropbox at most 150 MiB per request.
 */

import type { Readable } from "node:stream";
import { MongoShieldError, throwIfAborted } from "../../errors.ts";

const KIB = 1024;
const MIB = 1024 * KIB;

/** Google Drive resumable uploads: every chunk but the last is a multiple of 256 KiB. */
export const GOOGLE_DRIVE_CHUNK_MULTIPLE = 256 * KIB;
/** Dropbox upload sessions: at most 150 MiB per request. */
export const DROPBOX_MAX_CHUNK = 150 * MIB;

/** Options for {@link readChunks}. */
export interface ChunkOptions {
  /** Bytes per chunk (all but the last). */
  readonly chunkSize: number;
  /** `chunkSize` must be a multiple of this (Google Drive: 256 KiB). */
  readonly multipleOf?: number;
  /** `chunkSize` must not exceed this (Dropbox: 150 MiB). */
  readonly maxChunkSize?: number;
  /** Checked before each read; an abort ends the iteration with MS_ABORTED. */
  readonly signal?: AbortSignal | undefined;
}

/** One chunk of the body. */
export interface UploadChunk {
  /** The chunk's bytes. Exactly `chunkSize` long unless `last`. */
  readonly bytes: Buffer;
  /** Where the chunk starts in the whole body. */
  readonly offset: number;
  /** True for the final chunk; `offset + bytes.length` is then the total size. */
  readonly last: boolean;
}

/**
 * Checks a chunk size against a provider's rules.
 *
 * @throws MS_CONFIG_INVALID when it is not a positive whole number, not a multiple of
 *   `multipleOf`, or larger than `maxChunkSize`.
 */
export function assertValidChunkSize(options: Omit<ChunkOptions, "signal">): void {
  const { chunkSize, multipleOf, maxChunkSize } = options;
  const problems: string[] = [];
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) problems.push("a positive whole number");
  if (multipleOf !== undefined && chunkSize % multipleOf !== 0) {
    problems.push(`a multiple of ${multipleOf / KIB} KiB`);
  }
  if (maxChunkSize !== undefined && chunkSize > maxChunkSize) {
    problems.push(`at most ${maxChunkSize / MIB} MiB`);
  }
  if (problems.length > 0) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Invalid upload chunk size ${chunkSize}.`, {
      hint: `The chunk size must be ${problems.join(" and ")}.`,
    });
  }
}

/**
 * Yields `body` in chunks (see the file header). A source error ends the iteration
 * with that error; stopping early (break, an upload failure) destroys the source.
 */
export async function* readChunks(
  body: Readable | Uint8Array,
  options: ChunkOptions,
): AsyncGenerator<UploadChunk, void, undefined> {
  assertValidChunkSize(options);
  const { chunkSize, signal } = options;
  throwIfAborted(signal);

  if (body instanceof Uint8Array) {
    yield* chunksOfBuffer(Buffer.from(body.buffer, body.byteOffset, body.byteLength), chunkSize);
    return;
  }

  let pending: Buffer[] = [];
  let pendingLength = 0;
  let offset = 0;
  for await (const piece of body) {
    throwIfAborted(signal);
    const buffer = toBuffer(piece);
    if (buffer.length === 0) continue;
    pending.push(buffer);
    pendingLength += buffer.length;
    // Strictly more than one chunk: the chunk handed out is certainly not the last.
    while (pendingLength > chunkSize) {
      const joined = Buffer.concat(pending, pendingLength);
      const bytes = joined.subarray(0, chunkSize);
      const rest = joined.subarray(chunkSize);
      pending = [rest];
      pendingLength = rest.length;
      yield { bytes, offset, last: false };
      offset += chunkSize;
      throwIfAborted(signal);
    }
  }
  yield { bytes: Buffer.concat(pending, pendingLength), offset, last: true };
}

/** The chunks of a buffer that is already in memory (no copying). */
function* chunksOfBuffer(buffer: Buffer, chunkSize: number): Generator<UploadChunk> {
  if (buffer.length === 0) {
    yield { bytes: buffer, offset: 0, last: true };
    return;
  }
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const end = Math.min(buffer.length, offset + chunkSize);
    yield { bytes: buffer.subarray(offset, end), offset, last: end === buffer.length };
  }
}

function toBuffer(piece: unknown): Buffer {
  if (Buffer.isBuffer(piece)) return piece;
  if (piece instanceof Uint8Array)
    return Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
  if (typeof piece === "string") return Buffer.from(piece);
  throw new MongoShieldError("MS_INTERNAL", "Upload bodies must be streams of bytes.");
}
