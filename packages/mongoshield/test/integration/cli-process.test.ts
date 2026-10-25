/**
 * The real `mongoshield` process (src/cli/index.ts, run from source through jiti):
 * exit codes reach the shell, Ctrl-C and SIGTERM cancel a running command cleanly
 * (exit code 60), and a reader that closes the pipe early (`| head`)
 * does not produce an EPIPE crash.
 *
 * The long-running command is a backup against a TCP server that accepts connections
 * and never answers, so the CLI is reliably stuck "connecting" when the signal arrives.
 * Cancelling stops the connection attempt at once, so the second-press exit (130) is
 * covered by src/cli/interrupt.test.ts instead.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");
const cliEntry = join(packageRoot, "src/cli/index.ts");
const jitiCli = join(
  dirname(createRequire(import.meta.url).resolve("jiti/package.json")),
  "lib/jiti-cli.mjs",
);

/** Starting from source transpiles the whole CLI: allow for a busy machine. */
const STARTUP_TIMEOUT_MS = 60_000;

let silentServer: Server;
let silentPort = 0;
const sockets = new Set<Socket>();
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-process-"));
  silentServer = createServer((socket) => {
    // Accept, read and never reply: the driver waits for its handshake answer.
    sockets.add(socket);
    socket.on("data", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => silentServer.listen(0, "127.0.0.1", done));
  const address = silentServer.address();
  silentPort = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => silentServer.close(done));
  await rm(workDir, { recursive: true, force: true });
});

/** A running CLI process and what it has printed so far. */
interface CliProcess {
  readonly child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves when `text` appears on stderr. */
  waitForStderr(text: string): Promise<void>;
  /** Resolves with the exit code (or the signal name). */
  exited: Promise<number | string>;
}

function startCli(args: readonly string[]): CliProcess {
  const child = spawn(process.execPath, [jitiCli, cliEntry, ...args], {
    cwd: workDir,
    env: { PATH: process.env.PATH ?? "", HOME: workDir, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiters: { text: string; done: () => void }[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    for (const waiter of [...waiters]) {
      if (stderr.includes(waiter.text)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.done();
      }
    }
  });
  const exited = new Promise<number | string>((done) => {
    child.on("exit", (code, signal) => done(code ?? signal ?? "unknown"));
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    waitForStderr: (text) =>
      stderr.includes(text)
        ? Promise.resolve()
        : new Promise((done, fail) => {
            waiters.push({ text, done });
            void exited.then(() => fail(new Error(`exited before "${text}":\n${stderr}`)));
          }),
  };
}

/** `backup` that hangs while connecting to the silent server. */
function startStuckBackup(): CliProcess {
  const uri = `mongodb://127.0.0.1:${silentPort}/?serverSelectionTimeoutMS=120000&connectTimeoutMS=120000&directConnection=true`;
  return startCli(["backup", "--uri", uri, "--to", join(workDir, "backups")]);
}

describe("the mongoshield process", () => {
  it(
    "passes the exit code to the shell",
    async () => {
      const ok = startCli(["--version"]);
      expect(await ok.exited).toBe(0);
      expect(ok.stdout()).toMatch(/^mongoshield \d+\.\d+\.\d+/);

      const usage = startCli(["lsit"]);
      expect(await usage.exited).toBe(2);
      expect(usage.stderr()).toContain("Did you mean `mongoshield list`?");
    },
    STARTUP_TIMEOUT_MS * 2,
  );

  it(
    "on Ctrl-C cancels a stuck connection attempt and exits with 60",
    async () => {
      const cli = startStuckBackup();
      await cli.waitForStderr("Backing up");
      cli.child.kill("SIGINT");
      await cli.waitForStderr("Cancelling… (press Ctrl-C again to exit immediately)");
      expect(await cli.exited).toBe(60);
    },
    STARTUP_TIMEOUT_MS,
  );

  it(
    "treats SIGTERM like Ctrl-C for one-off commands",
    async () => {
      const cli = startStuckBackup();
      await cli.waitForStderr("Backing up");
      cli.child.kill("SIGTERM");
      await cli.waitForStderr("Cancelling…");
      expect(await cli.exited).toBe(60);
    },
    STARTUP_TIMEOUT_MS,
  );

  it(
    "stops quietly when the reader closes stdout early",
    async () => {
      const cli = startCli(["--help"]);
      // Close our end before the CLI writes: its write then fails with EPIPE.
      cli.child.stdout?.destroy();
      const code = await cli.exited;
      expect(code).toBe(0);
      expect(cli.stderr()).not.toContain("EPIPE");
    },
    STARTUP_TIMEOUT_MS,
  );
});
