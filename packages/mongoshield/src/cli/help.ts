/**
 * `--help` pages, rendered from the command specs.
 *
 *   mongoshield --help            overview: commands, global flags, examples
 *   mongoshield <command> --help  one command: usage, arguments, flags, examples
 */

import { version } from "../version.ts";
import { GLOBAL_OPTIONS } from "./args.ts";
import type { CommandSpec, ExampleSpec, OptionSpec } from "./command.ts";
import type { Output } from "./io.ts";
import { renderRows } from "./table.ts";

/** Where the full documentation lives. */
export const DOCS_URL = "https://shamalrathnayake.github.io/mongoshield/";

/** Examples on the overview page: the first five minutes with MongoShield. */
const ROOT_EXAMPLES: readonly ExampleSpec[] = [
  { description: "Create mongoshield.config.ts", command: "mongoshield init" },
  {
    description: "Back up to a local directory",
    command: "mongoshield backup --uri $MONGODB_URI --to ./backups",
  },
  { description: "See what is there", command: "mongoshield list" },
  {
    description: "Restore next to the live data",
    command: "mongoshield restore latest --rename 'app.*=app_restored.*'",
  },
];

/** The overview page. */
export function renderRootHelp(commands: readonly CommandSpec[], out: Output): string {
  const heading = (text: string): string => out.style("bold", text);
  const commandRows = commands.map((command) => [out.style("cyan", command.name), command.summary]);

  return [
    `${heading("mongoshield")} ${out.style("dim", `v${version}`)}  Back up and restore MongoDB without mongodump.`,
    "",
    `${heading("Usage")}  mongoshield <command> [options]`,
    "",
    heading("Commands"),
    indent(renderRows(commandRows)),
    "",
    heading("Global options"),
    indent(renderOptions(GLOBAL_OPTIONS, out)),
    "",
    heading("Examples"),
    ...renderExamples(ROOT_EXAMPLES, out),
    "",
    `Run ${out.style("cyan", "mongoshield <command> --help")} for a command's options and examples.`,
    `Configuration is read from mongoshield.config.ts, MONGOSHIELD_* environment variables and flags.`,
    `Docs: ${DOCS_URL}`,
  ].join("\n");
}

/** One command's page. */
export function renderCommandHelp(command: CommandSpec, out: Output): string {
  const heading = (text: string): string => out.style("bold", text);
  const sections: string[] = [
    `${heading(`mongoshield ${command.name}`)}  ${command.summary}`,
    "",
    `${heading("Usage")}  ${usageLine(command)}`,
  ];

  if (command.description) sections.push("", command.description);

  const positionals = command.positionals ?? [];
  if (positionals.length > 0) {
    const rows = positionals.map((positional) => [
      out.style("cyan", positional.optional ? `[${positional.name}]` : `<${positional.name}>`),
      positional.description,
    ]);
    sections.push("", heading("Arguments"), indent(renderRows(rows)));
  }

  if (Object.keys(command.options).length > 0) {
    sections.push("", heading("Options"), indent(renderOptions(command.options, out)));
  }
  sections.push("", heading("Global options"), indent(renderOptions(GLOBAL_OPTIONS, out)));

  if (command.examples.length > 0) {
    sections.push("", heading("Examples"), ...renderExamples(command.examples, out));
  }
  return sections.join("\n");
}

/** Each example as a dim `# description` line over the command, separated by blank lines. */
function renderExamples(examples: readonly ExampleSpec[], out: Output): string[] {
  const lines: string[] = [];
  for (const example of examples) {
    if (lines.length > 0) lines.push("");
    lines.push(`  ${out.style("dim", `# ${example.description}`)}`, `  ${example.command}`);
  }
  return lines;
}

/** `mongoshield restore [backup] [options]`. */
function usageLine(command: CommandSpec): string {
  const parts = ["mongoshield", command.name];
  for (const positional of command.positionals ?? []) {
    parts.push(positional.optional ? `[${positional.name}]` : `<${positional.name}>`);
  }
  if (Object.keys(command.options).length > 0) parts.push("[options]");
  return parts.join(" ");
}

/**
 * Flags longer than this get their description on the next line. Without a limit, one
 * flag with many choices (`--read-preference <primary|…|nearest>`) would push every
 * description on the page past column 80, and each line would wrap.
 */
const MAX_FLAG_LABEL_WIDTH = 40;

/** A two-column list of flags and their descriptions. */
function renderOptions(options: Readonly<Record<string, OptionSpec>>, out: Output): string {
  const rows = Object.entries(options).map(([name, spec]) => ({
    // Labels are plain text here, so `.length` is their width on screen.
    label: flagLabel(name, spec),
    description: optionDescription(spec),
  }));
  const fitting = rows.map((row) => row.label.length).filter((w) => w <= MAX_FLAG_LABEL_WIDTH);
  const width = Math.max(0, ...fitting);

  const lines = rows.map(({ label, description }) => {
    const styled = out.style("cyan", label);
    if (label.length > width) return `${styled}\n${" ".repeat(width + 2)}${description}`;
    return `${styled}${" ".repeat(width - label.length + 2)}${description}`;
  });
  return lines.join("\n");
}

/** `-c, --config <path>` / `--compression <zstd|gzip|none>` / `--include <pattern>…`. */
function flagLabel(name: string, spec: OptionSpec): string {
  const short = spec.short ? `-${spec.short}, ` : "    ";
  let value = "";
  if (spec.type === "string") {
    value = spec.choices ? ` <${spec.choices.join("|")}>` : ` ${spec.valueName ?? "<value>"}`;
  }
  const repeat = spec.multiple ? " …" : "";
  return `${short}--${name}${value}${repeat}`;
}

function optionDescription(spec: OptionSpec): string {
  const notes: string[] = [];
  if (spec.defaultText) notes.push(`default: ${spec.defaultText}`);
  if (spec.multiple) notes.push("repeatable");
  return notes.length > 0 ? `${spec.description} (${notes.join("; ")})` : spec.description;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}
