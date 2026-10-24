/**
 * `mongoshield drill`: prove a backup can be restored, and measure how long it takes.
 *
 * Restores the backup into temporary databases (`msdrill_<run>_<db>`) on a scratch
 * deployment given with --target-uri, checks document counts, indexes, optionally a
 * random sample of documents (--sample) and your own assertions (--assertions), then
 * drops the temporary databases. The headline is the RTO: how long the restore took.
 *
 * The target never defaults to the configured source: a drill is a full restore,
 * and running one against production must be a deliberate choice (and even then
 * needs --allow-same-deployment). Exit code 0 when the drill passed,
 * 33 (MS_INTEGRITY_FAILED) when it found problems, so a scheduled drill can alert.
 *
 * `mongoshield verify --drill` runs this same command (see `runDrillCommand`).
 */

import type { MongoShieldConfigInput } from "../../config/schema.ts";
import type { DrillAssertions, DrillReport, ShieldDrillOptions } from "../../engine/drill.ts";
import { MAX_DRILL_SAMPLE } from "../../engine/drill.ts";
import { loadDrillAssertionsFile } from "../../engine/drill-assertions-file.ts";
import { ERROR_CODES } from "../../errors.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec, OptionSpec } from "../command.ts";
import { formatCount, formatDuration, plural } from "../format.ts";
import type { Output } from "../io.ts";
import { ProgressDisplay } from "../progress.ts";
import {
  createCliShield,
  decryptionFromConfig,
  displayUri,
  readPassphraseEnv,
  rememberUriPassword,
} from "../setup.ts";
import { renderTable } from "../table.ts";
import {
  backupSelectorArgument,
  excludeOption,
  identityFileOption,
  includeOption,
  listOrUndefined,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "drill";

/**
 * The options only a drill has. Exported so `verify --drill` accepts exactly the
 * same flags as `drill`.
 */
export const DRILL_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  "target-uri": {
    type: "string",
    valueName: "<mongodb-uri>",
    description: "Scratch deployment to restore into (required; never the configured source)",
  },
  sample: {
    type: "string",
    valueName: "<n>",
    defaultText: "0",
    description:
      "Documents per collection to compare byte for byte with the backup (time series: field by field)",
  },
  assertions: {
    type: "string",
    valueName: "<file>",
    description: "A .ts/.js file whose default export checks the restored data",
  },
  keep: { type: "boolean", description: "Keep the temporary databases for inspection" },
  prefix: {
    type: "string",
    valueName: "<prefix>",
    defaultText: "msdrill_",
    description: "Prefix of the temporary database names",
  },
  "allow-same-deployment": {
    type: "boolean",
    description: "Allow the target to be the backup's own source deployment",
  },
  include: includeOption,
  exclude: excludeOption,
};

export const drillCommand: CommandSpec = {
  name: NAME,
  summary: "Prove a backup restores: restore into a scratch deployment, check, clean up",
  description: [
    "Restores the backup into temporary databases on a scratch deployment, checks",
    "document counts and indexes (and, with --sample, documents byte for byte),",
    "runs your --assertions, then drops the temporary databases. Prints the RTO:",
    "how long the restore took. The result is recorded next to the backup.",
  ].join("\n"),
  positionals: [
    { name: "backup", optional: true, description: 'Backup id, or "latest" (default)' },
  ],
  options: {
    ...DRILL_OPTIONS,
    from: storageFromOption,
    "identity-file": identityFileOption,
    "passphrase-env": passphraseEnvOption,
  },
  examples: [
    {
      description: "Drill the latest backup into a scratch cluster",
      command: "mongoshield drill --target-uri $SCRATCH_URI --identity-file ~/keys/backup.key",
    },
    {
      description: "Compare 100 random documents per collection and run your own checks",
      command:
        "mongoshield drill latest --target-uri $SCRATCH_URI --sample 100 --assertions ./drill.ts",
    },
  ],
  run: runDrillCommand,
};

