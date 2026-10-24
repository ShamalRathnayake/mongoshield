/**
 * Reading a stored backup back as plain mongodump data, for both export formats:
 * which namespaces to export, their metadata as mongodump JSON, and their documents
 * with every split part decrypted, decompressed and joined in order.
 *
 *   part 000 → integrity check → decrypt → decompress → split ┐
 *   part 001 → …                                              ├→ one stream of raw BSON documents
 *   part 002 → …                                              ┘
 *
 * All of the reading (checksums, decryption, passphrase key envelopes) is the read
 * pipeline restore and verify use (`src/engine/read-pipeline.ts`).
 */

import {
  openDocumentStream,
  readMetadataFile,
  type StoredBackupSource,
} from "../engine/read-pipeline.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { isAuthzEntry, type Manifest, type NamespaceEntry } from "../format/manifest.ts";
import { type CollectionMetadata, serializeCollectionMetadata } from "../format/metadata.ts";
import type { NamespaceFilter } from "../mongo/index.ts";
import type { SkippedNamespace } from "./import-target.ts";

/** One namespace to export, with its metadata ready to write. */
export interface ExportNamespace {
  readonly entry: NamespaceEntry;
  readonly metadata: CollectionMetadata;
  /** The metadata as mongodump's `<collection>.metadata.json` (canonical Extended JSON). */
  readonly metadataJson: string;
}

/** What was written for one namespace. */
export interface ExportedNamespace {
  readonly ns: string;
  readonly type: NamespaceEntry["type"];
  readonly documents: number;
  /** BSON bytes of the documents (before any gzip). */
  readonly bytes: number;
}

/** The namespaces of a backup to export, and the ones left out with the reason. */
export interface ExportSelection {
  readonly entries: readonly NamespaceEntry[];
  readonly skipped: readonly SkippedNamespace[];
}

/**
 * Applies include/exclude and leaves out what mongorestore cannot take from a
 * MongoShield backup: time-series collections, whose data MongoShield stores as
 * measurements while mongorestore expects the internal bucket documents.
 *
 * @throws MS_CONFIG_INVALID when patterns were given but select nothing.
 */
export function selectExportNamespaces(
  manifest: Manifest,
  filter: NamespaceFilter,
  hasPatterns: boolean,
): ExportSelection {
  const entries: NamespaceEntry[] = [];
  const skipped: SkippedNamespace[] = [];
  for (const entry of manifest.namespaces) {
    if (!filter(entry.ns)) continue;
    if (isAuthzEntry(entry)) {
      skipped.push({
        ns: entry.ns,
        reason:
          "users and roles: mongorestore expects them with the server's auth schema version; " +
          "restore them with `mongoshield restore --users-and-roles create` instead",
      });
      continue;
    }
    if (entry.type === "timeseries") {
      skipped.push({
        ns: entry.ns,
        reason:
          "time-series collection: mongorestore needs internal bucket documents, but the backup " +
          "holds measurements; restore it with `mongoshield restore` instead",
      });
      continue;
    }
    entries.push(entry);
  }
  if (hasPatterns && entries.length === 0 && skipped.length === 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "No namespace of the backup matches the filters.",
      {
        hint: `The backup holds: ${manifest.namespaces
          .slice(0, 20)
          .map((entry) => entry.ns)
          .join(", ")}.`,
      },
    );
  }
  return { entries, skipped };
}

/** Reads (and checks) a namespace's metadata file and renders it as mongodump JSON. */
export async function loadExportNamespace(
  source: StoredBackupSource,
  entry: NamespaceEntry,
  signal: AbortSignal,
): Promise<ExportNamespace> {
  const metadata = await readMetadataFile(source, entry.metadata, { signal });
  // The manifest's names are authoritative (metadata only repeats the collection name).
  const corrected: CollectionMetadata = { ...metadata, collectionName: entry.collection };
  return { entry, metadata: corrected, metadataJson: serializeCollectionMetadata(corrected) };
}

/**
 * Every document of a namespace, part after part, as raw BSON Buffers. Each part's
 * size and checksum are verified as it is read (see `openDocumentStream`).
 */
export async function* documentsOf(
  source: StoredBackupSource,
  entry: NamespaceEntry,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  for (const file of entry.files) {
    throwIfAborted(signal);
    for await (const document of openDocumentStream(source, file, { signal })) {
      yield document as Buffer;
    }
  }
}

/**
 * Fails when fewer or more documents were read than the manifest recorded, so an
 * export never silently differs from the backup.
 */
export function assertDocumentCount(entry: NamespaceEntry, documents: number): void {
  if (documents === entry.documents) return;
  throw new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `${entry.ns} has ${documents} documents in its data files, but the manifest records ${entry.documents}.`,
    { hint: "The backup is damaged. Run `mongoshield verify --deep` on it." },
  );
}

/**
 * The server version for mongodump's prelude, which mongorestore parses as
 * `major.minor.patch` (mongo-tools `common/db/version.go`, `StrToVersion`). Returns
 * undefined when the backup's version is not in that form.
 */
export function dumpServerVersion(manifest: Manifest): string | undefined {
  const version = manifest.source.serverVersion;
  return /^\d+\.\d+\.\d+([-+].*)?$/.test(version) ? version : undefined;
}
