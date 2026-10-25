/**
 * `exportBackup()`: turns a MongoShield backup into mongodump output that the
 * official `mongorestore` restores, for teams that keep mongorestore in their
 * runbooks or need to hand data to a system that only speaks mongodump.
 *
 *   select backup → unlock keys (openBackupSource) → choose namespaces
 *     → read every metadata file → write a dump directory or an archive
 *
 *   format "directory":  mongorestore [--gzip] --dir <output>
 *   format "archive":    mongorestore [--gzip] --archive=<output>
 *
 * Every file is checked against the manifest's size and SHA-256 while it is read,
 * and every namespace's document count against the manifest, so the export is
 * exactly the backup. Two things are written in mongodump's own form rather than
 * MongoShield's:
 *
 * - time-series collections: the backup holds measurements, mongorestore wants the
 *   internal bucket documents, which the export computes (timeseries-buckets.ts);
 * - users and roles: written both as `admin/system.users.bson` (restored by a full
 *   `mongorestore`) and as `<db>/$admin.system.users.bson` (restored by
 *   `mongorestore --db <db> --restoreDbUsersAndRoles`), with the auth schema version
 *   mongorestore checks first.
 */

import type { Writable } from "node:stream";
import { listBackups, selectBackup } from "../catalog/index.ts";
import { mapWithConcurrency } from "../engine/pool.ts";
import { openBackupSource } from "../engine/read-pipeline.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { Manifest } from "../format/manifest.ts";
import { type Logger, silentLogger } from "../logger.ts";
import { compileNamespaceFilter } from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { BackupSelector, DecryptionOptions, NamespacePattern } from "../types.ts";
import { version } from "../version.ts";
import { exportArchive } from "./export-archive.ts";
import {
  assertSomethingSelected,
  dumpServerVersion,
  type ExportedNamespace,
  type ExportNamespace,
  loadExportNamespace,
  loadUsersAndRoles,
  selectExportNamespaces,
} from "./export-data.ts";
import { exportDirectory } from "./export-directory.ts";
import type { SkippedNamespace } from "./import-target.ts";

/** Namespaces exported at the same time to a directory, by default. */
export const DEFAULT_EXPORT_PARALLELISM = 4;

/** Metadata files read at the same time before the export starts. */
const METADATA_READ_CONCURRENCY = 8;

