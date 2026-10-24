/**
 * Shared plumbing for the read-side recovery extras (tenant restore, document history,
 * diff, text export): selecting a backup, opening it ONCE for reading, and streaming
 * the documents of one of its namespaces.
 *
 *   listBackups → selectBackup → openBackupSource (unlocks a key envelope once)
 *     → for each namespace: data parts in order → raw BSON → (parsed) documents
 *
 * Opening once matters for passphrase and KMS backups: unlocking the key envelope
 * costs a scrypt run or a KMS call, so a command that reads many namespaces of one
 * backup must not unlock it per namespace (as `openNamespace` in find.ts would).
 *
 * An incremental backup is opened through its chain (src/engine/restore-chain.ts): the
 * base backup's namespaces and files, with every incremental's changes overlaid when
 * documents are read (`matchingDocuments`, `documentsAtWindowEnd`).
 */

import { BSON, type Document } from "mongodb";
import { type CatalogEntry, listBackups, selectBackup } from "../catalog/index.ts";
import type { EngineContext } from "../engine/context.ts";
import type { OpenedNamespace } from "../engine/find.ts";
import { openDocumentStream, type StoredBackupSource } from "../engine/read-pipeline.ts";
import { namespaceReading, type OpenedChain, openReadableBackup } from "../engine/restore-chain.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "../format/bson-stream.ts";
import {
  type CollectionEntry,
  collectionEntries,
  type DataFile,
  type Manifest,
} from "../format/manifest.ts";
import type { BackupSelector, DecryptionOptions } from "../types.ts";

/** A selected backup, opened for reading. */
export interface OpenedBackup {
  /** The backup holding the documents (for an incremental: its chain's base). */
  readonly manifest: Manifest;
  readonly source: StoredBackupSource;
  /** Set when an incremental backup was selected: its chain's windows to overlay. */
  readonly chain?: OpenedChain | undefined;
}

/** What `openSelectedBackup` needs to know. */
export interface OpenBackupOptions {
  readonly backup: BackupSelector;
  readonly decryption?: DecryptionOptions | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Selects one complete backup and opens it for reading.
 *
 * @throws MongoShieldError `MS_BACKUP_NOT_FOUND`, key errors (`MS_NO_IDENTITY`,
 *   `MS_DECRYPTION_FAILED`) from `openBackupSource`, storage errors.
 */
export async function openSelectedBackup(
  context: EngineContext,
  options: OpenBackupOptions,
): Promise<OpenedBackup> {
  const entries = await listBackups(context.storage, {
    logger: context.logger,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const manifest = manifestOf(selectBackup(entries, options.backup));
  return openReadableBackup(context.storage, entries, manifest, {
    decryption: options.decryption,
    signal: options.signal,
  });
}

/** The manifest of a selected (complete) catalog entry. */
export function manifestOf(entry: CatalogEntry): Manifest {
  if (entry.manifest === undefined) {
    // selectBackup only returns complete entries, which always carry a manifest.
    throw new MongoShieldError("MS_INTERNAL", `Backup ${entry.id} has no manifest.`);
  }
  return entry.manifest;
}

/**
 * The manifest entry of `namespace` when the backup holds it as a collection or time
 * series (views store no documents; users and roles entries are not collections).
 */
export function documentNamespace(
  manifest: Manifest,
  namespace: string,
): CollectionEntry | undefined {
  const entry = collectionEntries(manifest.namespaces).find(
    (candidate) => candidate.ns === namespace,
  );
  if (entry === undefined || entry.type === "view") return undefined;
  return entry;
}

/** The shape `matchingDocuments` (find.ts) reads from. */
export function openedNamespace(backup: OpenedBackup, entry: CollectionEntry): OpenedNamespace {
  // A chain's time series come from the incremental's own copy (restore-chain.ts).
  return namespaceReading(backup, entry);
}

/**
 * Every document of a namespace as the raw BSON bytes stored in the backup, part after
 * part. `files` defaults to every part; callers may pass fewer (see history.ts).
 * Stopping the iteration early closes the open data file.
 */
export async function* rawDocumentsOf(
  source: StoredBackupSource,
  files: readonly DataFile[],
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer> {
  for (const file of files) {
    for await (const raw of openDocumentStream(source, file, { signal })) {
      throwIfAborted(signal);
      if (!Buffer.isBuffer(raw)) {
        throw new MongoShieldError("MS_INTERNAL", "The BSON splitter yielded a non-Buffer chunk.");
      }
      yield raw;
    }
  }
}

/**
 * Parses one backed-up document losslessly (an Int32 stays an `Int32`). A document that
 * does not parse means a damaged file.
 */
export function parseRawDocument(raw: Uint8Array): Document {
  try {
    return BSON.deserialize(raw, LOSSLESS_DESERIALIZE_OPTIONS);
  } catch (error) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `A backed-up document is not valid BSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, hint: "The backup is damaged. Run `mongoshield verify` on it." },
    );
  }
}

/** Refuses a namespace string that cannot be `<database>.<collection>`. */
export function assertNamespace(namespace: string, what = "namespace"): void {
  const dot = namespace.indexOf(".");
  if (dot <= 0 || dot === namespace.length - 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `"${namespace}" is not a valid ${what}; use <database>.<collection>.`,
      { hint: "Example: app.users." },
    );
  }
}
