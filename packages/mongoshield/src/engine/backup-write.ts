/**
 * Writing one backup file: a source stream, a chain of transforms (compress,
 * encrypt) and `storage.put`, wired so that
 *
 * - backpressure flows from storage all the way back to the source: `put` reads
 *   the last stream only as fast as it can store the bytes, `pipeline()` pauses
 *   each stream when the next one is full, and a MongoDB cursor stream only asks
 *   the server for the next batch when it is read. Memory stays flat, whatever
 *   the collection size;
 * - a failure anywhere fails the whole file: an error in the pipeline destroys the
 *   stream `put` is reading (so `put` rejects and discards the partial object),
 *   and an error in `put` destroys the pipeline (which closes the cursor);
 * - nothing is left running or unhandled: both sides are awaited with
 *   `Promise.allSettled` before the function returns or throws;
 * - an abort (the caller's, or a sibling job's failure) tears everything down.
 *
 *   source → transforms… → digest (SHA-256 + size of the stored bytes) → storage.put
 */

import type { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { abortError, MongoShieldError } from "../errors.ts";
import { createDigestStream, type FileDigest } from "../format/hashing.ts";
import type { StorageAdapter } from "../storage/types.ts";

/** What to write and where. */
export interface WriteStoredFileRequest {
  readonly storage: StorageAdapter;
  /** Full storage key. */
  readonly key: string;
  /** Where the bytes come from (a cursor stream, or a one-chunk stream for metadata). */
  readonly source: Readable;
  /** Applied in order between the source and storage, e.g. [counter, compressor, encryptor]. */
  readonly transforms: readonly Transform[];
  readonly contentType: string;
  /** Write-once retention for the object (`backup({ retainDays })`); omit for none. */
  readonly retainUntil?: Date | undefined;
  /** Aborting it stops the write, which then rejects with the typed abort error. */
  readonly signal: AbortSignal;
}

/**
 * Streams `source` through `transforms` into `storage` and returns the SHA-256 and
 * size of the bytes stored, as recorded in the manifest.
 *
 * @throws the error that caused the failure (see `pickCause`), or the typed abort
 *   error if `signal` aborted. Every stream is destroyed by then.
 */
export async function writeStoredFile(request: WriteStoredFileRequest): Promise<FileDigest> {
  const { storage, key, source, transforms, signal } = request;
  const digest = createDigestStream();

  // The pipeline ends at the digest stream; its readable side is consumed by `put`.
  // pipeline() destroys every stream (including the digest stream, so `put` sees
  // the error) when any of them fails or the signal aborts.
  const piping = pipeline([source, ...transforms, digest.stream], { signal });

  const putting = storage
    .put(key, digest.stream, {
      contentType: request.contentType,
      signal,
      ...(request.retainUntil === undefined ? {} : { retainUntil: request.retainUntil }),
    })
    .catch((error: unknown) => {
      // `put` gave up, so nobody reads the digest stream anymore. Destroying it
      // makes pipeline() tear down the rest (and close the cursor) instead of
      // waiting forever on backpressure. It is destroyed WITHOUT an error on
      // purpose: if the pipeline already settled, no one listens for 'error'
      // anymore and emitting one would crash the process. pipeline() reports
      // the teardown as "premature close", and `pickCause` returns put's error.
      digest.stream.destroy();
      throw error;
    });

  // Wait for BOTH sides, so no stream is still running and no rejection is left
  // unhandled when this function returns or throws.
  const [pipeResult, putResult] = await Promise.allSettled([piping, putting]);
  if (pipeResult.status === "fulfilled" && putResult.status === "fulfilled") {
    return digest.digest();
  }
  if (signal.aborted) throw abortError(signal);
  throw pickCause(
    pipeResult.status === "rejected" ? { error: pipeResult.reason } : undefined,
    putResult.status === "rejected" ? { error: putResult.reason } : undefined,
    key,
  );
}

/**
 * When one side fails, the other usually fails too, but only as a consequence.
 * This picks the error that explains what went wrong:
 *
 * - A pipeline error is the cause (the cursor, compressor or encryptor failed and
 *   `put` merely saw its body break), unless it only reports that the stream was
 *   torn down because `put` stopped reading: then `put`'s own error is the cause.
 * - Otherwise whichever side failed.
 */
function pickCause(
  pipeFailure: { readonly error: unknown } | undefined,
  putFailure: { readonly error: unknown } | undefined,
  key: string,
): unknown {
  const pipeIsConsequence = putFailure !== undefined && isTeardownError(pipeFailure?.error);
  if (pipeFailure !== undefined && !pipeIsConsequence) return pipeFailure.error;
  if (putFailure !== undefined) return putFailure.error;
  // Unreachable: this is only called when at least one side failed.
  return new MongoShieldError("MS_INTERNAL", `Writing ${key} failed for an unknown reason.`);
}

/**
 * Node's errors for "this stream was closed under you". When a consumer such as
 * `put` stops reading (an exception inside `for await`, or `destroy()`), Node
 * tears the stream down and pipeline() reports one of these, depending on timing
 * and Node version. Our own abort is handled before this is consulted.
 */
const TEARDOWN_ERROR_CODES = new Set([
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
  "ABORT_ERR",
]);

function isTeardownError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" && TEARDOWN_ERROR_CODES.has(code);
}
