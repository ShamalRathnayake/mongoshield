/**
 * The mongodump archive format (`mongodump --archive`, format version "0.1"):
 * constants, event types and the small BSON documents that structure an archive.
 * The streaming reader and writer live in `archive-reader.ts` and `archive-writer.ts`.
 *
 * The format is not formally specified; this follows the reference implementation in
 * mongo-tools (github.com/mongodb/mongo-tools, package `common/archive`, checked
 * against release 100.16.0): `archive.go` (types and constants), `prelude.go`
 * (magic number and prelude), `parser.go` (blocks), `multiplexer.go` (writing) and
 * `demultiplexer.go` (reading and checks). Byte layout, all integers little-endian:
 *
 *   archive  := magic · prelude · block*
 *   magic    := uint32 0x8199E26D                    (bytes 6D E2 99 81)
 *   prelude  := Header · CollectionMetadata* · terminator
 *   block    := NamespaceHeader · document* · terminator
 *   terminator := uint32 0xFFFFFFFF                  (bytes FF FF FF FF)
 *
 * Every Header / CollectionMetadata / NamespaceHeader / document is one BSON
 * document. A reader tells a terminator from a document by the first four bytes:
 * a BSON length is at least 5 and far below 0xFFFFFFFF.
 *
 * The data of several collections is interleaved: mongodump dumps several
 * collections at once and starts a new block whenever the namespace changes.
 * Each namespace is closed by a block whose NamespaceHeader has `EOF: true` and the
 * CRC-64/ECMA (see `crc64.ts`) of all its document bytes, and no documents:
 *
 *   [users, EOF:false] doc doc FFFFFFFF  [orders, EOF:false] doc FFFFFFFF
 *   [users, EOF:false] doc FFFFFFFF      [users, EOF:true, CRC] FFFFFFFF …
 *
 * A namespace with no documents (an empty collection, a view) still gets an opening
 * block with no documents before its EOF block. There is no end-of-archive marker:
 * the archive simply ends after the last block's terminator. mongorestore checks that
 * every namespace listed in the prelude was closed by then.
 *
 * Time-series collections are listed in the prelude under their own name with
 * `type: "timeseries"`, but their data (bucket documents) is stored under the
 * namespace `<db>.system.buckets.<name>` (for servers before 8.3, which is what
 * `demultiplexer.go` `CreateDemux` expects).
 */

import { BSON, Long } from "mongodb";
import { MongoShieldError } from "../errors.ts";

/** The first four bytes of every archive (`archive.go` `MagicNumber`), read as a little-endian uint32. */
export const ARCHIVE_MAGIC_NUMBER = 0x8199e26d;

/** Ends the prelude and every block (`archive.go` `terminator`). */
export const ARCHIVE_TERMINATOR = 0xffffffff;

/** The only archive format version mongo-tools has ever written (`archive.go` `archiveFormatVersion`). */
export const ARCHIVE_FORMAT_VERSION = "0.1";

/** mongodump stores time-series data under this collection-name prefix (`common.TimeseriesBucketPrefix`). */
export const TIMESERIES_BUCKET_PREFIX = "system.buckets.";

/** The terminator as bytes, ready to write. */
export const TERMINATOR_BYTES: Buffer = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/** The magic number as bytes, ready to write. */
export const MAGIC_BYTES: Buffer = Buffer.from([0x6d, 0xe2, 0x99, 0x81]);

/** The archive-level header, the first document after the magic number (`archive.go` `Header`). */
export interface ArchiveHeader {
  /** `concurrent_collections`: how many collections mongodump interleaved (mongorestore uses it as its minimum parallelism). */
  readonly concurrentCollections: number;
  /** `version`: the archive format version, always "0.1". */
  readonly formatVersion: string;
  /** `server_version`: version of the dumped server, e.g. "7.0.12". mongorestore parses it. */
  readonly serverVersion: string;
  /** `tool_version`: the writer, e.g. "100.16.0". */
  readonly toolVersion: string;
}

