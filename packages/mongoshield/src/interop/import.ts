/**
 * `importMongodump()`: turns existing mongodump output into a proper MongoShield
 * backup (manifest, checksums, compression, optional encryption), so that
 * `restore`, `verify`, `list` and retention work on it like on any other backup.
 *
 *   { directory }        mongodump --out <dir> [--gzip]          → import-directory.ts
 *   { archive, gzip? }   mongodump --archive[=<file>] [--gzip]   → import-archive.ts
 *
 *   validate options → open the dump → new backup id → (key envelope) → write files
 *     → write manifest LAST (the commit marker)
 *
 * Exactly as with `runBackup`, nothing counts as a backup until the manifest is
 * written, and a failed or aborted import deletes the files it wrote. Documents are
 * copied byte for byte (never parsed), so the backup restores exactly what
 * mongodump dumped. Two things are converted into what a native backup holds
 * (see import-rules.ts):
 *
 * - time-series bucket documents become plain measurements (timeseries-buckets.ts);
 * - users and roles (`admin.system.users`, `$admin.system.users`, …) become the
 *   backup's users and roles entries (import-authz.ts).
 *
 * - the oplog of a `mongodump --oplog` dump becomes the change events of a
 *   `converge` backup (import-oplog.ts), so restore replays them to the end of the
 *   dump like `mongorestore --oplogReplay`; without an oplog the consistency is
 *   `none`, the same guarantee as mongodump without --oplog.
 *
 * Not imported (reported in `skipped`): system collections other than `system.js`,
 * and the auth schema version.
 */

import type { Readable } from "node:stream";
import { defaultCompression, isZstdAvailable } from "../compression/index.ts";
import { prepareFileEncryption } from "../engine/backup-key.ts";
import { planEncryption } from "../engine/backup-options.ts";
import { ProgressTracker } from "../engine/progress.ts";
import { abortError, isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { newBackupId } from "../format/layout.ts";
import type { Compression } from "../format/manifest.ts";
import { writeManifest } from "../format/manifest-io.ts";
import { type Logger, silentLogger } from "../logger.ts";
import { compileNamespaceFilter } from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type {
  CompletedBackupResult,
  EncryptionOptions,
  NamespacePattern,
  ProgressEvent,
} from "../types.ts";
import { scanDumpDirectory } from "./dump-directory.ts";
import { importArchive, openArchive } from "./import-archive.ts";
import { importDumpDirectory } from "./import-directory.ts";
import {
  buildImportManifest,
  deletePartialImport,
  type ImportTarget,
  type SkippedNamespace,
} from "./import-target.ts";

/** Namespaces imported at the same time from a dump directory, by default. */
export const DEFAULT_IMPORT_PARALLELISM = 4;

/** Where the mongodump output is. */
export type MongodumpSource =
  | {
      /** The directory given to `mongodump --out` (or one database directory inside it). */
      readonly directory: string;
      /** Database name when `directory` is a single database's directory. Defaults to its name. */
      readonly database?: string;
    }
  | {
      /** The file given to `mongodump --archive=<file>`, or a stream of one (e.g. stdin). */
      readonly archive: string | Readable;
      /** `true` for `--gzip` archives. Detected from the first bytes when omitted. */
      readonly gzip?: boolean;
    };

/** Options for `importMongodump()`. */
export interface ImportMongodumpOptions {
  /** Compression of the new backup's data files. Defaults to zstd (gzip on old Node.js). */
  readonly compression?: Compression;
  /** Encrypt the new backup, exactly like `backup` does. Omit for an unencrypted backup. */
  readonly encryption?: EncryptionOptions;
  /** Labels for the backup. `imported-from: mongodump` is always added. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Only these namespaces, e.g. `app.*`. Defaults to everything in the dump. */
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /**
   * When the dump was taken; becomes the backup's start/completion time (and its id),
   * which retention and `{ before: date }` restores rely on. Defaults to the newest
   * file time of the dump (directories, archive files) or now (streams).
   */
  readonly dumpedAt?: Date;
  /** Collections imported at the same time from a directory. Defaults to 4. */
  readonly parallelism?: number;
  /**
   * Leave out the oplog of a `mongodump --oplog` dump. By default it is converted into
   * the backup's change events, which restore replays to reach the state at the end of
   * the dump (consistency `converge`); some oplogs cannot be replayed (an update of a
   * field whose name contains a dot, for example), and importing fails with a message
   * that suggests this option. Without the oplog, the consistency is `none`.
   */
  readonly ignoreOplog?: boolean;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
}

/** What `importMongodump()` returns: the new backup, plus what was left out. */
export interface ImportResult extends CompletedBackupResult {
  /** Namespaces and files not imported, each with the reason. */
  readonly skipped: readonly SkippedNamespace[];
}

/** The label every imported backup carries, so it can be told apart from native ones. */
export const IMPORTED_FROM_LABEL = "imported-from";

/**
 * Imports a mongodump directory or archive into `storage` as a new backup.
 *
 * @throws MongoShieldError: `MS_CONFIG_INVALID` for bad options, an unreadable path or a
 *   filter that matches nothing; `MS_INTEGRITY_FAILED` / `MS_FORMAT_UNSUPPORTED` for a
 *   damaged or foreign dump; `MS_STORAGE_*`; `MS_ABORTED` / `MS_TIMEOUT`.
 */
export async function importMongodump(
  source: MongodumpSource,
  storage: StorageAdapter,
  options: ImportMongodumpOptions = {},
): Promise<ImportResult> {
  const clock = performance.now();
  const logger = options.logger ?? silentLogger;
  const signal = options.signal ?? new AbortController().signal;
  const compression = options.compression ?? defaultCompression();
  const parallelism = validateImportOptions(options, compression);
  const filter = compileNamespaceFilter({ include: options.include, exclude: options.exclude });
  const encryptionPlan = planEncryption(options.encryption);
  throwIfAborted(signal);

  // Open the dump first: a wrong path should fail before anything is written.
  const opened =
    "directory" in source
      ? {
          kind: "directory" as const,
          scan: await scanDumpDirectory(source.directory, { database: source.database }),
        }
      : { kind: "archive" as const, archive: await openArchive(source) };
  const dumpedAt =
    options.dumpedAt ??
    (opened.kind === "directory" ? opened.scan.newestFileTime : opened.archive.dumpedAt) ??
    new Date();

  const backupId = newBackupId(dumpedAt);
  const writtenKeys = new Set<string>();
  let manifestAttempted = false;
  logger.info("Importing mongodump output", { id: backupId, kind: opened.kind, compression });
  try {
    const encryption =
      encryptionPlan === undefined
        ? undefined
        : await prepareFileEncryption(encryptionPlan, { storage, backupId, writtenKeys, signal });
    const target: ImportTarget = {
      storage,
      logger,
      backupId,
      compression,
      encryption,
      progress: new ProgressTracker({ onProgress: options.onProgress, logger }),
      writtenKeys,
    };

    const ignoreOplog = options.ignoreOplog ?? false;
    const outcome =
      opened.kind === "directory"
        ? {
            ...(await importDumpDirectory(opened.scan, target, filter, {
              parallelism,
              ignoreOplog,
              signal,
            })),
            serverVersion: opened.scan.serverVersion,
            toolVersion: opened.scan.toolVersion,
          }
        : await importArchive(opened.archive, target, filter, { ignoreOplog, signal });
    throwIfAborted(signal);
    assertSomethingImported(
      outcome.entries.length + outcome.authzEntries.length,
      outcome.skipped,
      options,
    );

    const manifest = buildImportManifest({
      backupId,
      dumpedAt,
      serverVersion: outcome.serverVersion,
      compression,
      encryption,
      labels: importLabels(options.labels, outcome.toolVersion),
      entries: outcome.entries,
      authzEntries: outcome.authzEntries,
      window: outcome.window,
    });
    manifestAttempted = true;
    await writeManifest(storage, manifest, { signal });
    target.progress.finish();

    const durationMs = Math.round(performance.now() - clock);
    logger.info("Import complete", {
      id: backupId,
      namespaces: manifest.totals.namespaces,
      documents: manifest.totals.documents,
      skipped: outcome.skipped.length,
      durationMs,
    });
    return { status: "complete", id: backupId, manifest, durationMs, skipped: outcome.skipped };
  } catch (error) {
    const failure = signal.aborted ? abortError(signal) : asTypedError(error);
    logger.error("Import failed", { id: backupId, code: failure.code, error: failure.message });
    await deletePartialImport({ storage, logger, backupId, writtenKeys }, manifestAttempted);
    throw failure;
  }
}

/**
 * Checks what can be checked before reading the dump.
 *
 * @returns the effective parallelism.
 */
function validateImportOptions(options: ImportMongodumpOptions, compression: Compression): number {
  const parallelism = options.parallelism ?? DEFAULT_IMPORT_PARALLELISM;
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `parallelism must be a whole number of at least 1, got ${String(parallelism)}.`,
      { hint: `Omit it to use the default (${DEFAULT_IMPORT_PARALLELISM}).` },
    );
  }
  if (compression === "zstd" && !isZstdAvailable()) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `zstd compression is not available in Node.js ${process.version}.`,
      { hint: "Upgrade to Node.js 22.15+ or 23.8+, or use gzip compression." },
    );
  }
  if (options.dumpedAt !== undefined && Number.isNaN(options.dumpedAt.getTime())) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "dumpedAt is not a valid date.");
  }
  return parallelism;
}

