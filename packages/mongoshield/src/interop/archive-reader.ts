/**
 * Streaming reader for mongodump archives (`mongodump --archive`). See
 * `archive-format.ts` for the byte layout.
 *
 *   bytes (already gunzipped) → createArchiveReader() → ArchiveEvent objects:
 *     prelude                     once, first: archive header + every namespace's metadata
 *     namespaceStart              at every block start
 *     document                    one raw BSON Buffer per document
 *     namespaceEnd                when a namespace's EOF block arrives (CRC checked)
 *
 * It applies the checks mongorestore applies (mongo-tools `common/archive/parser.go`
 * and `demultiplexer.go`), so an archive this reader accepts is one mongorestore
 * would accept too:
 *
 * - the magic number; document lengths between 5 bytes and the size limit, each
 *   ending in 0x00; no two terminators in a row (a block always has a header);
 * - no documents after an EOF header, no header for a namespace that was closed;
 * - each namespace's CRC-64 matches its EOF header;
 * - at the end, the input stops on a block boundary, every namespace that was
 *   opened was closed, and every namespace the prelude announced was seen.
 *
 * Failures are `MS_INTEGRITY_FAILED` (damaged or truncated archive) or
 * `MS_FORMAT_UNSUPPORTED` (not an archive at all). Memory stays bounded by one
 * document plus one input chunk: documents are emitted as soon as they are complete.
 */

import { Transform, type TransformCallback } from "node:stream";
import { ByteQueue } from "../crypto/byte-queue.ts";
import { MongoShieldError } from "../errors.ts";
import { DEFAULT_MAX_DOCUMENT_BYTES, MIN_BSON_DOCUMENT_BYTES } from "../format/bson-stream.ts";
import {
  ARCHIVE_MAGIC_NUMBER,
  ARCHIVE_TERMINATOR,
  type ArchiveCollection,
  type ArchiveEvent,
  type ArchiveHeader,
  corrupt,
  dataCollectionOf,
  decodeArchiveCollection,
  decodeArchiveHeader,
  decodeNamespaceHeader,
  type NamespaceHeader,
} from "./archive-format.ts";
import { Crc64 } from "./crc64.ts";

/** Options for `createArchiveReader()`. */
export interface ArchiveReaderOptions {
  /** Largest document accepted, in bytes. Defaults to 64 MiB (see `DEFAULT_MAX_DOCUMENT_BYTES`). */
  readonly maxDocumentBytes?: number;
}

/**
 * Creates a stream that parses archive bytes into `ArchiveEvent`s (object mode).
 * Gzipped archives must be gunzipped first (`createDecompressor("gzip")`).
 */
export function createArchiveReader(options: ArchiveReaderOptions = {}): Transform {
  const parser = new ArchiveParser(options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES);
  return new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        parser.push(chunk, (event) => this.push(event));
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
    flush(callback: TransformCallback) {
      try {
        parser.finish();
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
  });
}

/** Where the parser is in the archive grammar. */
type Phase =
  /** Before the 4-byte magic number. */
  | "magic"
  /** Expecting the archive Header document. */
  | "preludeHeader"
  /** Expecting CollectionMetadata documents or the prelude's terminator. */
  | "preludeBody"
  /** Between blocks: expecting a NamespaceHeader (or the end of the input). */
  | "blockStart"
  /** Inside a block: expecting documents or the block's terminator. */
  | "blockBody";

/** What the parser tracks per namespace (keyed by `db.collection`). */
interface NamespaceState {
  readonly db: string;
  readonly collection: string;
  closed: boolean;
  documents: number;
  bytes: number;
  readonly crc: Crc64;
}

/** The parsing logic, separate from the stream plumbing so it reads top to bottom. */
class ArchiveParser {
  readonly #maxDocumentBytes: number;
  readonly #queue = new ByteQueue();
  #phase: Phase = "magic";
  #header: ArchiveHeader | undefined;
  readonly #collections: ArchiveCollection[] = [];
  readonly #namespaces = new Map<string, NamespaceState>();
  /** The namespace whose documents the current block holds; undefined inside an EOF block. */
  #current: NamespaceState | undefined;
  /** Bytes consumed so far, for error messages. */
  #offset = 0;

  constructor(maxDocumentBytes: number) {
    this.#maxDocumentBytes = maxDocumentBytes;
  }

