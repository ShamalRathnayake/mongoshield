/**
 * How a CLI command is described and what it receives when it runs.
 *
 * Each command file (`commands/*.ts`) exports one `CommandSpec`: its options,
 * help text, examples and a `run` function. The parser (`args.ts`), the help
 * renderer (`help.ts`) and the dispatcher (`run.ts`) all work from these specs,
 * so a command's documentation can never drift from what it actually accepts.
 */

import type { CliIo, Output } from "./io.ts";

/** One `--flag`. */
export interface OptionSpec {
  /** `string` options take a value; `boolean` options are switches. */
  readonly type: "string" | "boolean";
  /** May be repeated: `--include a --include b`. */
  readonly multiple?: boolean;
  /** One-letter alias, e.g. `y` for `-y`. */
  readonly short?: string;
  /** Placeholder shown in help, e.g. `<path>`. */
  readonly valueName?: string;
  /** Allowed values, checked by the parser and listed in help. */
  readonly choices?: readonly string[];
  /** Shown in help as "(default: …)"; the command applies the default itself. */
  readonly defaultText?: string;
  readonly description: string;
}

/** One positional argument. */
export interface PositionalSpec {
  readonly name: string;
  readonly description: string;
  /** Optional positionals are shown as `[name]` in help. */
  readonly optional?: boolean;
}

/** A worked example for the help page. */
export interface ExampleSpec {
  readonly command: string;
  readonly description: string;
}

/** Everything about one command. */
export interface CommandSpec {
  readonly name: string;
  /** One line, shown in the command list. */
  readonly summary: string;
  /** A paragraph or two, shown on the command's help page. */
  readonly description?: string;
  readonly positionals?: readonly PositionalSpec[];
  readonly options: Readonly<Record<string, OptionSpec>>;
  readonly examples: readonly ExampleSpec[];
  /** Runs the command and returns the process exit code. Throw MongoShieldError on failure. */
  readonly run: (context: CommandContext) => Promise<number>;
}

/** The global flags, available on every command. */
export interface GlobalFlags {
  readonly config: string | undefined;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly noColor: boolean;
  readonly yes: boolean;
}

/** Parsed `--flag` values of the running command, with typed accessors. */
export interface ParsedFlags {
  /** The last value of a string option, or `undefined`. */
  string(name: string): string | undefined;
  /** Every value of a repeatable string option (empty when not given). */
  list(name: string): string[];
  /** A boolean switch (false when not given). */
  boolean(name: string): boolean;
  /** A whole number within [min, max]; a usage error otherwise. */
  integer(name: string, range: { readonly min: number; readonly max?: number }): number | undefined;
  /** True if the option appeared on the command line at all. */
  has(name: string): boolean;
}

/** What a command's `run` receives. */
export interface CommandContext {
  readonly io: CliIo;
  readonly out: Output;
  readonly global: GlobalFlags;
  readonly flags: ParsedFlags;
  /** Positional arguments, in order. */
  readonly positionals: readonly string[];
  /** Aborted on Ctrl-C; pass it to every long operation. */
  readonly signal: AbortSignal;
  /**
   * Remembers a secret (a passphrase, a password) so that error output can
   * never echo it, even if some message accidentally includes it.
   */
  readonly addSecret: (secret: string) => void;
}
