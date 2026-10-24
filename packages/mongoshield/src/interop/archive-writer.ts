/**
 * Streaming writer for mongodump archives: the inverse of `archive-reader.ts`.
 * See `archive-format.ts` for the byte layout.
 *
 *   ArchiveWriterInput objects → createArchiveWriter() → archive bytes (gzip them for --gzip)
 *
 * Input, in order:
 *   1. one `prelude` event (archive header + every namespace that will follow);
 *   2. `document` events, in any interleaving of namespaces, optionally with
 *      `namespaceStart` events to force block boundaries;
 *   3. one `namespaceEnd` per namespace, after its last document.
 *
 * Blocks are formed the way mongodump's multiplexer forms them
 * (mongo-tools `common/archive/multiplexer.go`, `formatBody` and `formatEOF`):
 *
 * - a new block (terminator for the previous one, then a NamespaceHeader with
 *   `EOF: false` and `CRC: 0`) starts whenever the namespace changes;
 * - `namespaceEnd` closes the open block and writes the namespace's EOF block,
 *   `NamespaceHeader{EOF: true, CRC: <CRC-64/ECMA of its documents>}` + terminator;
 * - a namespace without documents still gets an (empty) opening block first, as
 *   mongodump writes for empty collections and views.
 *
 * Because reader events are valid input, `reader → writer` reproduces a mongodump
 * archive byte for byte.
 *
 * Input that would produce an archive mongorestore rejects (documents before the
 * prelude, data for a closed namespace, an announced namespace never ended) fails
 * the stream with `MS_INTERNAL`: the events come from MongoShield's own code.
 */

import { Transform, type TransformCallback } from "node:stream";
import { MongoShieldError } from "../errors.ts";
import { MIN_BSON_DOCUMENT_BYTES } from "../format/bson-stream.ts";
import {
  type ArchivePreludeEvent,
  type ArchiveWriterInput,
  dataCollectionOf,
  encodeArchiveCollection,
  encodeArchiveHeader,
  encodeNamespaceHeader,
  MAGIC_BYTES,
  TERMINATOR_BYTES,
} from "./archive-format.ts";
import { Crc64 } from "./crc64.ts";

/**
 * Creates a stream that turns `ArchiveWriterInput` objects into archive bytes.
 * Readable side: plain bytes, so it can be piped into gzip and a file directly.
 */
export function createArchiveWriter(): Transform {
  const writer = new ArchiveEncoder();
  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(input: ArchiveWriterInput, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        writer.write(input, (bytes) => this.push(bytes));
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
    flush(callback: TransformCallback) {
      try {
        writer.finish();
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
  });
}

/** Per-namespace bookkeeping: its running checksum and whether it was ended. */
interface NamespaceState {
  readonly crc: Crc64;
  ended: boolean;
}

/** The encoding logic, kept apart from the stream plumbing. */
class ArchiveEncoder {
  #preludeWritten = false;
  /** `db.collection` of every data namespace the prelude announced. */
  readonly #announced = new Set<string>();
  readonly #namespaces = new Map<string, NamespaceState>();
  /** The namespace of the block currently open, if any. */
  #openBlock: string | undefined;

  write(input: ArchiveWriterInput, emit: (bytes: Buffer) => void): void {
    if (input.kind === "prelude") {
      this.#writePrelude(input, emit);
      return;
    }
    if (!this.#preludeWritten) {
      throw writerError(`A "${input.kind}" event arrived before the prelude.`);
    }

    const key = `${input.db}.${input.collection}`;
    switch (input.kind) {
      case "namespaceStart":
        this.#enterBlock(input.db, input.collection, key, emit);
        return;
      case "document":
        this.#writeDocument(input.db, input.collection, key, input.document, emit);
        return;
      case "namespaceEnd":
        this.#endNamespace(input.db, input.collection, key, emit);
        return;
    }
  }

  /** Checks that the archive is complete: every announced and every started namespace ended. */
  finish(): void {
    if (!this.#preludeWritten) throw writerError("The archive has no prelude.");
    const notEnded = [...this.#announced].filter(
      (key) => this.#namespaces.get(key)?.ended !== true,
    );
    for (const [key, state] of this.#namespaces) {
      if (!state.ended && !notEnded.includes(key)) notEnded.push(key);
    }
    if (notEnded.length > 0) {
      throw writerError(
        `These namespaces were never ended, so mongorestore would reject the archive: ${notEnded.join(", ")}.`,
      );
    }
  }

  /** magic · Header · CollectionMetadata* · terminator */
  #writePrelude(prelude: ArchivePreludeEvent, emit: (bytes: Buffer) => void): void {
    if (this.#preludeWritten) throw writerError("The prelude was written twice.");
    this.#preludeWritten = true;
    emit(MAGIC_BYTES);
    emit(encodeArchiveHeader(prelude.header));
    for (const entry of prelude.collections) {
      emit(encodeArchiveCollection(entry));
      this.#announced.add(`${entry.db}.${dataCollectionOf(entry)}`);
    }
    emit(TERMINATOR_BYTES);
  }

  #writeDocument(
    db: string,
    collection: string,
    key: string,
    document: Buffer,
    emit: (bytes: Buffer) => void,
  ): void {
    assertWholeDocument(document, key);
    const state = this.#enterBlock(db, collection, key, emit);
    state.crc.update(document);
    emit(document);
  }

  /**
   * Makes `key` the namespace of the open block, starting a new block if another
   * namespace's block (or none) is open. Returns the namespace's state.
   */
  #enterBlock(
    db: string,
    collection: string,
    key: string,
    emit: (bytes: Buffer) => void,
  ): NamespaceState {
    let state = this.#namespaces.get(key);
    if (state?.ended === true) {
      throw writerError(`Data for ${key} arrived after the namespace was ended.`);
    }
    if (state === undefined) {
      state = { crc: new Crc64(), ended: false };
      this.#namespaces.set(key, state);
    }
    if (this.#openBlock !== key) {
      if (this.#openBlock !== undefined) emit(TERMINATOR_BYTES);
      emit(encodeNamespaceHeader({ db, collection, eof: false, crc: 0n }));
      this.#openBlock = key;
    }
    return state;
  }

  /** Closes the namespace: opening block if it never had one, then the EOF block. */
  #endNamespace(db: string, collection: string, key: string, emit: (bytes: Buffer) => void): void {
    const known = this.#namespaces.get(key);
    // mongodump always opens a block before the EOF block, even with no documents.
    const state = known === undefined ? this.#enterBlock(db, collection, key, emit) : known;
    if (state.ended) throw writerError(`The namespace ${key} was ended twice.`);

    if (this.#openBlock !== undefined) emit(TERMINATOR_BYTES);
    emit(encodeNamespaceHeader({ db, collection, eof: true, crc: state.crc.value() }));
    emit(TERMINATOR_BYTES);
    this.#openBlock = undefined;
    state.ended = true;
  }
}

/** A document must be one whole BSON document: its length prefix equals its size. */
function assertWholeDocument(document: Buffer, key: string): void {
  const isWhole =
    document.length >= MIN_BSON_DOCUMENT_BYTES &&
    document.readInt32LE(0) === document.length &&
    document[document.length - 1] === 0x00;
  if (!isWhole) throw writerError(`A document for ${key} is not one whole BSON document.`);
}

function writerError(message: string): MongoShieldError {
  return new MongoShieldError("MS_INTERNAL", `Cannot write the mongodump archive: ${message}`, {
    hint: "This is a bug in MongoShield; please report it.",
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