/** One namespace announced in the prelude (`archive.go` `CollectionMetadata`). */
export interface ArchiveCollection {
  /** Database name. Empty for the oplog of `mongodump --oplog`. */
  readonly db: string;
  /** Collection name (for time-series: the logical name, not `system.buckets.…`). */
  readonly collection: string;
  /** The `<collection>.metadata.json` contents (canonical Extended JSON), or "" when there is none. */
  readonly metadata: string;
  /** mongodump writes 0 here; kept so that archives can be re-written byte for byte. */
  readonly size: number;
  /** `collection`, `view`, `timeseries`, or "" for namespaces without a type (the oplog). */
  readonly type: string;
}

/** First event of a read archive / first input of a written one: everything before the data. */
export interface ArchivePreludeEvent {
  readonly kind: "prelude";
  readonly header: ArchiveHeader;
  /** In archive order. mongodump lists every namespace it is about to dump. */
  readonly collections: readonly ArchiveCollection[];
}

/**
 * A block for this namespace starts. Readers emit one per block; writers start a
 * block on their own whenever a document's namespace changes, so this event is only
 * needed to reproduce an archive's exact block structure (including empty blocks).
 */
export interface ArchiveNamespaceStartEvent {
  readonly kind: "namespaceStart";
  readonly db: string;
  readonly collection: string;
}

/** One document of a namespace, as raw BSON bytes. */
export interface ArchiveDocumentEvent {
  readonly kind: "document";
  readonly db: string;
  /** The data namespace's collection (`system.buckets.<name>` for time-series data). */
  readonly collection: string;
  readonly document: Buffer;
}

/** A namespace's EOF block: no more documents will follow for it. Writers only need the names. */
export interface ArchiveNamespaceEndInput {
  readonly kind: "namespaceEnd";
  readonly db: string;
  readonly collection: string;
}

/** A namespace's EOF block as the reader reports it, after checking its CRC. */
export interface ArchiveNamespaceEndEvent extends ArchiveNamespaceEndInput {
  /** Documents read for the namespace. */
  readonly documents: number;
  /** Their total size in bytes. */
  readonly bytes: number;
  /** The CRC-64/ECMA of those bytes, which matched the EOF header. */
  readonly crc: bigint;
}

/** What `createArchiveReader()` emits, in archive order. */
export type ArchiveEvent =
  | ArchivePreludeEvent
  | ArchiveNamespaceStartEvent
  | ArchiveDocumentEvent
  | ArchiveNamespaceEndEvent;

/** What `createArchiveWriter()` accepts. Reader events are valid writer input as they are. */
export type ArchiveWriterInput =
  | ArchivePreludeEvent
  | ArchiveNamespaceStartEvent
  | ArchiveDocumentEvent
  | ArchiveNamespaceEndInput;

/** A namespace header (`archive.go` `NamespaceHeader`), decoded. */
export interface NamespaceHeader {
  readonly db: string;
  readonly collection: string;
  readonly eof: boolean;
  /** Unsigned 64-bit CRC; 0 in opening headers. */
  readonly crc: bigint;
}

/**
 * The namespace whose documents carry the data of a prelude entry: the entry itself,
 * or `system.buckets.<name>` for a time-series collection (see the file header).
 */
export function dataCollectionOf(entry: Pick<ArchiveCollection, "collection" | "type">): string {
  return entry.type === "timeseries"
    ? `${TIMESERIES_BUCKET_PREFIX}${entry.collection}`
    : entry.collection;
}

// ---------------------------------------------------------------------------
// Encoding. Field names and order follow the Go structs' `bson` tags.
// ---------------------------------------------------------------------------

/** `Header` as BSON: concurrent_collections (int32), version, server_version, tool_version. */
export function encodeArchiveHeader(header: ArchiveHeader): Buffer {
  return serialize({
    concurrent_collections: new BSON.Int32(header.concurrentCollections),
    version: header.formatVersion,
    server_version: header.serverVersion,
    tool_version: header.toolVersion,
  });
}

/** `CollectionMetadata` as BSON: db, collection, metadata, size (int32, Go `int`), type. */
export function encodeArchiveCollection(entry: ArchiveCollection): Buffer {
  return serialize({
    db: entry.db,
    collection: entry.collection,
    metadata: entry.metadata,
    size: new BSON.Int32(entry.size),
    type: entry.type,
  });
}

