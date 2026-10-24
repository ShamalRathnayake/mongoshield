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
 * query language; see filter.ts for the list. Converge backups are read as dumped:
 * the changes recorded during the backup window (which a full restore replays) are
 * not applied, so a document changed during that window may show an older version.
 */

import { BSON, type Document } from "mongodb";
import { listBackups, selectBackup } from "../catalog/index.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "../format/bson-stream.ts";
import type { Manifest, NamespaceEntry } from "../format/manifest.ts";
import type { BackupSelector, DecryptionOptions } from "../types.ts";
import type { EngineContext } from "./context.ts";
import { compileFilter, type DocumentMatcher } from "./filter.ts";
import { compileProjection } from "./find-projection.ts";
import { openBackupSource, openDocumentStream, type StoredBackupSource } from "./read-pipeline.ts";

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
}

/** A namespace of a selected backup, opened for reading. */
export interface OpenedNamespace {
  readonly manifest: Manifest;
  readonly entry: NamespaceEntry;
  readonly source: StoredBackupSource;
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
    for await (const match of matchingDocuments(opened, matcher, options.signal)) {
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
  const manifest = selected.manifest;
  if (manifest === undefined) {
    // selectBackup only returns complete entries, which always carry a manifest.
    throw new MongoShieldError("MS_INTERNAL", `Backup ${selected.id} has no manifest.`);
  }

  const entry = namespaceEntry(manifest, options.namespace);
  if (manifest.changes !== undefined) {
    context.logger.warn(
      "This backup recorded changes made while it ran; find reads the documents as dumped, without replaying them",
      { backupId: manifest.id },
    );
  }
  const source = await openBackupSource(context.storage, manifest, options.decryption, {
    signal: options.signal,
  });
  return { manifest, entry, source };
}

/**
 * Yields every document of an opened namespace that matches, part after part.
 * Stopping the iteration early closes the open data file.
 */
export async function* matchingDocuments(
  opened: OpenedNamespace,
  matcher: DocumentMatcher,
  signal: AbortSignal | undefined,
): AsyncGenerator<MatchedDocument> {
  for (const file of opened.entry.files) {
    for await (const raw of openDocumentStream(opened.source, file, { signal })) {
      throwIfAborted(signal);
      const bytes = raw as Buffer;
      const document = parseDocument(bytes);
      if (matcher(document)) yield { document, bytes: bytes.length };
    }
  }
}

/** The manifest entry of `namespace`, or an error saying what the backup holds instead. */
function namespaceEntry(manifest: Manifest, namespace: string): NamespaceEntry {
  const entry = manifest.namespaces.find((candidate) => candidate.ns === namespace);
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

/** Parses one backed-up document losslessly. A document that does not parse means a damaged file. */
function parseDocument(raw: Buffer): Document {
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
