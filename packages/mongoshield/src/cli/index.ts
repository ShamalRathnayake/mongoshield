#!/usr/bin/env node
/**
 * The `mongoshield` executable.
 *
 * All behaviour lives in `runCli` (run.ts), which is tested directly. This file
 * only connects it to the real process: streams, environment, terminal
 * detection, Ctrl-C handling and the exit code.
 *
 * Ctrl-C: the first press aborts the running operation through an
 * AbortController, so it stops cleanly (connections closed, no half-written
 * manifest, exit code 60). A second press exits immediately (exit code 130,
 * the shell convention for SIGINT).
 */

import process from "node:process";
import type { CliIo } from "./io.ts";
import { runCli } from "./run.ts";

/** Exit code for "terminated by SIGINT" (128 + signal number 2). */
const SIGINT_EXIT_CODE = 130;

const controller = new AbortController();
let interruptCount = 0;

function onInterrupt(): void {
  interruptCount++;
  if (interruptCount > 1) process.exit(SIGINT_EXIT_CODE);
  process.stderr.write("\nCancelling… (press Ctrl-C again to exit immediately)\n");
  controller.abort();
}

/**
 * `mongoshield list | head` closes the pipe early. That is the reader's
 * choice, not an error, so stop quietly instead of crashing with EPIPE.
 */
function ignoreBrokenPipe(error: NodeJS.ErrnoException): void {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
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

process.exitCode = await runCli(process.argv.slice(2), io);
process.off("SIGINT", onInterrupt);
if (handlesTermination) process.off("SIGTERM", onInterrupt);
