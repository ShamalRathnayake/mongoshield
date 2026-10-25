/**
 * Runtime compatibility runner: proves the BUILT package works under Node.js,
 * Bun and Deno.
 *
 *   pnpm --filter mongoshield test:runtimes                 # builds, then every runtime on PATH
 *   node test/runtimes/run.ts --runtime bun --require       # one runtime; fail if it is missing
 *   node test/runtimes/run.ts --s3                          # also S3 against S3Mock (Docker)
 *
 * What it does, always from Node.js (so the infrastructure is the same for all):
 *
 *   1. starts a single-node replica set with mongodb-memory-server
 *      (MONGOMS_SYSTEM_BINARY=$(which mongod) skips the download), and with
 *      --s3 an Adobe S3Mock container;
 *   2. per runtime, runs `smoke.ts` (library scenarios: entry points, every
 *      compression × encryption × storage combination, corruption, AbortSignal,
 *      backpressure) in that runtime;
 *   3. per runtime, drives the CLI (`<runtime> dist/cli.mjs`): keygen, backup,
 *      list, deep verify, restore, a config file, Ctrl-C, and the bin as an
 *      installed package (`deno run -A npm:mongoshield`, `bun x mongoshield`).
 *
 * Exit code 1 if any check failed, or a --require'd runtime is not installed.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Binary, MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { isDockerAvailable } from "../helpers/docker.ts";

/** The package directory (packages/mongoshield). */
const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url));
/** The built CLI. */
const CLI = join(PACKAGE_DIR, "dist", "cli.mjs");
/** The library scenarios. */
const SMOKE_SCRIPT = fileURLToPath(new URL("./smoke.ts", import.meta.url));

/** Pinned like the integration tests, so emulator upgrades never change results unnoticed. */
const S3MOCK_IMAGE = "adobe/s3mock:5.2";
const S3MOCK_PORT = 9090;
const S3_BUCKET = "smoke";

/** `mongoshield` exits with this code when an operation was cancelled (MS_ABORTED). */
const ABORTED_EXIT_CODE = 60;

// ---------------------------------------------------------------------------
// Runtimes
// ---------------------------------------------------------------------------

/** How to start a script with one runtime. */
interface Runtime {
  readonly name: "node" | "bun" | "deno";
  /** Command and arguments that run a JavaScript/TypeScript file: `[...run, file, ...args]`. */
  readonly run: readonly string[];
  /** Prints the version, to check the runtime is installed. */
  readonly versionArgs: readonly string[];
}

const RUNTIMES: readonly Runtime[] = [
  { name: "node", run: [process.execPath], versionArgs: ["--version"] },
  { name: "bun", run: ["bun"], versionArgs: ["--version"] },
  // -A: the CLI reads env, files and the network, and spawns nothing; a real
  // deployment can narrow this to --allow-env --allow-read --allow-write --allow-net --allow-sys.
  { name: "deno", run: ["deno", "run", "-A"], versionArgs: ["--version"] },
];

