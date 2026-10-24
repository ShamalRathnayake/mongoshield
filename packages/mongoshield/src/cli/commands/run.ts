/**
 * `mongoshield run`: one scheduled job, right now.
 *
 * lock → backup (+ guard) → verify → prune → notify + heartbeat → unlock,
 * exactly what `mongoshield schedule` does on each cron tick, but once. This
 * is the command to put in system cron, a Kubernetes CronJob, GitHub Actions
 * or a serverless function: the external scheduler decides WHEN, MongoShield
 * does the rest, and the lock keeps overlapping invocations from colliding.
 *
 * Exit codes: 0 for success, and also when the run was skipped because
 * another runner holds the lock (that is the lock doing its job); otherwise
 * the exit code of the error that stopped the run (see docs/errors.md).
 *
 * Also exports the setup shared with `mongoshield schedule`.
 */

import type { MongoShieldConfigInput } from "../../config/schema.ts";
import { ERROR_CODES, type ErrorCode } from "../../errors.ts";
import { WEBHOOK_SECRET_ENV } from "../../notify/webhook.ts";
import { type RunReport, summarizeReport, verifyLabel } from "../../schedule/report.ts";
import { runScheduledJob, type ScheduledJobOptions } from "../../schedule/runner.ts";
import type { CommandContext, CommandSpec, OptionSpec } from "../command.ts";
import { formatBytes, formatDuration } from "../format.ts";
import { ProgressDisplay } from "../progress.ts";
import {
  type CliShield,
  createCliLogger,
  createCliShield,
  decryptionFromConfig,
  readPassphraseEnv,
  rememberUriPassword,
} from "../setup.ts";
import { renderDetails } from "../table.ts";
import {
  identityFileOption,
  listOrUndefined,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

/** Flags shared by `run` and `schedule`. */
export const scheduledRunOptions: Readonly<Record<string, OptionSpec>> = {
  uri: {
    type: "string",
    valueName: "<mongodb-uri>",
    description: "Connection string (default: config source.uri, MONGOSHIELD_URI or MONGODB_URI)",
  },
  to: storageFromOption,
  "identity-file": identityFileOption,
  "passphrase-env": passphraseEnvOption,
};

export const runCommand: CommandSpec = {
  name: "run",
  summary: "Run the scheduled job once: lock, back up, verify, prune, notify",
  description: [
    "Does what `mongoshield schedule` does on each tick, once, using the schedule,",
    "retention, guard, notify and heartbeat sections of mongoshield.config.ts.",
    "Made for system cron, Kubernetes CronJobs, CI and serverless schedulers.",
    "Exits 0 when another runner holds the lock (the run is skipped).",
  ].join("\n"),
  options: {
    ...scheduledRunOptions,
    verify: {
      type: "string",
      choices: ["none", "fast", "deep", "drill"],
      description: "Override schedule.verify (default: fast; drill needs the drill section)",
    },
    "no-prune": { type: "boolean", description: "Do not prune, whatever schedule.prune says" },
    jitter: {
      type: "boolean",
      description: "Wait a random 0–schedule.jitterSeconds before starting",
    },
  },
  examples: [
    { description: "Run the configured job now", command: "mongoshield run" },
    {
      description: "From crontab, every night at 03:15, with a deep verify",
      command: "15 3 * * * mongoshield run --verify deep --quiet",
    },
  ],
  run: runRunCommand,
};

async function runRunCommand(context: CommandContext): Promise<number> {
  const prepared = await prepareScheduledRun(context);
  const terminated = abortOnTerminate();
  const progress = new ProgressDisplay(context.out, "Backing up");
  try {
    const verify = context.flags.string("verify");
    const report = await runScheduledJob(prepared.cli.shield, prepared.cli.config, {
      ...prepared.options,
      signal: AbortSignal.any([context.signal, terminated.signal]),
      onProgress: progress.onProgress,
      applyJitter: context.flags.boolean("jitter"),
      ...(verify === "none" || verify === "fast" || verify === "deep" || verify === "drill"
        ? { verify }
        : {}),
      ...(context.flags.boolean("no-prune") ? { prune: false } : {}),
    });
    progress.stop();
    printRunReport(context, report);
    return exitCodeOf(report);
  } finally {
    progress.stop();
    terminated.dispose();
    await prepared.cli.shield.close();
  }
}

// ---------------------------------------------------------------------------
// Shared with `mongoshield schedule`
// ---------------------------------------------------------------------------

/** A configured shield plus the runner options that come from flags and environment. */
export interface PreparedScheduledRun {
  readonly cli: CliShield;
  readonly options: ScheduledJobOptions;
}

/** Loads the config (with `extra` overrides), the decryption keys and the webhook secret. */
export async function prepareScheduledRun(
  context: CommandContext,
  extra: MongoShieldConfigInput = { storage: undefined },
): Promise<PreparedScheduledRun> {
  const uri = context.flags.string("uri");
  if (uri) rememberUriPassword(context, uri);
  const passphraseVariable = context.flags.string("passphrase-env");
  const passphrase = passphraseVariable
    ? readPassphraseEnv(context, passphraseVariable)
    : undefined;
  const identityFiles = listOrUndefined(context, "identity-file");

  const cli = await createCliShield(context, {
    ...extra,
    source: uri ? { uri } : undefined,
    storage: context.flags.string("to"),
    decryption: identityFiles || passphrase ? { identityFiles, passphrase } : undefined,
  });
  const decryption = await decryptionFromConfig(context, cli.config);
  const webhookSecret = context.io.env[WEBHOOK_SECRET_ENV];
  if (webhookSecret) context.addSecret(webhookSecret);

  return {
    cli,
    options: {
      logger: createCliLogger(context.out),
      // A relative drill.assertions path means "relative to where I ran the command".
      cwd: context.io.cwd,
      ...(decryption ? { decryption } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    },
  };
}

/** 0 for success and skipped runs; the failing error's exit code otherwise. */
export function exitCodeOf(report: RunReport): number {
  if (report.status !== "failure") return 0;
  const code = report.error?.code;
  return code !== undefined && code in ERROR_CODES ? ERROR_CODES[code as ErrorCode].exitCode : 1;
}

/** Prints a run report: JSON with --json, a summary and details otherwise. */
export function printRunReport(context: CommandContext, report: RunReport): void {
  const { out } = context;
  if (out.settings.json) {
    out.json(report);
    return;
  }

  const summary = summarizeReport(report);
  if (report.status === "failure") {
    out.result(`${out.style("red", "✖")} ${summary}`);
    if (report.error?.hint) out.result(`  ${out.style("dim", `Hint: ${report.error.hint}`)}`);
    for (const finding of report.guard?.findings ?? []) out.result(`  • ${finding.message}`);
    return;
  }
  if (report.status === "skipped" || out.settings.quiet) {
    out.result(report.status === "skipped" ? summary : (report.backup?.id ?? summary));
    return;
  }

  out.success(summary);
  const rows: [string, string][] = [];
  if (report.backup) {
    rows.push(["Backup id", out.style("bold", report.backup.id)]);
    rows.push([
      "Data",
      `${formatBytes(report.backup.bytesRaw)} raw → ${formatBytes(report.backup.bytesStored)} stored`,
    ]);
  }
  if (report.verify)
    rows.push(["Verify", `${verifyLabel(report.verify)}: ${report.verify.ok ? "ok" : "failed"}`]);
  if (report.guard)
    rows.push(["Guard", report.guard.ok ? "ok" : `${report.guard.findings.length} warning(s)`]);
  if (report.prune)
    rows.push(["Pruned", `${report.prune.deletedBackups} backup(s), ${report.prune.kept} kept`]);
  rows.push(["Lock", report.lock.kind]);
  rows.push(["Duration", formatDuration(report.durationMs)]);
  out.result(renderDetails(rows, (label) => out.style("dim", label)));
  for (const finding of report.guard?.findings ?? []) out.warn(finding.message);
}

/**
 * Turns SIGTERM (sent by Kubernetes, systemd and Docker on shutdown) into an
 * abort, like Ctrl-C, so the run stops cleanly: partial files deleted, lock
 * released, failure reported. The CLI entry point handles SIGINT already.
 */
export function abortOnTerminate(): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onTerminate = (): void => controller.abort();
  process.once("SIGTERM", onTerminate);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGTERM", onTerminate);
    },
  };
}
