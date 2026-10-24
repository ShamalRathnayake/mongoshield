/**
 * Interoperability with mongodump and mongorestore.
 *
 *   importMongodump   mongodump directory or archive  → MongoShield backup
 *   exportBackup      MongoShield backup              → mongodump directory or archive
 *
 * plus the building blocks, for tools that want to read or write mongodump
 * archives themselves: a streaming archive reader and writer, and mongodump's
 * file-name escaping. No mongodump or mongorestore binary is ever run.
 */

export {
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_MAGIC_NUMBER,
  type ArchiveCollection,
  type ArchiveDocumentEvent,
  type ArchiveEvent,
  type ArchiveHeader,
  type ArchiveNamespaceEndEvent,
  type ArchiveNamespaceEndInput,
  type ArchiveNamespaceStartEvent,
  type ArchivePreludeEvent,
  type ArchiveWriterInput,
} from "./archive-format.ts";
export { type ArchiveReaderOptions, createArchiveReader } from "./archive-reader.ts";
export { createArchiveWriter } from "./archive-writer.ts";
export { Crc64, crc64 } from "./crc64.ts";
export {
  collectionFileStem,
  parseCollectionFileStem,
  queryEscape,
  queryUnescape,
} from "./dump-names.ts";
export {
  DEFAULT_EXPORT_PARALLELISM,
  type ExportOptions,
  type ExportSummary,
  exportBackup,
} from "./export.ts";
export type { ExportedNamespace } from "./export-data.ts";
export {
  DEFAULT_IMPORT_PARALLELISM,
  IMPORTED_FROM_LABEL,
  type ImportMongodumpOptions,
  type ImportResult,
  importMongodump,
  type MongodumpSource,
} from "./import.ts";
export type { SkippedNamespace } from "./import-target.ts";
