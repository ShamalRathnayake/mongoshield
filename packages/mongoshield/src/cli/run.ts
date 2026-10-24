/**
 * `runCli`: the whole CLI as one testable function.
 *
 *   const exitCode = await runCli(["list", "--json"], io);
 *
 * It finds the command, parses its flags, runs it, and turns any failure into
 * a printed error and an exit code (see report-error.ts). It never calls
 * `process.exit` and never touches `process.stdout`: everything goes through
 * the `CliIo` it is given, which is what makes it easy to test.
 */

import type { MongoShieldError } from "../errors.ts";
import {
  closestMatch,
  GLOBAL_OPTIONS,
  parseCommandLine,
  splitCommand,
  usageError,
} from "./args.ts";
import type { CommandContext, CommandSpec } from "./command.ts";
import { COMMANDS, findCommand } from "./commands/index.ts";
import { renderCommandHelp, renderRootHelp } from "./help.ts";
import { type CliIo, Output, type OutputSettings, shouldUseColor } from "./io.ts";
import { reportError } from "./report-error.ts";

/** Runs the CLI with `argv` (without the `node` and script paths) and returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  // Decided from the raw arguments first, so even a parse error honours
  // --json and --no-color.
  let out = new Output(io, settingsFromRawArgs(io, argv));
  const secrets: string[] = [];

  try {
    const { command: name, rest } = splitCommand(argv);

    if (name === undefined) return runWithoutCommand(io, out, rest);
    if (name === "help") return printHelpFor(out, rest[0]);

    const command = findCommand(name);
    if (!command) throw unknownCommandError(name);

    const parsed = parseCommandLine(rest, command.name, command.options, positionalLimit(command));
    out = new Output(io, {
      json: parsed.global.json,
      quiet: parsed.global.quiet,
      verbose: parsed.global.verbose,
      color: shouldUseColor(io, parsed.global.noColor),
    });
    if (parsed.help) {
      out.result(renderCommandHelp(command, out));
      return 0;
    }

    const context: CommandContext = {
      io,
      out,
      global: parsed.global,
      flags: parsed.flags,
      positionals: parsed.positionals,
      signal: io.signal ?? new AbortController().signal,
      addSecret: (secret) => {
        if (secret !== "") secrets.push(secret);
      },
    };
    return await command.run(context);
  } catch (error) {
    out.endLive();
    return reportError(error, out, secrets);
  }
}

/**
 * `mongoshield`, `mongoshield --help`, `mongoshield --version`: no command name.
 * Anything else without a command is a usage error.
 */
async function runWithoutCommand(io: CliIo, out: Output, rest: readonly string[]): Promise<number> {
  const versionFlags = ["--version", "-V"];
  if (rest.some((arg) => versionFlags.includes(arg))) {
    // Same as `mongoshield version`, keeping flags such as --json.
    return runCli(["version", ...rest.filter((arg) => !versionFlags.includes(arg))], io);
  }

  const wantsHelp = rest.length === 0 || rest.includes("--help") || rest.includes("-h");
  if (wantsHelp) {
    out.result(renderRootHelp(COMMANDS, out));
    return 0;
  }

  const message = rest.every(isGlobalFlag)
    ? "No command given."
    : `Unexpected option ${rest[0] ?? ""} without a command.`;
  throw usageError(message, undefined);
}

/** `mongoshield help [command]`. */
function printHelpFor(out: Output, name: string | undefined): number {
  if (name === undefined) {
    out.result(renderRootHelp(COMMANDS, out));
    return 0;
  }
  const command = findCommand(name);
  if (!command) throw unknownCommandError(name);
  out.result(renderCommandHelp(command, out));
  return 0;
}

function unknownCommandError(name: string): MongoShieldError {
  const suggestion = closestMatch(
    name,
    COMMANDS.map((command) => command.name),
  );
  const didYouMean = suggestion ? ` Did you mean \`mongoshield ${suggestion}\`?` : "";
  return usageError(`Unknown command "${name}".${didYouMean}`, undefined);
}

/** How many positional arguments a command accepts. */
function positionalLimit(command: CommandSpec): number {
  return command.positionals?.length ?? 0;
}

/** True for `--json`, `-q`, `--config=x`, … (global flags only). */
function isGlobalFlag(argument: string): boolean {
  const name = argument.replace(/^-{1,2}/, "").split("=")[0] ?? "";
  if (name in GLOBAL_OPTIONS) return true;
  return Object.values(GLOBAL_OPTIONS).some((spec) => spec.short === name);
}

/** Output settings guessed from raw arguments, before the real parse. */
function settingsFromRawArgs(io: CliIo, argv: readonly string[]): OutputSettings {
  return {
    json: argv.includes("--json"),
    quiet: argv.includes("--quiet") || argv.includes("-q"),
    verbose: argv.includes("--verbose"),
    color: shouldUseColor(io, argv.includes("--no-color")),
  };
}
