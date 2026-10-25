/**
 * Writing imported mongodump data as a regular MongoShield backup: the parts both
 * importers (directory and archive) share. Each namespace becomes exactly what
 * `mongoshield backup` writes for it (see docs/specs/FORMAT.md):
 *
 *   metadata:  CollectionMetadata → serializeCollectionMetadata → (encrypt) → digest → storage.put
 *   data:      raw BSON documents → count → coalesce → compress → (encrypt) → digest → storage.put
 *
 * The stream wiring (`writeStoredFile`), key layout, manifest builder, coalescer and
 * encryption set-up are the backup engine's own, imported rather than copied, so an
 * imported backup cannot drift from a native one. Only the source differs: dump
 * files or archive blocks instead of a MongoDB cursor.
 */

import { Readable, type Transform } from "node:stream";
import { createCompressor } from "../compression/index.ts";
import { createEncryptStream } from "../crypto/index.ts";
import { createCoalescer } from "../engine/backup-coalesce.ts";
import type { FileEncryption } from "../engine/backup-key.ts";
import { buildManifest } from "../engine/backup-manifest.ts";
import { writeStoredFile } from "../engine/backup-write.ts";
import type { CapturedWindow } from "../engine/converge-capture.ts";
import type { ProgressTracker } from "../engine/progress.ts";
import { createCountingStream } from "../format/hashing.ts";
import {
  caseCollisionSuffixes,
  changesFileKey,
  dataFileKey,
  manifestKey,
  metadataFileKey,
  reservedNameSuffix,
  resolveBackupKey,
} from "../format/layout.ts";
import type {
  ChangesFile,
  Compression,
  Manifest,
  NamespaceEntry,
  StoredFile,
} from "../format/manifest.ts";
import { type CollectionMetadata, serializeCollectionMetadata } from "../format/metadata.ts";
import type { Logger } from "../logger.ts";
import type { DeploymentInfo } from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";

/** Content type of data files and of every encrypted file (as the backup engine uses). */
const BINARY_CONTENT_TYPE = "application/octet-stream";

/** Content type of unencrypted metadata files. */
const JSON_CONTENT_TYPE = "application/json";

/** How long deleting the files of a failed import may take; it is best effort. */
const CLEANUP_TIMEOUT_MS = 60_000;

/** mongodump's 16 MiB limit, recorded nowhere but required by the `DeploymentInfo` type. */
const MAX_BSON_OBJECT_SIZE = 16 * 1024 * 1024;

/** Everything shared by the namespace writes of one import. */
export interface ImportTarget {
  readonly storage: StorageAdapter;
  readonly logger: Logger;
  readonly backupId: string;
  readonly compression: Compression;
  /** `undefined` for unencrypted backups. */
  readonly encryption: FileEncryption | undefined;
  readonly progress: ProgressTracker;
  /** Full keys of every object this import started writing, for cleanup on failure. */
  readonly writtenKeys: Set<string>;
}

/** One namespace to import: its names, metadata and file-name suffix. */
export interface ImportNamespace {
  readonly db: string;
  readonly collection: string;
  readonly metadata: CollectionMetadata;
  /** From `caseCollisionSuffixes()`, for names that clash by case; usually undefined. */
  readonly uniqueSuffix: string | undefined;
}

/** What writing one namespace's documents produced. */
export interface ImportedData {
  readonly file: StoredFile;
  readonly documents: number;
  readonly bytesRaw: number;
}

/** A namespace the import left out, and why. */
export interface SkippedNamespace {
  /** `db.collection`, or the file path for files that are not a namespace. */
  readonly ns: string;
  readonly reason: string;
}

/** `db.collection` of a namespace. */
export function namespaceOf(namespace: Pick<ImportNamespace, "db" | "collection">): string {
  return `${namespace.db}.${namespace.collection}`;
}

/** Writes `<collection>.metadata.json[.age]` and returns its manifest entry. */
export async function writeImportedMetadata(
  target: ImportTarget,
  namespace: ImportNamespace,
  signal: AbortSignal,
): Promise<StoredFile> {
  const json = serializeCollectionMetadata(namespace.metadata);
  const relativeKey = metadataFileKey({
    db: namespace.db,
    collection: namespace.collection,
    encrypted: target.encryption !== undefined,
    ...suffixOption(namespace),
  });
  const key = resolveBackupKey(target.backupId, relativeKey);
  target.writtenKeys.add(key);
  const digest = await writeStoredFile({
    storage: target.storage,
    key,
    source: Readable.from([Buffer.from(json, "utf8")]),
    transforms: encryptionTransforms(target),
    contentType: target.encryption === undefined ? JSON_CONTENT_TYPE : BINARY_CONTENT_TYPE,
    signal,
  });
  return { key: relativeKey, size: digest.size, sha256: digest.sha256 };
}