/**
 * `NamespaceHeader` as BSON: db, collection, EOF (boolean), CRC (int64). Go's
 * `MarshalBSON` stores the unsigned CRC's bit pattern in a signed int64, which is
 * what `Long.fromBigInt(BigInt.asIntN(64, crc))` produces.
 */
export function encodeNamespaceHeader(header: NamespaceHeader): Buffer {
  return serialize({
    db: header.db,
    collection: header.collection,
    EOF: header.eof,
    CRC: Long.fromBigInt(BigInt.asIntN(64, header.crc)),
  });
}

// ---------------------------------------------------------------------------
// Decoding. Wrong field types are corruption; unknown fields are ignored so a
// future mongodump that adds fields can still be read.
// ---------------------------------------------------------------------------

/** Parses the archive `Header` document. */
export function decodeArchiveHeader(bytes: Buffer): ArchiveHeader {
  const document = deserialize(bytes, "archive header");
  return {
    concurrentCollections: readInteger(document, "concurrent_collections", "archive header", 0),
    formatVersion: readString(document, "version", "archive header", ""),
    serverVersion: readString(document, "server_version", "archive header", ""),
    toolVersion: readString(document, "tool_version", "archive header", ""),
  };
}

/** Parses one prelude `CollectionMetadata` document. */
export function decodeArchiveCollection(bytes: Buffer): ArchiveCollection {
  const where = "archive prelude entry";
  const document = deserialize(bytes, where);
  return {
    db: readString(document, "db", where, ""),
    collection: readString(document, "collection", where, ""),
    metadata: readString(document, "metadata", where, ""),
    size: readInteger(document, "size", where, 0),
    type: readString(document, "type", where, ""),
  };
}

/** Parses a `NamespaceHeader` (the first document of every block). */
export function decodeNamespaceHeader(bytes: Buffer): NamespaceHeader {
  const where = "archive namespace header";
  const document = deserialize(bytes, where);
  const collection = readString(document, "collection", where, "");
  // demultiplexer.go rejects headers without a collection; so do we.
  if (collection === "") throw corrupt(`An ${where} has no collection name.`);
  const eof = document.EOF ?? false;
  if (typeof eof !== "boolean") throw corrupt(`The EOF field of an ${where} is not a boolean.`);
  return {
    db: readString(document, "db", where, ""),
    collection,
    eof,
    crc: readCrc(document.CRC, where),
  };
}

/** The CRC field: an int64 holding the unsigned value's bit pattern (absent means 0). */
function readCrc(value: unknown, where: string): bigint {
  if (value === undefined) return 0n;
  if (value instanceof Long) return BigInt.asUintN(64, value.toBigInt());
  throw corrupt(`The CRC field of an ${where} is not a 64-bit integer.`);
}

function readString(
  document: BSON.Document,
  field: string,
  where: string,
  fallback: string,
): string {
  const value: unknown = document[field];
  if (value === undefined) return fallback;
  if (typeof value !== "string")
    throw corrupt(`The ${field} field of an ${where} is not a string.`);
  return value;
}

function readInteger(
  document: BSON.Document,
  field: string,
  where: string,
  fallback: number,
): number {
  const value: unknown = document[field];
  if (value === undefined) return fallback;
  // promoteValues is on for these small documents, so int32 arrives as a number and
  // int64 (which Go may use for an `int`) as a Long.
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (value instanceof Long) return value.toNumber();
  throw corrupt(`The ${field} field of an ${where} is not an integer.`);
}

function serialize(document: BSON.Document): Buffer {
  const bytes = BSON.serialize(document);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function deserialize(bytes: Buffer, where: string): BSON.Document {
  try {
    // promoteLongs: false keeps int64 values (the CRC) as Long, so no precision is lost.
    return BSON.deserialize(bytes, { promoteLongs: false });
  } catch (error) {
    throw corrupt(`An ${where} is not valid BSON.`, error);
  }
}

/** The error for any malformed archive content. */
export function corrupt(message: string, cause?: unknown): MongoShieldError {
  return new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `The mongodump archive is corrupt: ${message}`,
    {
      hint: "Check that the file is a complete `mongodump --archive` output (use --gzip if it was written with --gzip).",
      ...(cause === undefined ? {} : { cause }),
    },
  );
}
