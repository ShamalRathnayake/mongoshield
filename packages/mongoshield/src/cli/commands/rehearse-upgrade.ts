/**
 * `mongoshield rehearse-upgrade [backup] --target-version 8.0`: prove a backup works
 * on a newer MongoDB release before production is upgraded.
 *
 *   1. analysis   the compatibility rules from MongoDB's release notes, over the
 *                 backup's metadata, users, roles and stored JavaScript
 *   2. restore    into a server of the target version: --target-uri (a scratch
 *                 deployment, checked to run that version and not to be the backup's
 *                 source), or an ephemeral mongod started for the purpose
 *                 (mongodb-memory-server, an optional dependency)
 *   3. checks     the drill's checks (counts, indexes, views, sampled documents byte
 *                 for byte, --assertions) plus `validate` on every collection, every
 *                 view queried and every validator evaluated on the new server
 *   4. record     the result is stored next to the backup as a drill, with the
 *                 version it proved, for `inspect` and the console
 *
 * Why a command of its own rather than `drill --upgrade-to 8.0`: it needs a different
 * default target (an ephemeral server of the right version instead of a required
 * --target-uri), has a mode that needs no server at all (--analyze-only), samples
 * documents by default, and its output leads with the compatibility findings. Its
 * restore and checks ARE the drill's, and so are the flags they share.
 *
 * Exit code 0 when the rehearsal passed, 33 (MS_INTEGRITY_FAILED) when it found
 * problems, like `drill`, so CI can gate an upgrade on it.
 */

