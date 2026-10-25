/**
 * Importing a mongodump output directory into a MongoShield backup.
 *
 *   scanDumpDirectory → resolve names + read metadata → decide what to import (import-rules.ts)
 *     → per namespace, N at a time:  metadata file, then
 *                                    <stem>.bson[.gz] → (gunzip) → BSON splitter → count → … → storage
 *     → users and roles entries (import-authz.ts)
 *     → oplog.bson of `mongodump --oplog` → change events (import-oplog.ts)
 *
 * The BSON splitter checks every document's framing on the way, so a truncated or
 * corrupt `.bson` file fails the import instead of producing a damaged backup.
 * Documents are copied byte for byte; nothing is parsed. The exception is
 * time-series data: mongodump writes `<name>.metadata.json` plus the bucket documents
 * in `system.buckets.<name>.bson`, and the buckets are unpacked into measurements on
 * the way (timeseries-buckets.ts).
 */

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CapturedWindow } from "../engine/converge-capture.ts";
import { mapWithConcurrency } from "../engine/pool.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { createBsonSplitter } from "../format/bson-stream.ts";
import type { NamespaceEntry } from "../format/manifest.ts";
import type { CollectionMetadata } from "../format/metadata.ts";
import type { NamespaceFilter } from "../mongo/index.ts";
import { TIMESERIES_BUCKET_PREFIX } from "./archive-format.ts";
import {
  type DumpCollectionFiles,
  type DumpDirectoryScan,
  type DumpFile,
  openDumpFile,
  readDumpTextFile,
} from "./dump-directory.ts";
import { parseDumpMetadata, recordedCollectionName } from "./dump-metadata.ts";
import { collectionFileStem, parseCollectionFileStem } from "./dump-names.ts";
import { AuthzCollector } from "./import-authz.ts";
import { IGNORED_OPLOG_REASON, importOplog } from "./import-oplog.ts";
import { importRole, ORPHAN_BUCKETS_REASON } from "./import-rules.ts";
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
import { createBucketUnpacker, timeSeriesSettings } from "./timeseries-buckets.ts";

/** A collection of the dump that will be imported, with its files. */
interface PlannedNamespace {
  readonly namespace: ImportNamespace;
  readonly files: DumpCollectionFiles;
  /** Time-series collections: the bucket documents (`system.buckets.<name>.bson`). */
  readonly buckets: DumpFile | undefined;
}

/** What importing a directory produced. */
export interface DirectoryImportOutcome {
  readonly entries: NamespaceEntry[];
  readonly authzEntries: NamespaceEntry[];
  /** The converted `oplog.bson` of `mongodump --oplog`, when there was one. */
  readonly window: CapturedWindow | undefined;
  readonly skipped: SkippedNamespace[];
}

/** Users and roles files are tiny; this is far above any real one. */
const MAX_AUTHZ_FILE_BYTES = 64 * 1024 * 1024;

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
  options: {
    readonly parallelism: number;
    readonly ignoreOplog: boolean;
    readonly signal: AbortSignal;
  },
): Promise<DirectoryImportOutcome> {
  const skipped: SkippedNamespace[] = scan.ignored.map((file) => ({
    ns: file.path,
    reason: file.reason,
  }));
  const authz = new AuthzCollector(filter);
  const planned = await planNamespaces(scan, filter, { skipped, authz }, options.signal);

  const entries = await mapWithConcurrency(
    planned,
    (item, _index, signal) => importNamespace(target, item, signal),
    { concurrency: options.parallelism, signal: options.signal },
  );
  const authzEntries = await authz.write(target, options.signal);

  let window: CapturedWindow | undefined;
  if (scan.oplog !== undefined && options.ignoreOplog) {
    skipped.push({ ns: scan.oplog.path, reason: IGNORED_OPLOG_REASON });
  } else if (scan.oplog !== undefined) {
    const { source, transforms } = openDumpFile(scan.oplog);
    window = await importOplog(target, source, [...transforms, createBsonSplitter()], {
      filter,
      where: scan.oplog.path,
      signal: options.signal,
    });
  }
  return { entries, authzEntries, window, skipped };
}

/** One stem of the dump with its resolved collection name and metadata text. */
interface NamedFiles {
  readonly files: DumpCollectionFiles;
  readonly collection: string;
  readonly metadataText: string;
}

/**
 * Resolves names and metadata, reads users and roles, pairs time-series metadata
 * with its bucket file, and keeps the collections that should be imported.
 */
