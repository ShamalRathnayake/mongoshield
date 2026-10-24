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
 *
 * Copying needs no backup storage, so unlike most commands it works without one
 * configured.
 */

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
};

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
    signal: context.signal,
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
    ...(rename ? { rename } : {}),
    ...(parallelism === undefined ? {} : { parallelism }),
    ...(settings.mask ? { mask: settings.mask } : {}),
    ...(settings.subset ? { subset: settings.subset } : {}),
  };
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
  // An uncountable target (undefined) might hold data, so it counts as non-empty.
  const nonEmpty = plan.entries.filter((entry) => entry.existingDocuments !== 0).length;
  const target = displayUri(settings.targetUri);

  let question: string | undefined;
  if (plan.mode === "drop") {
    question = `Drop and replace ${plural(plan.entries.length, "collection")} in ${target}?`;
  } else if (plan.mode === "upsert") {
    question = `Upsert into ${plural(plan.entries.length, "collection")} in ${target}, replacing documents with the same _id?`;
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
  // The summary is the command's result, so it goes to stdout.
  out.result(
    `${out.style("green", "✔")} Copied ${plural(result.documentsCopied, "document")} into ${plural(result.plan.entries.length, "namespace")} in ${formatDuration(result.durationMs)}` +
      (masked === undefined ? "." : `, masking ${plural(masked, "value")}.`),
  );
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
