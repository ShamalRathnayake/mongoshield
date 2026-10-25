/**
 * `mongoshield restore`: restore a backup into a deployment.
 *
 * Restoring is where data gets overwritten, so this command is careful:
 *
 *   1. It always works out and prints the plan first (source → target, documents,
 *      what will happen to each namespace).
 *   2. With the default mode (fail-if-exists) the planner stops if any target has data.
 *   3. Dropping, upserting, or inserting into non-empty collections needs a "yes":
 *      interactively, or with --yes. Without a terminal and without --yes it refuses.
 *   4. --dry-run stops after the plan and writes nothing.
 *   5. When a target already holds documents, every backup file is checksummed before
 *      the first write (`verifyFirst`, see `shouldVerifyFirst`).
 *
 * An incremental backup is restored through its chain: the plan shows the base full
 * backup's namespaces and names the incrementals replayed after it. `--at` with an
 * incremental's id stops inside its chain; `--at` alone uses the change journal, or an
 * incremental chain that reaches the time when the journal does not.
 */

import { findChainCovering } from "../../catalog/chain.ts";
import { selectBackup } from "../../catalog/select.ts";
import type { MongoShieldConfigInput } from "../../config/schema.ts";
import { assertNoConflicts } from "../../engine/restore-plan.ts";
import { isMongoShieldError, MongoShieldError } from "../../errors.ts";
import { type ClusterTime, isIncrementalManifest } from "../../format/manifest.ts";
import { planPointInTimeRestore, toJournalTime } from "../../journal/index.ts";
import type {
  RestoreMode,
  RestoreOptions,
  RestorePlan,
  RestorePlanEntry,
  RestoreResult,
  UsersAndRolesMode,
} from "../../types.ts";
import { usageError } from "../args.ts";
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
  backupSelectorArgument,
  excludeOption,
  identityFileOption,
  includeOption,
  listOrUndefined,
  parseKeyValues,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "restore";

const MODES: readonly RestoreMode[] = ["fail-if-exists", "drop", "insert", "upsert"];

const USERS_AND_ROLES_MODES: readonly UsersAndRolesMode[] = ["skip", "create", "replace"];

export const restoreCommand: CommandSpec = {
  name: NAME,
  summary: "Restore a backup into MongoDB",
  description: [
    "Shows the plan first, then restores. By default nothing is overwritten: the",
    "restore stops if a target collection already has documents. Use --rename to",
    "restore next to the live data, or --mode to replace (drop), add to (insert) or",
    "merge into (upsert) existing collections; those modes ask for confirmation.",
  ].join("\n"),
  positionals: [
    { name: "backup", optional: true, description: 'Backup id, or "latest" (default)' },
  ],
  options: {
    "to-uri": {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "Restore into this deployment (default: the configured source)",
    },
    from: storageFromOption,
    include: includeOption,
    exclude: excludeOption,
    rename: {
      type: "string",
      multiple: true,
      valueName: "<from=to>",
      description: "Restore under another name, e.g. 'app.*=app_restored.*'",
    },
    mode: {
      type: "string",
      choices: MODES,
      defaultText: "fail-if-exists",
      description: "What to do when a target collection already exists",
    },
    drop: { type: "boolean", description: "Same as --mode drop" },
    at: {
      type: "string",
      valueName: "<time>",
      description:
        "Point-in-time recovery: an ISO date (2026-11-14T03:17:42Z) or a cluster time (t:i). Needs the change journal, or an incremental chain reaching that time",
    },
    "dry-run": { type: "boolean", description: "Show the plan and stop; write nothing" },
    "identity-file": identityFileOption,
    "passphrase-env": passphraseEnvOption,
    "skip-indexes": {
      type: "boolean",
      description: "Do not create indexes (faster, for throwaway targets)",
    },
    "skip-search-indexes": {
      type: "boolean",
      description: "Do not recreate Atlas Search / Vector Search indexes",
    },
    "verify-first": {
      type: "boolean",
      description:
        "Check every file's size and SHA-256 before writing anything (default when a target already has documents)",
    },
    "no-verify-first": {
      type: "boolean",
      description: "Skip that check even when targets already have documents",
    },
    "users-and-roles": {
      type: "string",
      choices: USERS_AND_ROLES_MODES,
      defaultText: "skip",
      description:
        "Restore the backup's users and roles: create missing ones, or replace existing ones too",
    },
  },
  examples: [
    {
      description: "Restore the latest backup next to the live data",
      command: "mongoshield restore --rename 'app.*=app_restored.*'",
    },
    {
      description: "Preview restoring one collection into a staging cluster",
      command:
        "mongoshield restore 2026-10-20T03-00-04Z_7f3a9c --include app.users --to-uri $STAGING_URI --dry-run",
    },
    {
      description: "Replace existing collections in a script",
      command: "mongoshield restore latest --drop --yes --identity-file ~/keys/backup.key",
    },
    {
      description: "Restore an incremental's chain as it was at 03:17 (inside the chain)",
      command:
        "mongoshield restore 2026-10-20T04-00-02Z_1a2b3c --at 2026-10-20T03:17:00Z --rename 'app.*=app_restored.*'",
    },
  ],
  run: runRestoreCommand,
};

