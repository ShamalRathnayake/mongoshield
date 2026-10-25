/**
 * Running `mongoshield …` in tests through `runCli`, with in-memory streams.
 *
 *   const run = await runTestCli(["list", "--json"], { cwd });
 *   expect(run.code).toBe(0);
 *   expect(run.json()).toMatchObject({ backups: [] });
 *
 * Interactive runs: pass `terminal` steps. The fake terminal waits until the
 * prompt text appears on stderr, then types the keys, one step at a time. This is
 * how a person answers @clack/prompts questions, so wizard and confirmation paths
 * are tested end to end without mocking the prompt library.
 *
 *   await runTestCli(["init"], {
 *     cwd,
 *     terminal: [
 *       { when: "Where should backups be stored?", keys: KEYS.enter },
 *       { when: "Encrypt backups?", keys: KEYS.down + KEYS.down + KEYS.enter },
 *     ],
 *   });
 */

import { PassThrough, type Readable, Writable } from "node:stream";
import type { CliIo } from "../../src/cli/io.ts";
import { runCli } from "../../src/cli/run.ts";

/** What one CLI run printed and returned. */
export interface TestCliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout parsed as the single JSON document of a --json run. */
  json<T = Record<string, unknown>>(): T;
}

/** Key sequences a terminal sends. */
export const KEYS = {
  enter: "\r",
  up: "\u001b[A",
  down: "\u001b[B",
  left: "\u001b[D",
  right: "\u001b[C",
  ctrlC: "\u0003",
  /** Ctrl-U: delete the whole line typed so far (to replace a pre-filled answer). */
  clearLine: "\u0015",
} as const;

/** One answer: when `when` shows up on stderr, type `keys`. */
export interface TerminalStep {
  readonly when: string;
  readonly keys: string;
}

/** How to run the CLI. Defaults: no terminal, empty environment. */
export interface TestCliOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Pretend a person is at a terminal (colors, live progress, prompts). */
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly signal?: AbortSignal;
  /** A stdin stream (e.g. an archive for `import -`). Ignored when `terminal` is given. */
  readonly stdin?: Readable;
  /** Scripted answers to prompts; implies `isTTY: true` with a stdin. */
  readonly terminal?: readonly TerminalStep[];
}

/** A writable stream that collects everything written to it. */
export function collector(onWrite?: (all: string) => void): {
  stream: Writable;
  text: () => string;
} {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      text += chunk.toString();
      onWrite?.(text);
      done();
    },
  });
  return { stream, text: () => text };
}

/**
 * A fake terminal stdin that answers prompts as they appear. Each step's text must
 * appear on stderr after the previous step's keys were typed, so a repeated
 * question (a validation error) is answered again only if a step says so.
 */
function scriptedTerminal(steps: readonly TerminalStep[]): {
  stdin: PassThrough;
  onStderr: (all: string) => void;
  remaining: () => readonly TerminalStep[];
} {
  const stdin = new PassThrough();
  // @clack/prompts calls setRawMode on TTY inputs; a PassThrough needs a stand-in.
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
  let next = 0;
  /** Everything written to stderr so far. */
  let latest = "";
  /** Where to look for the next step's text: output from before the last keys is stale. */
  let searchFrom = 0;
  let typing = false;

  const onStderr = (all: string): void => {
    latest = all;
    if (typing) return;
    const step = steps[next];
    if (step === undefined) return;
    if (!unwrapped(all.slice(searchFrom)).includes(unwrapped(step.when))) return;
    typing = true;
    next++;
    // Type after the prompt finished rendering and attached its key listener.
    setTimeout(() => {
      searchFrom = latest.length;
      for (const character of splitKeys(step.keys)) stdin.write(character);
      // The reaction to the keys may already be on stderr (or arrive later).
      setTimeout(() => {
        typing = false;
        onStderr(latest);
      }, 5);
    }, 20);
  };
  return { stdin, onStderr, remaining: () => steps.slice(next) };
}

/**
 * Prompt text with colors removed and wrapped lines joined: @clack/prompts wraps long
 * questions at the terminal width and starts each continuation line with a "│" gutter.
 */
function unwrapped(text: string): string {
  return plain(text).replace(/\s*\n[│└]?\s*/g, " ");
}

/** Escape sequences must arrive whole; everything else one character at a time. */
function splitKeys(keys: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
  return keys.match(/\u001b\[[A-D]|[\s\S]/g) ?? [];
}

/** Runs the CLI with `args` and returns what it printed and its exit code. */
export async function runTestCli(
  args: readonly string[],
  options: TestCliOptions = {},
): Promise<TestCliRun> {
  const terminal = options.terminal ? scriptedTerminal(options.terminal) : undefined;
  const stdout = collector();
  const stderr = collector((all) => terminal?.onStderr(all));
  const stdin = terminal?.stdin ?? options.stdin;
  const io: CliIo = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    isTTY: options.isTTY ?? terminal !== undefined,
    ...(stdin ? { stdin } : {}),
    ...(options.columns ? { columns: options.columns } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const code = await runCli(args, io);
  terminal?.stdin.end();
  const unanswered = terminal?.remaining() ?? [];
  if (unanswered.length > 0) {
    throw new Error(
      `The CLI exited before asking: ${unanswered.map((step) => step.when).join(", ")}\n${stderr.text()}`,
    );
  }
  return {
    code,
    stdout: stdout.text(),
    stderr: stderr.text(),
    json: <T>() => JSON.parse(stdout.text()) as T,
  };
}

/** Removes ANSI escape codes, for asserting on colored or prompt output. */
export function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}
