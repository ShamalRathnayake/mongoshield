/**
 * `mongoshield prune`: delete backups the retention policy no longer needs.
 *
 * The policy comes from the flags if any count flag is given, otherwise from
 * the config file's `retention` section. The plan (what is kept and why, what
 * is removed and why) is always printed first; deleting needs --yes or an
 * interactive "yes". All decisions are made by the catalog's retention planner,
 * which never removes the newest backup, held backups, or invalid ones.
 *
 * ## Scope: whose backups
 *
 * A storage location is often shared (two jobs for different databases or
 * clusters, a nightly full backup next to an hourly one of one collection).
 * By default the policy only covers the backups of the configured source and
 * selection, exactly like the scheduler's automatic prune:
 *
 *   cluster  the source deployment's `clusterId` (connects to `source.uri` /
 *            --uri to read it). Without a source it is inferred from the
 *            matching backups, and prune refuses when several deployments match.
 *   labels   the `mongoshield.shape` label of the include/exclude selection
 *            (config `backup` section or --include/--exclude), or the config's
 *            `retention.scopeLabels` (the labels `mongoshield run` marks and prunes
 *            its backups by), or the --scope-label pairs instead of either.
 *
 * Every other backup is left alone and counted in the output. `--all-sources`
 * applies the policy to the whole location (the old behaviour) and always asks
 * for confirmation, listing what it would delete per source/selection.
 */

