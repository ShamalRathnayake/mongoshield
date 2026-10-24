/**
 * `mongoshield export`: write a backup as mongodump output, for `mongorestore`.
 *
 *   mongoshield export latest --output ./dump                     then: mongorestore --dir ./dump
 *   mongoshield export latest --format archive --output app.archive --gzip
 *                                                                 then: mongorestore --gzip --archive=app.archive
 *   mongoshield export latest --format archive --output - | mongorestore --archive
 *   mongoshield export --format jsonl --namespace app.users --output users.jsonl
 *   mongoshield export --format csv --namespace app.users --fields _id,name,address.city --output users.csv
 *
 * The text formats (JSON Lines, CSV) export one collection and are handled by
 * export-text.ts next to this file (engine: src/extras/export-text.ts).
 *
 * The backup is decrypted, decompressed and checked on the way; split parts are
 * joined. Time-series measurements are written as the bucket documents mongorestore
 * expects, and users and roles (backups taken with --users-and-roles) as mongodump
 * writes them, for `mongorestore` (full restore) and `mongorestore --db <db>
 * --restoreDbUsersAndRoles`.
 */

import { isAbsolute, resolve } from "node:path";
import type { MongoShieldConfigInput } from "../../config/schema.ts";
import { type ExportOptions, type ExportSummary, exportBackup } from "../../interop/export.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { formatBytes, formatCount, formatDuration, plural } from "../format.ts";
import {
  createCliLogger,
  createCliShield,
  decryptionFromConfig,
  readPassphraseEnv,
} from "../setup.ts";
import { renderDetails } from "../table.ts";
import { isTextFormat, runTextExport, TEXT_EXPORT_OPTIONS } from "./export-text.ts";
import {
  backupSelectorArgument,
  excludeOption,
  identityFileOption,
  includeOption,
  listOrUndefined,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "export";

/** The output that means "write the archive to standard output". */
const STDOUT_PATH = "-";

export const exportCommand: CommandSpec = {
  name: NAME,
  summary: "Export a backup as mongodump output for mongorestore",
  description: [
    "Writes a backup as a mongodump directory (restore with `mongorestore --dir`)",
    "or archive (restore with `mongorestore --archive`), decrypted and checked.",
    "With --gzip the files are gzipped like `mongodump --gzip` (then restore with",
    "`mongorestore --gzip`). Time-series collections become mongorestore's bucket",
    "documents; users and roles are written for `mongorestore --restoreDbUsersAndRoles`.",
  ].join("\n"),
  positionals: [
    { name: "backup", optional: true, description: 'Backup id, or "latest" (default)' },
  ],
  options: {
    format: {
      type: "string",
      choices: ["directory", "archive", "jsonl", "csv"],
      defaultText: "directory",
      description: "mongodump directory or archive, or one collection as JSON Lines or CSV",
    },
    output: {
      type: "string",
      valueName: "<path>",
      description: 'New directory or file; "-" writes an archive, JSONL or CSV to stdout',
    },
    ...TEXT_EXPORT_OPTIONS,
    gzip: { type: "boolean", description: "gzip the output, like mongodump --gzip" },
    from: storageFromOption,
    include: includeOption,
    exclude: excludeOption,
    "identity-file": identityFileOption,
    "passphrase-env": passphraseEnvOption,
  },
  examples: [
    {
      description: "Export the latest backup to a directory for mongorestore",
      command: "mongoshield export --output ./dump && mongorestore --dir ./dump",
    },
    {
      description: "Export one database of an encrypted backup as a gzipped archive",
      command:
        "mongoshield export latest --include 'app.*' --format archive --gzip --output app.archive.gz --identity-file ~/keys/backup.key",
    },
    {
      description: "Pipe straight into mongorestore",
      command:
        "mongoshield export --format archive --output - | mongorestore --uri $TARGET --archive",
    },
    {
      description: "One collection as CSV for a spreadsheet",
      command:
        "mongoshield export --format csv --namespace app.users --fields _id,name,address.city --output users.csv",
    },
  ],
  run: runExportCommand,
};

async function runExportCommand(context: CommandContext): Promise<number> {
  const textFormat = context.flags.string("format");
  if (isTextFormat(textFormat)) return runTextExport(context, textFormat);
  const options = exportFlags(context);
  const cli = await createCliShield(context, exportOverrides(context));
  try {
    const decryption = await decryptionFromConfig(context, cli.config);
    const toStdout = options.output === STDOUT_PATH;
    context.out.info(
      `Exporting ${backupSelectorArgument(context)} from ${cli.storageLabel} → ${toStdout ? "stdout" : options.output}`,
    );
    const summary = await exportBackup(cli.shield.storage, backupSelectorArgument(context), {
      ...options,
      output: toStdout ? context.io.stdout : options.output,
      logger: createCliLogger(context.out),
      signal: context.signal,
      ...(decryption ? { decryption } : {}),
    });
    printSummary(context, summary, toStdout);
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** Reads and checks the export flags. */
function exportFlags(
  context: CommandContext,
): Pick<ExportOptions, "format" | "gzip" | "include" | "exclude"> & { readonly output: string } {
  const { flags } = context;
  for (const flag of Object.keys(TEXT_EXPORT_OPTIONS)) {
    if (flags.has(flag)) throw usageError(`--${flag} needs --format jsonl or csv.`, NAME);
  }
  const format = flags.string("format") === "archive" ? "archive" : "directory";
  const rawOutput = flags.string("output");
  if (rawOutput === undefined || rawOutput === "") {
    throw usageError(
      "Where to? Pass --output <directory> (or --format archive --output <file>).",
      NAME,
    );
  }
  if (rawOutput === STDOUT_PATH && format !== "archive") {
    throw usageError(
      "--output - (stdout) needs --format archive: a directory cannot be streamed.",
      NAME,
    );
  }
  if (rawOutput === STDOUT_PATH && context.global.json) {
    throw usageError(
      "--json cannot be combined with --output -: stdout carries the archive.",
      NAME,
    );
  }
  const output =
    rawOutput === STDOUT_PATH || isAbsolute(rawOutput)
      ? rawOutput
      : resolve(context.io.cwd, rawOutput);
  const include = listOrUndefined(context, "include");
  const exclude = listOrUndefined(context, "exclude");
  return {
    format,
    output,
    gzip: flags.boolean("gzip"),
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

/** Flags as a config layer: where backups are read from, and decryption secrets. */
function exportOverrides(context: CommandContext): MongoShieldConfigInput {
  const passphraseVariable = context.flags.string("passphrase-env");
  const passphrase = passphraseVariable
    ? readPassphraseEnv(context, passphraseVariable)
    : undefined;
  const identityFiles = listOrUndefined(context, "identity-file");
  return {
    storage: context.flags.string("from"),
    decryption: identityFiles || passphrase ? { identityFiles, passphrase } : undefined,
  };
}

/**
 * Prints what was exported and how to restore it. When the archive went to stdout,
 * everything goes to stderr instead, so the archive stays clean.
 */
function printSummary(context: CommandContext, summary: ExportSummary, toStdout: boolean): void {
  const { out } = context;
  for (const item of summary.skipped) out.warn(`Not exported: ${item.ns}: ${item.reason}`);
  if (out.settings.json) {
    out.json(summary);
    return;
  }
  const lines = renderDetails(
    [
      ["Backup id", out.style("bold", summary.backupId)],
      ["Output", toStdout ? "stdout" : summary.output],
      ["Format", `${summary.format}${summary.gzip ? " (gzip)" : ""}`],
      ["Namespaces", formatCount(summary.namespaces.length)],
      ["Documents", formatCount(summary.documents)],
      ...usersAndRolesRow(summary),
      ["Data", formatBytes(summary.bytes)],
      ["Duration", formatDuration(summary.durationMs)],
    ],
    (label) => out.style("dim", label),
  );
  out.success("Export complete.");
  if (toStdout) {
    out.info(lines);
    return;
  }
  out.result(lines);
  out.info(out.style("dim", `Restore with: ${restoreHint(summary)}`));
}

/** "2 users, 1 role" when the export holds users or roles. */
function usersAndRolesRow(summary: ExportSummary): [string, string][] {
  const { users, roles } = summary.usersAndRoles;
  if (users + roles === 0) return [];
  return [["Users and roles", `${plural(users, "user")}, ${plural(roles, "role")}`]];
}

/** The mongorestore command line for the exported output. */
function restoreHint(summary: ExportSummary): string {
  const gzip = summary.gzip ? " --gzip" : "";
  if (summary.format === "archive")
    return `mongorestore --uri <target>${gzip} --archive=${summary.output}`;
  return `mongorestore --uri <target>${gzip} --dir ${summary.output}`;
}
