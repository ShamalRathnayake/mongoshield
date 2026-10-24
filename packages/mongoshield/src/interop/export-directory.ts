/**
 * Writing a backup as a mongodump output directory, which `mongorestore --dir <dir>`
 * (plus `--gzip` when exported with gzip) restores:
 *
 *   <dir>/prelude.json[.gz]                  {"ServerVersion":…,"ToolVersion":…}
 *   <dir>/<db>/<stem>.metadata.json[.gz]     the metadata, as mongodump writes it
 *   <dir>/<db>/<stem>.bson[.gz]              every document, parts joined (not for views)
 *   <dir>/<db>/system.buckets.<stem>.bson    time-series collections: computed buckets
 *   <dir>/admin/system.{users,roles,version}.bson      users and roles, for a full restore
 *   <dir>/<db>/$admin.system.{users,roles,version}.bson  the same per database, for
 *                                                      --db <db> --restoreDbUsersAndRoles
 *
 * Names follow mongodump exactly (`dump-names.ts`), so the directory is
 * indistinguishable from one mongodump would write. Files are created with the
 * `wx` flag: an export never overwrites anything, and two collections whose file
 * names collide (`Users` / `users` on a case-insensitive filesystem) fail loudly
 * instead of one silently replacing the other.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createCompressor } from "../compression/index.ts";
import { createCoalescer } from "../engine/backup-coalesce.ts";
import { mapWithConcurrency } from "../engine/pool.ts";
import type { StoredBackupSource } from "../engine/read-pipeline.ts";
import { MongoShieldError } from "../errors.ts";
import { createCountingStream } from "../format/hashing.ts";
import type { Logger } from "../logger.ts";
import { collectionFileStem } from "./dump-names.ts";
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
import { createBucketPacker, timeSeriesSettings } from "./timeseries-buckets.ts";

/** What the directory writer needs. */
export interface DirectoryExportTarget {
  readonly source: StoredBackupSource;
  /** Users and roles to write (both empty for none). */
  readonly authz: ExportedAuthz;
  /** The output directory; it must be missing or empty. */
  readonly directory: string;
  readonly gzip: boolean;
  /** For `prelude.json`; omitted when unknown. */
  readonly serverVersion: string | undefined;
  readonly toolVersion: string;
  readonly parallelism: number;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

/**
 * Writes `namespaces` as a mongodump directory. On failure, removes the files it
 * created (best effort) before rethrowing.
 *
 * @throws MS_CONFIG_INVALID when the directory is not empty; read errors from the backup.
 */
export async function exportDirectory(
  target: DirectoryExportTarget,
  namespaces: readonly ExportNamespace[],
): Promise<ExportedNamespace[]> {
  await prepareDirectory(target.directory);
  const created: string[] = [];
  try {
    if (target.serverVersion !== undefined) {
      await writePrelude(target, created);
    }
    const exported = await mapWithConcurrency(
      namespaces,
      (namespace, _index, signal) => exportNamespace({ ...target, signal }, namespace, created),
      { concurrency: target.parallelism, signal: target.signal },
    );
    await writeUsersAndRoles(target, created);
    return exported;
  } catch (error) {
    await removeCreated(created, target.logger);
    throw error;
  }
}

/** Writes one namespace's metadata and data files. */
async function exportNamespace(
  target: DirectoryExportTarget,
  namespace: ExportNamespace,
  created: string[],
): Promise<ExportedNamespace> {
  const { entry } = namespace;
  assertSafeDatabaseName(entry.db);
  const databaseDirectory = join(target.directory, entry.db);
  await mkdir(databaseDirectory, { recursive: true });
  const stem = collectionFileStem(entry.collection);
  const extension = target.gzip ? ".gz" : "";

  const metadataPath = join(databaseDirectory, `${stem}.metadata.json${extension}`);
  await writeFile(
    metadataPath,
    Readable.from([Buffer.from(namespace.metadataJson, "utf8")]),
    [],
    target,
    created,
  );

  if (entry.type === "view") {
    return { ns: entry.ns, type: entry.type, documents: 0, bytes: 0 };
  }
  // Counted before packing: the manifest counts measurements, not buckets.
  const counter = createCountingStream();
  const written = createCountingStream();
  const packing =
    entry.type === "timeseries"
      ? [createBucketPacker(timeSeriesSettings(namespace.metadata, entry.ns), entry.ns)]
      : [];
  const dataPath = join(
    databaseDirectory,
    `${collectionFileStem(dumpDataCollection(entry))}.bson${extension}`,
  );
  await writeFile(
    dataPath,
    Readable.from(documentsOf(target.source, entry, target.signal)),
    [counter.stream, ...packing, written.stream, createCoalescer()],
    target,
    created,
  );
  const counts = counter.counts();
  assertDocumentCount(entry, counts.items);
  target.logger.info("Exported namespace", {
    ns: entry.ns,
    documents: counts.items,
    path: dataPath,
  });
  return { ns: entry.ns, type: entry.type, documents: counts.items, bytes: written.counts().bytes };
}

/**
 * Users and roles in both of mongodump's forms (see the file header), each with the
 * auth schema version mongorestore checks before restoring them. Nothing is written
 * when there are none.
 */
async function writeUsersAndRoles(target: DirectoryExportTarget, created: string[]): Promise<void> {
  const { users, roles } = target.authz;
  if (users.length + roles.length === 0) return;
  const files: {
    db: string;
    prefix: string;
    users: readonly Buffer[];
    roles: readonly Buffer[];
  }[] = [{ db: "admin", prefix: "", users, roles }];
  const databases = [...new Set([...users, ...roles].map(authzDatabase))].sort();
  for (const db of databases) {
    // mongorestore refuses --restoreDbUsersAndRoles for admin, whose users the full form holds.
    if (db === "admin" || db === "") continue;
    files.push({
      db,
      prefix: "$admin.",
      users: users.filter((user) => authzDatabase(user) === db),
      roles: roles.filter((role) => authzDatabase(role) === db),
    });
  }

  const extension = target.gzip ? ".gz" : "";
  for (const file of files) {
    assertSafeDatabaseName(file.db);
    const directory = join(target.directory, file.db);
    await mkdir(directory, { recursive: true });
    const contents = [
      ["system.users", file.users],
      ["system.roles", file.roles],
      ["system.version", [AUTH_SCHEMA_DOCUMENT]],
    ] as const;
    for (const [collection, documents] of contents) {
      const path = join(directory, `${file.prefix}${collection}.bson${extension}`);
      await writeFile(path, Readable.from(documents), [createCoalescer()], target, created);
    }
  }
  target.logger.info("Exported users and roles", { users: users.length, roles: roles.length });
}

/** `prelude.json`: mongorestore reads `ServerVersion` from it (mongodump 100.12+ writes it). */
async function writePrelude(target: DirectoryExportTarget, created: string[]): Promise<void> {
  // Field order of mongodump's Go `PreludeData` struct.
  const json = JSON.stringify({
    ServerVersion: target.serverVersion,
    ToolVersion: target.toolVersion,
  });
  const path = join(target.directory, `prelude.json${target.gzip ? ".gz" : ""}`);
  await writeFile(path, Readable.from([Buffer.from(json, "utf8")]), [], target, created);
}

/** Streams `source → transforms → (gzip) → new file`. */
async function writeFile(
  path: string,
  source: Readable,
  transforms: readonly Transform[],
  target: Pick<DirectoryExportTarget, "gzip" | "signal">,
  created: string[],
): Promise<void> {
  const compress = target.gzip ? [createCompressor("gzip")] : [];
  created.push(path);
  try {
    await pipeline([source, ...transforms, ...compress, createWriteStream(path, { flags: "wx" })], {
      signal: target.signal,
    });
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "EEXIST") {
      // Not ours: never delete a file this export did not create.
      created.splice(created.indexOf(path), 1);
      throw new MongoShieldError("MS_CONFIG_INVALID", `${path} already exists.`, {
        cause: error,
        hint: "Two collections map to the same file name (they differ only in case on a case-insensitive filesystem). Export them separately with --include.",
      });
    }
    throw error;
  }
}