async function runRestoreCommand(context: CommandContext): Promise<number> {
  const cli = await createCliShield(context, restoreOverrides(context));
  try {
    const targetUri = context.flags.string("to-uri") ?? cli.config.source?.uri;
    if (!targetUri) throw missingTargetError();

    const requested = await restoreOptions(context, cli, targetUri);
    // `--at` inside an incremental chain restores that chain (see the file header).
    const options = await chainForPointInTime(context, cli, requested);
    // For a point-in-time restore, the plan shown is the base backup's plan; the
    // journal replay on top of it is announced separately.
    const plan = await cli.shield.planRestore(await baseRestoreOptions(context, cli, options));
    checkPlan(plan);
    // Show the plan before anything else, even when it is going to be refused:
    // the table is what tells the user which collections are in the way.
    printPlan(context.out, plan, targetUri, cli.storageLabel);
    assertNoConflicts(plan);

    if (options.dryRun) return finishDryRun(context, plan);

    await confirmIfDestructive(context, plan, targetUri);
    const verifyFirst = shouldVerifyFirst(context, plan);
    const result = await restoreWithProgress(context, cli, { ...options, verifyFirst });
    printRestoreResult(context, result);
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/**
 * Whether to checksum every file before writing (`verifyFirst`). Explicit flags win;
 * otherwise it is on exactly when the restore writes into a target that already
 * holds documents (or may: an uncountable target counts as non-empty).
 *
 * Why that default: a damaged file is normally found while it is being restored. Into
 * empty targets that leaves only restored data behind, which `--drop` replaces on the
 * next run. Into existing data (drop, insert, upsert into non-empty collections) it
 * leaves a mix of live and half-restored documents, or a dropped collection, so the
 * extra read of the backup is worth paying there. For empty targets it would double
 * the transfer of every restore for little gain.
 */
function shouldVerifyFirst(context: CommandContext, plan: RestorePlan): boolean {
  const { flags } = context;
  if (flags.boolean("verify-first") && flags.boolean("no-verify-first")) {
    throw usageError("--verify-first contradicts --no-verify-first.", NAME);
  }
  if (flags.boolean("verify-first")) return true;
  if (flags.boolean("no-verify-first")) return false;
  return plan.entries.some(writesIntoExistingData);
}

/** True for plan entries that change or remove documents a target already holds. */
function writesIntoExistingData(entry: RestorePlanEntry): boolean {
  if (entry.existingDocuments === 0) return false;
  return (
    entry.action === "drop-and-create" || entry.action === "insert" || entry.action === "upsert"
  );
}

/** Flags as a config layer: where backups are read from, and decryption secrets. */
function restoreOverrides(context: CommandContext): MongoShieldConfigInput {
  const toUri = context.flags.string("to-uri");
  if (toUri) rememberUriPassword(context, toUri);

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

/** Builds the RestoreOptions shared by the plan and the real run. */
async function restoreOptions(
  context: CommandContext,
  cli: CliShield,
  targetUri: string,
): Promise<RestoreOptions> {
  const { flags } = context;
  const include = listOrUndefined(context, "include");
  const exclude = listOrUndefined(context, "exclude");
  const rename = parseKeyValues(context, NAME, "rename");
  const decryption = await decryptionFromConfig(context, cli.config);

  const at = parseAt(context);
  return {
    backup: backupSelectorArgument(context),
    target: { uri: targetUri },
    ...(at ? { at } : {}),
    mode: restoreMode(context),
    dryRun: flags.boolean("dry-run"),
    skipIndexes: flags.boolean("skip-indexes"),
    skipSearchIndexes: flags.boolean("skip-search-indexes"),
    usersAndRoles:
      USERS_AND_ROLES_MODES.find((mode) => mode === flags.string("users-and-roles")) ?? "skip",
    signal: context.signal,
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
    ...(rename ? { rename } : {}),
    ...(decryption ? { decryption } : {}),
  };
}

/**
 * `--at`: an ISO 8601 date, or an exact cluster time written `t:i`
 * (as shown by `mongoshield journal status`).
 */
function parseAt(context: CommandContext): Date | ClusterTime | undefined {
  const raw = context.flags.string("at");
  if (raw === undefined) return undefined;

  const clusterTime = /^(\d+):(\d+)$/.exec(raw);
  if (clusterTime) return { t: Number(clusterTime[1]), i: Number(clusterTime[2]) };

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw usageError(
      `--at ${raw} is neither a date (2026-11-14T03:17:42Z) nor a cluster time (t:i).`,
      NAME,
    );
  }
  return date;
}

/** `--drop` is shorthand for `--mode drop`; giving both with different modes is a mistake. */
function restoreMode(context: CommandContext): RestoreMode {
  const mode = context.flags.string("mode");
  if (context.flags.boolean("drop")) {
    if (mode !== undefined && mode !== "drop") {
      throw usageError(`--drop contradicts --mode ${mode}.`, NAME);
    }
    return "drop";
  }
  return MODES.find((candidate) => candidate === mode) ?? "fail-if-exists";
}

/**
 * Stops when the filters selected nothing: "restored 0 documents" would look
 * like success to a script. (Conflicts with existing data are reported by the
 * planner itself, with every conflicting namespace listed.)
 */
function checkPlan(plan: RestorePlan): void {
  if (plan.entries.length > 0) return;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `No namespaces in backup ${plan.backupId} match the --include/--exclude filters.`,
    { hint: `Run \`mongoshield inspect ${plan.backupId}\` to see what the backup contains.` },
  );
}

/** The plan table, on stderr (it is context for the decision, not the result). */
function printPlan(out: Output, plan: RestorePlan, targetUri: string, storage: string): void {
  if (out.settings.json) return;
  out.info(
    `Restore plan: backup ${out.style("bold", plan.backupId)} from ${storage} → ${displayUri(targetUri)} (mode: ${plan.mode})`,
  );
  const rows = plan.entries.map((entry) => [
    entry.from,
    "→",
    entry.to,
    entry.type,
    formatCount(entry.documents),
    formatExisting(out, entry.existingDocuments),
    styledAction(out, entry),
  ]);
  const table = renderTable(
    [
      { header: "SOURCE" },
      { header: "" },
      { header: "TARGET" },
      { header: "TYPE" },
      { header: "DOCUMENTS", align: "right" },
      { header: "EXISTING", align: "right" },
      { header: "ACTION" },
    ],
    rows,
    (text) => out.style("dim", text),
  );
  out.info(indent(table));
  const documents = plan.entries.reduce((sum, entry) => sum + entry.documents, 0);
  out.info(`${plural(plan.entries.length, "namespace")}, ${plural(documents, "document")}.`);
  if (plan.chain !== undefined) {
    // The table shows the base backup's documents; the incrementals come on top.
    out.info(
      `Incremental chain: base ${plan.chain.baseBackupId}, then the changes of ${plural(plan.chain.incrementals.length, "incremental backup")} replayed in order${plan.chain.incrementals.length > 0 ? ` (${plan.chain.incrementals.join(", ")})` : ""}.`,
    );
  }
}

/** Destructive actions stand out in red/yellow. */
function styledAction(out: Output, entry: RestorePlanEntry): string {
  switch (entry.action) {
    case "create":
      return out.style("green", "create");
    case "drop-and-create":
      return out.style("red", "drop + create");
    case "insert":
      return out.style("yellow", "insert");
    case "upsert":
      return out.style("yellow", "upsert");
    case "skip":
      return out.style("dim", "skip");
    case "conflict":
      return out.style("red", `conflict: ${entry.reason ?? "target has data"}`);
  }
}

/** Existing documents in the target: highlighted when non-zero, "?" when uncountable. */
function formatExisting(out: Output, existing: number | undefined): string {
  if (existing === undefined) return out.style("yellow", "?");
  return existing > 0 ? out.style("yellow", formatCount(existing)) : "0";
}

function finishDryRun(context: CommandContext, plan: RestorePlan): number {
  if (context.out.settings.json) {
    const result: RestoreResult = { plan, dryRun: true, documentsRestored: 0, durationMs: 0 };
    context.out.json(result);
  } else {
    context.out.success("Dry run: nothing was written.");
  }
  return 0;
}

/**
 * Asks before dropping or upserting, or inserting into collections that
 * already have documents. Plain creates into empty targets need no question.
 */
async function confirmIfDestructive(
  context: CommandContext,
  plan: RestorePlan,
  targetUri: string,
): Promise<void> {
  // An uncountable target (undefined) might hold data, so it counts as non-empty.
  const nonEmpty = plan.entries.filter((entry) => entry.existingDocuments !== 0).length;
  const target = displayUri(targetUri);

  let question: string | undefined;
  if (plan.mode === "drop") {
    question = `Drop and replace ${plural(plan.entries.length, "collection")} in ${target}?`;
  } else if (plan.mode === "upsert") {
    question = `Upsert into ${plural(plan.entries.length, "collection")} in ${target}, replacing documents with the same _id?`;
  } else if (nonEmpty > 0) {
    question = `Insert into ${plural(nonEmpty, "collection")} in ${target} that already have documents?`;
  }
  if (question === undefined) return;

  await confirmOrThrow(context, { question, action: `restore with --mode ${plan.mode}` });
}

async function restoreWithProgress(
  context: CommandContext,
  cli: CliShield,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const progress = new ProgressDisplay(context.out, "Restoring");
  try {
    return await cli.shield.restore({ ...options, onProgress: progress.onProgress });
  } finally {
    progress.stop();
  }
}

function printRestoreResult(context: CommandContext, result: RestoreResult): void {
  const { out } = context;
  if (out.settings.json) {
    out.json(result);
    return;
  }
  // The summary is the command's result, so it goes to stdout.
  out.result(
    `${out.style("green", "✔")} Restored ${plural(result.documentsRestored, "document")} from ${result.plan.backupId} into ${plural(result.plan.entries.length, "namespace")} in ${formatDuration(result.durationMs)}.`,
  );
  const pointInTime = result.pointInTime;
  const chain = result.plan.chain;
  if (pointInTime) {
    const events = chain === undefined ? "journal event" : "change event of the chain";
    out.result(
      `  Replayed ${plural(pointInTime.events, events)}: the data now reflects ${formatClusterTime(pointInTime.restoredTo)}.`,
    );
    for (const warning of pointInTime.warnings) out.warn(warning);
  } else if (chain !== undefined) {
    out.result(
      `  Replayed ${plural(result.eventsReplayed ?? 0, "change event")} of ${plural(chain.incrementals.length, "incremental backup")} on top of base ${chain.baseBackupId}.`,
    );
  }
  printSearchIndexes(out, result);
  printUsersAndRoles(out, result);
}

/** Search indexes created (they finish building on Atlas) or left out. */
function printSearchIndexes(out: Output, result: RestoreResult): void {
  const report = result.searchIndexes;
  if (report === undefined) return;
  if (report.created.length > 0) {
    out.result(
      `  Created ${plural(report.created.length, "search index", "search indexes")}; Atlas builds them in the background.`,
    );
  }
  if (report.notCreated.length > 0) {
    const names = report.notCreated.map((index) => `${index.ns} ${index.name}`).join(", ");
    out.warn(`The target does not support Atlas Search; not created: ${names}.`);
  }
}

/** Users and roles written, and the users who need a new password. */
function printUsersAndRoles(out: Output, result: RestoreResult): void {
  const report = result.usersAndRoles;
  if (report === undefined) return;
  const roles = report.rolesCreated.length + report.rolesReplaced.length;
  const users = report.usersCreated.length + report.usersReplaced.length;
  const kept = report.rolesKept.length + report.usersKept.length;
  out.result(
    `  Restored ${plural(roles, "role")} and ${plural(users, "user")}${kept > 0 ? ` (${kept} already existed and were kept)` : ""}.`,
  );
  if (report.passwordResetRequired.length > 0) {
    out.warn(
      `The target did not accept password hashes. These users got a random password and need a password reset: ${report.passwordResetRequired.join(", ")}.`,
    );
  }
}

/**
 * The options to plan with: unchanged for a normal restore; for `--at`, the base
 * backup the journal planner picks (which also fails early on journal gaps).
 */
async function baseRestoreOptions(
  context: CommandContext,
  cli: CliShield,
  options: RestoreOptions,
): Promise<RestoreOptions> {
  if (options.at === undefined) return options;
  // An incremental's chain is cut at `at` by the planner itself (chainForPointInTime
  // only lets incremental ids through).
  if (options.backup !== "latest") return options;
  const pointInTime = await planPointInTimeRestore(cli.shield.storage, options.at, {
    signal: context.signal,
  });
  context.out.info(
    `Point in time: base backup ${pointInTime.baseBackupId}, then ${pointInTime.segments.length} journal segment(s) replayed up to ${formatClusterTime(pointInTime.at)}.`,
  );
  const { at: _at, ...rest } = options;
  return { ...rest, backup: pointInTime.baseBackupId };
}

/**
 * `--at` and incremental chains: with an incremental's id, its chain is restored up to
 * `--at` (a full backup's id is refused: it can only be restored as it is). With
 * `latest`, the change journal is used when it reaches `--at`; when it does not, an
 * incremental chain that reaches it is used instead. Returns the options to plan and
 * restore with.
 */
async function chainForPointInTime(
  context: CommandContext,
  cli: CliShield,
  options: RestoreOptions,
): Promise<RestoreOptions> {
  const at = options.at;
  if (at === undefined) return options;
  const entries = await cli.shield.list({ signal: context.signal });
  if (options.backup !== "latest") {
    const selected = selectBackup(entries, options.backup).manifest;
    if (selected === undefined || !isIncrementalManifest(selected)) {
      throw usageError(
        "--at with a backup id needs an incremental backup (its chain is restored up to --at); for full backups leave out the id: --at picks its base backup itself.",
        NAME,
      );
    }
    context.out.info(
      `Point in time: the chain of ${selected.id} (base ${selected.chain.base}) up to ${formatClusterTime(toJournalTime(at))}.`,
    );
    return options;
  }
  try {
    await planPointInTimeRestore(cli.shield.storage, at, { signal: context.signal });
    return options;
  } catch (error) {
    if (!isMongoShieldError(error, "MS_CHANGE_HISTORY_LOST")) throw error;
    const covering = findChainCovering(entries, toJournalTime(at));
    if (covering === undefined) throw error;
    context.out.info(
      `Point in time: the journal does not reach it; using the chain of ${covering.id} (base ${covering.chain.base}).`,
    );
    return { ...options, backup: covering.id };
  }
}

/** `{ t: 1794538804, i: 3 }` → `2026-11-14T03:00:04Z (1794538804:3)`. */
function formatClusterTime(time: ClusterTime): string {
  return `${new Date(time.t * 1000).toISOString().replace(".000", "")} (${time.t}:${time.i})`;
}

function missingTargetError(): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", "No restore target is configured.", {
    hint: "Pass --to-uri, set MONGODB_URI (or MONGOSHIELD_URI), or set source.uri in mongoshield.config.ts.",
  });
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
