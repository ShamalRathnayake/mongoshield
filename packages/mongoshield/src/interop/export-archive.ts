/**
 * Writing a backup as a mongodump archive, which `mongorestore --archive=<file>`
 * (plus `--gzip` when exported with gzip) restores:
 *
 *   events (prelude, then each namespace's documents and end) → createArchiveWriter
 *     → coalesce → (gzip, of the whole archive, like `mongodump --archive --gzip`) → file or stream
 *
 * Namespaces are written one after the other (`concurrent_collections: 1`), so the
 * archive has one block of documents per namespace; mongorestore restores them in
 * that order. The prelude carries every namespace's metadata up front, which is why
 * all metadata files are read before the first document.
 *
 * As in a mongodump archive, a time-series collection is announced under its own
 * name and its (computed) buckets are stored under `system.buckets.<name>`; users
 * and roles come before the collections as `admin.system.users` /
 * `admin.system.roles` and as `<db>.$admin.system.users` / `<db>.$admin.system.roles`,
 * each form with its auth schema version (see export-directory.ts for why both).
 */

import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createCompressor } from "../compression/index.ts";
import { createCoalescer } from "../engine/backup-coalesce.ts";
import type { StoredBackupSource } from "../engine/read-pipeline.ts";
import { MongoShieldError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import {
  ARCHIVE_FORMAT_VERSION,
  type ArchiveCollection,
  type ArchiveWriterInput,
} from "./archive-format.ts";
import { createArchiveWriter } from "./archive-writer.ts";
import {
  AUTH_SCHEMA_DOCUMENT,
  assertDocumentCount,
  authzDatabase,
  documentsOf,
  dumpDataCollection,
  type ExportedAuthz,
  type ExportedNamespace,
  type ExportNamespace,
} from "./export-data.ts";
import { BucketPacker, timeSeriesSettings } from "./timeseries-buckets.ts";

/**
 * Used as the archive's server version when the backup's is unknown: mongorestore
 * requires a parseable `major.minor.patch` (it fails on anything else).
 */
const UNKNOWN_SERVER_VERSION = "0.0.0";

/** What the archive writer needs. */
export interface ArchiveExportTarget {
  readonly source: StoredBackupSource;
  /** Users and roles to write (both empty for none). */
  readonly authz: ExportedAuthz;
  /** A file path (must not exist yet) or a stream such as stdout. */
  readonly output: string | Writable;
  readonly gzip: boolean;
  readonly serverVersion: string | undefined;
  readonly toolVersion: string;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

/**
 * Writes `namespaces` as one archive. A partially written archive file is removed
 * on failure (best effort).
 *
 * @throws MS_CONFIG_INVALID when the output file exists; read errors from the backup.
 */
export async function exportArchive(
  target: ArchiveExportTarget,
  namespaces: readonly ExportNamespace[],
): Promise<ExportedNamespace[]> {
  const results: ExportedNamespace[] = [];
  const output = await openOutput(target.output);
  const compress = target.gzip ? [createCompressor("gzip")] : [];
  try {
    await pipeline(
      [
        Readable.from(archiveEvents(target, namespaces, results), { objectMode: true }),
        createArchiveWriter(),
        // The writer emits one small Buffer per document; batch them for gzip and the file.
        createCoalescer(),
        ...compress,
        output,
      ],
      { signal: target.signal },
    );
    return results;
  } catch (error) {
    if (typeof target.output === "string") {
      await rm(target.output, { force: true }).catch((removeError: unknown) => {
        target.logger.warn("Could not remove the partial archive", {
          path: target.output,
          error: String(removeError),
        });
      });
    }
    throw error;
  }
}

/** The writer's input: the prelude, then each namespace's block, counted on the way. */
async function* archiveEvents(
  target: ArchiveExportTarget,
  namespaces: readonly ExportNamespace[],
  results: ExportedNamespace[],
): AsyncGenerator<ArchiveWriterInput> {
  const authzBlocks = usersAndRolesBlocks(target.authz);
  yield {
    kind: "prelude",
    header: {
      concurrentCollections: 1,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      serverVersion: target.serverVersion ?? UNKNOWN_SERVER_VERSION,
      toolVersion: target.toolVersion,
    },
    collections: [
      // mongodump announces these without metadata or type.
      ...authzBlocks.map(({ db, collection }) => ({
        db,
        collection,
        metadata: "",
        size: 0,
        type: "",
      })),
      ...namespaces.map(preludeEntry),
    ],
  };

  // Users, roles and the auth version come first, as mongodump writes them:
  // mongorestore reads them before it restores any collection.
  for (const block of authzBlocks) {
    const { db, collection } = block;
    yield { kind: "namespaceStart", db, collection };
    for (const document of block.documents) yield { kind: "document", db, collection, document };
    yield { kind: "namespaceEnd", db, collection };
  }

  for (const namespace of namespaces) {
    const { entry } = namespace;
    const { db } = entry;
    const collection = dumpDataCollection(entry);
    const packer =
      entry.type === "timeseries"
        ? new BucketPacker(timeSeriesSettings(namespace.metadata, entry.ns), entry.ns)
        : undefined;
    yield { kind: "namespaceStart", db, collection };
    let documents = 0;
    let bytes = 0;
    for await (const document of documentsOf(target.source, entry, target.signal)) {
      documents += 1;
      // Time-series measurements become buckets; the packer returns each one when full.
      const written = packer === undefined ? document : packer.add(document);
      if (written === undefined) continue;
      bytes += written.length;
      yield { kind: "document", db, collection, document: written };
    }
    const last = packer?.finish();
    if (last !== undefined) {
      bytes += last.length;
      yield { kind: "document", db, collection, document: last };
    }
    assertDocumentCount(entry, documents);
    yield { kind: "namespaceEnd", db, collection };
    results.push({ ns: entry.ns, type: entry.type, documents, bytes });
    target.logger.info("Exported namespace", { ns: entry.ns, documents });
  }
}

/** One users, roles or auth version namespace of the archive. */
interface AuthzBlock {
  readonly db: string;
  readonly collection: string;
  readonly documents: readonly Buffer[];
}

/** Users and roles in both of mongodump's forms, with their auth schema version. */
function usersAndRolesBlocks(authz: ExportedAuthz): AuthzBlock[] {
  const { users, roles } = authz;
  if (users.length + roles.length === 0) return [];
  const blocks: AuthzBlock[] = [
    { db: "admin", collection: "system.users", documents: users },
    { db: "admin", collection: "system.roles", documents: roles },
    { db: "admin", collection: "system.version", documents: [AUTH_SCHEMA_DOCUMENT] },
  ];
  const databases = [...new Set([...users, ...roles].map(authzDatabase))].sort();
  for (const db of databases) {
    // mongorestore refuses --restoreDbUsersAndRoles for admin, whose users the full form holds.
    if (db === "admin" || db === "") continue;
    blocks.push(
      {
        db,
        collection: "$admin.system.users",
        documents: users.filter((user) => authzDatabase(user) === db),
      },
      {
        db,
        collection: "$admin.system.roles",
        documents: roles.filter((role) => authzDatabase(role) === db),
      },
      { db, collection: "$admin.system.version", documents: [AUTH_SCHEMA_DOCUMENT] },
    );
  }
  return blocks;
}

/** A prelude entry as mongodump writes it (`size` is always 0 there). */
function preludeEntry(namespace: ExportNamespace): ArchiveCollection {
  return {
    db: namespace.entry.db,
    collection: namespace.entry.collection,
    metadata: namespace.metadataJson,
    size: 0,
    type: namespace.metadata.type,
  };
}

/** Opens the output; a path must not exist yet, so an export never overwrites a file. */
async function openOutput(output: string | Writable): Promise<Writable> {
  if (typeof output !== "string") return output;
  const existing = await stat(output).catch(() => undefined);
  if (existing !== undefined) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `${output} already exists.`, {
      hint: "Choose a new file name, or delete the old archive first.",
    });
  }
  return createWriteStream(output, { flags: "wx" });
}
