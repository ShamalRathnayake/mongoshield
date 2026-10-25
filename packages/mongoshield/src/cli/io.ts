/**
 * The CLI's connection to the outside world, and the one place that prints.
 *
 * `runCli()` never touches `process` directly: it receives a `CliIo` (streams,
 * environment, working directory, terminal detection). The real binary passes
 * the process's; tests pass in-memory streams. Everything a command shows goes
 * through `Output`, which knows the rules:
 *
 *   stdout   results only (tables, summaries, JSON with --json)
 *   stderr   everything else: status lines, progress, warnings, errors, prompts
 *
 * so `mongoshield list --json | jq` and `mongoshield backup --quiet > id.txt`
 * always get clean, parseable output.
 */

import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";

/** What `runCli` needs from its environment. */
export interface CliIo {
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** Needed only for interactive prompts. Without it the CLI is never interactive. */
  readonly stdin?: Readable;
  readonly env: NodeJS.ProcessEnv;
  /** Directory relative paths (config, storage, key files) are resolved against. */
  readonly cwd: string;
  /** True when a human is at a terminal: enables colors, live progress and prompts. */
  readonly isTTY: boolean;
  /** Aborted when the user presses Ctrl-C; long operations stop cleanly. */
  readonly signal?: AbortSignal;
  /** Terminal width, used to keep progress lines on one row. */
  readonly columns?: number;
}

/** The text styles the CLI uses (a subset of `util.inspect.colors`). */
export type Style = "bold" | "dim" | "red" | "green" | "yellow" | "cyan" | "gray";

/** Global output settings, decided once from the flags and the environment. */
export interface OutputSettings {
  /** `--json`: stdout carries exactly one JSON document. */
  readonly json: boolean;
  /** `--quiet`: no status lines or progress; results and errors still print. */
  readonly quiet: boolean;
  /** `--verbose`: debug logs (and stack traces on errors) on stderr. */
  readonly verbose: boolean;
  /** Whether ANSI colors are used. See {@link shouldUseColor}. */
  readonly color: boolean;
}

/**
 * Colors are used only on a terminal, and never when the user opted out with
 * `--no-color`, `NO_COLOR` (https://no-color.org) or `TERM=dumb`.
 * `FORCE_COLOR` (anything but "0") turns them on even when piped.
 */
export function shouldUseColor(io: CliIo, noColorFlag: boolean): boolean {
  if (noColorFlag) return false;
  if (io.env.NO_COLOR !== undefined && io.env.NO_COLOR !== "") return false;
  const force = io.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  if (io.env.TERM === "dumb") return false;
  return io.isTTY;
}

/** Prints for the CLI, following the stdout/stderr rules in the file header. */
export class Output {
  readonly settings: OutputSettings;
  readonly #io: CliIo;
  /** The progress line currently drawn at the bottom of the terminal, if any. */
  #liveLine: string | undefined;

  constructor(io: CliIo, settings: OutputSettings) {
    this.#io = io;
    this.settings = settings;
  }

  /** Applies a style when colors are on; returns the text unchanged otherwise. */
  style(styles: Style | readonly Style[], text: string): string {
    if (!this.settings.color) return text;
    // We already decided whether to color, so stop styleText second-guessing
    // the (possibly fake) stream.
    const formats = typeof styles === "string" ? styles : [...styles];
    return styleText(formats, text, { validateStream: false });
  }

  /** A result line for stdout. Suppressed with --json (the JSON document is the result). */
  result(text = ""): void {
    if (this.settings.json) return;
    this.#io.stdout.write(`${text}\n`);
  }

  /** The one JSON document of a --json run. */
  json(value: unknown): void {
    this.#io.stdout.write(`${JSON.stringify(value, jsonReplacer, 2)}\n`);
  }

  /** A status line on stderr ("Connecting…", "Wrote …"). Hidden by --quiet. */
  info(text: string): void {
    if (this.settings.quiet) return;
    this.#writeStderr(`${text}\n`);
  }

  /** A success line on stderr, with a green check mark. Hidden by --quiet. */
  success(text: string): void {
    this.info(`${this.style("green", "✔")} ${text}`);
  }

  /** A warning on stderr. Shown even with --quiet: warnings need attention. */
  warn(text: string): void {
    this.#writeStderr(`${this.style("yellow", "▲")} ${text}\n`);
  }

  /** A debug line on stderr, only with --verbose. */
  debug(text: string): void {
    if (!this.settings.verbose) return;
    this.#writeStderr(`${this.style("gray", `debug ${text}`)}\n`);
  }

  /** Raw text on stderr (error reports). Never suppressed. */
  stderr(text: string): void {
    this.#writeStderr(text);
  }

  /**
   * Draws (or redraws) the single live progress line. Only call this when
   * `liveProgress` is true: it relies on the terminal understanding `\r` and
   * the "erase line" escape sequence.
   */
  live(text: string): void {
    this.#liveLine = text;
    this.#io.stderr.write(`${CLEAR_LINE}${text}`);
  }

  /** Removes the live progress line, leaving the cursor at the start of an empty line. */
  endLive(): void {
    if (this.#liveLine === undefined) return;
    this.#liveLine = undefined;
    this.#io.stderr.write(CLEAR_LINE);
  }

  /**
   * Writes to stderr without garbling the live progress line: the line is
   * erased, the text printed above it, and the line drawn again below.
   */
  #writeStderr(text: string): void {
    if (this.#liveLine === undefined) {
      this.#io.stderr.write(text);
      return;
    }
    this.#io.stderr.write(`${CLEAR_LINE}${text}${this.#liveLine}`);
  }

  /** True when a person can answer prompts: a terminal with stdin, and not CI. */
  get interactive(): boolean {
    return this.#io.isTTY && this.#io.stdin !== undefined && !isCi(this.#io.env);
  }

  /** True when progress can be redrawn in place on one line. */
  get liveProgress(): boolean {
    return this.#io.isTTY && !this.settings.quiet && !this.settings.json;
  }

  /** Terminal width, or a safe default when unknown. */
  get columns(): number {
    return this.#io.columns ?? 100;
  }
}

/** Carriage return + "erase entire line" (ANSI EL2): the cursor ends at column 0 of a blank line. */
const CLEAR_LINE = "\r\u001b[2K";

/** CI systems set `CI`; prompts there would hang the job forever. */
function isCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI;
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/**
 * `JSON.stringify` replacer: Dates are already handled (toJSON), but BigInt and
 * Error values are not, and a crash while printing the result would hide it.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}
