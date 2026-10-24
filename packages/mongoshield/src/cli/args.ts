/**
 * Command-line parsing.
 *
 *   mongoshield [global flags] <command> [arguments] [flags]
 *
 * Global flags (`--json`, `--config`, …) may appear anywhere, before or after
 * the command name. Parsing is strict: an unknown flag or a bad value is a usage
 * error (exit code 2) with a "did you mean" suggestion, never silently ignored,
 * because a mistyped `--exclude` or `--dry-run` must not lead to a surprise.
 *
 * We use `node:util` parseArgs rather than citty's parser because citty keeps
 * only the last value of a repeated flag (`--include a --include b`), and
 * repeatable namespace filters are central to this CLI.
 */

import { parseArgs } from "node:util";
import { MongoShieldError } from "../errors.ts";
import type { GlobalFlags, OptionSpec, ParsedFlags } from "./command.ts";

/** Flags every command accepts. */
export const GLOBAL_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  config: {
    type: "string",
    short: "c",
    valueName: "<path>",
    description:
      "Config file (default: mongoshield.config.ts and friends in the current directory)",
  },
  json: { type: "boolean", description: "Print one machine-readable JSON document on stdout" },
  quiet: { type: "boolean", short: "q", description: "Only print results, warnings and errors" },
  verbose: { type: "boolean", description: "Print debug logs, and stack traces on errors" },
  "no-color": { type: "boolean", description: "Disable colors (also: NO_COLOR=1)" },
  yes: { type: "boolean", short: "y", description: "Answer yes to confirmations (for scripts)" },
  help: { type: "boolean", short: "h", description: "Show help" },
};

/** The command name and the remaining arguments, as found in argv. */
export interface CommandLine {
  /** `undefined` when no command was given (`mongoshield`, `mongoshield --help`). */
  readonly command: string | undefined;
  /** argv without the command name. */
  readonly rest: readonly string[];
}

/**
 * Finds the command name: the first argument that is not a flag and not the
 * value of a global flag that takes one (`--config path`).
 */
export function splitCommand(argv: readonly string[]): CommandLine {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    if (argument === "--") break;
    if (argument.startsWith("-")) {
      if (takesSeparateValue(argument)) index++;
      continue;
    }
    return { command: argument, rest: [...argv.slice(0, index), ...argv.slice(index + 1)] };
  }
  return { command: undefined, rest: argv };
}

/** `--config x` and `-c x` consume the next argument; `--config=x` does not. */
function takesSeparateValue(argument: string): boolean {
  if (argument.includes("=")) return false;
  return argument === "--config" || argument === "-c";
}

/** The result of parsing one command's arguments. */
export interface ParsedCommandLine {
  readonly global: GlobalFlags;
  readonly help: boolean;
  readonly flags: ParsedFlags;
  readonly positionals: string[];
}

type RawValue = string | boolean | (string | boolean)[] | undefined;

/**
 * Parses arguments against the global options plus a command's own options.
 * Throws a usage error (MS_CONFIG_INVALID) for unknown flags, missing values,
 * values outside `choices`, or too many positionals.
 */
export function parseCommandLine(
  args: readonly string[],
  commandName: string,
  options: Readonly<Record<string, OptionSpec>>,
  maxPositionals: number,
): ParsedCommandLine {
  const allOptions = { ...GLOBAL_OPTIONS, ...options };
  const config: Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }> =
    {};
  for (const [name, spec] of Object.entries(allOptions)) {
    config[name] = {
      type: spec.type,
      ...(spec.multiple ? { multiple: true } : {}),
      ...(spec.short ? { short: spec.short } : {}),
    };
  }

  let parsed: { values: Record<string, RawValue>; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...args], options: config, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageErrorFromParser(error, commandName, Object.keys(allOptions));
  }

  const values = parsed.values;
  const help = values.help === true;
  if (!help) {
    checkChoices(values, allOptions, commandName);
    if (parsed.positionals.length > maxPositionals) {
      const extra = parsed.positionals.slice(maxPositionals).join(" ");
      throw usageError(`Unexpected argument: ${extra}`, commandName);
    }
  }

  return {
    help,
    positionals: parsed.positionals,
    flags: createParsedFlags(values, commandName),
    global: {
      config: lastString(values.config),
      json: values.json === true,
      quiet: values.quiet === true,
      verbose: values.verbose === true,
      noColor: values["no-color"] === true,
      yes: values.yes === true,
    },
  };
}

