/**
 * `mongoshield mask suggest`: sample the source deployment, find personal data, and
 * suggest mask rules for `copy` / `pull` (docs/guides/staging-data.md).
 *
 *   mongoshield mask suggest --include 'app.*'                  table + snippet to paste
 *   mongoshield mask suggest --mask ./mask.ts                   marks fields it already covers
 *   mongoshield mask suggest --mask ./mask.json --write         merges new rules into the file
 *   mongoshield mask suggest --json                             the report, for scripts
 *
 * Read-only on the database: one bounded `$sample` per collection, one collection at a
 * time, from a secondary when there is one (see mask/suggest/suggest.ts). Output never
 * contains a sampled value: examples are shapes (`xxx.xxxxx@xxxx.xxx`).
 *
 * --write and mask file formats:
 *   the file does not exist   it is created: `.json` as JSON, `.ts`/`.mts`/`.js`/`.mjs` as a
 *                             `defineMask` module (secret from MONGOSHIELD_MASK_SECRET)
 *   an existing `.json` file  new rules are merged in; existing rules are never changed
 *   an existing module        left untouched, and the snippet is printed to paste by
 *                             hand: a mask module is a program (functions, process.env,
 *                             comments), and rewriting it could silently change what is
 *                             masked
 *
 * A `mask` command with an action (like `journal start|status`) leaves room for more
 * mask tooling, and reads as what it does: "mask: suggest rules".
 */

import { access, readFile, rename, writeFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { MongoShieldConfigInput } from "../../config/schema.ts";
import { MongoShieldError } from "../../errors.ts";
import type { MaskConfig } from "../../mask/index.ts";
import {
  countRules,
  KIND_LABELS,
  MAX_SAMPLE_SIZE,
  type MaskSuggestion,
  type MaskSuggestionReport,
  mergeIntoJsonMask,
  renderMaskModule,
  renderRulesSnippet,
  suggestMasks,
  toLiteral,
} from "../../mask/suggest/index.ts";
import { openConnection } from "../../mongo/index.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { formatCount, plural } from "../format.ts";
import type { Output } from "../io.ts";
import { createCliLogger, displayUri, loadCliConfig, rememberUriPassword } from "../setup.ts";
import { renderTable } from "../table.ts";
import { maskFromFlags } from "./copy.ts";
import { excludeOption, includeOption, listOrUndefined } from "./shared-options.ts";

const NAME = "mask";

/**
 * Sampling needs no backup storage, but the config schema requires a storage location.
 * This placeholder satisfies validation; only `source.uri` is read from the config.
 */
const STORAGE_NOT_USED = "memory://mask-suggest-uses-no-storage";

/** Mask file extensions --write can create, and the one kind it can merge into. */
const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
const JSON_EXTENSION = ".json";

/** `mongoshield mask suggest` (see the file header). */
export const maskCommand: CommandSpec = {
  name: NAME,
  summary: "Find personal data and suggest mask rules for copy/pull (suggest)",
  description: [
    "mask suggest samples every collection (--sample documents each, read-only, from a",
    "secondary when there is one) and detects personal data by value patterns and field",
    "names: emails, phones, names, addresses, postal codes, card numbers, IBANs, IP",
    "addresses, national ids, dates of birth, secrets, geolocation, and free text that",
    "contains emails or phones. It prints one suggested rule per field, in the mask file",
    "format, ordered by confidence. With --mask it marks fields that file already covers;",
    "--write adds the new rules to it (JSON files are merged; TypeScript/JavaScript files",
    "are created when missing, and never rewritten: the snippet is printed instead).",
    "",
    "Detection works on samples and patterns: review the rules before copying.",
  ].join("\n"),
  positionals: [{ name: "action", description: "suggest" }],
  options: {
    from: {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "Sample this deployment (default: the configured source / MONGODB_URI)",
    },
    include: includeOption,
    exclude: excludeOption,
    sample: {
      type: "string",
      valueName: "<n>",
      defaultText: "1000",
      description: `Documents sampled per collection (1–${MAX_SAMPLE_SIZE})`,
    },
    "min-confidence": {
      type: "string",
      valueName: "<0..1>",
      defaultText: "0.5",
      description: "Leave out findings below this confidence",
    },
    mask: {
      type: "string",
      valueName: "<file>",
      description: "The current mask file: covered fields are marked, --write updates it",
    },
    write: {
      type: "boolean",
      description: "Add the new rules to the --mask file (created if missing)",
    },
  },
  examples: [
    {
      description: "Suggest rules for the app database",
      command: "mongoshield mask suggest --from $PROD_URI --include 'app.*'",
    },
    {
      description: "Check an existing mask file for fields it misses",
      command: "mongoshield mask suggest --include 'app.*' --mask ./mask.ts",
    },
    {
      description: "Draft a mask file, then review it and copy with it",
      command: "mongoshield mask suggest --include 'app.*' --mask ./mask.json --write",
    },
  ],
  run: runMaskCommand,
};

async function runMaskCommand(context: CommandContext): Promise<number> {
  const action = context.positionals[0];
  if (action === "suggest") return runSuggest(context);
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    action === undefined ? "Which mask action? Use suggest." : `Unknown mask action "${action}".`,
    { hint: "Run `mongoshield mask suggest` to find personal data and suggest mask rules." },
  );
}