/** True if `command` is an executable somewhere on PATH (or is an absolute path). */
function isOnPath(command: string): boolean {
  if (command.includes("/")) return existsSync(command);
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((directory) => directory !== "" && existsSync(join(directory, command)));
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

/** What a finished child process produced. */
interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Options for `runProcess`. */
interface RunOptions {
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  /** Kill the process (and fail) after this long. */
  readonly timeoutMs?: number;
  /**
   * Echo stdout line by line as it arrives (for the long smoke run), except
   * the machine-readable SMOKE_RESULT line, which only the runner reads.
   */
  readonly echo?: boolean;
  /** Called once the process has started, e.g. to send it a signal later. */
  readonly onSpawn?: (child: ChildProcess) => void;
}

/** Runs a command to completion and collects its output. Never rejects. */
function runProcess(command: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
  const [program, ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(program ?? "", args, {
      cwd: options.cwd ?? PACKAGE_DIR,
      env: { ...process.env, NO_COLOR: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    /** How much of `stdout` has been echoed (always up to a line break). */
    let echoed = 0;
    const echoCompleteLines = () => {
      const end = stdout.lastIndexOf("\n") + 1;
      for (const line of stdout.slice(echoed, end).split("\n")) {
        if (line !== "" && !line.startsWith("SMOKE_RESULT ")) process.stdout.write(`${line}\n`);
      }
      echoed = Math.max(echoed, end);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.echo) echoCompleteLines();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.on("error", (error) => {
      stderr += String(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    options.onSpawn?.(child);
  });
}

// ---------------------------------------------------------------------------
// Checks and reporting
// ---------------------------------------------------------------------------

/** One line of the final report. */
interface CheckResult {
  readonly runtime: string;
  readonly name: string;
  readonly status: "ok" | "fail" | "skip";
  readonly detail?: string;
}

const results: CheckResult[] = [];

/** Records and prints the result of one check. Throwing inside `body` fails it. */
async function check(runtime: Runtime, name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    results.push({ runtime: runtime.name, name, status: "ok" });
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ runtime: runtime.name, name, status: "fail", detail });
    process.stdout.write(`  FAIL  ${name}\n${detail.replace(/^/gm, "        ")}\n`);
  }
}

/** Throws a descriptive error unless a CLI run exited with `expectedCode`. */
function expectExit(result: ProcessResult, expectedCode: number, what: string): void {
  if (result.code === expectedCode) return;
  throw new Error(
    `${what}: exit code ${String(result.code)} (signal ${String(result.signal)}), expected ${expectedCode}\n` +
      `stdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-2000)}`,
  );
}

/** Parses the `--json` output of a CLI command. */
function parseJson(result: ProcessResult): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`not JSON on stdout: ${result.stdout.slice(0, 500)}\nstderr: ${result.stderr}`);
  }
}

/** Reads a string property of a parsed JSON value, or fails. */
function stringField(value: unknown, field: string): string {
  const found: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;
  if (typeof found !== "string")
    throw new Error(`no string "${field}" in ${JSON.stringify(value)}`);
  return found;
}

/** Waits until `predicate` holds, polling, or fails after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---------------------------------------------------------------------------
// The scenarios run from here
// ---------------------------------------------------------------------------

/** Runs smoke.ts in `runtime` and records each scenario it reports. */
async function runLibraryScenarios(runtime: Runtime, env: Record<string, string>): Promise<void> {
  const result = await runProcess([...runtime.run, SMOKE_SCRIPT], {
    env,
    echo: true,
    timeoutMs: 10 * 60_000,
  });
  const summaryLine = result.stdout.split("\n").find((line) => line.startsWith("SMOKE_RESULT "));
  if (summaryLine === undefined) {
    // The runtime crashed (or hung) before printing its summary: one failure.
    results.push({
      runtime: runtime.name,
      name: "library scenarios (smoke.ts)",
      status: "fail",
      detail: `no summary; exit ${String(result.code)}\n${result.stderr.slice(-3000)}`,
    });
    process.stdout.write(`  FAIL  smoke.ts did not finish\n${result.stderr.slice(-3000)}\n`);
    return;
  }
  const summary: { results: { name: string; status: "ok" | "fail" | "skip"; detail?: string }[] } =
    JSON.parse(summaryLine.slice("SMOKE_RESULT ".length));
  for (const scenario of summary.results) {
    results.push({
      runtime: runtime.name,
      name: scenario.name,
      status: scenario.status,
      ...(scenario.detail === undefined ? {} : { detail: scenario.detail }),
    });
  }
}

/** Seeds `<dbName>.docs` with `count` small documents for the CLI checks. */
async function seedCliDatabase(client: MongoClient, dbName: string, count: number): Promise<void> {
  const documents = Array.from({ length: count }, (_, index) => ({ index, text: `doc ${index}` }));
  await client.db(dbName).collection("docs").insertMany(documents);
}