/**
 * An import that selects nothing is almost certainly a mistake (a typo in a
 * pattern, the wrong directory); refusing beats committing an empty backup.
 */
function assertSomethingImported(
  imported: number,
  skipped: readonly SkippedNamespace[],
  options: ImportMongodumpOptions,
): void {
  if (imported > 0) return;
  const hasPatterns = (options.include?.length ?? 0) + (options.exclude?.length ?? 0) > 0;
  const skippedList = skipped
    .slice(0, 10)
    .map((item) => `${item.ns} (${item.reason})`)
    .join("; ");
  throw new MongoShieldError("MS_CONFIG_INVALID", "The dump contains nothing to import.", {
    hint: hasPatterns
      ? "No namespace matches the include/exclude patterns. Check them against the dump's contents."
      : skippedList === ""
        ? "The dump is empty."
        : `Everything was skipped: ${skippedList}.`,
  });
}

/** The user's labels plus where the backup came from. User labels win on conflict. */
function importLabels(
  labels: Readonly<Record<string, string>> | undefined,
  toolVersion: string | undefined,
): Record<string, string> {
  return {
    [IMPORTED_FROM_LABEL]: toolVersion === undefined ? "mongodump" : `mongodump@${toolVersion}`,
    ...labels,
  };
}

/** Anything thrown becomes a MongoShieldError (unexpected errors as MS_INTERNAL). */
function asTypedError(error: unknown): MongoShieldError {
  if (isMongoShieldError(error)) return error;
  const code = Reflect.get(Object(error), "code");
  if (code === "ENOENT" || code === "EACCES" || code === "EISDIR") {
    return new MongoShieldError("MS_CONFIG_INVALID", `Cannot read the dump: ${String(error)}`, {
      cause: error,
      hint: "Check that the dump files exist and are readable.",
    });
  }
  return new MongoShieldError("MS_INTERNAL", `The import failed: ${String(error)}`, {
    cause: error,
  });
}
