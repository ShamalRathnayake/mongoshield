/**
 * Generates the CLI reference: one page per command, plus an overview.
 *
 * The pages are rendered from the same `CommandSpec` objects that the CLI's own
 * `--help` uses (packages/mongoshield/src/cli/commands), so the website can never
 * document a flag the CLI does not accept.
 *
 *   src/content/docs/reference/cli/index.md      every command, the global options
 *   src/content/docs/reference/cli/<command>.md  usage, arguments, options, examples
 *
 * The command modules import the whole library, including TypeScript that type
 * stripping alone cannot run (constructor parameter properties), so this script runs
 * with `node --experimental-transform-types` (see package.json). No build step needed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CommandSpec,
  OptionSpec,
  PositionalSpec,
} from "../../packages/mongoshield/src/cli/command.ts";
import {
  CONTENT_DIR,
  codeCell,
  escapeMarkdown,
  generatedNotice,
  githubEditUrl,
  REPO_ROOT,
  renderFrontmatter,
  resetDirectory,
  tableCell,
  unwrapParagraphs,
  writePage,
} from "./lib.ts";

const CLI_SOURCE = "packages/mongoshield/src/cli";
const OUTPUT_DIR = join(CONTENT_DIR, "reference", "cli");
const SCRIPT = "gen-cli-reference.ts";

// Imported dynamically so a failure names this script rather than a module path.
const { COMMANDS } = (await import(`../../${CLI_SOURCE}/commands/index.ts`)) as {
  COMMANDS: readonly CommandSpec[];
};
const { GLOBAL_OPTIONS } = (await import(`../../${CLI_SOURCE}/args.ts`)) as {
  GLOBAL_OPTIONS: Readonly<Record<string, OptionSpec>>;
};

function main(): void {
  resetDirectory(OUTPUT_DIR);
  writePage(join(OUTPUT_DIR, "index.md"), renderOverview());
  COMMANDS.forEach((command, index) => {
    writePage(join(OUTPUT_DIR, `${command.name}.md`), renderCommand(command, index + 1));
  });
  process.stdout.write(`gen-cli-reference: ${COMMANDS.length + 1} pages\n`);
}

/** The overview page: what each command does, and the flags every command takes. */
function renderOverview(): string {
  const rows = COMMANDS.map(
    (command) =>
      `| [\`${command.name}\`](/reference/cli/${command.name}/) | ${tableCell(command.summary)} |`,
  );
  return [
    renderFrontmatter({
      title: "CLI reference",
      description: "Every mongoshield command, its options and examples.",
      editUrl: githubEditUrl(`${CLI_SOURCE}/commands/index.ts`),
      sidebarOrder: 0,
      sidebarLabel: "Overview",
    }),
    generatedNotice(`${CLI_SOURCE}/commands`, SCRIPT),
    "```sh",
    "mongoshield <command> [options]",
    "```",
    "",
    "Configuration is read from `mongoshield.config.ts` (see the",
    "[config file reference](/reference/config/)), `MONGOSHIELD_*` environment variables",
    "and flags, in increasing order of precedence. Every command prints its own help with",
    "`mongoshield <command> --help`; these pages are generated from the same definitions.",
    "",
    "## Commands",
    "",
    "| Command | What it does |",
    "|---|---|",
    ...rows,
    "",
    "## Global options",
    "",
    "Accepted by every command.",
    "",
    renderOptionsTable(GLOBAL_OPTIONS),
    "",
    "## Exit codes",
    "",
    "`0` means success. Failures exit with a code that depends on the kind of error;",
    "see [Error codes](/reference/errors/) for the full list and what to do about each.",
    "",
  ].join("\n");
}

/** One command's page. */
function renderCommand(command: CommandSpec, order: number): string {
  const sections: string[] = [
    renderFrontmatter({
      title: `mongoshield ${command.name}`,
      description: command.summary,
      editUrl: githubEditUrl(commandSourceFile(command)),
      sidebarOrder: order,
      sidebarLabel: command.name,
    }),
    generatedNotice(commandSourceFile(command), SCRIPT),
    `${escapeMarkdown(command.summary)}.`,
    "",
    "```sh",
    usageLine(command),
    "```",
    "",
  ];

  if (command.description) {
    sections.push(escapeMarkdown(unwrapParagraphs(command.description)), "");
  }

  const positionals = command.positionals ?? [];
  if (positionals.length > 0) {
    sections.push("## Arguments", "", renderPositionalsTable(positionals), "");
  }

  if (Object.keys(command.options).length > 0) {
    sections.push("## Options", "", renderOptionsTable(command.options), "");
  }
  sections.push(
    "The [global options](/reference/cli/#global-options) (`--config`, `--json`, `--quiet`,",
    "`--verbose`, `--no-color`, `--yes`) work here too.",
    "",
  );

  if (command.examples.length > 0) {
    sections.push("## Examples", "");
    for (const example of command.examples) {
      sections.push(
        `${escapeMarkdown(example.description)}:`,
        "",
        "```sh",
        example.command,
        "```",
        "",
      );
    }
  }
  return sections.join("\n");
}

/** `mongoshield restore [backup] [options]`, as in `--help`. */
function usageLine(command: CommandSpec): string {
  const parts = ["mongoshield", command.name];
  for (const positional of command.positionals ?? []) {
    parts.push(positional.optional ? `[${positional.name}]` : `<${positional.name}>`);
  }
  if (Object.keys(command.options).length > 0) parts.push("[options]");
  return parts.join(" ");
}

function renderPositionalsTable(positionals: readonly PositionalSpec[]): string {
  const rows = positionals.map((positional) => {
    const name = positional.optional ? `[${positional.name}]` : `<${positional.name}>`;
    const required = positional.optional ? "optional" : "required";
    return `| ${codeCell(name)} | ${required} | ${tableCell(positional.description)} |`;
  });
  return ["| Argument | | Description |", "|---|---|---|", ...rows].join("\n");
}

function renderOptionsTable(options: Readonly<Record<string, OptionSpec>>): string {
  const rows = Object.entries(options).map(([name, spec]) => {
    return `| ${flagCell(name, spec)} | ${optionDescription(spec)} |`;
  });
  return ["| Option | Description |", "|---|---|", ...rows].join("\n");
}

/** `-c, --config <path>`, `--include <pattern>` (repeatable), `--compression <zstd|gzip|none>`. */
function flagCell(name: string, spec: OptionSpec): string {
  let flag = spec.short ? `-${spec.short}, --${name}` : `--${name}`;
  if (spec.type === "string") {
    const value = spec.choices ? `<${spec.choices.join("|")}>` : (spec.valueName ?? "<value>");
    flag += ` ${value}`;
  }
  return codeCell(flag);
}

/** The description plus "Repeatable." and "Default: …" notes. */
function optionDescription(spec: OptionSpec): string {
  // End the description with a full stop so the notes read as separate sentences.
  const description = /[.!?]$/.test(spec.description) ? spec.description : `${spec.description}.`;
  const notes: string[] = [tableCell(description)];
  if (spec.multiple) notes.push("Repeatable.");
  if (spec.defaultText) notes.push(`Default: ${codeCell(spec.defaultText)}.`);
  return notes.join(" ");
}

/** The file that defines a command, for "Edit page" (falls back to the command list). */
function commandSourceFile(command: CommandSpec): string {
  const candidate = `${CLI_SOURCE}/commands/${command.name}.ts`;
  return existsSync(join(REPO_ROOT, candidate)) ? candidate : `${CLI_SOURCE}/commands/index.ts`;
}

main();