/** Options read from the flags, checked before connecting. */
interface SuggestSettings {
  readonly sampleSize: number | undefined;
  readonly minConfidence: number | undefined;
  /** Absolute path of --mask, if given. */
  readonly maskFile: string | undefined;
  readonly write: boolean;
}

/** `mask suggest`: sample, report, and optionally write. */
async function runSuggest(context: CommandContext): Promise<number> {
  const { out } = context;
  const settings = readSettings(context);
  const mask = await currentMask(context, settings);
  const sourceUri = await resolveSource(context);
  rememberUriPassword(context, sourceUri);

  const logger = createCliLogger(out);
  const connection = await openConnection({ uri: sourceUri }, { logger });
  let report: MaskSuggestionReport;
  try {
    out.info(`Sampling ${displayUri(sourceUri)} (read-only)…`);
    const include = listOrUndefined(context, "include");
    const exclude = listOrUndefined(context, "exclude");
    report = await suggestMasks(connection.client, {
      signal: context.signal,
      logger,
      onCollection: (ns, index, total) =>
        out.info(out.style("dim", `  ${ns} (${index + 1}/${total})`)),
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
      ...(settings.sampleSize === undefined ? {} : { sampleSize: settings.sampleSize }),
      ...(settings.minConfidence === undefined ? {} : { minConfidence: settings.minConfidence }),
      ...(mask === undefined ? {} : { mask }),
    });
  } finally {
    await connection.close();
  }

  const written = settings.write ? await writeSuggestions(context, settings, report) : undefined;
  if (out.settings.json) {
    out.json(written === undefined ? report : { ...report, write: written });
    return 0;
  }
  printReport(out, report);
  printNextStep(context, report, settings, written);
  return 0;
}

/** Parses and checks --sample, --min-confidence, --mask and --write. */
function readSettings(context: CommandContext): SuggestSettings {
  const { flags } = context;
  const write = flags.boolean("write");
  const mask = flags.string("mask");
  if (write && mask === undefined) {
    throw usageError("--write needs --mask <file>: the mask file to create or update.", NAME);
  }
  const maskFile = mask === undefined ? undefined : absolutePath(context, mask);
  if (write && maskFile !== undefined) assertWritableFormat(maskFile);
  return {
    sampleSize: flags.integer("sample", { min: 1, max: MAX_SAMPLE_SIZE }),
    minConfidence: minConfidenceFlag(context),
    maskFile,
    write,
  };
}

function minConfidenceFlag(context: CommandContext): number | undefined {
  const text = context.flags.string("min-confidence");
  if (text === undefined) return undefined;
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw usageError(`--min-confidence must be a number from 0 to 1, got "${text}".`, NAME);
  }
  return value;
}

