/**
 * `mongoshield copy`: copy namespaces from one deployment straight into another,
 * optionally masking and subsetting them on the way. `pull` (pull.ts) is the same
 * flow with safe defaults for local development, and reuses everything here.
 *
 * Like restore, copying writes into a live deployment, so the command is careful:
 *
 *   1. It always plans first (a dry run of the engine) and prints the plan:
 *      source → target, documents, how each namespace is selected and masked.
 *   2. With the default mode (fail-if-exists) any target holding data stops the copy.
 *   3. Dropping, upserting, or inserting into non-empty collections needs a "yes":
 *      interactively, or with --yes. Without a terminal and without --yes it refuses.
 *   4. --dry-run stops after the plan and writes nothing.
 *   5. Progress is checkpointed in a local file (`.mongoshield/copy-<id>.json` in the
 *      working directory, or --checkpoint <file>), so an interrupted copy continues
 *      with the same command plus --resume. The file is deleted when the copy completes.
 *
 * Copying needs no backup storage, so unlike most commands it works without one
 * configured.
 */

import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MongoShieldConfigInput } from "../../config/schema.ts";
import { assertNoCopyConflicts, planCopy, runCopy } from "../../copy/index.ts";
import { loadMaskFile, loadSubsetFile } from "../../copy/load-file.ts";
import { MongoShieldError } from "../../errors.ts";
import type { MaskConfig } from "../../mask/index.ts";
import { openConnection } from "../../mongo/index.ts";
import type { SubsetConfig } from "../../subset/index.ts";
import type { CopyOptions, CopyPlan, CopyPlanEntry, CopyResult, RestoreMode } from "../../types.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec, OptionSpec } from "../command.ts";
import { confirmOrThrow } from "../confirm.ts";
import { formatCount, formatDuration, plural } from "../format.ts";
import type { Output } from "../io.ts";
import { ProgressDisplay } from "../progress.ts";
import { createCliLogger, displayUri, loadCliConfig, rememberUriPassword } from "../setup.ts";
import { renderTable } from "../table.ts";
import { excludeOption, includeOption, listOrUndefined, parseKeyValues } from "./shared-options.ts";

const NAME = "copy";

const MODES: readonly RestoreMode[] = ["fail-if-exists", "drop", "insert", "upsert"];

/** Where the masking secret is read from when the mask file sets none. */
export const DEFAULT_MASK_SECRET_ENV = "MONGOSHIELD_MASK_SECRET";

/**
 * Copying never touches backup storage, but the config schema requires a storage
 * location. This placeholder satisfies validation without changing anything copy
 * uses (only `source.uri` is read from the config).
 */
const STORAGE_NOT_USED = "memory://copy-uses-no-storage";

/** The options `copy` and `pull` share, defined once so they read the same everywhere. */
export const COPY_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  from: {
    type: "string",
    valueName: "<mongodb-uri>",
    description: "Copy from this deployment (default: the configured source / MONGODB_URI)",
  },
  include: includeOption,
  exclude: excludeOption,
  rename: {
    type: "string",
    multiple: true,
    valueName: "<from=to>",
    description: "Copy under another name, e.g. 'app.*=app_staging.*'",
  },
  mask: {
    type: "string",
    valueName: "<file>",
    description: "Mask file (e.g. ./mask.ts) applied to every document on its way",
  },
  "mask-secret-env": {
    type: "string",
    valueName: "<VAR>",
    defaultText: DEFAULT_MASK_SECRET_ENV,
    description: "Read the masking secret from this variable when the mask file sets none",
  },
  subset: {
    type: "string",
    valueName: "<file>",
    description: "Subset file (e.g. ./subset.ts): filters, and references to follow",
  },
  mode: {
    type: "string",
    choices: MODES,
    defaultText: "fail-if-exists",
    description: "What to do when a target collection already exists",
  },
  drop: { type: "boolean", description: "Same as --mode drop" },
  "dry-run": { type: "boolean", description: "Show the plan and stop; write nothing" },
  parallelism: {
    type: "string",
    valueName: "<n>",
    defaultText: "4",
    description: "Collections copied at the same time (1–64)",
  },
  "skip-indexes": {
    type: "boolean",
    description: "Do not create indexes (faster, for throwaway targets)",
  },
  "skip-search-indexes": {
    type: "boolean",
    description: "Do not recreate Atlas Search / Vector Search indexes on the target",
  },
  resume: {
    type: "boolean",
    description: "Continue an interrupted copy from its checkpoint (same options as before)",
  },
  checkpoint: {
    type: "string",
    valueName: "<file>",
    defaultText: ".mongoshield/copy-<id>.json",
    description: "Where the copy records its progress for --resume",
  },
};

