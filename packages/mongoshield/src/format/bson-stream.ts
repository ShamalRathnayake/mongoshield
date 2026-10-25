/**
 * Streams for `.bson` data files: concatenated BSON documents, exactly what
 * mongodump writes and mongorestore reads.
 *
 *   restore:  bytes → createBsonSplitter → raw document Buffers → createBsonDeserializer → Documents
 *   backup:   Documents → createBsonSerializer → document Buffers → bytes
 *
 * Note for the backup engine: the driver can skip parsing entirely.
 * `collection.find(filter, { raw: true })` yields each document as the raw BSON
 * Buffer the server sent, which can be written to the data file as-is. That is
 * faster (no deserialize/serialize per document) and byte-exact by construction,
 * so prefer it over `createBsonSerializer()` for dumps.
 *
 * BSON document layout (https://bsonspec.org/spec.html):
 *
 *   int32 (little-endian)   total length in bytes, including these 4 bytes
 *   element...              type byte, cstring name, value
 *   0x00                    terminator
 *
 * The smallest document, `{}`, is 5 bytes: `05 00 00 00 00`.
 */

import { Transform, type TransformCallback } from "node:stream";
import { BSON, type Document } from "mongodb";
import { MongoShieldError } from "../errors.ts";

/** Size of the int32 length prefix of every BSON document. */
const LENGTH_PREFIX_BYTES = 4;

/** An empty document is the 4-byte length plus the 0x00 terminator. */
export const MIN_BSON_DOCUMENT_BYTES = 5;

/**
 * Default upper bound for one document in a data file: 64 MiB.
 *
 * MongoDB limits user documents to 16 MiB, but the limit here is not a MongoDB
 * rule. It is a sanity check that stops a corrupt length prefix (say, 2 GiB) from
 * making us buffer gigabytes before noticing. It is set well above 16 MiB so that
 * no real document is ever rejected: the server's internal limit is slightly above
 * 16 MiB, and future versions or other tools may write somewhat larger documents.
 * 64 MiB is still small enough to hold in memory safely.
 */
export const DEFAULT_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

/** Options for `createBsonSplitter()`. */
export interface BsonSplitterOptions {
  /** Largest document accepted, in bytes. Defaults to `DEFAULT_MAX_DOCUMENT_BYTES` (64 MiB). */
  readonly maxDocumentBytes?: number;
}

// ---------------------------------------------------------------------------
// Splitter: bytes → one Buffer per document
// ---------------------------------------------------------------------------

/**
 * Creates a stream that cuts a `.bson` byte stream into documents.
 *
 * Input: byte chunks of any size, with document boundaries anywhere.
 * Output (object mode): one Buffer per document holding its raw, unparsed bytes.
 *
 * Each length prefix must be between 5 and `maxDocumentBytes`, each document must
 * end in 0x00, and the input must not end mid-document; otherwise the stream fails
 * with `MS_INTEGRITY_FAILED`.
 */
export function createBsonSplitter(options: BsonSplitterOptions = {}): Transform {
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  if (!Number.isInteger(maxDocumentBytes) || maxDocumentBytes < MIN_BSON_DOCUMENT_BYTES) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `maxDocumentBytes must be a whole number of at least ${MIN_BSON_DOCUMENT_BYTES}.`,
    );
  }

  const splitter = new BsonSplitter(maxDocumentBytes);
  return new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        splitter.push(chunk, (document) => this.push(document));
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
    flush(callback: TransformCallback) {
      try {
        splitter.assertNoPartialDocument();
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
  });
}

/**
 * The splitting logic, kept separate from the stream plumbing.
 *
 * Fast path: documents that lie entirely inside one chunk are emitted as
 * `subarray` views of that chunk, without copying. Slow path: a document that
 * spans chunks is collected as a list of pieces and joined once, when its last
 * byte arrives, so each byte is copied at most once (no repeated concatenation,
 * which would be quadratic for a large document arriving in many small chunks).
 */
class BsonSplitter {
  readonly #maxDocumentBytes: number;
  /** Pieces of a document that started in an earlier chunk. */
  #pieces: Buffer[] = [];
  #piecesBytes = 0;
  /** Length of the partial document, once its 4-byte prefix has been seen. */
  #partialLength: number | undefined;
  /** Stream offset where the partial document starts, for error messages. */
  #partialOffset = 0;
  /** Bytes consumed from the stream before the current chunk, for error messages. */
  #streamOffset = 0;
  /** Documents emitted so far, for error messages. */
  #documentIndex = 0;

  constructor(maxDocumentBytes: number) {
    this.#maxDocumentBytes = maxDocumentBytes;
  }