import type { MongoShieldConfigInput } from "../../config/schema.ts";
import type { DrillAssertions } from "../../engine/drill.ts";
import { MAX_DRILL_SAMPLE } from "../../engine/drill.ts";
import { loadDrillAssertionsFile } from "../../engine/drill-assertions-file.ts";
import type { CompatibilityFinding, CompatibilityReport } from "../../engine/upgrade-compat.ts";
import type { UpgradeCheck } from "../../engine/upgrade-live.ts";
import {
  DEFAULT_REHEARSAL_SAMPLE,
  type ShieldUpgradeRehearsalOptions,
  type UpgradeCompatibilityResult,
  type UpgradeRehearsalReport,
} from "../../engine/upgrade-rehearsal.ts";
import { ERROR_CODES } from "../../errors.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { formatDuration, plural } from "../format.ts";
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
import { namespaceTable } from "./drill.ts";
import {
  backupSelectorArgument,
  excludeOption,
  identityFileOption,
  includeOption,
  listOrUndefined,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "rehearse-upgrade";

export const rehearseUpgradeCommand: CommandSpec = {
  name: NAME,
  summary: "Prove a backup works on a newer MongoDB version before upgrading",
  description: [
    "Checks the backup against MongoDB's compatibility notes for the target version",
    "(removed index types, removed JavaScript functions, the 8.0 null/undefined change,",
    "…), restores it into a server of that version, and runs the drill's checks plus",
    "validate, every view and every validator there. Without --target-uri an ephemeral",
    "mongod is started (needs the mongodb-memory-server package). The result is",
    "recorded next to the backup.",
  ].join("\n"),
  positionals: [
    { name: "backup", optional: true, description: 'Backup id, or "latest" (default)' },
  ],
  options: {
    "target-version": {
      type: "string",
      valueName: "<x.y[.z]>",
      description: "The MongoDB version to rehearse (required), e.g. 8.0 or 8.0.13",
    },
    "target-uri": {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "Scratch deployment running the target version (default: an ephemeral mongod)",
    },
    "mongod-binary": {
      type: "string",
      valueName: "<path>",
      description: "mongod binary for the ephemeral server, instead of downloading one",
    },
    "analyze-only": {
      type: "boolean",
      description: "Only run the compatibility analysis (no server needed)",
    },
    sample: {
      type: "string",
      valueName: "<n>",
      defaultText: String(DEFAULT_REHEARSAL_SAMPLE),
      description: "Documents per collection to compare byte for byte with the backup",
    },
    assertions: {
      type: "string",
      valueName: "<file>",
      description: "A .ts/.js file whose default export checks the restored data",
    },
    keep: { type: "boolean", description: "Keep the temporary databases (--target-uri only)" },
    prefix: {
      type: "string",
      valueName: "<prefix>",
      defaultText: "msdrill_",
      description: "Prefix of the temporary database names",
    },
    include: includeOption,
    exclude: excludeOption,
    from: storageFromOption,
    "identity-file": identityFileOption,
    "passphrase-env": passphraseEnvOption,
  },
  examples: [
    {
      description: "Rehearse the latest backup on an ephemeral MongoDB 8.0.13",
      command: "mongoshield rehearse-upgrade --target-version 8.0.13",
    },
    {
      description: "Rehearse on your own 8.0 staging cluster",
      command:
        "mongoshield rehearse-upgrade latest --target-version 8.0 --target-uri $STAGING_80_URI",
    },
    {
      description: "Only check the compatibility notes, in CI, as JSON",
      command: "mongoshield rehearse-upgrade --target-version 8.0 --analyze-only --json",
    },
  ],
  run: runRehearseUpgradeCommand,
};

async function runRehearseUpgradeCommand(context: CommandContext): Promise<number> {
  const targetVersion = context.flags.string("target-version");
  if (!targetVersion) {
    throw usageError("Which version are you upgrading to? Pass --target-version, e.g. 8.0.", NAME);
  }
  const targetUri = context.flags.string("target-uri");
  if (targetUri) rememberUriPassword(context, targetUri);
  if (context.flags.boolean("analyze-only")) assertNoServerFlags(context);

  const cli = await createCliShield(context, rehearsalOverrides(context));
  try {
    const decryption = await decryptionFromConfig(context, cli.config);
    const include = listOrUndefined(context, "include");
    const exclude = listOrUndefined(context, "exclude");
    const common = {
      backup: backupSelectorArgument(context),
      targetVersion,
      signal: context.signal,
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
      ...(decryption ? { decryption } : {}),
    };

    if (context.flags.boolean("analyze-only")) {
      const result = await cli.shield.checkUpgradeCompatibility(common);
      printAnalysis(context.out, result);
      return result.ok ? 0 : ERROR_CODES.MS_INTEGRITY_FAILED.exitCode;
    }

    const assertions = await loadAssertionsFlag(context);
    const prefix = context.flags.string("prefix");
    const mongodBinary = context.flags.string("mongod-binary");
    const options: ShieldUpgradeRehearsalOptions = {
      ...common,
      sample: sampleFlag(context),
      keep: context.flags.boolean("keep"),
      ...(targetUri ? { target: { uri: targetUri } } : {}),
      ...(mongodBinary ? { mongodBinary } : {}),
      ...(prefix === undefined ? {} : { prefix }),
      ...(assertions ? { assertions } : {}),
    };
    context.out.info(
      targetUri
        ? `Rehearsing MongoDB ${targetVersion} on ${displayUri(targetUri)} (temporary databases)…`
        : `Rehearsing MongoDB ${targetVersion} on an ephemeral mongod…`,
    );
    const progress = new ProgressDisplay(context.out, "Restoring");
    let report: UpgradeRehearsalReport;
    try {
      report = await cli.shield.rehearseUpgrade({ ...options, onProgress: progress.onProgress });
    } finally {
      progress.stop();
    }
    printReport(context.out, report);
    return report.ok ? 0 : ERROR_CODES.MS_INTEGRITY_FAILED.exitCode;
  } finally {
    await cli.shield.close();
  }
}

/** --analyze-only never touches a server, so flags about one are a mistake. */
function assertNoServerFlags(context: CommandContext): void {
  for (const flag of ["target-uri", "mongod-binary", "assertions", "prefix", "sample"]) {
    if (context.flags.string(flag) !== undefined) {
      throw usageError(`--${flag} has no effect with --analyze-only (nothing is restored).`, NAME);
    }
  }
  if (context.flags.boolean("keep")) {
    throw usageError("--keep has no effect with --analyze-only (nothing is restored).", NAME);
  }
}

/** Flags as a config layer: where backups are read from, and decryption secrets. */
function rehearsalOverrides(context: CommandContext): MongoShieldConfigInput {
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
  return (
    context.flags.integer("sample", { min: 0, max: MAX_DRILL_SAMPLE }) ?? DEFAULT_REHEARSAL_SAMPLE
  );
}

async function loadAssertionsFlag(context: CommandContext): Promise<DrillAssertions | undefined> {
  const file = context.flags.string("assertions");
  if (file === undefined) return undefined;
  return loadDrillAssertionsFile(file, context.io.cwd);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printAnalysis(out: Output, result: UpgradeCompatibilityResult): void {
  if (out.settings.json) {
    out.json(result);
    return;
  }
  printCompatibility(out, result);
  const problems = countBySeverity(result.findings, "problem");
  if (result.ok) {
    out.result(
      `${out.style("green", "✔")} No compatibility problems in backup ${result.backupId} for MongoDB ${result.targetVersion}. Run without --analyze-only to prove it on a real server.`,
    );
  } else {
    out.result(
      `${out.style("red", "✖")} ${plural(problems, "compatibility problem")} in backup ${result.backupId} for MongoDB ${result.targetVersion}.`,
    );
  }
}

function printReport(out: Output, report: UpgradeRehearsalReport): void {
  if (out.settings.json) {
    out.json(report);
    return;
  }
  printCompatibility(out, report.compatibility);

  const drill = report.drill;
  const where = report.ephemeral ? "an ephemeral server" : "the scratch deployment";
  out.result(
    `${out.style("bold", "Restore")} into MongoDB ${report.serverVersion} (${where}): ${plural(drill.documentsRestored, "document")} in ${formatDuration(drill.restoreDurationMs)}${drill.restored ? "" : ", failed"}`,
  );
  if (drill.namespaces.length > 0) out.result(namespaceTable(out, drill));
  if (report.checks.length > 0) out.result(checksTable(out, report.checks));

  if (report.ok) {
    out.result(
      `${out.style("green", "✔")} Rehearsal passed: backup ${report.backupId} from MongoDB ${report.sourceVersion} works on ${report.serverVersion} (${formatDuration(report.durationMs)} in total).`,
    );
  } else {
    out.result(
      `${out.style("red", "✖")} Rehearsal failed: ${plural(report.problems.length, "problem")} for MongoDB ${report.serverVersion}.`,
    );
    // Compatibility problems were listed above with their rule; these are the rest.
    for (const problem of drill.problems) {
      out.result(`  ${out.style("red", "•")} ${problem.subject}: ${problem.problem}`);
    }
  }
  if (drill.kept && report.ephemeral) {
    out.warn(
      "--keep kept nothing: the ephemeral server was deleted after the rehearsal. Use --target-uri to inspect the restored data.",
    );
  } else if (drill.kept) {
    out.warn(
      `Kept the temporary databases: ${drill.databases.map((database) => database.target).join(", ")}. Drop them when done.`,
    );
  }
  for (const warning of drill.warnings) out.warn(warning);
}

/** The analysis: versions, upgrade path, then every finding with its rule and source. */
function printCompatibility(out: Output, report: CompatibilityReport): void {
  const path =
    report.upgradePath.length > 0
      ? `, in-place path: ${[report.sourceVersion, ...report.upgradePath].join(" → ")}`
      : "";
  out.result(
    `${out.style("bold", "Compatibility")} MongoDB ${report.sourceVersion} → ${report.targetVersion}${path} (${plural(report.rulesChecked, "rule")} checked)`,
  );
  if (report.findings.length === 0) {
    out.result(`  ${out.style("green", "✔")} nothing in the release notes affects this backup`);
  }
  for (const finding of report.findings) out.result(findingLine(out, finding));
  out.result();
}

function findingLine(out: Output, finding: CompatibilityFinding): string {
  const mark =
    finding.severity === "problem"
      ? out.style("red", "✖ problem")
      : out.style("yellow", "▲ warning");
  return [
    `  ${mark}  ${out.style("bold", finding.subject)}: ${finding.message}`,
    `             ${out.style("dim", `${finding.rule}, MongoDB ${finding.since}: ${finding.reference}`)}`,
  ].join("\n");
}

/** One row per live check. */
function checksTable(out: Output, checks: readonly UpgradeCheck[]): string {
  const outcome = (check: UpgradeCheck) => {
    if (check.outcome === "passed") return out.style("green", "passed");
    return check.outcome === "problem"
      ? out.style("red", "problem")
      : out.style("yellow", "warning");
  };
  const rows = checks.map((check) => [check.ns, check.check, outcome(check), check.message]);
  return renderTable(
    [{ header: "NAMESPACE" }, { header: "CHECK" }, { header: "RESULT" }, { header: "DETAIL" }],
    rows,
    (text) => out.style("dim", text),
  );
}

function countBySeverity(
  findings: readonly CompatibilityFinding[],
  severity: CompatibilityFinding["severity"],
): number {
  return findings.filter((finding) => finding.severity === severity).length;
}
