/**
 * Joins many small raw BSON documents into fewer, larger byte chunks before they
 * reach the compressor.
 *
 * A cursor in `raw: true` mode yields one Buffer per document, often only a few
 * hundred bytes. Feeding those one by one to zlib costs a native call and several
 * stream callbacks per document, which made compression (not MongoDB) the
 * bottleneck: about 5x slower than draining the cursor. Copying documents into
 * ~256 KiB chunks first costs one memcpy per byte and lets zlib and the encryptor
 * work on big blocks. It also lets go of the driver's batch buffers early: a raw
 * document is a slice of a whole server reply, which stays in memory as long as
 * any slice of it does.
 *
 * The output bytes are exactly the input bytes, in order; only chunk boundaries change.
 */

import { Transform, type TransformCallback } from "node:stream";

/** Target size of an output chunk. Large enough for zlib, small enough to stay cheap. */
export const DEFAULT_COALESCE_BYTES = 256 * 1024;

/**
 * Creates a stream that takes Buffers (object mode, e.g. raw documents) and emits
 * byte chunks of at least `targetBytes` (except the last one).
 */
export function createCoalescer(targetBytes: number = DEFAULT_COALESCE_BYTES): Transform {
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  /** Emits everything collected so far as one chunk. */
  function emitPending(stream: Transform): void {
    if (pendingBytes === 0) return;
    stream.push(Buffer.concat(pending, pendingBytes));
    pending = [];
    pendingBytes = 0;
  }

  return new Transform({
    // Documents come in as separate objects; bytes go out.
    writableObjectMode: true,
    readableObjectMode: false,
    transform(
      this: Transform,
      chunk: Uint8Array,
      _encoding: BufferEncoding,
      done: TransformCallback,
    ) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      pending.push(buffer);
      pendingBytes += buffer.length;
      if (pendingBytes >= targetBytes) emitPending(this);
      done();
    },
    flush(this: Transform, done: TransformCallback) {
      emitPending(this);
      done();
    },
  });
}
