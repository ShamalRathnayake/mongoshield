/**
 * `find`: searching one namespace of a backup for documents, without restoring it.
 *
 *   select backup → find the namespace → open the backup (keys) → for each data part:
 *   stored bytes → decrypt? → decompress → split into BSON documents → parse
 *   → filter (filter.ts) → projection (find-projection.ts) → yield, until `limit`
 *
 * Everything streams: the backup is read part by part and document by document, and
 * reading stops (closing the storage download) as soon as `limit` documents were
 * found or the caller stops iterating. Memory use does not depend on the size of
 * the collection.
 *
 * Documents are parsed losslessly (`LOSSLESS_DESERIALIZE_OPTIONS`): an Int32 stays an
 * `Int32`, a Long a `Long`, so a found document can be written back exactly as it
 * was backed up (see `restoreDocuments` in find-restore.ts).
 *
 * The filter is evaluated in-process, so `find` only supports a subset of MongoDB's
 * query language; see filter.ts for the list. Converge backups are read as they were
 * at the end of their window: the changes recorded while the backup ran are overlaid
 * on the dumped documents (find-window.ts) before the filter sees them, as a full
 * restore would replay them. Incremental backups are read the same way, as their
 * chain's base backup with every incremental's changes overlaid (restore-chain.ts).
 */

import type { Document } from "mongodb";
import { listBackups, selectBackup } from "../catalog/index.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { isCollectionEntry, type Manifest, type NamespaceEntry } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import type { BackupSelector, DecryptionOptions } from "../types.ts";
import type { EngineContext } from "./context.ts";
import { compileFilter, type DocumentMatcher } from "./filter.ts";
import { parseBackedUpDocument } from "./find-parse.ts";
import { compileProjection } from "./find-projection.ts";
import { documentsAtWindowEnd, needsOverlay } from "./find-window.ts";
import { openDocumentStream, type StoredBackupSource } from "./read-pipeline.ts";
import { namespaceReading, type OpenedChain, openReadableBackup } from "./restore-chain.ts";

/** Options for `findInBackup`. */
export interface FindInBackupOptions {
  /** Which backup: an id, `"latest"`, or `{ before: date }`. */
  readonly backup: BackupSelector;
  /** The namespace to search, `<database>.<collection>`. */
  readonly namespace: string;
  /**
   * A MongoDB query filter, e.g. `{ _id: new ObjectId("…") }` or
   * `{ email: /@example\.com$/i, age: { $gte: 18 } }`. Defaults to `{}` (every
   * document). Only the operators listed in filter.ts are supported.
   */
  readonly filter?: Document;
  /** Inclusion or exclusion projection, e.g. `{ name: 1, email: 1 }` or `{ password: 0 }`. */
  readonly projection?: Document;
  /** Stop after this many matching documents. Omit (or 0) for no limit. */
  readonly limit?: number;
  /** Keys for encrypted backups. */
  readonly decryption?: DecryptionOptions;
  readonly signal?: AbortSignal;
}

/** A matching document together with its size in the backup (raw BSON bytes). */
export interface MatchedDocument {
  readonly document: Document;
  readonly bytes: number;
  /**
   * The stored BSON, when the document is exactly as backed up (not changed by a
   * converge backup's window). Diff compares these bytes rather than re-encoding.
   */
  readonly raw?: Buffer;
}

/** A namespace of a selected backup, opened for reading. */
export interface OpenedNamespace {
  /** The backup holding the documents (for an incremental: its chain's base). */
  readonly manifest: Manifest;
  readonly entry: NamespaceEntry;
  readonly source: StoredBackupSource;
  /** Set when an incremental backup was selected: its chain's windows to overlay. */
  readonly chain?: OpenedChain | undefined;
}

/** The id of the backup the caller selected (an incremental's own id, not its base's). */
export function selectedBackupId(opened: Pick<OpenedNamespace, "manifest" | "chain">): string {
  return opened.chain?.backupId ?? opened.manifest.id;
}

/**
 * Searches one namespace of a backup and yields the matching documents, in the order
 * they are stored in the backup (the collection's natural order when it was backed up).
 *
 * The filter, projection and limit are validated immediately, so mistakes in them
 * throw from this call; everything else (selecting the backup, reading it) happens
 * while iterating.
 *
 *   for await (const user of findInBackup(context, {
 *     backup: "latest",
 *     namespace: "app.users",
 *     filter: { email: "ada@example.com" },
 *   })) console.log(user);
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for an unsupported or malformed filter or
 *   projection, a bad limit, or a namespace the backup does not hold (also a view).
 *   While iterating: `MS_BACKUP_NOT_FOUND`, `MS_NO_IDENTITY` / `MS_DECRYPTION_FAILED`,
 *   `MS_INTEGRITY_FAILED` for damaged files, `MS_ABORTED`.
 */
