/**
 * The text formats of `mongoshield export`: one collection as JSON Lines or CSV
 * (engine: src/extras/export-text.ts). export.ts hands over here when --format is
 * `jsonl` or `csv`; this file is not a command of its own.
 *
 *   mongoshield export --format jsonl --namespace app.users --output users.jsonl
 *   mongoshield export latest --format csv --namespace app.users \
 *     --fields _id,name,address.city --filter '{"active":true}' --output -
 */

import { isAbsolute, resolve } from "node:path";
import {
  type ExportDocumentsResult,
  exportDocuments,
  type TextExportFormat,
} from "../../extras/export-text.ts";
import { usageError } from "../args.ts";
import type { CommandContext, OptionSpec } from "../command.ts";
import { formatBytes, formatCount, formatDuration } from "../format.ts";
import { createCliLogger, createCliShield, decryptionFromConfig } from "../setup.ts";
import { renderDetails } from "../table.ts";
import { backupReadOverrides, parseEjsonDocument } from "./recovery-shared.ts";
import { backupSelectorArgument } from "./shared-options.ts";

const NAME = "export";

/** The output that means "write to standard output". */
const STDOUT_PATH = "-";

/** Flags only the text formats accept (spread into the `export` command's options). */
export const TEXT_EXPORT_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  namespace: {
    type: "string",
    valueName: "<db.collection>",
    description: "With jsonl/csv: the collection to export",
  },
  fields: {
    type: "string",
    valueName: "<a,b.c>",
    description: "With jsonl/csv: dotted field paths (required for csv: its columns)",
  },
  filter: {
    type: "string",
    valueName: "<json>",
    description: "With jsonl/csv: only documents matching this Extended JSON filter",
  },
  ejson: {
    type: "string",
    choices: ["relaxed", "canonical"],
    defaultText: "relaxed",
    description: "With jsonl/csv: Extended JSON flavour (canonical keeps every BSON type)",
  },
};

/** True for the formats handled here. */
export function isTextFormat(format: string | undefined): format is TextExportFormat {
  return format === "jsonl" || format === "csv";
}

/** Runs `export --format jsonl|csv`. */
export async function runTextExport(
  context: CommandContext,
  format: TextExportFormat,
): Promise<number> {
  const { flags } = context;
  for (const flag of ["gzip", "include", "exclude"]) {
    if (flags.has(flag))
      throw usageError(`--${flag} only applies to --format directory or archive.`, NAME);
  }
  const namespace = flags.string("namespace");
  if (namespace === undefined) {
    throw usageError(
      `--format ${format} exports one collection: pass --namespace <db.collection>.`,
      NAME,
    );
  }
  const rawOutput = flags.string("output");
  if (rawOutput === undefined || rawOutput === "") {
    throw usageError(`Where to? Pass --output <file>, or --output - for stdout.`, NAME);
  }
  const toStdout = rawOutput === STDOUT_PATH;
  if (toStdout && context.global.json) {
    throw usageError("--json cannot be combined with --output -: stdout carries the export.", NAME);
  }
  const output = toStdout || isAbsolute(rawOutput) ? rawOutput : resolve(context.io.cwd, rawOutput);
  const fields = parseFields(flags.string("fields"));
  const filterText = flags.string("filter");
  const ejson = flags.string("ejson") === "canonical" ? "canonical" : "relaxed";

  const cli = await createCliShield(context, backupReadOverrides(context));
  try {
    const decryption = await decryptionFromConfig(context, cli.config);
    const backup = backupSelectorArgument(context);
    context.out.info(
      `Exporting ${namespace} from ${backup} (${cli.storageLabel}) → ${toStdout ? "stdout" : output}`,
    );
    const result = await exportDocuments(
      { storage: cli.shield.storage, logger: createCliLogger(context.out) },
      {
        backup,
        namespace,
        format,
        ejson,
        output: toStdout ? context.io.stdout : output,
        signal: context.signal,
        ...(fields ? { fields } : {}),
        ...(filterText !== undefined ? { filter: parseEjsonDocument(filterText, "filter") } : {}),
        ...(decryption ? { decryption } : {}),
      },
    );
    printTextSummary(context, result, toStdout);
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** `--fields a,b.c` → `["a", "b.c"]` (spaces around commas are ignored). */
function parseFields(text: string | undefined): string[] | undefined {
  if (text === undefined) return undefined;
  return text.split(",").map((field) => field.trim());
}

/** What was written; on stderr when the export itself went to stdout. */
function printTextSummary(
  context: CommandContext,
  result: ExportDocumentsResult,
  toStdout: boolean,
): void {
  const { out } = context;
  if (out.settings.json) {
    out.json(result);
    return;
  }
  const lines = renderDetails(
    [
      ["Backup id", out.style("bold", result.backupId)],
      ["Namespace", result.namespace],
      ["Format", result.format],
      ["Output", toStdout ? "stdout" : result.output],
      ["Documents", formatCount(result.documents)],
      ["Size", formatBytes(result.bytes)],
      ["Duration", formatDuration(result.durationMs)],
    ],
    (label) => out.style("dim", label),
  );
  out.success("Export complete.");
  if (toStdout) out.info(lines);
  else out.result(lines);
}