function absolutePath(context: CommandContext, path: string): string {
  return isAbsolute(path) ? path : resolve(context.io.cwd, path);
}

/** --write only knows how to write JSON and ES module mask files. */
function assertWritableFormat(file: string): void {
  const extension = extname(file).toLowerCase();
  if (extension === JSON_EXTENSION || MODULE_EXTENSIONS.has(extension)) return;
  throw usageError(
    `--write cannot write a "${extension || "(no extension)"}" mask file; use .json, .ts, .mts, .js or .mjs.`,
    NAME,
  );
}

/**
 * The current mask config, for marking covered fields: --mask, loaded like `copy` does.
 * A --mask file that does not exist yet is fine with --write (it will be created).
 */
async function currentMask(
  context: CommandContext,
  settings: SuggestSettings,
): Promise<MaskConfig | undefined> {
  if (settings.maskFile === undefined) return undefined;
  if (settings.write && !(await exists(settings.maskFile))) return undefined;
  return maskFromFlags(context);
}

/** The deployment to sample: --from, else the configured source (config, MONGOSHIELD_URI, MONGODB_URI). */
async function resolveSource(context: CommandContext): Promise<string> {
  const from = context.flags.string("from");
  const overrides: MongoShieldConfigInput = {
    storage: STORAGE_NOT_USED,
    source: from ? { uri: from } : undefined,
  };
  const { config } = await loadCliConfig(context, overrides);
  const uri = config.source?.uri;
  if (!uri) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "Sample which deployment? No source is configured.",
      {
        hint: "Pass --from <mongodb-uri>, set MONGODB_URI (or MONGOSHIELD_URI), or set source.uri in mongoshield.config.ts.",
      },
    );
  }
  return uri;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// --write
// ---------------------------------------------------------------------------

/** What --write did, for the summary and the --json report. */
interface WriteOutcome {
  readonly file: string;
  /**
   * `created`: a new mask file; `updated`: rules merged into a JSON file; `unchanged`:
   * nothing new to add; `snippet`: an existing module, left alone (paste the rules).
   */
  readonly action: "created" | "updated" | "unchanged" | "snippet";
  /** Rules added to the file. */
  readonly added: number;
}

/** Applies --write (see the file header). */
async function writeSuggestions(
  context: CommandContext,
  settings: SuggestSettings,
  report: MaskSuggestionReport,
): Promise<WriteOutcome> {
  // readSettings guarantees a mask file with --write.
  const file = settings.maskFile ?? "";
  const fresh = countRules(report.rules);
  const isJson = extname(file).toLowerCase() === JSON_EXTENSION;
  const found = await exists(file);
  if (fresh === 0) return { file, action: "unchanged", added: 0 };
  if (found && !isJson) return { file, action: "snippet", added: 0 };

  let text: string;
  let added = fresh;
  if (isJson) {
    const merged = mergeJson(file, found ? await readFile(file, "utf8") : undefined, report);
    text = merged.text;
    added = merged.added;
  } else {
    text = renderMaskModule(report.collections);
  }
  if (added > 0) await writeAtomically(file, text);
  context.out.debug(`wrote ${added} rules to ${file}`);
  return { file, action: added === 0 ? "unchanged" : found ? "updated" : "created", added };
}