async function planNamespaces(
  scan: DumpDirectoryScan,
  filter: NamespaceFilter,
  found: { readonly skipped: SkippedNamespace[]; readonly authz: AuthzCollector },
  signal: AbortSignal,
): Promise<PlannedNamespace[]> {
  const candidates: NamedFiles[] = [];
  /** Bucket files by `db\0<time-series collection>`, removed as they are paired. */
  const bucketFiles = new Map<string, { files: DumpCollectionFiles; ns: string }>();
  /** Shortened stems without a metadata file, by `db\0stem`: bucket files of long names. */
  const unnamed = new Map<string, DumpCollectionFiles>();
  for (const files of scan.collections) {
    throwIfAborted(signal);
    const metadataText = files.metadata === undefined ? "" : await readDumpTextFile(files.metadata);
    const collection = resolveCollectionName(files, metadataText);
    if (collection === undefined) {
      unnamed.set(`${files.db}\0${files.stem}`, files);
      continue;
    }
    const ns = `${files.db}.${collection}`;
    const role = importRole(files.db, collection);
    switch (role.kind) {
      case "namespace":
        candidates.push({ files, collection, metadataText });
        break;
      case "buckets":
        bucketFiles.set(`${files.db}\0${role.collection}`, { files, ns });
        break;
      case "users":
      case "roles":
        if (files.data !== undefined) await readAuthzFile(files.data, role.kind, found.authz);
        break;
      case "skip":
        if (filter(ns)) found.skipped.push({ ns, reason: role.reason });
        break;
    }
  }
  claimShortenedBucketFiles(candidates, unnamed, bucketFiles);

  const selected: {
    named: NamedFiles;
    metadata: CollectionMetadata;
    buckets: DumpFile | undefined;
  }[] = [];
  for (const named of candidates) {
    const { files, collection, metadataText } = named;
    const ns = `${files.db}.${collection}`;
    // Bucket files are claimed even when filtered out, so they are not reported as orphans.
    const bucketKey = `${files.db}\0${collection}`;
    const buckets = bucketFiles.get(bucketKey);
    if (!filter(ns)) {
      bucketFiles.delete(bucketKey);
      continue;
    }
    const metadata = parseDumpMetadata(metadataText, collection, files.metadata?.path ?? ns);
    if (metadata.type === "timeseries") bucketFiles.delete(bucketKey);
    selected.push({
      named,
      metadata,
      buckets: metadata.type === "timeseries" ? buckets?.files.data : undefined,
    });
  }
  for (const [key, orphan] of bucketFiles) {
    // Filtered like mongorestore does: by the time-series collection's name.
    const timeSeriesNs = `${orphan.files.db}.${key.slice(key.indexOf("\0") + 1)}`;
    if (filter(timeSeriesNs)) found.skipped.push({ ns: orphan.ns, reason: ORPHAN_BUCKETS_REASON });
  }

  const suffixes = caseSuffixesByNamespace(
    selected.map((item) => ({ db: item.named.files.db, collection: item.named.collection })),
  );
  return selected.map((item) => ({
    files: item.named.files,
    buckets: item.buckets,
    namespace: {
      db: item.named.files.db,
      collection: item.named.collection,
      metadata: item.metadata,
      uniqueSuffix: suffixes.get(`${item.named.files.db}.${item.named.collection}`),
    },
  }));
}

/** Reads a users or roles file into the collector. */
async function readAuthzFile(
  file: DumpFile,
  kind: "users" | "roles",
  authz: AuthzCollector,
): Promise<void> {
  const { source, transforms } = openDumpFile(file);
  let total = 0;
  const collect = new Writable({
    objectMode: true,
    write(document: Buffer, _encoding, callback) {
      total += document.length;
      if (total > MAX_AUTHZ_FILE_BYTES) {
        callback(
          new MongoShieldError(
            "MS_INTEGRITY_FAILED",
            `${file.path} is larger than ${MAX_AUTHZ_FILE_BYTES} bytes.`,
            {
              hint: "This is not a users or roles file mongodump writes.",
            },
          ),
        );
        return;
      }
      try {
        authz.add(kind, document, file.path);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  await pipeline([source, ...transforms, createBsonSplitter(), collect]);
}

/**
 * The collection name for a file stem: unescaped from the stem, or (for stems
 * mongodump shortened) the `collectionName` recorded in the metadata file.
 * Undefined for a shortened stem without metadata, which only the bucket file of a
 * time-series collection with a long name has (see `claimShortenedBucketFiles`).
 */
function resolveCollectionName(
  files: DumpCollectionFiles,
  metadataText: string,
): string | undefined {
  const parsed = parseCollectionFileStem(files.stem);
  if (parsed.kind === "name") return parsed.collection;
  const where = files.metadata?.path ?? files.stem;
  return metadataText === "" ? undefined : recordedCollectionName(metadataText, where);
}

/**
 * mongodump names a time-series collection's bucket file like a collection called
 * `system.buckets.<name>`, shortened when long, and writes no metadata file for it,
 * so a shortened bucket stem can only be recognised by computing it from each
 * collection's name. Pairs those stems with their collections; any other shortened
 * stem without metadata is an error, as in mongorestore ("no collection name found
 * in metadata file").
 */
function claimShortenedBucketFiles(
  candidates: readonly NamedFiles[],
  unnamed: Map<string, DumpCollectionFiles>,
  bucketFiles: Map<string, { files: DumpCollectionFiles; ns: string }>,
): void {
  for (const { files, collection } of candidates) {
    const bucketCollection = `${TIMESERIES_BUCKET_PREFIX}${collection}`;
    const key = `${files.db}\0${collectionFileStem(bucketCollection)}`;
    const bucket = unnamed.get(key);
    if (bucket === undefined) continue;
    unnamed.delete(key);
    bucketFiles.set(`${files.db}\0${collection}`, {
      files: bucket,
      ns: `${files.db}.${bucketCollection}`,
    });
  }
  for (const files of unnamed.values()) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `The file name "${files.stem}" was shortened by mongodump, and the collection's real name ` +
        "is not in a metadata file next to it.",
      { hint: "Keep the .metadata.json file of every collection in the dump directory." },
    );
  }
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
    const isTimeSeries = item.namespace.metadata.type === "timeseries";
    const file = isTimeSeries ? item.buckets : item.files.data;
    if (file === undefined) {
      // A collection with metadata but no .bson file: import it empty, like mongorestore.
      data = await writeImportedData(target, item.namespace, Readable.from([]), [], signal);
    } else {
      const { source, transforms } = openDumpFile(file);
      // Time-series buckets are unpacked into the measurements a backup stores.
      const unpack = isTimeSeries
        ? [createBucketUnpacker(timeSeriesSettings(item.namespace.metadata, ns), ns)]
        : [];
      data = await writeImportedData(
        target,
        item.namespace,
        source,
        [...transforms, createBsonSplitter(), ...unpack],
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