/** Directory (under the working directory) of the default checkpoint files. */
export const CHECKPOINT_DIRECTORY = ".mongoshield";

/** `mongoshield copy`: see the file header. */
export const copyCommand: CommandSpec = {
  name: NAME,
  summary: "Copy databases between deployments, with masking and subsetting",
  description: [
    "Streams documents from --from straight into --to; nothing is stored in between.",
    "Shows the plan first. By default nothing is overwritten: the copy stops if a",
    "target collection already has documents. --mask anonymises documents on the way",
    "(deterministically, so references still match), --subset copies a consistent slice.",
  ].join("\n"),
  options: {
    ...COPY_OPTIONS,
    to: {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "Copy into this deployment (required)",
    },
  },
  examples: [
    {
      description: "Refresh staging from production, masked",
      command:
        "mongoshield copy --from $PROD_URI --to $STAGING_URI --include 'app.*' --mask ./mask.ts --drop",
    },
    {
      description: "Copy a recent slice under a new name in the same cluster",
      command:
        "mongoshield copy --to $MONGODB_URI --rename 'app.*=app_sample.*' --subset ./subset.ts",
    },
    {
      description: "Preview what would be copied",
      command: "mongoshield copy --to $STAGING_URI --mask ./mask.ts --dry-run",
    },
  ],
  run: async (context) => {
    const targetUri = context.flags.string("to");
    if (!targetUri) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        "Where to? `copy` needs --to <mongodb-uri>.",
        {
          hint: "For a local development copy, `mongoshield pull` defaults to mongodb://localhost:27017.",
        },
      );
    }
    const sourceUri = await resolveSourceUri(context);
    return runCopyFlow(context, {
      name: NAME,
      sourceUri,
      targetUri,
      mask: await maskFromFlags(context),
      subset: await subsetFromFlags(context),
    });
  },
};

/** What `runCopyFlow` needs besides the shared flags. */
export interface CopyFlowSettings {
  /** The command name, for messages. */
  readonly name: string;
  readonly sourceUri: string;
  readonly targetUri: string;
  readonly mask: MaskConfig | undefined;
  readonly subset: SubsetConfig | undefined;
}