  /** Consumes one chunk and calls `emit` for every document it completes. */
  push(chunk: Buffer, emit: (document: Buffer) => void): void {
    let position = this.#piecesBytes > 0 ? this.#continuePartial(chunk, emit) : 0;

    // Fast path: whole documents inside this chunk.
    while (position + LENGTH_PREFIX_BYTES <= chunk.length) {
      const length = this.#checkLength(chunk.readInt32LE(position), this.#streamOffset + position);
      if (position + length > chunk.length) break;
      emit(this.#finishDocument(chunk.subarray(position, position + length)));
      position += length;
    }

    // Whatever is left starts a document that continues in the next chunk.
    if (position < chunk.length) {
      this.#partialOffset = this.#streamOffset + position;
      this.#addPiece(chunk.subarray(position));
    }
    this.#streamOffset += chunk.length;
  }

  /** Throws if the input ended in the middle of a document. */
  assertNoPartialDocument(): void {
    if (this.#piecesBytes === 0) return;
    const expected =
      this.#partialLength === undefined ? "a 4-byte length prefix" : `${this.#partialLength} bytes`;
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `The BSON data ends in the middle of document #${this.#documentIndex + 1}: ` +
        `expected ${expected}, got only ${this.#piecesBytes}. The file was truncated.`,
      {
        hint: "The data file is incomplete. Verify the backup or restore from another one.",
        details: { documentIndex: this.#documentIndex, offset: this.#partialOffset },
      },
    );
  }

  /**
   * Adds bytes from the start of `chunk` to the partial document, emitting it if it
   * completes. Returns the position in `chunk` where unconsumed data starts.
   */
  #continuePartial(chunk: Buffer, emit: (document: Buffer) => void): number {
    let position = 0;

    // The length prefix itself may be split across chunks: complete it first.
    if (this.#partialLength === undefined) {
      position = Math.min(LENGTH_PREFIX_BYTES - this.#piecesBytes, chunk.length);
      this.#addPiece(chunk.subarray(0, position));
    }
    const length = this.#partialLength;
    if (length === undefined) return position; // the chunk was too small to finish the prefix

    const take = Math.min(length - this.#piecesBytes, chunk.length - position);
    this.#addPiece(chunk.subarray(position, position + take));
    position += take;

    if (this.#piecesBytes === length) {
      // The single copy of a spanning document happens here.
      const document = Buffer.concat(this.#pieces, length);
      this.#pieces = [];
      this.#piecesBytes = 0;
      this.#partialLength = undefined;
      emit(this.#finishDocument(document));
    }
    return position;
  }

  /** Appends a piece to the partial document, reading its length once 4 bytes are known. */
  #addPiece(piece: Buffer): void {
    if (piece.length === 0) return;
    this.#pieces.push(piece);
    this.#piecesBytes += piece.length;
    if (this.#partialLength === undefined && this.#piecesBytes >= LENGTH_PREFIX_BYTES) {
      const prefix = copyFirstBytes(this.#pieces, LENGTH_PREFIX_BYTES);
      this.#partialLength = this.#checkLength(prefix.readInt32LE(0), this.#partialOffset);
    }
  }

  /** Validates a document length read from a prefix at stream offset `offset`. */
  #checkLength(length: number, offset: number): number {
    if (length < MIN_BSON_DOCUMENT_BYTES || length > this.#maxDocumentBytes) {
      throw new MongoShieldError(
        "MS_INTEGRITY_FAILED",
        `Invalid BSON document length ${length} at byte ${offset} (document #${this.#documentIndex + 1}); ` +
          `expected ${MIN_BSON_DOCUMENT_BYTES} to ${this.#maxDocumentBytes} bytes.`,
        {
          hint: "The data file is corrupt, or was not decrypted/decompressed correctly.",
          details: { documentIndex: this.#documentIndex, offset },
        },
      );
    }
    return length;
  }

  /** Checks the 0x00 terminator and counts the document. */
  #finishDocument(document: Buffer): Buffer {
    if (document[document.length - 1] !== 0x00) {
      throw new MongoShieldError(
        "MS_INTEGRITY_FAILED",
        `BSON document #${this.#documentIndex + 1} does not end with a 0x00 byte.`,
        {
          hint: "The data file is corrupt, or was not decrypted/decompressed correctly.",
          details: { documentIndex: this.#documentIndex },
        },
      );
    }
    this.#documentIndex += 1;
    return document;
  }
}

/**
 * Copies the first `count` bytes spread over `pieces` into a new small Buffer,
 * without joining the (possibly large) pieces themselves.
 */
function copyFirstBytes(pieces: readonly Buffer[], count: number): Buffer {
  const result = Buffer.alloc(count);
  let filled = 0;
  for (const piece of pieces) {
    if (filled === count) break;
    filled += piece.copy(result, filled, 0, Math.min(piece.length, count - filled));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deserializer and serializer
// ---------------------------------------------------------------------------

/**
 * Options that make deserialization lossless, so `serialize(deserialize(bytes))`
 * returns the original bytes. The driver's defaults convert values to the nearest
 * JavaScript type, which changes the BSON type on the way back:
 *
 * - `promoteValues: false` keeps numbers in their wrapper classes. Without it a
 *   double `1.0` comes back as the JS number 1 and is re-serialized as an int32,
 *   an int64 that fits in 53 bits becomes an int32 or double, and a symbol
 *   becomes a string.
 * - `promoteLongs: false` and `promoteBuffers: false` are implied by the above but
 *   spelled out so nobody "simplifies" this away: int64 stays `Long`, binary stays
 *   `Binary` (with its subtype) instead of becoming a Buffer.
 * - `bsonRegExp: true` returns `BSONRegExp` instead of a JS `RegExp`, because JS
 *   regexes cannot hold every BSON flag or pattern (`l`, `x`, PCRE syntax).
 * - `useBigInt64: false` keeps `Long` rather than `bigint`.
 * - UTF-8 validation stays on (the default): a string that is not valid UTF-8
 *   cannot survive a round trip, so it is better to fail than to silently replace
 *   bytes with U+FFFD.
 *
 * Remaining cases the driver cannot round-trip byte for byte (all rare):
 * deprecated `undefined` values (written back as null), duplicate field names
 * (the last one wins), DBRef-shaped sub-documents whose fields are not in
 * `$ref, $id, $db` order, and strings with invalid UTF-8 (rejected). Dumping with
 * `{ raw: true }` avoids all of them.
 *
 * Field ORDER is not kept by these options alone: JavaScript objects list integer-like
 * names ("0", "7") first. Code that writes parsed documents back parses them with
 * `deserializeInStoredOrder` and writes `inStoredOrder(document)` (field-order.ts).
 */
export const LOSSLESS_DESERIALIZE_OPTIONS = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
  useBigInt64: false,
} as const satisfies BSON.DeserializeOptions;

/** Options for serializing documents back exactly as they were read. */
const SERIALIZE_OPTIONS = {
  // Field names such as `$x` or `a.b` are legal in stored documents; do not reject them.
  checkKeys: false,
  // Functions are never data; skip them rather than storing code by accident.
  serializeFunctions: false,
  ignoreUndefined: false,
} as const satisfies BSON.SerializeOptions;

/**
 * Creates an object-mode stream that parses raw BSON Buffers into Documents,
 * preserving every BSON type (see `LOSSLESS_DESERIALIZE_OPTIONS`).
 * Malformed documents fail the stream with `MS_INTEGRITY_FAILED`.
 */
export function createBsonDeserializer(): Transform {
  let documentIndex = 0;
  return new Transform({
    objectMode: true,
    transform(raw: Uint8Array, _encoding: BufferEncoding, callback: TransformCallback) {
      documentIndex += 1;
      let document: Document;
      try {
        document = BSON.deserialize(raw, LOSSLESS_DESERIALIZE_OPTIONS);
      } catch (error) {
        callback(
          new MongoShieldError(
            "MS_INTEGRITY_FAILED",
            `BSON document #${documentIndex} is malformed: ${errorMessage(error)}`,
            { cause: error, details: { documentIndex: documentIndex - 1 } },
          ),
        );
        return;
      }
      callback(null, document);
    },
  });
}

/**
 * Creates an object-mode stream that turns Documents into BSON Buffers.
 * A document that cannot be serialized (too large, unsupported value) fails the
 * stream with `MS_INTERNAL`, since documents reaching it come from our own code.
 */
export function createBsonSerializer(): Transform {
  return new Transform({
    objectMode: true,
    transform(document: Document, _encoding: BufferEncoding, callback: TransformCallback) {
      let bytes: Uint8Array;
      try {
        bytes = BSON.serialize(document, SERIALIZE_OPTIONS);
      } catch (error) {
        callback(
          new MongoShieldError(
            "MS_INTERNAL",
            `A document could not be serialized to BSON: ${errorMessage(error)}`,
            { cause: error },
          ),
        );
        return;
      }
      // Always hand out Buffers, whatever Uint8Array subclass the library returns.
      callback(null, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