/**
 * Streams a namespace's documents into `<collection>.bson[.zst|.gz][.age]`.
 *
 * @param documents an object-mode stream of raw BSON Buffers, one per document
 * @param before transforms that turn the source into such a stream (e.g. gunzip + BSON
 *   splitter for a dump file); empty when `documents` already yields documents
 */
export async function writeImportedData(
  target: ImportTarget,
  namespace: ImportNamespace,
  documents: Readable,
  before: readonly Transform[],
  signal: AbortSignal,
): Promise<ImportedData> {
  const ns = namespaceOf(namespace);
  const relativeKey = dataFileKey({
    db: namespace.db,
    collection: namespace.collection,
    compression: target.compression,
    encrypted: target.encryption !== undefined,
    ...suffixOption(namespace),
  });
  const key = resolveBackupKey(target.backupId, relativeKey);
  // Counting raw documents (before compression) gives the manifest's documents and bytesRaw.
  const counter = createCountingStream(
    target.progress.enabled
      ? { onProgress: (counts) => target.progress.updateNamespace(ns, counts.items, counts.bytes) }
      : {},
  );
  target.writtenKeys.add(key);
  const digest = await writeStoredFile({
    storage: target.storage,
    key,
    source: documents,
    transforms: [
      ...before,
      counter.stream,
      createCoalescer(),
      createCompressor(target.compression),
      ...encryptionTransforms(target),
    ],
    contentType: BINARY_CONTENT_TYPE,
    signal,
  });
  const counts = counter.counts();
  return {
    file: { key: relativeKey, size: digest.size, sha256: digest.sha256 },
    documents: counts.items,
    bytesRaw: counts.bytes,
  };
}

/**
 * Streams converted oplog events into the changes file (`_changes/window.bson…`),
 * compressed and encrypted like a data file, exactly where a converge backup keeps it.
 *
 * @param events an object-mode stream of raw BSON change events (after `before`)
 */
export async function writeImportedChanges(
  target: ImportTarget,
  events: Readable,
  before: readonly Transform[],
  signal: AbortSignal,
): Promise<ChangesFile> {
  const relativeKey = changesFileKey({
    compression: target.compression,
    encrypted: target.encryption !== undefined,
  });
  const key = resolveBackupKey(target.backupId, relativeKey);
  const counter = createCountingStream();
  target.writtenKeys.add(key);
  const digest = await writeStoredFile({
    storage: target.storage,
    key,
    source: events,
    transforms: [
      ...before,
      counter.stream,
      createCoalescer(),
      createCompressor(target.compression),
      ...encryptionTransforms(target),
    ],
    contentType: BINARY_CONTENT_TYPE,
    signal,
  });
  return {
    key: relativeKey,
    size: digest.size,
    sha256: digest.sha256,
    events: counter.counts().items,
  };
}

/** The manifest entry of an imported namespace. Views have no data file. */
export function namespaceEntry(
  namespace: ImportNamespace,
  metadata: StoredFile,
  data: ImportedData | undefined,
): NamespaceEntry {
  return {
    ns: namespaceOf(namespace),
    db: namespace.db,
    collection: namespace.collection,
    type: namespace.metadata.type,
    documents: data?.documents ?? 0,
    bytesRaw: data?.bytesRaw ?? 0,
    files: data === undefined ? [] : [data.file],
    metadata,
  };
}

/**
 * The unique-suffix of every namespace whose name clashes with another by case
 * within its database (see `caseCollisionSuffixes`), or with the changes file
 * (`_changes.window`, see `reservedNameSuffix`), keyed by `db.collection`. The
 * same rules as `runBackup`, so imported backups lay out files like native ones.
 */
