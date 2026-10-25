#!/usr/bin/env node
/**
 * The `mongoshield` executable.
 *
 * All behaviour lives in `runCli` (run.ts), which is tested directly. This file
 * only connects it to the real process: streams, environment, terminal
 * detection, Ctrl-C handling and the exit code.
 *
 * Ctrl-C: the first press aborts the running operation through an
 * AbortController, so it stops cleanly (exit code 60); a second press exits
 * immediately with 130. See interrupt.ts.
 */

import process from "node:process";
import { createInterruptHandler } from "./interrupt.ts";
import type { CliIo } from "./io.ts";
import { runCli } from "./run.ts";

const controller = new AbortController();
const onInterrupt = createInterruptHandler({
  abort: () => controller.abort(),
  exit: (code) => process.exit(code),
  write: (message) => process.stderr.write(message),
});

/**
 * `mongoshield list | head` closes the pipe early. That is the reader's
 * choice, not an error, so stop quietly instead of crashing with EPIPE.
 */
function ignoreBrokenPipe(error: NodeJS.ErrnoException): void {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
}

/**
 * Resolves once everything written to `stream` so far has been handed to the OS:
 * pipes are asynchronous on macOS, so exiting right away could cut the output short.
 */
function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((done) => {
    stream.write("", () => done());
  });
}

process.on("SIGINT", onInterrupt);

// Containers and process managers stop programs with SIGTERM. One-off commands treat
// it like Ctrl-C (cancel cleanly). `run` and `schedule` install their own SIGTERM
// handling, because a scheduler should finish its current job within a grace period
// instead of aborting it.
const COMMANDS_WITH_OWN_TERMINATION = new Set(["run", "schedule"]);
const handlesTermination = !COMMANDS_WITH_OWN_TERMINATION.has(process.argv[2] ?? "");
if (handlesTermination) process.on("SIGTERM", onInterrupt);
process.stdout.on("error", ignoreBrokenPipe);

const io: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
  // Colors, live progress and prompts only when a person is at a terminal on
  // every stream: `mongoshield list | less` must not receive escape codes.
  isTTY:
    process.stdin.isTTY === true && process.stdout.isTTY === true && process.stderr.isTTY === true,
  signal: controller.signal,
  ...(process.stderr.columns ? { columns: process.stderr.columns } : {}),
};

const exitCode = await runCli(process.argv.slice(2), io);
process.exitCode = exitCode;
process.off("SIGINT", onInterrupt);
if (handlesTermination) process.off("SIGTERM", onInterrupt);

// A cancelled command has reported its outcome, but the driver may still hold a
// socket to a server that never answered (on Linux until connectTimeoutMS), which
// would keep the process alive. Nothing is left to do, so exit once the output is out.
if (controller.signal.aborted) {
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exit(exitCode);
}
