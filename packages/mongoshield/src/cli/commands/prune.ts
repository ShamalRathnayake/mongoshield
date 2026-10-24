/**
 * `mongoshield prune`: delete backups the retention policy no longer needs.
 *
 * The policy comes from the flags if any count flag is given, otherwise from
 * the config file's `retention` section. The plan (what is kept and why, what
 * is removed and why) is always printed first; deleting needs --yes or an
 * interactive "yes". All decisions are made by the catalog's retention planner,
 * which never removes the newest backup, held backups, or invalid ones.
 */

import type { PruneResult } from "../../catalog/prune.ts";
import { hasAnyCount, type RetentionPlan, type RetentionPolicy } from "../../catalog/retention.ts";
import type { MongoShieldConfig } from "../../config/schema.ts";
import { MongoShieldError } from "../../errors.ts";
import type { CommandContext, CommandSpec, OptionSpec } from "../command.ts";
import { confirmOrThrow } from "../confirm.ts";
import { formatBytes, plural } from "../format.ts";
import type { Output } from "../io.ts";
import { createCliShield } from "../setup.ts";
import { renderTable } from "../table.ts";
import { storageFromOption } from "./shared-options.ts";

/** The count flags, in the order they are applied (finest period first). */
const COUNT_FLAGS = ["last", "hourly", "daily", "weekly", "monthly", "yearly"] as const;

function countOption(description: string): OptionSpec {
  return { type: "string", valueName: "<n>", description };
}

export const pruneCommand: CommandSpec = {
  name: "prune",
  summary: "Delete backups that the retention policy no longer keeps",
  description: [
    "Keeps the newest backup of each period (like restic/borg --keep-*). The newest",
    "backup, held backups and invalid backups are never removed. Without count flags",
    "the policy comes from `retention` in mongoshield.config.ts.",
  ].join("\n"),
  options: {
    last: countOption("Keep the N newest backups"),
    hourly: countOption("Keep the newest backup of each of the last N hours"),
    daily: countOption("Keep the newest backup of each of the last N days"),
    weekly: countOption("Keep the newest backup of each of the last N ISO weeks"),
    monthly: countOption("Keep the newest backup of each of the last N months"),
    yearly: countOption("Keep the newest backup of each of the last N years"),
    "min-verified": countOption("Always keep at least N verified backups"),
    "dry-run": { type: "boolean", description: "Show the plan and delete nothing" },
    from: storageFromOption,
  },
  examples: [
    { description: "Preview the configured policy", command: "mongoshield prune --dry-run" },
    {
      description: "Keep 7 dailies, 4 weeklies and 12 monthlies, without prompting",
      command: "mongoshield prune --daily 7 --weekly 4 --monthly 12 --yes",
    },
  ],
  run: runPruneCommand,
};

async function runPruneCommand(context: CommandContext): Promise<number> {
  const cli = await createCliShield(context, { storage: context.flags.string("from") });
  try {
    const policy = retentionPolicy(context, cli.config);
    // One clock for planning and deleting, so both runs make the same decisions.
    const now = new Date();
    const dryRun = context.flags.boolean("dry-run");

    const preview = await cli.shield.prune(policy, { dryRun: true, now, signal: context.signal });
    printPlan(context.out, preview.plan);

    if (dryRun || preview.plan.remove.length === 0) {
      printResult(context, policy, preview);
      return 0;
    }

    const count = plural(preview.plan.remove.length, "backup");
    await confirmOrThrow(context, {
      question: `Permanently delete ${count} from ${cli.storageLabel}?`,
      action: `delete ${count}`,
    });
    const result = await cli.shield.prune(policy, { dryRun: false, now, signal: context.signal });
    printResult(context, policy, result);
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** A policy under construction; every field is set only when it has a value. */
type MutablePolicy = { -readonly [Field in keyof RetentionPolicy]: RetentionPolicy[Field] };

/**
 * Count flags, when any is given, replace the config's counts entirely (mixing
 * two policies is confusing). `--min-verified` overrides the config's value.
 */
function retentionPolicy(context: CommandContext, config: MongoShieldConfig): RetentionPolicy {
  const { flags } = context;
  const fromFlags: MutablePolicy = {};
  for (const name of COUNT_FLAGS) {
    const value = flags.integer(name, { min: 1 });
    if (value !== undefined) fromFlags[name] = value;
  }

  const policy = Object.keys(fromFlags).length > 0 ? fromFlags : configCounts(config);
  const minVerified = flags.integer("min-verified", { min: 0 }) ?? config.retention?.minVerified;
  if (minVerified !== undefined) policy.minVerified = minVerified;

  if (!hasAnyCount(policy)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "No retention policy is configured.", {
      hint: "Pass counts such as --daily 7 --weekly 4, or set `retention` in mongoshield.config.ts.",
    });
  }
  return policy;
}

/** The count fields of the config's `retention` section that are set. */
function configCounts(config: MongoShieldConfig): MutablePolicy {
  const counts: MutablePolicy = {};
  for (const name of COUNT_FLAGS) {
    const value = config.retention?.[name];
    if (value !== undefined) counts[name] = value;
  }
  return counts;
}

/** Every backup, newest first, with keep/remove and the reasons. */
function printPlan(out: Output, plan: RetentionPlan): void {
  if (out.settings.json) return;
  for (const warning of plan.warnings) out.warn(warning);

  const rows: { id: string; cells: string[] }[] = [];
  for (const kept of plan.keep) {
    rows.push({
      id: kept.id,
      cells: [kept.id, out.style("green", "keep"), kept.reasons.join(", ")],
    });
  }
  for (const removed of plan.remove) {
    rows.push({ id: removed.id, cells: [removed.id, out.style("red", "remove"), removed.reason] });
  }
  if (rows.length === 0) {
    out.info("There are no backups to prune.");
    return;
  }
  // Ids begin with the UTC start time, so string order is chronological.
  rows.sort((a, b) => (a.id < b.id ? 1 : -1));

  out.info(
    renderTable(
      [{ header: "BACKUP" }, { header: "DECISION" }, { header: "WHY" }],
      rows.map((row) => row.cells),
      (text) => out.style("dim", text),
    ),
  );
}

function printResult(context: CommandContext, policy: RetentionPolicy, result: PruneResult): void {
  const { out } = context;
  if (out.settings.json) {
    out.json({ policy, ...result });
    return;
  }
  const removing = result.plan.remove.length;
  if (removing === 0) {
    out.result(`${out.style("green", "✔")} Nothing to prune: every backup is kept.`);
    return;
  }
  if (result.dryRun) {
    out.result(`Dry run: would delete ${plural(removing, "backup")}. Nothing was deleted.`);
    return;
  }
  out.result(
    `${out.style("green", "✔")} Deleted ${plural(result.deletedBackups, "backup")} (${plural(result.deletedObjects, "object")}, ${formatBytes(result.deletedBytes)}).`,
  );
  if (result.skipped.length > 0) {
    out.warn(`Skipped ${result.skipped.join(", ")}: completed while pruning, so it was kept.`);
  }
}