export function findInBackup(
  context: EngineContext,
  options: FindInBackupOptions,
): AsyncIterable<Document> {
  const matcher = compileFilter(options.filter ?? {});
  const project = compileProjection(options.projection);
  const limit = validateLimit(options.limit);

  async function* run(): AsyncGenerator<Document> {
    const opened = await openNamespace(context, options);
    let found = 0;
    const matches = matchingDocuments(opened, matcher, options.signal, {
      logger: context.logger,
    });
    for await (const match of matches) {
      yield project(match.document);
      found += 1;
      // Returning ends the loop, which closes the open data file stream.
      if (limit !== undefined && found >= limit) return;
    }
  }
  return run();
}

/**
 * Selects the backup, checks that it holds `namespace` as a collection (or time
 * series), and opens it for reading (unlocking the key envelope of passphrase and
 * KMS backups once).
 *
 * @throws MongoShieldError `MS_BACKUP_NOT_FOUND`, `MS_CONFIG_INVALID` when the backup
 *   does not hold the namespace or it is a view, key errors from `openBackupSource`.
 */
export async function openNamespace(
  context: EngineContext,
  options: Pick<FindInBackupOptions, "backup" | "namespace" | "decryption" | "signal">,
): Promise<OpenedNamespace> {
  const entries = await listBackups(context.storage, {
    logger: context.logger,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const selected = selectBackup(entries, options.backup);
  if (selected.manifest === undefined) {
    // selectBackup only returns complete entries, which always carry a manifest.
    throw new MongoShieldError("MS_INTERNAL", `Backup ${selected.id} has no manifest.`);
  }

  // An incremental is read as its chain's base plus the chain's changes.
  const readable = await openReadableBackup(context.storage, entries, selected.manifest, {
    decryption: options.decryption,
    signal: options.signal,
  });
  const entry = namespaceEntry(readable.manifest, options.namespace, readable.chain);
  // A chain's time series are read from the incremental's own copy (restore-chain.ts).
  return isCollectionEntry(entry) ? namespaceReading(readable, entry) : { ...readable, entry };
}

/** Options of `matchingDocuments` besides what to match. */
export interface MatchOptions {
  /** Told when a converge backup's change window is overlaid. */
  readonly logger?: Logger | undefined;
  /** Memory for the change window overlay (see find-window.ts). Mainly for tests. */
  readonly windowMemoryBytes?: number | undefined;
}

/**
 * Yields every document of an opened namespace that matches, part after part.
 * Converge backups are matched in their state at the end of the window (see the
 * file header). Stopping the iteration early closes the open data file.
 */
export async function* matchingDocuments(
  opened: OpenedNamespace,
  matcher: DocumentMatcher,
  signal: AbortSignal | undefined,
  options: MatchOptions = {},
): AsyncGenerator<MatchedDocument> {
  if (needsOverlay(opened)) {
    const documents = documentsAtWindowEnd(opened, {
      signal,
      logger: options.logger,
      memoryBytes: options.windowMemoryBytes,
    });
    for await (const match of documents) {
      if (matcher(match.document)) yield match;
    }
    return;
  }
  for (const file of opened.entry.files) {
    for await (const raw of openDocumentStream(opened.source, file, { signal })) {
      throwIfAborted(signal);
      const bytes = raw as Buffer;
      const document = parseBackedUpDocument(bytes);
      if (matcher(document)) yield { document, bytes: bytes.length };
    }
  }
}

/** The manifest entry of `namespace`, or an error saying what the backup holds instead. */
function namespaceEntry(
  manifest: Manifest,
  namespace: string,
  chain?: OpenedChain,
): NamespaceEntry {
  const entry = manifest.namespaces.find((candidate) => candidate.ns === namespace);
  if (entry === undefined && chain !== undefined) {
    // Collections created after the base exist only as events: searching them would
    // mean reading every window without a starting point, which find does not do.
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The base backup ${manifest.id} of incremental ${chain.backupId} does not contain the namespace ${namespace}.`,
      {
        hint: "A collection created after the chain's base backup can only be read by restoring the incremental (e.g. into a scratch database with --rename).",
      },
    );
  }
  if (entry === undefined) {
    const available = manifest.namespaces
      .filter((candidate) => candidate.type !== "view")
      .map((candidate) => candidate.ns);
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Backup ${manifest.id} does not contain the namespace ${namespace}.`,
      {
        hint:
          available.length > 0
            ? `It holds: ${available.slice(0, 10).join(", ")}${available.length > 10 ? ", …" : ""}.`
            : "It holds no collections.",
      },
    );
  }
  if (entry.type === "view") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `${namespace} is a view in backup ${manifest.id}; views store no documents.`,
      { hint: "Search the collection the view reads from instead." },
    );
  }
  return entry;
}

/** `limit`: a whole number ≥ 0; 0 and undefined mean "no limit". */
function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || limit === 0) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `limit must be a whole number ≥ 0 (got ${limit}).`,
      { hint: "Pass e.g. limit: 10, or omit it to return every match." },
    );
  }
  return limit;
}
