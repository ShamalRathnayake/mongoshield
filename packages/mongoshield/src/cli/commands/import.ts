/**
 * `mongoshield import`: turn mongodump output into a MongoShield backup.
 *
 *   mongoshield import ./dump --to s3://acme-backups/prod            a `mongodump --out` directory
 *   mongoshield import ./prod.archive.gz --to ./backups               a `mongodump --archive --gzip` file
 *   mongodump --archive | mongoshield import - --archive --to …        an archive on stdin
 *
 * The result is a normal backup (manifest, checksums, compression, optional
 * encryption), so `verify`, `restore`, `list` and `prune` work on it. Time-series
 * buckets become measurements, users and roles the backup's users and roles
 * entries, and the oplog of `mongodump --oplog` change events that restore replays
 * (consistency `converge`; --ignore-oplog leaves it out). What is not imported
 * (system collections, the auth schema version) is listed with the reason, as warnings.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { MongoShieldConfig, MongoShieldConfigInput } from "../../config/schema.ts";
import { assertValidRecipient } from "../../crypto/index.ts";
import { MongoShieldError } from "../../errors.ts";
import {
  type ImportMongodumpOptions,
  type ImportResult,
  importMongodump,
  type MongodumpSource,
} from "../../interop/import.ts";
import type { EncryptionOptions } from "../../types.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { formatBytes, formatCount, formatDuration, plural } from "../format.ts";
import { ProgressDisplay } from "../progress.ts";
import { createCliLogger, createCliShield, readPassphraseEnv } from "../setup.ts";
import { renderDetails } from "../table.ts";
import {
  assertNotBoth,
  excludeOption,
  includeOption,
  listOrUndefined,
  parseKeyValues,
  passphraseEnvOption,
} from "./shared-options.ts";

const NAME = "import";

/** The positional that means "read the archive from standard input". */
const STDIN_PATH = "-";

export const importCommand: CommandSpec = {
  name: NAME,
  summary: "Import mongodump output as a backup",
  description: [
    "Reads a directory written by `mongodump --out` or a file written by",
    "`mongodump --archive` (gzipped or not) and stores it as a regular MongoShield",
    "backup: compressed, optionally encrypted, with a manifest and checksums.",
    "Documents are copied byte for byte. Time-series buckets are unpacked into",
    "measurements, users and roles become the backup's users and roles, and the oplog",
    "of `mongodump --oplog` is replayed on restore (up to the end of the dump).",
    "System collections are not imported; they are listed as warnings.",
  ].join("\n"),
  positionals: [
    {
      name: "path",
      description: 'The dump directory, the archive file, or "-" for an archive on stdin',
    },
  ],
  options: {
    to: {
      type: "string",
      valueName: "<storage-url>",
      description: "Where to store the backup: ./dir, file:///abs, s3://bucket/prefix",
    },
    archive: {
      type: "boolean",
      description: "The path is a mongodump archive (detected automatically for files)",
    },
    gzip: {
      type: "boolean",
      description: "The archive is gzipped (detected automatically when omitted)",
    },
    database: {
      type: "string",
      valueName: "<name>",
      description: "Database name when the path is one database's directory (default: its name)",
    },
    include: includeOption,
    exclude: excludeOption,
    compression: {
      type: "string",
      choices: ["zstd", "gzip", "none"],
      defaultText: "zstd",
      description: "Compression of the new backup",
    },
    recipient: {
      type: "string",
      multiple: true,
      valueName: "<age1…>",
      description: "Encrypt for this age public key (from `mongoshield keygen`)",
    },
    "passphrase-env": passphraseEnvOption,
    label: {
      type: "string",
      multiple: true,
      valueName: "<key=value>",
      description: "Attach a label to the backup, e.g. env=prod",
    },
    "dumped-at": {
      type: "string",
      valueName: "<date>",
      description: "When the dump was taken, e.g. 2026-01-31T02:00:00Z (default: the files' time)",
    },
    "ignore-oplog": {
      type: "boolean",
      description: "Leave out the oplog of a `mongodump --oplog` dump (consistency `none`)",
    },
  },
  examples: [
    {
      description: "Import a dump directory into local storage",
      command: "mongoshield import ./dump --to ./backups",
    },
    {
      description: "Import a gzipped archive into S3, encrypted",
      command: "mongoshield import ./prod.archive.gz --to s3://acme-backups/prod --recipient age1…",
    },
    {
      description: "Stream straight from mongodump",
      command: "mongodump --uri $URI --archive | mongoshield import - --archive --to ./backups",
    },
  ],
  run: runImportCommand,
};

async function runImportCommand(context: CommandContext): Promise<number> {
  const { out } = context;
  const source = await mongodumpSource(context);
  const { shield, config, storageLabel } = await createCliShield(context, importOverrides(context));
  try {
    out.info(`Importing ${describeSource(context)} → ${storageLabel}`);
    const progress = new ProgressDisplay(out, "Importing");
    let result: ImportResult;
    try {
      result = await importMongodump(
        source,
        shield.storage,
        importOptions(context, config, progress),
      );
    } finally {
      progress.stop();
    }
    printImportResult(context, result, storageLabel);
    return 0;
  } finally {
    await shield.close();
  }
}

