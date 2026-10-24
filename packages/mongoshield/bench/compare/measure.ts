/**
 * Runs one command and measures it: wall time, peak resident memory (RSS) and CPU
 * time (user + system).
 *
 * Peak RSS and CPU time come from the kernel's resource accounting for the process
 * (getrusage), read through /usr/bin/time: `-l` on macOS, `-v` on Linux (GNU time).
 * That is exact, unlike polling `ps`, which can miss a short spike between samples.
 * Where /usr/bin/time is missing (Windows, minimal containers) the harness falls back
 * to sampling the process's RSS with `ps` every 50 ms and reports CPU time as null.
 *
 * Every tool measured here (the mongoshield CLI, mongodump, mongorestore) is a single
 * process, so the numbers of that one process are the whole cost on the client side.
 * The server's own work (mongod) is in the wall time but not in RSS or CPU.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The resource-accounting wrapper, if this machine has one. */
const TIME_BINARY = "/usr/bin/time";

/** Interval of the `ps` fallback sampler. */
const SAMPLE_INTERVAL_MS = 50;

/** What one measured run cost. */
export interface Measurement {
  readonly wallMs: number;
  readonly peakRssBytes: number;
  /** User + system CPU time; null when only the `ps` fallback was available. */
  readonly cpuMs: number | null;
  /** How the numbers were taken, recorded in the results file. */
  readonly method: "rusage" | "ps-sampling";
}

/** A command to run, with its environment additions and working directory. */
export interface Command {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Runs `command` to completion and measures it. Throws (with the command's output)
 * when it exits non-zero, because a failed run must never be counted as a fast run.
 */
export async function measure(command: Command): Promise<Measurement> {
  if (process.platform !== "win32" && existsSync(TIME_BINARY)) {
    return measureWithRusage(command);
  }
  return measureWithSampling(command);
}

/** True when the exact rusage method is available (recorded in the results). */
export function rusageAvailable(): boolean {
  return process.platform !== "win32" && existsSync(TIME_BINARY);
}

// ---------------------------------------------------------------------------
// rusage through /usr/bin/time
// ---------------------------------------------------------------------------

async function measureWithRusage(command: Command): Promise<Measurement> {
  // /usr/bin/time writes its report to a file (-o), so it never mixes with the
  // tool's own stderr.
  const reportDirectory = await mkdtemp(join(tmpdir(), "mongoshield-bench-time-"));
  const reportFile = join(reportDirectory, "time.txt");
  const verbosityFlag = process.platform === "darwin" ? "-l" : "-v";
  try {
    const started = performance.now();
    await run({
      ...command,
      program: TIME_BINARY,
      args: [verbosityFlag, "-o", reportFile, command.program, ...command.args],
    });
    const wallMs = performance.now() - started;
    const report = await readFile(reportFile, "utf8");
    const usage = process.platform === "darwin" ? parseBsdTime(report) : parseGnuTime(report);
    return { wallMs, peakRssBytes: usage.peakRssBytes, cpuMs: usage.cpuMs, method: "rusage" };
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
}

/** The two numbers we need from a /usr/bin/time report. */
interface Usage {
  readonly peakRssBytes: number;
  readonly cpuMs: number;
}

/**
 * Parses macOS (BSD) `time -l`, which prints for example:
 *
 *         12.34 real         9.87 user         1.23 sys
 *     123456789  maximum resident set size        (bytes on macOS)
 */
export function parseBsdTime(report: string): Usage {
  const times = /([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(report);
  const rss = /(\d+)\s+maximum resident set size/.exec(report);
  if (times === null || rss === null) throw new Error(`Unexpected time -l output:\n${report}`);
  return {
    peakRssBytes: Number(rss[1]),
    cpuMs: (Number(times[2]) + Number(times[3])) * 1000,
  };
}

/**
 * Parses GNU `time -v`, which prints lines such as:
 *
 *     User time (seconds): 9.87
 *     System time (seconds): 1.23
 *     Maximum resident set size (kbytes): 120563     (KiB on Linux)
 */
export function parseGnuTime(report: string): Usage {
  const user = /User time \(seconds\): ([\d.]+)/.exec(report);
  const system = /System time \(seconds\): ([\d.]+)/.exec(report);
  const rss = /Maximum resident set size \(kbytes\): (\d+)/.exec(report);
  if (user === null || system === null || rss === null) {
    throw new Error(`Unexpected time -v output:\n${report}`);
  }
  return {
    peakRssBytes: Number(rss[1]) * 1024,
    cpuMs: (Number(user[1]) + Number(system[1])) * 1000,
  };
}

// ---------------------------------------------------------------------------
// Fallback: sample RSS with ps
// ---------------------------------------------------------------------------

async function measureWithSampling(command: Command): Promise<Measurement> {
  let peakRssBytes = 0;
  const started = performance.now();
  await run(command, (pid) => {
    // One `ps` at a time: if a sample is slow, skip the tick instead of piling up.
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void sampleRss(pid)
        .then((bytes) => {
          peakRssBytes = Math.max(peakRssBytes, bytes);
        })
        .finally(() => {
          busy = false;
        });
    }, SAMPLE_INTERVAL_MS);
    return () => clearInterval(timer);
  });
  return {
    wallMs: performance.now() - started,
    peakRssBytes,
    cpuMs: null,
    method: "ps-sampling",
  };
}

/** The RSS of `pid` in bytes (ps reports KiB), or 0 once the process is gone. */
async function sampleRss(pid: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    return Number(stdout.trim()) * 1024;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/**
 * Spawns `command` and resolves when it exits with code 0. `whileRunning` is called
 * with the pid once it has started and returns a function that stops whatever it
 * started (the sampler). Output is kept (the last 64 KiB) for the error message.
 */
function run(command: Command, whileRunning?: (pid: number) => () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.program, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-65_536);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const stop = child.pid === undefined ? undefined : whileRunning?.(child.pid);
    child.on("error", (error) => {
      stop?.();
      reject(error);
    });
    child.on("close", (code) => {
      stop?.();
      if (code === 0) resolve();
      else
        reject(
          new Error(`${command.program} ${command.args.join(" ")} exited ${code}:\n${output}`),
        );
    });
  });
}

/** Total size in bytes of every file under `directory` (the backup's size on disk). */
export async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}