import type { CatalogEntry } from "../../catalog/catalog.ts";
import type { PruneResult } from "../../catalog/prune.ts";
import { hasAnyCount, type RetentionPlan, type RetentionPolicy } from "../../catalog/retention.ts";
import { describeScope, isInScope, PLAN_LABEL, type PruneScope } from "../../catalog/scope.ts";
import type { MongoShieldConfig, MongoShieldConfigInput } from "../../config/schema.ts";
import { backupShapeLabel, GUARD_SHAPE_LABEL } from "../../engine/backup-guard.ts";
import { MongoShieldError } from "../../errors.ts";
import type { CommandContext, CommandSpec, OptionSpec } from "../command.ts";
import { confirmOrThrow } from "../confirm.ts";
import { formatBytes, plural } from "../format.ts";
import type { Output } from "../io.ts";
import { type CliShield, createCliShield, rememberUriPassword } from "../setup.ts";
import { renderTable } from "../table.ts";
import {
  assertNotBoth,
  excludeOption,
  includeOption,
  listOrUndefined,
  parseKeyValues,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "prune";

/** The count flags, in the order they are applied (finest period first). */
const COUNT_FLAGS = ["last", "hourly", "daily", "weekly", "monthly", "yearly"] as const;

function countOption(description: string): OptionSpec {
  return { type: "string", valueName: "<n>", description };
}

export const pruneCommand: CommandSpec = {
  name: NAME,
  summary: "Delete backups that the retention policy no longer keeps",
  description: [
    "Keeps the newest backup of each period (like restic/borg --keep-*). The newest",
    "backup, held backups and invalid backups are never removed. Without count flags",
    "the policy comes from `retention` in mongoshield.config.ts.",
    "",
    "Only the backups of the configured source and selection (include/exclude) are",
    "pruned; backups of other sources or selections in the same storage are left",
    "alone. --all-sources applies the policy to every backup in the storage.",
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
    uri: {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "Source whose backups to prune (default: config source.uri, MONGODB_URI)",
    },
    include: {
      ...includeOption,
      description: "The selection whose backups to prune (as backed up)",
    },
    exclude: {
      ...excludeOption,
      description: "The selection whose backups to prune (as backed up)",
    },
    "scope-label": {
      type: "string",
      multiple: true,
      valueName: "<key=value>",
      description: "Prune only backups with this label, instead of the selection's shape",
    },
    "all-sources": {
      type: "boolean",
      description: "Apply the policy to every backup in the storage, whoever wrote it",
    },
  },
  examples: [
    { description: "Preview the configured policy", command: "mongoshield prune --dry-run" },
    {
      description: "Keep 7 dailies, 4 weeklies and 12 monthlies, without prompting",
      command: "mongoshield prune --daily 7 --weekly 4 --monthly 12 --yes",
    },
    {
      description: "Prune the backups of one selection in a shared bucket",
      command: "mongoshield prune --include 'app.orders' --last 24 --from s3://acme-backups/prod",
    },
    {
      description: "Prune the backups labelled team=billing",
      command: "mongoshield prune --scope-label team=billing --daily 7",
    },
    {
      description: "Apply one policy to every backup in the storage (asks first)",
      command: "mongoshield prune --all-sources --daily 7",
    },
  ],
  run: runPruneCommand,
};

async function runPruneCommand(context: CommandContext): Promise<number> {
  const cli = await createCliShield(context, pruneOverrides(context));
  try {
    const policy = retentionPolicy(context, cli.config);
    // One clock for planning and deleting, so both runs make the same decisions.
    const now = new Date();
    const dryRun = context.flags.boolean("dry-run");
    const allSources = context.flags.boolean("all-sources");
    const scope = allSources ? undefined : await resolveScope(context, cli);
    const scoped = scope === undefined ? {} : { scope };

    const preview = await cli.shield.prune(policy, {
      dryRun: true,
      now,
      signal: context.signal,
      ...scoped,
    });
    printScope(context.out, scope);
    printPlan(context.out, preview.plan);

    if (dryRun || preview.plan.remove.length === 0) {
      printResult(context, policy, scope, preview);
      return 0;
    }

    const count = plural(preview.plan.remove.length, "backup");
    if (allSources) {
      // The whole location: show whose backups go, so nobody deletes another
      // team's backups by accident. This always asks (or needs --yes).
      const groups = await removalsBySource(cli, preview.plan);
      printRemovalsBySource(context.out, groups);
      await confirmOrThrow(context, {
        question: `Permanently delete ${count} of ${plural(groups.length, "source/selection", "sources/selections")} from ${cli.storageLabel}?`,
        action: `delete ${count} across all sources`,
      });
    } else {
      await confirmOrThrow(context, {
        question: `Permanently delete ${count} from ${cli.storageLabel}?`,
        action: `delete ${count}`,
      });
    }
    const result = await cli.shield.prune(policy, {
      dryRun: false,
      now,
      signal: context.signal,
      ...scoped,
    });
    printResult(context, policy, scope, result);
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** The flags as a config layer: storage, the source and the selection to scope by. */
function pruneOverrides(context: CommandContext): MongoShieldConfigInput {
  const { flags } = context;
  for (const flag of ["scope-label", "include", "exclude", "uri"]) {
    assertNotBoth(context, NAME, "all-sources", flag);
  }
  assertNotBoth(context, NAME, "scope-label", "include");
  assertNotBoth(context, NAME, "scope-label", "exclude");

  const uri = flags.string("uri");
  if (uri) rememberUriPassword(context, uri);
  const include = listOrUndefined(context, "include");
  const exclude = listOrUndefined(context, "exclude");
  return {
    storage: flags.string("from"),
    source: uri ? { uri } : undefined,
    // Only given flags replace the config's selection; the config's other
    // `backup` settings do not matter here.
    backup: include || exclude ? { include, exclude } : undefined,
  };
}

/**
 * The default scope (see the file header): the source's cluster and the
 * selection's shape label, or the config's `retention.scopeLabels` (the same scope
 * `mongoshield run` prunes), or the --scope-label pairs instead of the shape.
 */
async function resolveScope(context: CommandContext, cli: CliShield): Promise<PruneScope> {
  const configured = cli.config.retention?.scopeLabels;
  const custom =
    parseKeyValues(context, NAME, "scope-label") ??
    // Empty labels would widen the scope to the whole deployment: same as unset.
    (configured !== undefined && Object.keys(configured).length > 0 ? configured : undefined);
  const labels = custom ?? {
    [GUARD_SHAPE_LABEL]: backupShapeLabel(cli.config.backup ?? {}),
  };
  const clusterId = cli.config.source?.uri
    ? await cli.shield.sourceClusterId({ signal: context.signal })
    : await inferClusterId(context, cli, labels);
  return clusterId === undefined ? { labels } : { clusterId, labels };
}

/**
 * Without a source to ask, the deployment is read from the backups that match
 * `labels`: if they all come from one deployment, that is the one. If they come
 * from several, pruning them as one series would let one cluster's backups push
 * out another's, so prune refuses and asks which one is meant.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when several deployments match.
 */
async function inferClusterId(
  context: CommandContext,
  cli: CliShield,
  labels: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const deployments = new Set<string | undefined>();
  for (const entry of await cli.shield.list({ signal: context.signal })) {
    const manifest = entry.manifest;
    if (manifest === undefined) continue;
    if (isInScope({ clusterId: manifest.source.clusterId, labels: manifest.labels }, { labels })) {
      deployments.add(manifest.source.clusterId);
    }
  }
  if (deployments.size > 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Backups of ${deployments.size} deployments in ${cli.storageLabel} match ${describeScope({ labels })}, and no source is configured to say which one to prune.`,
      {
        hint: "Pass --uri (or set source.uri) to prune one deployment's backups, or --all-sources to apply the policy to every backup there.",
      },
    );
  }
  const [only] = deployments;
  return only;
}

/** One source/selection and the backups `--all-sources` would delete from it. */
interface SourceRemovals {
  readonly source: string;
  readonly ids: string[];
}

/** Groups the backups a whole-location plan removes by where they came from. */
async function removalsBySource(cli: CliShield, plan: RetentionPlan): Promise<SourceRemovals[]> {
  const entries = new Map((await cli.shield.list()).map((entry) => [entry.id, entry]));
  const groups = new Map<string, string[]>();
  for (const removed of plan.remove) {
    const source = sourceOf(entries.get(removed.id));
    const ids = groups.get(source) ?? [];
    ids.push(removed.id);
    groups.set(source, ids);
  }
  return [...groups].map(([source, ids]) => ({ source, ids }));
}

/** `cluster 3f9a… · shape 1c2d…` for a backup, or what is unknown about it. */
function sourceOf(entry: CatalogEntry | undefined): string {
  const manifest = entry?.manifest;
  if (manifest === undefined) return "incomplete runs (source not recorded)";
  const parts = [
    manifest.source.clusterId === undefined
      ? "unknown cluster"
      : `cluster ${manifest.source.clusterId}`,
  ];
  const plan = manifest.labels[PLAN_LABEL];
  if (plan !== undefined) parts.push(`plan ${plan}`);
  const shape = manifest.labels[GUARD_SHAPE_LABEL];
  parts.push(shape === undefined ? "no selection label" : `selection ${shape}`);
  return parts.join(" · ");
}

/** The per-source table shown before an `--all-sources` confirmation. */
function printRemovalsBySource(out: Output, groups: readonly SourceRemovals[]): void {
  if (out.settings.json) return;
  out.info("Backups to delete, by source/selection:");
  out.info(
    renderTable(
      [{ header: "SOURCE / SELECTION" }, { header: "DELETE" }, { header: "BACKUPS" }],
      groups.map((group) => [group.source, String(group.ids.length), group.ids.join(", ")]),
      (text) => out.style("dim", text),
    ),
  );
}

/** Says which backups the policy covers. */
function printScope(out: Output, scope: PruneScope | undefined): void {
  if (out.settings.json) return;
  out.info(
    scope === undefined
      ? "Applying the policy to every backup in the storage (--all-sources)."
      : `Applying the policy to backups of ${describeScope(scope)}.`,
  );
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

function printResult(
  context: CommandContext,
  policy: RetentionPolicy,
  scope: PruneScope | undefined,
  result: PruneResult,
): void {
  const { out } = context;
  if (out.settings.json) {
    out.json({ policy, scope: scope ?? null, ...result });
    return;
  }
  const removing = result.plan.remove.length;
  if (removing === 0) {
    out.result(`${out.style("green", "✔")} Nothing to prune: every backup is kept.`);
  } else if (result.dryRun) {
    out.result(`Dry run: would delete ${plural(removing, "backup")}. Nothing was deleted.`);
  } else {
    out.result(
      `${out.style("green", "✔")} Deleted ${plural(result.deletedBackups, "backup")} (${plural(result.deletedObjects, "object")}, ${formatBytes(result.deletedBytes)}).`,
    );
    if (result.skipped.length > 0) {
      out.warn(`Skipped ${result.skipped.join(", ")}: completed while pruning, so it was kept.`);
    }
  }
  printOutOfScope(out, result);
}

/** "12 backups of other sources/selections were left alone", and why some are. */
function printOutOfScope(out: Output, result: PruneResult): void {
  const count = result.outOfScope.length;
  if (count === 0) return;
  out.result(
    `${plural(count, "backup")} of other sources/selections ${count === 1 ? "was" : "were"} left alone.`,
  );
  const unattributed = result.outOfScope.filter((backup) => backup.reason === "unattributed");
  if (unattributed.length > 0) {
    out.info(
      `${plural(unattributed.length, "incomplete run")} among them cannot be attributed to a source; \`mongoshield prune --all-sources\` removes ${unattributed.length === 1 ? "it" : "them"} once idle.`,
    );
  }
}