/** Plan → print → (dry run | confirm → copy with progress → summary). Shared with `pull`. */
export async function runCopyFlow(
  context: CommandContext,
  settings: CopyFlowSettings,
): Promise<number> {
  rememberUriPassword(context, settings.targetUri);
  const options = copyOptions(context, settings);
  const logger = createCliLogger(context.out);
  const source = await openConnection({ uri: settings.sourceUri }, { logger });
  try {
    const target = await openConnection({ uri: settings.targetUri }, { logger });
    try {
      const copyContext = { source: source.client, target: target.client, logger };
      await mentionInterruptedCopy(context, options);
      // Show the plan before anything else, even when it is going to be refused:
      // the table is what tells the user which collections are in the way.
      const plan = await planCopy(copyContext, options);
      printPlan(context.out, plan, settings);
      assertNoCopyConflicts(plan);
      if (options.dryRun === true) {
        // The engine's dry run adds the pre-flight checks (privileges) to the plan.
        return finishDryRun(context, await runCopy(copyContext, options));
      }

      await confirmIfDestructive(context, plan, settings);
      const progress = new ProgressDisplay(context.out, "Copying");
      let result: CopyResult;
      try {
        result = await runCopy(copyContext, { ...options, onProgress: progress.onProgress });
      } finally {
        progress.stop();
      }
      printResult(context, result);
      return 0;
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

/** The source: --from, else the configured source (config file, MONGOSHIELD_URI, MONGODB_URI). */
export async function resolveSourceUri(context: CommandContext): Promise<string> {
  const from = context.flags.string("from");
  const overrides: MongoShieldConfigInput = {
    storage: STORAGE_NOT_USED,
    source: from ? { uri: from } : undefined,
  };
  const { config } = await loadCliConfig(context, overrides);
  const uri = config.source?.uri;
  if (!uri) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "Copy from where? No source is configured.", {
      hint: "Pass --from <mongodb-uri>, set MONGODB_URI (or MONGOSHIELD_URI), or set source.uri in mongoshield.config.ts.",
    });
  }
  return uri;
}

/** Loads --mask, filling in the secret from the environment when the file has none. */
export async function maskFromFlags(context: CommandContext): Promise<MaskConfig | undefined> {
  const file = context.flags.string("mask");
  if (file === undefined) return undefined;
  const mask = await loadMaskFile(file, context.io.cwd);
  const variable = context.flags.string("mask-secret-env") ?? DEFAULT_MASK_SECRET_ENV;
  const secret = mask.secret ?? context.io.env[variable];
  // The secret must never appear in output, whatever goes wrong.
  if (secret) context.addSecret(secret);
  return secret ? { ...mask, secret } : mask;
}

/** Loads --subset. */
export async function subsetFromFlags(context: CommandContext): Promise<SubsetConfig | undefined> {
  const file = context.flags.string("subset");
  return file === undefined ? undefined : loadSubsetFile(file, context.io.cwd);
}

/** The engine options shared by the plan and the real run. */
function copyOptions(context: CommandContext, settings: CopyFlowSettings): Omit<CopyOptions, "to"> {
  const { flags } = context;
  const include = listOrUndefined(context, "include");
  const exclude = listOrUndefined(context, "exclude");
  const rename = parseKeyValues(context, settings.name, "rename");
  const parallelism = flags.integer("parallelism", { min: 1, max: 64 });
  return {
    mode: copyMode(context, settings.name),
    dryRun: flags.boolean("dry-run"),
    skipIndexes: flags.boolean("skip-indexes"),
    skipSearchIndexes: flags.boolean("skip-search-indexes"),
    checkpoint: checkpointPath(context, settings),
    resume: flags.boolean("resume"),
    signal: context.signal,
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
    ...(rename ? { rename } : {}),
    ...(parallelism === undefined ? {} : { parallelism }),
    ...(settings.mask ? { mask: settings.mask } : {}),
    ...(settings.subset ? { subset: settings.subset } : {}),
  };
}

/**
 * The checkpoint file: --checkpoint, or one per copy under `.mongoshield/`, named by a
 * hash of what identifies the copy: both connection strings without their passwords
 * (rotating a password does not lose the checkpoint, and the name reveals no host
 * names) and the namespaces it copies (--include, --exclude, --rename), so two
 * different copies between the same deployments never share a file.
 */
export function checkpointPath(context: CommandContext, settings: CopyFlowSettings): string {
  const explicit = context.flags.string("checkpoint");
  if (explicit !== undefined) return resolve(context.io.cwd, explicit);
  const identity = JSON.stringify([
    displayUri(settings.sourceUri),
    displayUri(settings.targetUri),
    [...(listOrUndefined(context, "include") ?? [])].sort(),
    [...(listOrUndefined(context, "exclude") ?? [])].sort(),
    parseKeyValues(context, settings.name, "rename") ?? {},
  ]);
  const id = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16);
  return join(context.io.cwd, CHECKPOINT_DIRECTORY, `copy-${id}.json`);
}

/**
 * Before a fresh copy over an interrupted one, says that it could be resumed instead:
 * the targets the interrupted copy filled usually show up as conflicts next.
 */
async function mentionInterruptedCopy(
  context: CommandContext,
  options: Omit<CopyOptions, "to">,
): Promise<void> {
  if (options.resume === true || options.checkpoint === undefined) return;
  const found = await access(options.checkpoint).then(
    () => true,
    () => false,
  );
  if (found) {
    context.out.warn(
      `An interrupted copy left a checkpoint (${options.checkpoint}); add --resume to continue it. Copying from the start replaces it.`,
    );
  }
}