/** Flags as a config layer: where to store, how to compress and encrypt. */
function importOverrides(context: CommandContext): MongoShieldConfigInput {
  const { flags } = context;
  assertNotBoth(context, NAME, "recipient", "passphrase-env");
  const recipients = listOrUndefined(context, "recipient");
  const passphraseVariable = flags.string("passphrase-env");
  const passphrase = passphraseVariable
    ? readPassphraseEnv(context, passphraseVariable)
    : undefined;
  return {
    storage: flags.string("to"),
    compression: compressionFlag(flags.string("compression")),
    encryption: recipients || passphrase ? { recipients, passphrase } : undefined,
  };
}

/** Works out what the path is: an archive (file or stdin) or a dump directory. */
async function mongodumpSource(context: CommandContext): Promise<MongodumpSource> {
  const path = context.positionals[0];
  if (path === undefined || path === "") {
    throw usageError("Which dump? Pass the mongodump directory or archive file.", NAME);
  }
  const gzip = context.flags.has("gzip") ? { gzip: context.flags.boolean("gzip") } : {};

  if (path === STDIN_PATH) {
    const stdin = context.io.stdin;
    if (stdin === undefined) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        "There is no standard input to read the archive from.",
      );
    }
    return { archive: stdin, ...gzip };
  }

  const absolute = isAbsolute(path) ? path : resolve(context.io.cwd, path);
  const info = await stat(absolute).catch((error: unknown) => {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Cannot read ${absolute}.`, {
      cause: error,
      hint: "Pass the directory given to `mongodump --out`, or the file given to `mongodump --archive=`.",
    });
  });
  if (context.flags.boolean("archive") || info.isFile()) return { archive: absolute, ...gzip };

  const database = context.flags.string("database");
  return { directory: absolute, ...(database === undefined ? {} : { database }) };
}

/** The per-run options, from flags and the merged config. */
function importOptions(
  context: CommandContext,
  config: MongoShieldConfig,
  progress: ProgressDisplay,
): ImportMongodumpOptions {
  const include = listOrUndefined(context, "include");
  const exclude = listOrUndefined(context, "exclude");
  const labels = parseKeyValues(context, NAME, "label");
  const encryption = encryptionFromConfig(config);
  const dumpedAt = dumpedAtFlag(context);
  return {
    logger: createCliLogger(context.out),
    signal: context.signal,
    onProgress: progress.onProgress,
    ...(config.compression ? { compression: config.compression } : {}),
    ...(encryption ? { encryption } : {}),
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
    ...(labels ? { labels } : {}),
    ...(dumpedAt ? { dumpedAt } : {}),
    ...(context.flags.boolean("ignore-oplog") ? { ignoreOplog: true } : {}),
  };
}

/** Encryption settings from the merged config, with recipients validated up front. */
function encryptionFromConfig(config: MongoShieldConfig): EncryptionOptions | undefined {
  const encryption = config.encryption;
  if (!encryption) return undefined;
  for (const recipient of encryption.recipients ?? []) assertValidRecipient(recipient);
  return {
    ...(encryption.recipients ? { recipients: encryption.recipients } : {}),
    ...(encryption.passphrase ? { passphrase: encryption.passphrase } : {}),
    ...(encryption.kms ? { kms: encryption.kms } : {}),
  };
}

function dumpedAtFlag(context: CommandContext): Date | undefined {
  const value = context.flags.string("dumped-at");
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw usageError(
      `--dumped-at expects a date such as 2026-01-31T02:00:00Z (got "${value}").`,
      NAME,
    );
  }
  return date;
}

function describeSource(context: CommandContext): string {
  const path = context.positionals[0] ?? "";
  return path === STDIN_PATH ? "archive from stdin" : path;
}

/** Prints the summary (just the id with --quiet, the result with --json) and the skipped list. */
function printImportResult(context: CommandContext, result: ImportResult, storage: string): void {
  const { out } = context;
  if (out.settings.json) {
    out.json(result);
    return;
  }
  for (const item of result.skipped) out.warn(`Not imported: ${item.ns}: ${item.reason}`);
  if (out.settings.quiet) {
    out.result(result.id);
    return;
  }

  const { manifest } = result;
  out.success("Import complete.");
  out.result(
    renderDetails(
      [
        ["Backup id", out.style("bold", result.id)],
        ["Storage", storage],
        ["Namespaces", formatCount(manifest.totals.namespaces)],
        ["Documents", formatCount(manifest.totals.documents)],
        [
          "Data",
          `${formatBytes(manifest.totals.bytesRaw)} raw → ${formatBytes(manifest.totals.bytesStored)} stored`,
        ],
        ["Dumped at", manifest.completedAt],
        ["Consistency", consistencyText(manifest)],
        ["Skipped", plural(result.skipped.length, "namespace")],
        ["Duration", formatDuration(result.durationMs)],
      ],
      (label) => out.style("dim", label),
    ),
  );
  out.info(out.style("dim", `Next: mongoshield verify ${result.id} --deep`));
}

/** "converge (oplog: 120 changes replayed on restore)" or "none". */
function consistencyText(manifest: ImportResult["manifest"]): string {
  if (manifest.consistency.mode !== "converge") return manifest.consistency.mode;
  return `converge (oplog: ${plural(manifest.changes?.events ?? 0, "change")} replayed on restore)`;
}

/** The parser already checked the value against `choices`; this narrows the type. */
function compressionFlag(value: string | undefined): "zstd" | "gzip" | "none" | undefined {
  return value === "zstd" || value === "gzip" || value === "none" ? value : undefined;
}