/** Builds the typed accessor object commands use to read their flags. */
function createParsedFlags(values: Record<string, RawValue>, commandName: string): ParsedFlags {
  return {
    string: (name) => lastString(values[name]),
    list: (name) => allStrings(values[name]),
    boolean: (name) => values[name] === true,
    has: (name) => values[name] !== undefined,
    integer: (name, range) => {
      const raw = lastString(values[name]);
      if (raw === undefined) return undefined;
      const number = Number(raw);
      const max = range.max ?? Number.MAX_SAFE_INTEGER;
      if (!/^\d+$/.test(raw.trim()) || number < range.min || number > max) {
        const bounds = range.max === undefined ? `≥ ${range.min}` : `${range.min}–${range.max}`;
        throw usageError(`--${name} must be a whole number ${bounds} (got "${raw}").`, commandName);
      }
      return number;
    },
  };
}

/** Rejects values outside an option's `choices`. */
function checkChoices(
  values: Record<string, RawValue>,
  options: Readonly<Record<string, OptionSpec>>,
  commandName: string,
): void {
  for (const [name, spec] of Object.entries(options)) {
    if (!spec.choices) continue;
    for (const value of allStrings(values[name])) {
      if (!spec.choices.includes(value)) {
        throw usageError(
          `--${name} must be one of ${spec.choices.join(", ")} (got "${value}").`,
          commandName,
        );
      }
    }
  }
}

function lastString(value: RawValue): string | undefined {
  const all = allStrings(value);
  return all[all.length - 1];
}

function allStrings(value: RawValue): string[] {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.filter((item): item is string => typeof item === "string");
}

/**
 * Turns a `node:util` parseArgs error into a short usage error. Node's messages
 * are long and mention internals; we keep the first sentence and add a
 * suggestion for misspelled flags.
 */
function usageErrorFromParser(
  error: unknown,
  commandName: string,
  knownOptions: readonly string[],
): MongoShieldError {
  const message = error instanceof Error ? error.message : String(error);
  const firstSentence = message.split(/\.\s/)[0] ?? message;
  const unknown = /^Unknown option '(-{1,2})([^']+)'/.exec(message);
  if (unknown?.[2]) {
    const suggestion = closestMatch(unknown[2], knownOptions);
    const didYouMean = suggestion ? ` Did you mean --${suggestion}?` : "";
    return usageError(`Unknown option ${unknown[1]}${unknown[2]}.${didYouMean}`, commandName);
  }
  return usageError(`${firstSentence.replace(/\.$/, "")}.`, commandName);
}

/** A usage mistake: exit code 2, with a pointer to the command's help. */
export function usageError(message: string, commandName: string | undefined): MongoShieldError {
  const helpCommand = commandName ? `mongoshield ${commandName} --help` : "mongoshield --help";
  return new MongoShieldError("MS_CONFIG_INVALID", message, {
    hint: `Run \`${helpCommand}\` to see the available options and examples.`,
  });
}

/**
 * The candidate closest to `input` by edit distance, if it is close enough to
 * be a plausible typo (at most a third of the word, and at least 1 edit allowed).
 */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const allowed = Math.max(1, Math.floor(input.length / 3));
  return bestDistance <= allowed ? best : undefined;
}

/**
 * Edit distance counting insertions, deletions, substitutions and swaps of two
 * neighbouring letters as one edit each ("optimal string alignment"), so the
 * common typo `--form` for `--from` is one edit away.
 */
function editDistance(a: string, b: string): number {
  // rows[i][j] = distance between the first i letters of a and the first j of b.
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push([i]);
    for (let j = 1; j <= b.length; j++) rows[i]?.push(i === 0 ? j : 0);
  }
  const at = (i: number, j: number): number => rows[i]?.[j] ?? 0;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      const swapped = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];
      if (swapped) best = Math.min(best, at(i - 2, j - 2) + 1);
      const row = rows[i];
      if (row) row[j] = best;
    }
  }
  return at(a.length, b.length);
}