/** Options for `exportBackup()`. */
export interface ExportOptions {
  /** `directory` (like `mongodump --out`) or `archive` (like `mongodump --archive`). */
  readonly format: "directory" | "archive";
  /**
   * Directory format: a new or empty directory. Archive format: a new file, or a
   * writable stream (e.g. stdout, to pipe into `mongorestore --archive`).
   */
  readonly output: string | Writable;
  /** gzip every file (directory) or the whole archive, like `mongodump --gzip`. */
  readonly gzip?: boolean;
  /** Keys for encrypted backups. */
  readonly decryption?: DecryptionOptions;
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /** Namespaces written at the same time (directory format only). Defaults to 4. */
  readonly parallelism?: number;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

/** What `exportBackup()` wrote. */
export interface ExportSummary {
  readonly backupId: string;
  readonly format: "directory" | "archive";
  readonly gzip: boolean;
  /** The output path, or `"stream"` when writing to a stream. */
  readonly output: string;
  readonly namespaces: readonly ExportedNamespace[];
  /** Users and custom roles written (both 0 when the backup has none or none was selected). */
  readonly usersAndRoles: { readonly users: number; readonly roles: number };
  /**
   * Namespaces left out, with the reason. Nothing is left out any more (time-series
   * collections and users are exported since 2.0); kept so callers that read it work.
   */
  readonly skipped: readonly SkippedNamespace[];
  /** Totals over `namespaces`. */
  readonly documents: number;
  readonly bytes: number;
  readonly durationMs: number;
}

/**
 * Exports a backup as mongodump output.
 *
 * @throws MongoShieldError: `MS_BACKUP_NOT_FOUND` / `MS_MANIFEST_INVALID` for the selector,
 *   `MS_NO_IDENTITY` / `MS_DECRYPTION_FAILED` for keys, `MS_INTEGRITY_FAILED` for a damaged
 *   backup, `MS_CONFIG_INVALID` for bad options or an output that already exists,
 *   `MS_ABORTED` / `MS_TIMEOUT`.
 */
export async function exportBackup(
  storage: StorageAdapter,
  selector: BackupSelector,
  options: ExportOptions,
): Promise<ExportSummary> {
  const clock = performance.now();
  const logger = options.logger ?? silentLogger;
  const signal = options.signal ?? new AbortController().signal;
  const parallelism = validateExportOptions(options);
  const filter = compileNamespaceFilter({ include: options.include, exclude: options.exclude });

  const manifest = await loadManifest(storage, selector, logger, signal);
  const source = await openBackupSource(storage, manifest, options.decryption, { signal });
  const hasPatterns = (options.include?.length ?? 0) + (options.exclude?.length ?? 0) > 0;
  const selection = selectExportNamespaces(manifest, filter);
  logger.info("Exporting backup", {
    id: manifest.id,
    format: options.format,
    namespaces: selection.entries.length,
  });

  const namespaces: ExportNamespace[] = await mapWithConcurrency(
    selection.entries,
    (entry, _index, jobSignal) => loadExportNamespace(source, entry, jobSignal),
    { concurrency: METADATA_READ_CONCURRENCY, signal },
  );
  const authz = await loadUsersAndRoles(source, selection.authz, filter, signal);
  assertSomethingSelected(
    manifest,
    { namespaces: namespaces.length, usersAndRoles: authz.users.length + authz.roles.length },
    hasPatterns,
  );
  throwIfAborted(signal);

  const gzip = options.gzip ?? false;
  const common = {
    source,
    authz,
    gzip,
    serverVersion: dumpServerVersion(manifest),
    toolVersion: `mongoshield@${version}`,
    logger,
    signal,
  };
  const exported =
    options.format === "directory"
      ? await exportDirectory(
          { ...common, directory: outputPath(options.output), parallelism },
          namespaces,
        )
      : await exportArchive({ ...common, output: options.output }, namespaces);

  let documents = 0;
  let bytes = 0;
  for (const item of exported) {
    documents += item.documents;
    bytes += item.bytes;
  }
  return {
    backupId: manifest.id,
    format: options.format,
    gzip,
    output: typeof options.output === "string" ? options.output : "stream",
    namespaces: exported,
    usersAndRoles: { users: authz.users.length, roles: authz.roles.length },
    skipped: selection.skipped,
    documents,
    bytes,
    durationMs: Math.round(performance.now() - clock),
  };
}

function validateExportOptions(options: ExportOptions): number {
  if (options.format !== "directory" && options.format !== "archive") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `format must be "directory" or "archive", got "${String(options.format)}".`,
    );
  }
  const parallelism = options.parallelism ?? DEFAULT_EXPORT_PARALLELISM;
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `parallelism must be a whole number of at least 1, got ${String(parallelism)}.`,
    );
  }
  if (options.format === "directory" && typeof options.output !== "string") {
    throw new MongoShieldError("MS_CONFIG_INVALID", "A directory export needs an output path.", {
      hint: 'Pass a directory path, or use format "archive" to write to a stream.',
    });
  }
  if (typeof options.output === "string" && options.output === "") {
    throw new MongoShieldError("MS_CONFIG_INVALID", "The output path is empty.");
  }
  return parallelism;
}

/** Narrows the output of a directory export (checked in `validateExportOptions`). */
function outputPath(output: string | Writable): string {
  if (typeof output === "string") return output;
  throw new MongoShieldError("MS_INTERNAL", "A directory export needs an output path.");
}

/** Resolves the selector to one complete backup's manifest. */
async function loadManifest(
  storage: StorageAdapter,
  selector: BackupSelector,
  logger: Logger,
  signal: AbortSignal,
): Promise<Manifest> {
  const entries = await listBackups(storage, { logger, signal });
  const selected = selectBackup(entries, selector);
  if (selected.manifest === undefined) {
    // selectBackup only returns complete entries, which always carry a manifest.
    throw new MongoShieldError("MS_INTERNAL", `Backup ${selected.id} has no manifest.`);
  }
  // An incremental holds change events, which mongodump's layout has no place for:
  // exporting it would produce an empty dump that looks like a complete one.
  const chain = selected.manifest.chain;
  if (chain !== undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Backup ${selected.id} is an incremental backup: it holds only the changes since ${chain.parent}, which a mongodump export cannot represent.`,
      {
        hint: `Export its full backup ${chain.base} (the data as of that backup), or restore the incremental into a scratch deployment and run mongodump there.`,
      },
    );
  }
  return selected.manifest;
}
