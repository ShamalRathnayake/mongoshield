/**
 * Importing a mongodump output directory into a MongoShield backup.
 *
 *   scanDumpDirectory → resolve names + read metadata → decide what to import
 *     → per namespace, N at a time:  metadata file, then
 *                                    <stem>.bson[.gz] → (gunzip) → BSON splitter → count → … → storage
 *
 * The BSON splitter checks every document's framing on the way, so a truncated or
 * corrupt `.bson` file fails the import instead of producing a damaged backup.
 * Documents are copied byte for byte; nothing is parsed.
 */

import { Readable } from "node:stream";
import { mapWithConcurrency } from "../engine/pool.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { createBsonSplitter } from "../format/bson-stream.ts";
import type { NamespaceEntry } from "../format/manifest.ts";
import type { CollectionMetadata } from "../format/metadata.ts";
import type { NamespaceFilter } from "../mongo/index.ts";
import {
  type DumpCollectionFiles,
  type DumpDirectoryScan,
  openDumpFile,
  readDumpTextFile,
} from "./dump-directory.ts";
import { parseDumpMetadata, recordedCollectionName } from "./dump-metadata.ts";
import { parseCollectionFileStem } from "./dump-names.ts";
import { skipReason } from "./import-rules.ts";
import {
  caseSuffixesByNamespace,
  type ImportNamespace,
  type ImportTarget,
  namespaceEntry,
  namespaceOf,
  type SkippedNamespace,
  writeImportedData,
  writeImportedMetadata,
} from "./import-target.ts";

/** A collection of the dump that will be imported, with its files. */
interface PlannedNamespace {
  readonly namespace: ImportNamespace;
  readonly files: DumpCollectionFiles;
}

/** What importing a directory produced. */
export interface DirectoryImportOutcome {
  readonly entries: NamespaceEntry[];
  readonly skipped: SkippedNamespace[];
}

/**
 * Writes every selected collection of a scanned dump directory into `target`.
 *
 * @throws MongoShieldError from reading the dump (`MS_INTEGRITY_FAILED` for corrupt
 *   files) or from storage.
 */
export async function importDumpDirectory(
  scan: DumpDirectoryScan,
  target: ImportTarget,
  filter: NamespaceFilter,
  options: { readonly parallelism: number; readonly signal: AbortSignal },
): Promise<DirectoryImportOutcome> {
  const skipped: SkippedNamespace[] = scan.ignored.map((file) => ({
    ns: file.path,
    reason: file.reason,
  }));
  const planned = await planNamespaces(scan, filter, skipped, options.signal);

  const entries = await mapWithConcurrency(
    planned,
    (item, _index, signal) => importNamespace(target, item, signal),
    { concurrency: options.parallelism, signal: options.signal },
  );
  return { entries, skipped };
}

/** Resolves names and metadata, and keeps the collections that should be imported. */
async function planNamespaces(
  scan: DumpDirectoryScan,
  filter: NamespaceFilter,
  skipped: SkippedNamespace[],
  signal: AbortSignal,
): Promise<PlannedNamespace[]> {
  const selected: {
    collection: string;
    metadata: CollectionMetadata;
    files: DumpCollectionFiles;
  }[] = [];
  for (const files of scan.collections) {
    throwIfAborted(signal);
    const metadataText = files.metadata === undefined ? "" : await readDumpTextFile(files.metadata);
    const collection = resolveCollectionName(files, metadataText);
    const ns = `${files.db}.${collection}`;
    if (!filter(ns)) continue;

    const metadata = parseDumpMetadata(metadataText, collection, files.metadata?.path ?? ns);
    const reason = skipReason(collection, metadata.type);
    if (reason !== undefined) {
      skipped.push({ ns, reason });
      continue;
    }
    selected.push({ collection, metadata, files });
  }

  const suffixes = caseSuffixesByNamespace(
    selected.map((item) => ({ db: item.files.db, collection: item.collection })),
  );
  return selected.map((item) => ({
    files: item.files,
    namespace: {
      db: item.files.db,
      collection: item.collection,
      metadata: item.metadata,
      uniqueSuffix: suffixes.get(`${item.files.db}.${item.collection}`),
    },
  }));
}

/**
 * The collection name for a file stem: unescaped from the stem, or (for stems
 * mongodump shortened) the `collectionName` recorded in the metadata file.
 */
function resolveCollectionName(files: DumpCollectionFiles, metadataText: string): string {
  const parsed = parseCollectionFileStem(files.stem);
  if (parsed.kind === "name") return parsed.collection;
  const where = files.metadata?.path ?? files.stem;
  const recorded = metadataText === "" ? undefined : recordedCollectionName(metadataText, where);
  if (recorded === undefined) {
    // mongorestore fails the same way: "no collection name found in metadata file".
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `The file name "${files.stem}" was shortened by mongodump, and the collection's real name ` +
        "is not in a metadata file next to it.",
      { hint: "Keep the .metadata.json file of every collection in the dump directory." },
    );
  }
  return recorded;
}

/** Writes one namespace: metadata, then (except for views) its documents. */
async function importNamespace(
  target: ImportTarget,
  item: PlannedNamespace,
  signal: AbortSignal,
): Promise<NamespaceEntry> {
  const ns = namespaceOf(item.namespace);
  target.progress.startNamespace(ns, 0);
  const metadata = await writeImportedMetadata(target, item.namespace, signal);

  let data: Awaited<ReturnType<typeof writeImportedData>> | undefined;
  if (item.namespace.metadata.type !== "view") {
    const file = item.files.data;
    if (file === undefined) {
      // A collection with metadata but no .bson file: import it empty, like mongorestore.
      data = await writeImportedData(target, item.namespace, Readable.from([]), [], signal);
    } else {
      const { source, transforms } = openDumpFile(file);
      data = await writeImportedData(
        target,
        item.namespace,
        source,
        [...transforms, createBsonSplitter()],
        signal,
      );
    }
  }

  const entry = namespaceEntry(item.namespace, metadata, data);
  target.progress.finishNamespace(ns, entry.documents, entry.bytesRaw);
  target.logger.info("Imported namespace", {
    ns,
    type: entry.type,
    documents: entry.documents,
    bytesRaw: entry.bytesRaw,
  });
  return entry;
}