/** The output directory must be new or empty, so an export never mixes with other files. */
async function prepareDirectory(directory: string): Promise<void> {
  const existing = await readdir(directory).catch((error: unknown) => {
    if (Reflect.get(Object(error), "code") === "ENOENT") return [];
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Cannot use ${directory} as the output directory.`,
      {
        cause: error,
        hint: "Pass a new or empty directory.",
      },
    );
  });
  if (existing.length > 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The output directory ${directory} is not empty.`,
      {
        hint: "Pass a new or empty directory, so the export does not mix with other files.",
      },
    );
  }
  await mkdir(directory, { recursive: true });
}

/**
 * Database names become directory names as they are (mongodump does the same).
 * MongoDB forbids `/`, `\` and `.` in them; a manifest that contains one anyway
 * must never make the export write outside the output directory.
 */
function assertSafeDatabaseName(db: string): void {
  if (/[/\\\0]/.test(db) || db === "." || db === "..") {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `The backup names a database "${db}", which is not a valid MongoDB database name.`,
      { hint: "The manifest was modified. Export from another backup." },
    );
  }
}

/** Removes the files of a failed export. Best effort: problems are only logged. */
async function removeCreated(paths: readonly string[], logger: Logger): Promise<void> {
  for (const path of paths) {
    await rm(path, { force: true }).catch((error: unknown) => {
      logger.warn("Could not remove a file of the failed export", { path, error: String(error) });
    });
  }
}
