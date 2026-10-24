/**
 * `mongoshield rollback <label>`: put the data back as it was at a snapshot.
 *
 * Like `restore`, it shows the plan first and asks before replacing anything (or needs
 * --yes). By default it replaces every collection of the snapshot (mode drop) after
 * taking a `pre-rollback-<label>` safety snapshot of what it is about to replace, so
 * the rollback itself can be undone. See src/extras/snapshot.ts.
 */

import { MongoShieldError } from "../../errors.ts";
import { rollback } from "../../extras/snapshot.ts";
import type { RestoreMode, RestorePlan } from "../../types.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { confirmOrThrow } from "../confirm.ts";
import { formatCount, formatDuration, plural } from "../format.ts";
import type { Output } from "../io.ts";
import { ProgressDisplay } from "../progress.ts";
import {
  type CliShield,
  createCliShield,
  decryptionFromConfig,
  displayUri,
  readPassphraseEnv,
  rememberUriPassword,
} from "../setup.ts";
import { renderTable } from "../table.ts";
import {
  excludeOption,
  identityFileOption,
  includeOption,
  listOrUndefined,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "rollback";

const MODES: readonly RestoreMode[] = ["drop", "upsert", "insert", "fail-if-exists"];

export const rollbackCommand: CommandSpec = {
  name: NAME,
  summary: "Roll the database back to a snapshot",
  description: [
    "Restores the newest snapshot with <label> over the live data, replacing each",
    "collection it contains. A safety snapshot (pre-rollback-<label>) of the",
    "collections about to be replaced is taken first. Collections created after the",
    "snapshot are left alone. Asks for confirmation unless --yes.",
  ].join("\n"),
  positionals: [{ name: "label", optional: true, description: "Snapshot label (or use --id)" }],
  options: {
    id: {
      type: "string",
      valueName: "<backup-id>",
      description: "Roll back to this backup id instead of a label",
    },
    uri: {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "The deployment to roll back (default: config source.uri)",
    },
    from: storageFromOption,
    include: includeOption,
    exclude: excludeOption,
    mode: {
      type: "string",
      choices: MODES,
      defaultText: "drop",
      description: "How to put collections back",
    },
    "dry-run": { type: "boolean", description: "Show the plan and stop; write nothing" },
    "no-safety-snapshot": {
      type: "boolean",
      description: "Do not snapshot the live collections before replacing them",
    },
    "skip-erasures": {
      type: "boolean",
      description: "Do not re-apply the GDPR erasure ledger afterwards",
    },
    "identity-file": identityFileOption,
    "passphrase-env": passphraseEnvOption,
  },
  examples: [
    {
      description: "Undo a failed migration",
      command: "mongoshield rollback v42-add-orders-index",
    },
    {
      description: "Preview rolling back just one collection",
      command: "mongoshield rollback v42-add-orders-index --include app.orders --dry-run",
    },
  ],
  run: runRollbackCommand,
};

async function runRollbackCommand(context: CommandContext): Promise<number> {
  const label = context.positionals[0];
  const backupId = context.flags.string("id");
  if ((label === undefined) === (backupId === undefined)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "Name the snapshot: a label or --id.", {
      hint: "Example: mongoshield rollback before-v42. `mongoshield list` shows snapshot labels.",
    });
  }
  const uri = context.flags.string("uri");
  if (uri) rememberUriPassword(context, uri);
  const passphraseVariable = context.flags.string("passphrase-env");
  const passphrase = passphraseVariable
    ? readPassphraseEnv(context, passphraseVariable)
    : undefined;
  const identityFiles = listOrUndefined(context, "identity-file");
  const cli = await createCliShield(context, {
    source: uri ? { uri } : undefined,
    storage: context.flags.string("from"),
    decryption: identityFiles || passphrase ? { identityFiles, passphrase } : undefined,
  });
  try {
    const target = cli.config.source?.uri;
    if (!target) {
      throw new MongoShieldError("MS_CONFIG_INVALID", "No database to roll back is configured.", {
        hint: "Pass --uri, set MONGODB_URI (or MONGOSHIELD_URI), or set source.uri in the config.",
      });
    }
    const include = listOrUndefined(context, "include");
    const exclude = listOrUndefined(context, "exclude");
    const decryption = await decryptionFromConfig(context, cli.config);
    const mode = MODES.find((candidate) => candidate === context.flags.string("mode")) ?? "drop";
    const base = {
      ...(label !== undefined ? { label } : {}),
      ...(backupId !== undefined ? { backupId } : {}),
      mode,
      signal: context.signal,
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
      ...(decryption ? { decryption } : {}),
    };

    const preview = await rollback(cli.shield, { ...base, dryRun: true });
    printPlan(context.out, preview.plan, preview.label, target, cli);
    if (context.flags.boolean("dry-run")) {
      if (context.out.settings.json) context.out.json(preview);
      else context.out.success("Dry run: nothing was written.");
      return 0;
    }

    const safety = !context.flags.boolean("no-safety-snapshot");
    await confirmOrThrow(context, {
      question: `Replace ${plural(preview.plan.entries.length, "collection")} in ${displayUri(target)} with snapshot ${preview.snapshotId}${safety ? " (a safety snapshot is taken first)" : ""}?`,
      action: "roll back",
    });
    const progress = new ProgressDisplay(context.out, "Rolling back");
    try {
      const result = await rollback(cli.shield, {
        ...base,
        safetySnapshot: safety,
        skipErasures: context.flags.boolean("skip-erasures"),
        onProgress: progress.onProgress,
      });
      progress.stop();
      if (context.out.settings.json) {
        context.out.json(result);
        return 0;
      }
      if (result.safetySnapshotId !== undefined) {
        context.out.info(
          `Safety snapshot ${result.safetySnapshotId} holds the data as it was before the rollback.`,
        );
      }
      context.out.result(
        `${context.out.style("green", "✔")} Rolled back ${plural(result.plan.entries.length, "namespace")} to ${result.snapshotId} (${plural(result.restore?.documentsRestored ?? 0, "document")}, ${formatDuration(result.restore?.durationMs ?? 0)}).`,
      );
      return 0;
    } finally {
      progress.stop();
    }
  } finally {
    await cli.shield.close();
  }
}

/** The plan, on stderr: what will be replaced, and with how much. */
function printPlan(
  out: Output,
  plan: RestorePlan,
  label: string | undefined,
  target: string,
  cli: CliShield,
): void {
  if (out.settings.json) return;
  const name = label === undefined ? plan.backupId : `"${label}" (${plan.backupId})`;
  out.info(
    `Rollback plan: snapshot ${out.style("bold", name)} from ${cli.storageLabel} → ${displayUri(target)} (mode: ${plan.mode})`,
  );
  const rows = plan.entries.map((entry) => [
    entry.to,
    entry.type,
    formatCount(entry.documents),
    entry.existingDocuments === undefined ? "?" : formatCount(entry.existingDocuments),
    entry.action,
  ]);
  const table = renderTable(
    [
      { header: "NAMESPACE" },
      { header: "TYPE" },
      { header: "SNAPSHOT DOCS", align: "right" },
      { header: "LIVE DOCS", align: "right" },
      { header: "ACTION" },
    ],
    rows,
    (text) => out.style("dim", text),
  );
  out.info(table);
}
