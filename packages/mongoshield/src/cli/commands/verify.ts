/**
 * `mongoshield verify`: check that a backup is complete and intact.
 *
 * Fast mode checks every file's size and SHA-256 (no key needed). Deep mode
 * also decrypts, decompresses and parses every document. The exit code is
 * non-zero (MS_INTEGRITY_FAILED, 33) when problems are found, so a scheduled
 * `mongoshield verify --deep` can alert on failure. The result is recorded
 * next to the backup and shown by `list` and `inspect`.
 *
 * An incremental backup is verified with its whole chain (every earlier backup back
 * to the full one, in the same mode); `--chain links` only checks that the chain is
 * complete and lines up, plus the incremental's own files.
 */

import type { MongoShieldConfigInput } from "../../config/schema.ts";
import { ERROR_CODES } from "../../errors.ts";
import type { VerifyOptions, VerifyReport } from "../../types.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { formatBytes, formatCount, formatDuration, plural } from "../format.ts";
import { ProgressDisplay } from "../progress.ts";
import { createCliShield, decryptionFromConfig, readPassphraseEnv } from "../setup.ts";
import { DRILL_OPTIONS, runDrillCommand } from "./drill.ts";
import {
  backupSelectorArgument,
  identityFileOption,
  listOrUndefined,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

export const verifyCommand: CommandSpec = {
  name: "verify",
  summary: "Check that a backup is complete and intact",
  positionals: [
    { name: "backup", optional: true, description: 'Backup id, or "latest" (default)' },
  ],
  options: {
    deep: {
      type: "boolean",
      description: "Also decrypt, decompress and parse every document (needs the key)",
    },
    drill: {
      type: "boolean",
      description:
        "Restore the backup into a scratch deployment and check it (see `mongoshield drill`)",
    },
    // The drill command's own options (--target-uri, --sample, …), so `verify --drill` takes them too.
    ...DRILL_OPTIONS,
    from: storageFromOption,
    "identity-file": identityFileOption,
    "passphrase-env": passphraseEnvOption,
    chain: {
      type: "string",
      choices: ["full", "links"],
      defaultText: "full",
      description:
        "Incremental backups: also check every earlier backup's files (full), or only that the chain is intact (links)",
    },
  },
  examples: [
    { description: "Quick check of the latest backup", command: "mongoshield verify" },
    {
      description: "Full check of an encrypted backup",
      command: "mongoshield verify latest --deep --identity-file ~/keys/backup.key",
    },
  ],
  run: runVerifyCommand,
};

async function runVerifyCommand(context: CommandContext): Promise<number> {
  // `verify --drill` is an alias: a drill is the strongest form of verification.
  if (context.flags.boolean("drill")) return runDrillCommand(context);
  const cli = await createCliShield(context, verifyOverrides(context));
  try {
    const decryption = await decryptionFromConfig(context, cli.config);
    const progress = new ProgressDisplay(context.out, "Verifying");
    const options: VerifyOptions = {
      backup: backupSelectorArgument(context),
      mode: context.flags.boolean("deep") ? "deep" : "fast",
      ...(context.flags.string("chain") === "links" ? { chain: "links" as const } : {}),
      signal: context.signal,
      onProgress: progress.onProgress,
      ...(decryption ? { decryption } : {}),
    };

    let report: VerifyReport;
    try {
      report = await cli.shield.verify(options);
    } finally {
      progress.stop();
    }
    printReport(context, report);
    return report.ok ? 0 : ERROR_CODES.MS_INTEGRITY_FAILED.exitCode;
  } finally {
    await cli.shield.close();
  }
}

function verifyOverrides(context: CommandContext): MongoShieldConfigInput {
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

function printReport(context: CommandContext, report: VerifyReport): void {
  const { out } = context;
  if (out.settings.json) {
    out.json(report);
    return;
  }

  const checked = [plural(report.filesChecked, "file"), formatBytes(report.bytesChecked)];
  if (report.mode === "deep") checked.push(plural(report.documentsChecked, "document"));
  const scope = `${checked.join(", ")} checked (${report.mode}) in ${formatDuration(report.durationMs)}`;
  if (report.chain !== undefined) {
    // Which backups the verdict covers: the whole chain, or its links only.
    const what = report.chain.scope === "full" ? "files and links" : "links";
    out.info(
      `Chain: incremental #${report.chain.length} after base ${report.chain.baseBackupId}; ${what} of ${plural(report.chain.members.length, "backup")} checked.`,
    );
  }

  if (report.ok) {
    out.result(`${out.style("green", "✔")} Backup ${report.backupId} is intact: ${scope}.`);
    return;
  }

  out.result(
    `${out.style("red", "✖")} Backup ${report.backupId} has ${plural(report.problems.length, "problem")}: ${scope}.`,
  );
  for (const problem of report.problems) {
    out.result(`  ${out.style("red", "•")} ${problem.subject}: ${problem.problem}`);
  }
  out.info(
    out.style(
      "dim",
      `Do not rely on this backup. Exit code ${formatCount(ERROR_CODES.MS_INTEGRITY_FAILED.exitCode)} (MS_INTEGRITY_FAILED).`,
    ),
  );
}