/** Merges into a JSON mask file's content, as a config error when it is not one. */
function mergeJson(
  file: string,
  existing: string | undefined,
  report: MaskSuggestionReport,
): { text: string; added: number } {
  try {
    return mergeIntoJsonMask(existing, report.rules);
  } catch (error) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Cannot add rules to ${file}: ${error instanceof Error ? error.message : String(error)}.`,
      {
        cause: error,
        hint: 'It must be a JSON object like { "rules": { "app.users": { "email": { "fake": "email" } } } }. Nothing was written.',
      },
    );
  }
}

/** Writes next to the file, then renames: a crash never leaves half a mask file. */
async function writeAtomically(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** The findings, one table per collection, on stdout. */
function printReport(out: Output, report: MaskSuggestionReport): void {
  for (const collection of report.collections) {
    const noun = collection.documents === 1 ? "document" : "documents";
    const heading = `${out.style("bold", collection.ns)} ${out.style("dim", `(${formatCount(collection.documents)} ${noun} sampled)`)}`;
    if (collection.suggestions.length === 0) {
      out.result(`${heading}: no personal data found`);
    } else {
      out.result(heading);
      out.result(indent(suggestionTable(out, collection.suggestions)));
    }
    // Said either way: "nothing found" in a truncated profile is not the whole story.
    if (collection.truncated) {
      out.result(
        out.style("yellow", "  (more than 1,000 field paths: the rest were not profiled)"),
      );
    }
  }
  if (report.skipped.length > 0) {
    const skipped = report.skipped.map((entry) => `${entry.ns} (${entry.reason})`).join(", ");
    out.result(out.style("dim", `Skipped: ${skipped}`));
  }
}

function suggestionTable(out: Output, suggestions: readonly MaskSuggestion[]): string {
  return renderTable(
    [
      { header: "FIELD" },
      { header: "FOUND" },
      { header: "CONFIDENCE", align: "right" },
      { header: "MATCHED", align: "right" },
      { header: "EXAMPLE" },
      { header: "RULE" },
      { header: "STATUS" },
    ],
    suggestions.map((suggestion) => suggestionRow(out, suggestion)),
    (text) => out.style("dim", text),
  );
}

function suggestionRow(out: Output, suggestion: MaskSuggestion): string[] {
  return [
    suggestion.path,
    foundLabel(suggestion),
    suggestion.confidence.toFixed(2),
    `${Math.floor(suggestion.share * 100)}%`,
    out.style("dim", suggestion.example),
    toLiteral(suggestion.rule),
    styledStatus(out, suggestion),
  ];
}

/**
 * What was found: the kind, with the variant where it tells the reviewer something
 * (`secret: jwt`, `national ID: us-ssn`).
 */
function foundLabel(suggestion: MaskSuggestion): string {
  const label = KIND_LABELS[suggestion.kind];
  const showsVariant = suggestion.kind === "secret" || suggestion.kind === "national-id";
  return showsVariant && suggestion.detail !== undefined ? `${label}: ${suggestion.detail}` : label;
}

/** `new` stands out; covered fields name the rule that covers them. */
function styledStatus(out: Output, suggestion: MaskSuggestion): string {
  const by = suggestion.coveredBy;
  const rule = by === undefined ? "" : ` by ${by.pattern} → ${by.path} (${by.operation})`;
  switch (suggestion.status) {
    case "new":
      return out.style("yellow", "new");
    case "covered":
      return out.style("green", `covered${rule}`);
    case "kept":
      return out.style("dim", `kept${rule}`);
  }
}

/** After the tables: the snippet to paste, or what --write did. */
function printNextStep(
  context: CommandContext,
  report: MaskSuggestionReport,
  settings: SuggestSettings,
  written: WriteOutcome | undefined,
): void {
  const { out } = context;
  const fresh = countRules(report.rules);
  if (fresh === 0) {
    const found = report.collections.some((collection) => collection.suggestions.length > 0);
    out.success(
      found
        ? "Every field found already has a rule in the mask file."
        : "No personal data found in the sample.",
    );
    return;
  }
  if (written?.action === "created" || written?.action === "updated") {
    out.success(
      `${written.action === "created" ? "Created" : "Updated"} ${written.file} with ${plural(written.added, "new rule")}. Review them before copying.`,
    );
    return;
  }
  out.result("");
  out.result(`${plural(fresh, "new rule")}; add to the \`rules\` of your mask file:`);
  out.result("");
  out.result(renderRulesSnippet(report.collections, 2));
  if (written?.action === "snippet") {
    out.warn(
      `Did not change ${written.file}: TypeScript/JavaScript mask files are programs (functions, process.env, comments), and rewriting one could silently change what is masked. Paste the rules above into it, or use a .json mask file with --write.`,
    );
  } else if (settings.maskFile === undefined) {
    out.info(out.style("dim", "Add --mask ./mask.json --write to save them to a mask file."));
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