export function caseSuffixesByNamespace(
  namespaces: readonly Pick<ImportNamespace, "db" | "collection">[],
): Map<string, string> {
  const namesByDatabase = new Map<string, string[]>();
  for (const namespace of namespaces) {
    const names = namesByDatabase.get(namespace.db) ?? [];
    names.push(namespace.collection);
    namesByDatabase.set(namespace.db, names);
  }
  const suffixes = new Map<string, string>();
  for (const [db, names] of namesByDatabase) {
    for (const [name, suffix] of caseCollisionSuffixes(names))
      suffixes.set(`${db}.${name}`, suffix);
  }
  for (const namespace of namespaces) {
    const reserved = reservedNameSuffix(namespace.db, namespace.collection);
    const ns = namespaceOf(namespace);
    if (reserved !== undefined && !suffixes.has(ns)) suffixes.set(ns, reserved);
  }
  return suffixes;
}

/** What the manifest of an imported backup is built from. */
export interface ImportManifestInput {
  readonly backupId: string;
  /** When the dump was taken (best known): becomes `startedAt` and `completedAt`. */
  readonly dumpedAt: Date;
  /** The dumped server's version, or undefined when the dump does not say. */
  readonly serverVersion: string | undefined;
  readonly compression: Compression;
  readonly encryption: FileEncryption | undefined;
  readonly labels: Readonly<Record<string, string>>;
  /** Collections, views and time-series collections, in any order. */
  readonly entries: readonly NamespaceEntry[];
  /** The users and roles entries (roles first), stored after the collections. */
  readonly authzEntries?: readonly NamespaceEntry[];
  /** The converted oplog of `mongodump --oplog`, for consistency `converge`. */
  readonly window?: CapturedWindow | undefined;
}

/**
 * Builds the manifest with the backup engine's `buildManifest`. A dump says nothing
 * about the deployment's topology or identity, so `source` is reduced to what is
 * known. mongodump without `--oplog` gives no consistency guarantee (`none`); with
 * `--oplog`, the converted oplog makes it a `converge` backup (see oplog-events.ts).
 */
export function buildImportManifest(input: ImportManifestInput): Manifest {
  const serverVersion = input.serverVersion ?? "unknown";
  // buildManifest takes a full DeploymentInfo; only topology, version and clusterId
  // reach the manifest, and `source` is replaced below so no made-up id is stored.
  const deployment: DeploymentInfo = {
    topology: "unknown",
    serverVersion,
    clusterId: "",
    supportsChangeStreams: false,
    supportsSnapshotReads: false,
    maxBsonObjectSize: MAX_BSON_OBJECT_SIZE,
  };
  // Manifests list namespaces sorted by name, then users and roles, like native backups.
  const sorted = [
    ...[...input.entries].sort((a, b) => compareNamespaces(a.ns, b.ns)),
    ...(input.authzEntries ?? []),
  ];
  const manifest = buildManifest({
    id: input.backupId,
    startedAt: input.dumpedAt,
    completedAt: input.dumpedAt,
    deployment,
    consistency:
      input.window === undefined
        ? { mode: "none", clusterTime: undefined }
        : { mode: "converge", clusterTime: undefined, window: input.window },
    compression: input.compression,
    encryption: input.encryption,
    labels: input.labels,
    namespaces: sorted,
  });
  return { ...manifest, source: { topology: "unknown", serverVersion } };
}

/**
 * Deletes what a failed import wrote: the manifest first (if its write was attempted),
 * then the other files, so a half-deleted backup never looks complete. Best effort:
 * problems are logged, never thrown, so the caller sees the original error.
 */
export async function deletePartialImport(
  target: Pick<ImportTarget, "storage" | "logger" | "backupId" | "writtenKeys">,
  manifestAttempted: boolean,
): Promise<void> {
  const keys = [...target.writtenKeys];
  try {
    if (manifestAttempted) {
      await target.storage.delete([manifestKey(target.backupId)], {
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      });
    }
    if (keys.length > 0) {
      await target.storage.delete(keys, { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
    }
  } catch (error) {
    target.logger.warn("Could not remove the files of the failed import; delete them by hand", {
      id: target.backupId,
      files: keys,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function suffixOption(namespace: ImportNamespace): { uniqueSuffix?: string } {
  return namespace.uniqueSuffix === undefined ? {} : { uniqueSuffix: namespace.uniqueSuffix };
}

/** A fresh encrypt stream per file (age gives every file its own key), or none. */
function encryptionTransforms(target: ImportTarget): Transform[] {
  if (target.encryption === undefined) return [];
  return [createEncryptStream({ recipients: target.encryption.recipients })];
}

/** Plain code-unit order of two namespaces, independent of locale. */
function compareNamespaces(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