/** Runs a drill from the parsed flags. Also used by `mongoshield verify --drill`. */
export async function runDrillCommand(context: CommandContext): Promise<number> {
  const targetUri = context.flags.string("target-uri");
  if (!targetUri) {
    throw usageError(
      "A drill needs a scratch deployment to restore into: pass --target-uri.",
      NAME,
    );
  }
  rememberUriPassword(context, targetUri);
  const sample = sampleFlag(context);
  const assertions = await loadAssertionsFlag(context);

  const cli = await createCliShield(context, drillOverrides(context));
  try {
    const decryption = await decryptionFromConfig(context, cli.config);
    const include = listOrUndefined(context, "include");
    const exclude = listOrUndefined(context, "exclude");
    const prefix = context.flags.string("prefix");
    const options: ShieldDrillOptions = {
      backup: backupSelectorArgument(context),
      target: { uri: targetUri },
      sample,
      keep: context.flags.boolean("keep"),
      allowSameDeployment: context.flags.boolean("allow-same-deployment"),
      signal: context.signal,
      ...(prefix === undefined ? {} : { prefix }),
      ...(assertions ? { assertions } : {}),
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
      ...(decryption ? { decryption } : {}),
    };

    context.out.info(`Drilling into ${displayUri(targetUri)} (temporary databases)…`);
    const progress = new ProgressDisplay(context.out, "Restoring");
    let report: DrillReport;
    try {
      report = await cli.shield.drill({ ...options, onProgress: progress.onProgress });
    } finally {
      progress.stop();
    }
    printReport(context.out, report);
    return report.ok ? 0 : ERROR_CODES.MS_INTEGRITY_FAILED.exitCode;
  } finally {
    await cli.shield.close();
  }
}

/** Flags as a config layer: where backups are read from, and decryption secrets. */
function drillOverrides(context: CommandContext): MongoShieldConfigInput {
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

function sampleFlag(context: CommandContext): number {
  return context.flags.integer("sample", { min: 0, max: MAX_DRILL_SAMPLE }) ?? 0;
}

// ---------------------------------------------------------------------------
// The assertions file
// ---------------------------------------------------------------------------

/**
 * Loads `--assertions <file>` (see engine/drill-assertions-file.ts for the file's
 * shape), relative to the working directory.
 */
async function loadAssertionsFlag(context: CommandContext): Promise<DrillAssertions | undefined> {
  const file = context.flags.string("assertions");
  if (file === undefined) return undefined;
  return loadDrillAssertionsFile(file, context.io.cwd);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printReport(out: Output, report: DrillReport): void {
  if (out.settings.json) {
    out.json(report);
    return;
  }

  // The RTO comes first: it is the number people run drills for.
  const rto = formatDuration(report.restoreDurationMs);
  out.result(
    `${out.style("bold", "RTO")} ${out.style("bold", rto)}  (restore of backup ${report.backupId}: ${plural(report.documentsRestored, "document")}${report.restored ? "" : ", failed"})`,
  );

  if (report.namespaces.length > 0) out.result(namespaceTable(out, report));

  if (report.ok) {
    out.result(
      `${out.style("green", "✔")} Drill passed: backup ${report.backupId} restores completely (${formatDuration(report.durationMs)} in total).`,
    );
  } else {
    out.result(
      `${out.style("red", "✖")} Drill failed: ${plural(report.problems.length, "problem")} in backup ${report.backupId}.`,
    );
    for (const problem of report.problems) {
      out.result(`  ${out.style("red", "•")} ${problem.subject}: ${problem.problem}`);
    }
  }

  if (report.kept) {
    out.warn(
      `Kept the temporary databases: ${report.databases.map((database) => database.target).join(", ")}. Drop them when done.`,
    );
  }
  for (const warning of report.warnings) out.warn(warning);
}

function namespaceTable(out: Output, report: DrillReport): string {
  const rows = report.namespaces.map((namespace) => [
    namespace.ns,
    namespace.type,
    namespace.type === "view"
      ? "-"
      : `${formatCount(namespace.restoredDocuments)}/${formatCount(namespace.expectedDocuments)}`,
    namespace.type === "view" ? "-" : `${namespace.indexesFound}/${namespace.indexesExpected}`,
    namespace.sampled > 0 ? formatCount(namespace.sampled) : "-",
    namespace.ok ? out.style("green", "ok") : out.style("red", "problems"),
  ]);
  return renderTable(
    [
      { header: "NAMESPACE" },
      { header: "TYPE" },
      { header: "DOCUMENTS", align: "right" },
      { header: "INDEXES", align: "right" },
      { header: "SAMPLED", align: "right" },
      { header: "RESULT" },
    ],
    rows,
    (text) => out.style("dim", text),
  );
}