/** Drives the built CLI with `runtime`. */
async function runCliScenarios(runtime: Runtime, client: MongoClient, uri: string): Promise<void> {
  const cli = (...args: string[]) => [...runtime.run, CLI, ...args];
  const workDirectory = await mkdtemp(join(tmpdir(), `mongoshield-cli-${runtime.name}-`));
  const storage = join(workDirectory, "backups");
  const dbName = `cli_${runtime.name}_${randomBytes(3).toString("hex")}`;
  await seedCliDatabase(client, dbName, 500);
  const env = { MONGODB_URI: uri, MONGOSHIELD_STORAGE: storage };

  let recipient = "";
  let identity = "";
  let backupId = "";

  await check(runtime, "CLI: --version", async () => {
    const result = await runProcess(cli("--version"));
    expectExit(result, 0, "--version");
    if (!result.stdout.includes("mongoshield")) throw new Error(`unexpected: ${result.stdout}`);
  });

  await check(runtime, "CLI: keygen --json", async () => {
    const result = await runProcess(cli("keygen", "--json"));
    expectExit(result, 0, "keygen");
    const keys = parseJson(result);
    recipient = stringField(keys, "recipient");
    identity = stringField(keys, "identity");
  });

  await check(runtime, "CLI: backup (zstd, age recipient) from environment variables", async () => {
    const result = await runProcess(
      cli("backup", "--include", `${dbName}.*`, "--recipient", recipient, "--json"),
      { env },
    );
    expectExit(result, 0, "backup");
    backupId = stringField(parseJson(result), "id");
  });

  await check(runtime, "CLI: list --json", async () => {
    const result = await runProcess(cli("list", "--json"), { env });
    expectExit(result, 0, "list");
    if (!result.stdout.includes(backupId)) throw new Error(`backup ${backupId} is not listed`);
  });

  await check(runtime, "CLI: verify --deep with an identity", async () => {
    const result = await runProcess(cli("verify", backupId, "--deep", "--json"), {
      env: { ...env, MONGOSHIELD_IDENTITY: identity },
    });
    expectExit(result, 0, "verify --deep");
  });

  await check(runtime, "CLI: restore --rename", async () => {
    const result = await runProcess(
      cli("restore", backupId, "--rename", `${dbName}.*=${dbName}_r.*`, "--yes", "--json"),
      { env: { ...env, MONGOSHIELD_IDENTITY: identity } },
    );
    expectExit(result, 0, "restore");
    const restored = await client.db(`${dbName}_r`).collection("docs").countDocuments();
    if (restored !== 500) throw new Error(`restored ${restored} documents, expected 500`);
  });

  await check(runtime, "CLI: mongoshield.config.ts is loaded", async () => {
    // A config file with TypeScript syntax, loaded by jiti inside the runtime.
    const projectDirectory = join(workDirectory, "project");
    await mkdir(projectDirectory);
    await writeFile(
      join(projectDirectory, "mongoshield.config.ts"),
      [
        "const storage: string = process.env.SMOKE_STORAGE ?? '';",
        "export default { storage, compression: 'gzip' as const };",
        "",
      ].join("\n"),
    );
    const result = await runProcess(cli("list", "--json"), {
      cwd: projectDirectory,
      env: { SMOKE_STORAGE: storage, MONGOSHIELD_STORAGE: "" },
    });
    expectExit(result, 0, "list with a config file");
    if (!result.stdout.includes(backupId))
      throw new Error("the config file's storage was not used");
  });

  await check(runtime, "CLI: Ctrl-C cancels a running backup cleanly (exit 60)", async () => {
    // A throttled backup of 8 MiB at 1 MiB/s takes about 8 s, so the interrupt
    // reliably lands while it runs.
    const bigDb = `${dbName}_big`;
    const payload = new Binary(randomBytes(64 * 1024));
    const documents = Array.from({ length: 128 }, (_, index) => ({ index, payload }));
    await client.db(bigDb).collection("blobs").insertMany(documents);
    let child: ChildProcess | undefined;
    const started = Date.now();
    const running = runProcess(
      cli(
        "backup",
        "--include",
        `${bigDb}.*`,
        "--max-bytes-per-second",
        "1MiB",
        "--compression",
        "none",
      ),
      { env, onSpawn: (spawned) => (child = spawned), timeoutMs: 60_000 },
    );
    // Give the runtime time to start, connect and begin reading.
    await waitFor(() => child !== undefined, 5_000, "the CLI to start");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    child?.kill("SIGINT");
    const result = await running;
    expectExit(result, ABORTED_EXIT_CODE, "backup interrupted with SIGINT");
    if (Date.now() - started > 30_000)
      throw new Error("the interrupted backup took over 30 s to stop");
  });

  await check(runtime, "CLI: runs as an installed package", async () => {
    // A throwaway project whose node_modules/mongoshield points at this package
    // and whose node_modules/.bin/mongoshield points at its bin, which is how a
    // package manager installs it. Each runtime starts the bin its own way.
    const projectDirectory = join(workDirectory, "installed");
    const modules = join(projectDirectory, "node_modules");
    await mkdir(join(modules, ".bin"), { recursive: true });
    await symlink(PACKAGE_DIR, join(modules, "mongoshield"), "dir");
    await symlink(
      join("..", "mongoshield", "dist", "cli.mjs"),
      join(modules, ".bin", "mongoshield"),
    );
    await writeFile(
      join(projectDirectory, "package.json"),
      JSON.stringify({ name: "smoke", private: true, dependencies: { mongoshield: "*" } }),
    );
    const binCommand: Record<Runtime["name"], string[]> = {
      node: [process.execPath, join("node_modules", ".bin", "mongoshield")],
      // --bun: run the bin with Bun even though its shebang says `node`.
      bun: ["bun", "--bun", "x", "mongoshield"],
      deno: ["deno", "run", "-A", "npm:mongoshield"],
    };
    const result = await runProcess([...binCommand[runtime.name], "--version"], {
      cwd: projectDirectory,
    });
    expectExit(result, 0, `${binCommand[runtime.name].join(" ")} --version`);
  });

  await rm(workDirectory, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Starts S3Mock and creates the bucket. Returns the endpoint and the container. */
async function startS3Mock(): Promise<{ endpoint: string; container: StartedTestContainer }> {
  const container = await new GenericContainer(S3MOCK_IMAGE)
    .withExposedPorts(S3MOCK_PORT)
    .withWaitStrategy(Wait.forHttp("/", S3MOCK_PORT).forStatusCodeMatching(() => true))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(S3MOCK_PORT)}`;
  const s3 = new S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "smoke", secretAccessKey: "smoke" },
  });
  await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  s3.destroy();
  return { endpoint, container };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      runtime: { type: "string", multiple: true },
      require: { type: "boolean", default: false },
      s3: { type: "boolean", default: process.env.SMOKE_S3 === "1" },
    },
  });
  if (!existsSync(CLI)) {
    process.stderr.write("dist/ is missing: run `pnpm --filter mongoshield build` first.\n");
    return 2;
  }

  const requested = values.runtime ?? RUNTIMES.map((runtime) => runtime.name);
  const selected: Runtime[] = [];
  for (const runtime of RUNTIMES) {
    if (!requested.includes(runtime.name)) continue;
    if (isOnPath(runtime.run[0] ?? "")) {
      selected.push(runtime);
    } else if (values.require) {
      process.stderr.write(`${runtime.name} is not installed, but --require was given.\n`);
      return 1;
    } else {
      process.stdout.write(`skipping ${runtime.name}: not installed\n`);
    }
  }

  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await replSet.waitUntilRunning();
  const uri = replSet.getUri();
  const client = await MongoClient.connect(uri);

  let s3: { endpoint: string; container: StartedTestContainer } | undefined;
  if (values.s3) {
    if (await isDockerAvailable()) s3 = await startS3Mock();
    else process.stdout.write("--s3 given, but Docker is not reachable: S3 scenarios will skip\n");
  }

  try {
    for (const runtime of selected) {
      const version = await runProcess([runtime.run[0] ?? "", ...runtime.versionArgs]);
      process.stdout.write(`\n=== ${runtime.name} ${version.stdout.split("\n")[0]?.trim()}\n`);
      await runLibraryScenarios(runtime, {
        SMOKE_MONGODB_URI: uri,
        ...(s3 ? { SMOKE_S3_ENDPOINT: s3.endpoint, SMOKE_S3_BUCKET: S3_BUCKET } : {}),
      });
      await runCliScenarios(runtime, client, uri);
    }
  } finally {
    await client.close();
    await replSet.stop();
    await s3?.container.stop();
  }

  // Summary table: one row per runtime.
  process.stdout.write("\nSummary\n");
  for (const runtime of selected) {
    const mine = results.filter((result) => result.runtime === runtime.name);
    const count = (status: CheckResult["status"]) =>
      mine.filter((result) => result.status === status).length;
    process.stdout.write(
      `  ${runtime.name.padEnd(5)} ${count("ok")} ok, ${count("fail")} failed, ${count("skip")} skipped\n`,
    );
  }
  return results.some((result) => result.status === "fail") ? 1 : 0;
}

process.exitCode = await main();