/** `--drop` is shorthand for `--mode drop`; giving both with different modes is a mistake. */
function copyMode(context: CommandContext, name: string): RestoreMode {
  const mode = context.flags.string("mode");
  if (context.flags.boolean("drop")) {
    if (mode !== undefined && mode !== "drop") {
      throw usageError(`--drop contradicts --mode ${mode}.`, name);
    }
    return "drop";
  }
  return MODES.find((candidate) => candidate === mode) ?? "fail-if-exists";
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** The plan table, on stderr (it is context for the decision, not the result). */
function printPlan(out: Output, plan: CopyPlan, settings: CopyFlowSettings): void {
  if (out.settings.json) return;
  out.info(
    `Copy plan: ${displayUri(settings.sourceUri)} → ${displayUri(settings.targetUri)} (mode: ${plan.mode})`,
  );
  const rows = plan.entries.map((entry) => [
    entry.from,
    "→",
    entry.to,
    entry.type,
    formatCount(entry.documents),
    formatExisting(out, entry.existingDocuments),
    entry.subset === "all" ? "all" : out.style("cyan", entry.subset),
    entry.masked.length === 0
      ? out.style("dim", "-")
      : out.style("green", plural(entry.masked.length, "rule")),
    entry.resume === undefined ? styledAction(out, entry) : styledResume(out, entry),
  ]);
  const table = renderTable(
    [
      { header: "SOURCE" },
      { header: "" },
      { header: "TARGET" },
      { header: "TYPE" },
      { header: "DOCUMENTS", align: "right" },
      { header: "EXISTING", align: "right" },
      { header: "SELECT" },
      { header: "MASK" },
      { header: "ACTION" },
    ],
    rows,
    (text) => out.style("dim", text),
  );
  out.info(indent(table));
  for (const entry of plan.entries) {
    if (entry.masked.length > 0)
      out.info(out.style("dim", `  ${entry.from}: ${entry.masked.join(", ")}`));
  }
  const unmasked = plan.entries.filter(
    (entry) => entry.type !== "view" && entry.masked.length === 0,
  );
  if (settings.mask !== undefined && unmasked.length > 0) {
    out.info(
      out.style(
        "yellow",
        `  No mask rule applies to: ${unmasked.map((entry) => entry.from).join(", ")}`,
      ),
    );
  }
  const documents = plan.entries.reduce((sum, entry) => sum + entry.documents, 0);
  out.info(
    `${plural(plan.entries.length, "namespace")}, about ${plural(documents, "document")} at the source.`,
  );
}

/** In a resumed copy: what is left to do, after the first run's action. */
function styledResume(out: Output, entry: CopyPlanEntry): string {
  switch (entry.resume) {
    case "done":
      return out.style("dim", "done");
    case "partial":
      return out.style("cyan", "resume");
    case "restart":
      return out.style("yellow", `${styledAction(out, entry)} (again from the start)`);
    default:
      return styledAction(out, entry);
  }
}

/** Destructive actions stand out in red/yellow. */
function styledAction(out: Output, entry: CopyPlanEntry): string {
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

function finishDryRun(context: CommandContext, result: CopyResult): number {
  if (context.out.settings.json) context.out.json(result);
  else context.out.success("Dry run: nothing was written.");
  return 0;
}

/**
 * Asks before dropping or upserting, or inserting into collections that already
 * have documents. Plain creates into empty targets need no question.
 */
async function confirmIfDestructive(
  context: CommandContext,
  plan: CopyPlan,
  settings: CopyFlowSettings,
): Promise<void> {
  // A resumed copy only touches anew what the interrupted run had not reached: the
  // targets it filled were already agreed to (and hold its own documents).
  const entries = plan.entries.filter(
    (entry) => entry.resume === undefined || entry.resume === "not-started",
  );
  if (entries.length === 0) return;
  // An uncountable target (undefined) might hold data, so it counts as non-empty.
  const nonEmpty = entries.filter((entry) => entry.existingDocuments !== 0).length;
  const target = displayUri(settings.targetUri);

  let question: string | undefined;
  if (plan.mode === "drop") {
    question = `Drop and replace ${plural(entries.length, "collection")} in ${target}?`;
  } else if (plan.mode === "upsert") {
    question = `Upsert into ${plural(entries.length, "collection")} in ${target}, replacing documents with the same _id?`;
  } else if (nonEmpty > 0) {
    question = `Insert into ${plural(nonEmpty, "collection")} in ${target} that already have documents?`;
  }
  if (question === undefined) return;
  await confirmOrThrow(context, { question, action: `${settings.name} with --mode ${plan.mode}` });
}

function printResult(context: CommandContext, result: CopyResult): void {
  const { out } = context;
  if (out.settings.json) {
    out.json(result);
    return;
  }
  const masked = result.mask?.rules.reduce((sum, rule) => sum + rule.values, 0);
  const notCreated = result.searchIndexes?.notCreated ?? [];
  if (notCreated.length > 0) {
    out.warn(
      `The target has no Atlas Search; ${plural(notCreated.length, "search index", "search indexes")} not created: ${notCreated.map((index) => `${index.ns}/${index.name}`).join(", ")}.`,
    );
  }
  // The summary is the command's result, so it goes to stdout.
  out.result(
    `${out.style("green", "✔")} ${result.resumed === true ? "Resumed the copy: copied" : "Copied"} ${plural(result.documentsCopied, "document")} into ${plural(result.plan.entries.length, "namespace")} in ${formatDuration(result.durationMs)}` +
      (masked === undefined ? "." : `, masking ${plural(masked, "value")}.`),
  );
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