  /** Consumes a chunk of input and emits every event it completes. */
  push(chunk: Buffer, emit: (event: ArchiveEvent) => void): void {
    this.#queue.push(chunk);
    if (this.#phase === "magic") {
      if (this.#queue.length < 4) return;
      this.#checkMagic(this.#queue.take(4));
    }

    // Each unit is either a 4-byte terminator or a whole BSON document.
    while (this.#queue.length >= 4) {
      const prefix = this.#queue.peek(4).readUInt32LE(0);
      if (prefix === ARCHIVE_TERMINATOR) {
        this.#queue.take(4);
        this.#offset += 4;
        this.#onTerminator(emit);
        continue;
      }
      this.#checkLength(prefix);
      if (this.#queue.length < prefix) return; // wait for the rest of the document
      const document = this.#queue.take(prefix);
      if (document[prefix - 1] !== 0x00) {
        throw corrupt(`The document at byte ${this.#offset} does not end with a 0x00 byte.`);
      }
      this.#offset += prefix;
      this.#onDocument(document, emit);
    }
  }

  /** Called at the end of the input: checks that the archive is complete. */
  finish(): void {
    if (this.#phase === "magic") {
      throw notAnArchive("The input is empty or shorter than the 4-byte archive magic number.");
    }
    if (this.#queue.length > 0 || this.#phase !== "blockStart") {
      throw corrupt(
        `The archive ends in the middle of ${this.#phase.startsWith("prelude") ? "its prelude" : "a block"} (after ${this.#offset} bytes); it is truncated.`,
      );
    }
    // demultiplexer.go `End`: every opened namespace must be closed…
    const unfinished = [...this.#namespaces.values()].filter((state) => !state.closed);
    if (unfinished.length > 0) {
      throw corrupt(
        `The archive ends while namespaces are unfinished: ${unfinished.map(nameOf).join(", ")}. It is truncated.`,
      );
    }
    // …and every namespace announced in the prelude must have been seen.
    const missing = this.#collections
      .map((entry) => `${entry.db}.${dataCollectionOf(entry)}`)
      .filter((key) => !this.#namespaces.has(key));
    if (missing.length > 0) {
      throw corrupt(
        `The archive ends before all announced namespaces were seen: ${missing.join(", ")}.`,
      );
    }
  }

  #checkMagic(bytes: Buffer): void {
    this.#offset = 4;
    if (bytes.readUInt32LE(0) === ARCHIVE_MAGIC_NUMBER) {
      this.#phase = "preludeHeader";
      return;
    }
    // 1F 8B starts every gzip stream: the most common mistake is a missing --gzip.
    const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    throw notAnArchive(
      isGzip
        ? "The input is gzip-compressed."
        : "The input does not start with the mongodump archive magic number.",
      isGzip
        ? "Read it with gzip enabled (the archive was written with `mongodump --archive --gzip`)."
        : undefined,
    );
  }

  #checkLength(length: number): void {
    // parser.go `readBSONOrTerminator`: anything else is neither a BSON length nor a terminator.
    if (length < MIN_BSON_DOCUMENT_BYTES || length > this.#maxDocumentBytes) {
      throw corrupt(
        `${length} at byte ${this.#offset} is neither a valid document length ` +
          `(${MIN_BSON_DOCUMENT_BYTES} to ${this.#maxDocumentBytes} bytes) nor a block terminator.`,
      );
    }
  }

  #onTerminator(emit: (event: ArchiveEvent) => void): void {
    switch (this.#phase) {
      case "preludeHeader":
        throw corrupt("The prelude has no archive header.");
      case "preludeBody": {
        const header = this.#header;
        if (header === undefined) throw corrupt("The prelude has no archive header.");
        emit({ kind: "prelude", header, collections: [...this.#collections] });
        this.#phase = "blockStart";
        return;
      }
      case "blockStart":
        // parser.go `ReadBlock`: "consecutive terminators / headerless blocks are not allowed".
        throw corrupt(`A block at byte ${this.#offset - 4} has no namespace header.`);
      case "blockBody":
        this.#phase = "blockStart";
        this.#current = undefined;
        return;
      case "magic":
        return; // unreachable: the magic number is consumed before any unit
    }
  }

  #onDocument(document: Buffer, emit: (event: ArchiveEvent) => void): void {
    switch (this.#phase) {
      case "preludeHeader":
        this.#header = decodeArchiveHeader(document);
        this.#phase = "preludeBody";
        return;
      case "preludeBody":
        this.#collections.push(decodeArchiveCollection(document));
        return;
      case "blockStart":
        this.#onNamespaceHeader(decodeNamespaceHeader(document), emit);
        this.#phase = "blockBody";
        return;
      case "blockBody":
        this.#onBody(document, emit);
        return;
      case "magic":
        return; // unreachable
    }
  }

  #onNamespaceHeader(header: NamespaceHeader, emit: (event: ArchiveEvent) => void): void {
    const key = `${header.db}.${header.collection}`;
    let state = this.#namespaces.get(key);
    if (state?.closed === true) {
      throw corrupt(`The namespace ${key} appears again after its end.`);
    }
    if (state === undefined) {
      state = {
        db: header.db,
        collection: header.collection,
        closed: false,
        documents: 0,
        bytes: 0,
        crc: new Crc64(),
      };
      this.#namespaces.set(key, state);
    }

    if (!header.eof) {
      this.#current = state;
      emit({ kind: "namespaceStart", db: header.db, collection: header.collection });
      return;
    }

    // An EOF header closes the namespace; its block must not carry documents.
    const crc = state.crc.value();
    if (crc !== header.crc) {
      throw corrupt(
        `The checksum of ${key} does not match (computed ${crc}, archive says ${header.crc}); its data is damaged.`,
      );
    }
    state.closed = true;
    this.#current = undefined;
    emit({
      kind: "namespaceEnd",
      db: state.db,
      collection: state.collection,
      documents: state.documents,
      bytes: state.bytes,
      crc,
    });
  }

  #onBody(document: Buffer, emit: (event: ArchiveEvent) => void): void {
    const state = this.#current;
    if (state === undefined) {
      throw corrupt(`A document at byte ${this.#offset} follows an end-of-namespace header.`);
    }
    state.crc.update(document);
    state.documents += 1;
    state.bytes += document.length;
    emit({ kind: "document", db: state.db, collection: state.collection, document });
  }
}

function nameOf(state: NamespaceState): string {
  return `${state.db}.${state.collection}`;
}

function notAnArchive(message: string, hint?: string): MongoShieldError {
  return new MongoShieldError("MS_FORMAT_UNSUPPORTED", `Not a mongodump archive: ${message}`, {
    hint: hint ?? "Pass a file written by `mongodump --archive=<file>`.",
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
