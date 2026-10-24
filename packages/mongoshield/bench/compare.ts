/**
 * Benchmark: MongoShield vs mongodump/mongorestore on the same data, same machine.
 *
 *   pnpm bench                                   # small dataset (~100k documents), 3 runs
 *   pnpm bench --scale medium                    # 2M documents, ~1.5 GiB of BSON
 *   pnpm bench --scale large                     # 5M documents, ~3.7 GiB of BSON
 *   pnpm bench --scale tiny --runs 1             # CI smoke test: only proves the harness works
 *
 * Options
 *   --scale <tiny|small|medium|large>  Dataset size (default small; see bench/compare/dataset.ts)
 *   --runs <n>                         Backup + restore runs per variant; medians are reported (default 3)
 *   --variants <id,id>                 Only these variants (ids in bench/compare/variants.ts)
 *   --uri <mongodb-uri>                Use this deployment instead of starting a local mongod
 *                                      (only the mongoshield_bench* databases are touched)
 *   --consistency <mode>               mongoshield --consistency (default auto)
 *   --cache-gb <n>                     WiredTiger cache of the local mongod (default: mongod's own)
 *   --no-restore                       Measure backups only
 *   --require-tools                    Fail instead of skipping when mongodump is not installed
 *   --output <file>                    Results file (default bench/results/<scale>.json)
 *   --table <file>                     Only print the Markdown table of an existing results file
 *
 * How it works: it starts a single-node replica set from mongodb-memory-server (set
 * MONGOMS_SYSTEM_BINARY to use an installed mongod) with its data directory on the
 * local disk, seeds a reproducible dataset, then for every run and every variant
 * backs the database up to a fresh local directory and restores it into an empty
 * database under another name, measuring each command as a separate process (wall
 * time, peak RSS, CPU time; see bench/compare/measure.ts). The order of the variants
 * rotates from run to run so none of them always goes first. Each restore is checked
 * (same collections, document counts and indexes) so a broken run cannot look fast.
 *
 * mongodump/mongorestore come from MONGO_TOOLS_BIN or packages/mongoshield/.tools
 * (`node scripts/fetch-mongo-tools.ts`). The mongoshield CLI is the built one
 * (dist/cli.mjs): run `pnpm build` first.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { MongoClient } from "mongodb";
import {
  compareSummaries,
  RESTORE_DATABASE,
  SCALES,
  seedDataset,
  summarizeDatabase,
} from "./compare/dataset.ts";
import { directorySize, measure, rusageAvailable } from "./compare/measure.ts";
import {
  type BenchmarkResults,
  markdownTable,
  type RunResult,
  summarizeVariant,
  type VariantResult,
} from "./compare/report.ts";
import { VARIANTS, type Variant, type VariantContext } from "./compare/variants.ts";

const execFileAsync = promisify(execFile);

/** packages/mongoshield, whatever directory the script is started from. */
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

const { values } = parseArgs({
  options: {
    scale: { type: "string", default: "small" },
    runs: { type: "string", default: "3" },
    variants: { type: "string" },
    uri: { type: "string" },
    consistency: { type: "string", default: "auto" },
    "cache-gb": { type: "string" },
    "no-restore": { type: "boolean", default: false },
    "require-tools": { type: "boolean", default: false },
    output: { type: "string" },
    table: { type: "string" },
  },
});

await main();

async function main(): Promise<void> {
  // --table: re-render the table of an earlier run (for docs/benchmarks.md) and stop.
  if (values.table !== undefined) {
    print(markdownTable(JSON.parse(readFileSync(values.table, "utf8")) as BenchmarkResults));
    return;
  }

  const startedAt = new Date();
  const scaleName = values.scale;
  const scale = SCALES[scaleName];
  if (scale === undefined) {
    throw new Error(`--scale must be one of ${Object.keys(SCALES).join(", ")} (got ${scaleName})`);
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

  const mongoshieldCli = await snapshotBuild();

  // Everything temporary (mongod's data, backups, the age key) lives under one
  // directory on the local disk, removed at the end.
  const scratch = await mkdtemp(join(tmpdir(), "mongoshield-bench-"));
  const database = await startDatabase(values.uri, join(scratch, "db"), values["cache-gb"]);
  const client = new MongoClient(database.uri);
  try {
    print(`Seeding the ${scaleName} dataset…`);
    const seedStarted = performance.now();
    const dataset = await seedDataset(client, scale, print);
    print(
      `Seeded ${dataset.totalDocuments.toLocaleString("en-US")} documents, ` +
        `${(dataset.totalDataBytes / 1024 ** 2).toFixed(0)} MiB of BSON ` +
        `in ${((performance.now() - seedStarted) / 1000).toFixed(0)} s.`,
    );

    const workDirectory = join(scratch, "work");
    await mkdir(workDirectory, { recursive: true });
    const context: VariantContext = {
      uri: database.uri,
      mongoshieldCli,
      toolsBin: findToolsBin(),
      ...(await generateAgeKey(mongoshieldCli, workDirectory)),
      consistency: values.consistency,
      workDirectory,
    };

    const { selected, skipped } = selectVariants(context);
    const variantRuns = new Map<string, RunResult[]>();
    for (let run = 1; run <= runs; run++) {
      // Rotate the order each run, so no variant always runs first (cold) or last.
      const rotation = (run - 1) % selected.length;
      const ordered = [...selected.slice(rotation), ...selected.slice(0, rotation)];
      for (const variant of ordered) {
        const result = await runVariant(client, context, variant, run, scratch, dataset);
        const list = variantRuns.get(variant.id) ?? [];
        list.push(result);
        variantRuns.set(variant.id, list);
      }
    }

    const variantResults: VariantResult[] = selected.map((variant) =>
      summarizeVariant(variant.id, variant.label, variantRuns.get(variant.id) ?? []),
    );
    const results: BenchmarkResults = {
      schema: 1,
      scale: scaleName,
      startedAt: startedAt.toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      runsPerVariant: runs,
      machine: await machineInfo(client, context),
      settings: {
        consistency: values.consistency,
        restore: !values["no-restore"],
        measurement: rusageAvailable() ? "rusage (/usr/bin/time)" : "ps sampling every 50 ms",
        deployment: values.uri === undefined ? "local single-node replica set" : "--uri",
        scale,
      },
      dataset,
      variants: variantResults,
      skipped,
    };
    const output = values.output ?? join(PACKAGE_ROOT, "bench", "results", `${scaleName}.json`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(results, null, 2)}\n`);

    print("");
    print(markdownTable(results));
    for (const entry of skipped) print(`Skipped ${entry.id}: ${entry.reason}`);
    print(`\nResults written to ${output}`);
  } finally {
    await client.close();
    await database.stop();
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Backs up with `variant` into a fresh directory, then (unless --no-restore) drops
 * the restore database and restores into it, and checks the restored data.
 */
async function runVariant(
  client: MongoClient,
  context: VariantContext,
  variant: Variant,
  run: number,
  scratch: string,
  dataset: Awaited<ReturnType<typeof seedDataset>>,
): Promise<RunResult> {
  const outputDirectory = join(scratch, "backups", variant.id);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const backup = await measure(variant.backup(context, outputDirectory));
  const outputBytes = await directorySize(outputDirectory);

  let restore = null;
  if (!values["no-restore"]) {
    // Every restore starts from an empty target (outside the timed part).
    await client.db(RESTORE_DATABASE).dropDatabase();
    restore = await measure(variant.restore(context, outputDirectory));
    const restored = await summarizeDatabase(client, RESTORE_DATABASE);
    const difference = compareSummaries(dataset, restored);
    if (difference !== undefined) {
      throw new Error(`${variant.id} restored the wrong data: ${difference}`);
    }
  }

  print(
    `run ${run} ${variant.id.padEnd(22)} backup ${(backup.wallMs / 1000).toFixed(1)} s` +
      (restore === null ? "" : `, restore ${(restore.wallMs / 1000).toFixed(1)} s`) +
      `, ${(outputBytes / 1024 ** 2).toFixed(0)} MiB`,
  );
  return { run, backup, restore, outputBytes };
}

/** The variants to run: --variants, minus the mongodump ones when the tools are missing. */
function selectVariants(context: VariantContext): {
  readonly selected: readonly Variant[];
  readonly skipped: { readonly id: string; readonly reason: string }[];
} {
  const wanted = values.variants?.split(",").map((id) => id.trim());
  const unknown = wanted?.filter((id) => !VARIANTS.some((variant) => variant.id === id)) ?? [];
  if (unknown.length > 0) throw new Error(`Unknown --variants: ${unknown.join(", ")}`);

  const selected: Variant[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const variant of VARIANTS) {
    if (wanted !== undefined && !wanted.includes(variant.id)) continue;
    if (variant.tool === "mongodump" && context.toolsBin === undefined) {
      const reason =
        "mongodump not found (set MONGO_TOOLS_BIN or run node scripts/fetch-mongo-tools.ts)";
      if (values["require-tools"]) throw new Error(reason);
      skipped.push({ id: variant.id, reason });
      continue;
    }
    selected.push(variant);
  }
  if (selected.length === 0) throw new Error("No variants to run.");
  return { selected, skipped };
}

/** Starts a local single-node replica set (or uses --uri). */
async function startDatabase(
  uri: string | undefined,
  dbPath: string,
  cacheGb: string | undefined,
): Promise<{ readonly uri: string; readonly stop: () => Promise<void> }> {
  if (uri !== undefined) return { uri, stop: async () => {} };
  await mkdir(dbPath, { recursive: true });
  const { MongoMemoryReplSet } = await import("mongodb-memory-server");
  const args = cacheGb === undefined ? [] : ["--wiredTigerCacheSizeGB", cacheGb];
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
    // A data directory we chose, on the local disk (not a RAM disk).
    instanceOpts: [{ dbPath, args }],
  });
  await replSet.waitUntilRunning();
  return { uri: replSet.getUri(), stop: async () => void (await replSet.stop()) };
}

/**
 * Copies dist/ to node_modules/.cache/mongoshield-bench/dist and returns the CLI
 * there. A long benchmark must not break (or silently change) when someone runs
 * `pnpm build` meanwhile, which empties dist/. Inside node_modules the copy still
 * resolves the package's dependencies (Node walks up to packages/mongoshield/node_modules).
 */
async function snapshotBuild(): Promise<string> {
  const built = join(PACKAGE_ROOT, "dist");
  if (!existsSync(join(built, "cli.mjs"))) {
    throw new Error("dist/cli.mjs is missing: run `pnpm build` before the benchmark.");
  }
  const snapshot = join(PACKAGE_ROOT, "node_modules", ".cache", "mongoshield-bench", "dist");
  await rm(snapshot, { recursive: true, force: true });
  await cp(built, snapshot, { recursive: true });
  return join(snapshot, "cli.mjs");
}

/** mongodump's directory: MONGO_TOOLS_BIN, else packages/mongoshield/.tools/<release>/bin. */
function findToolsBin(): string | undefined {
  const fromEnv = process.env.MONGO_TOOLS_BIN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const toolsRoot = join(PACKAGE_ROOT, ".tools");
  if (!existsSync(toolsRoot)) return undefined;
  for (const entry of readdirSync(toolsRoot)) {
    const bin = join(toolsRoot, entry, "bin");
    if (existsSync(join(bin, "mongodump")) || existsSync(join(bin, "mongodump.exe"))) return bin;
  }
  return undefined;
}

/** A throwaway age key pair for the encrypted variant, made with `mongoshield keygen`. */
async function generateAgeKey(
  mongoshieldCli: string,
  workDirectory: string,
): Promise<{ readonly ageRecipient: string; readonly ageIdentityFile: string }> {
  const identityFile = join(workDirectory, "bench-age.key");
  const { stdout } = await execFileAsync(process.execPath, [
    mongoshieldCli,
    "keygen",
    "--json",
    "--output",
    identityFile,
  ]);
  const parsed = JSON.parse(stdout) as { recipient: string };
  return { ageRecipient: parsed.recipient, ageIdentityFile: identityFile };
}

/** The machine and software versions, so a results file says where it came from. */
async function machineInfo(
  client: MongoClient,
  context: VariantContext,
): Promise<Record<string, unknown>> {
  const admin = client.db("admin");
  const buildInfo = await admin.command({ buildInfo: 1 });
  const serverStatus = await admin.command({ serverStatus: 1 });
  const cacheBytes = Number(serverStatus.wiredTiger?.cache?.["maximum bytes configured"] ?? 0);
  const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  let mongodumpVersion: string | null = null;
  if (context.toolsBin !== undefined) {
    const { stdout } = await execFileAsync(join(context.toolsBin, "mongodump"), ["--version"]);
    mongodumpVersion = stdout.split("\n")[0]?.replace("mongodump version: ", "").trim() ?? null;
  }
  const processors = cpus();
  return {
    cpu: processors[0]?.model ?? "unknown",
    logicalCpus: processors.length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    freeMemoryGiBAtEnd: Math.round(freemem() / 1024 ** 3),
    loadAverageAtEnd: loadavg().map((value) => Number(value.toFixed(2))),
    os: `${platform()} ${release()} ${arch()}`,
    node: process.version,
    mongod: String(buildInfo.version),
    wiredTigerCacheGiB: Number((cacheBytes / 1024 ** 3).toFixed(1)),
    mongoshield: packageJson.version,
    mongoshieldGit: await gitDescription(),
    mongodump: mongodumpVersion,
  };
}

/**
 * The commit the measured build came from, e.g. "3162676" or "3162676-dirty" when the
 * working tree had uncommitted changes; null outside a git checkout.
 */
async function gitDescription(): Promise<string | null> {
  try {
    const options = { cwd: PACKAGE_ROOT };
    const head = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], options);
    // `git status --porcelain` prints one line per changed file, nothing when clean.
    const status = await execFileAsync("git", ["status", "--porcelain"], options);
    const dirty = status.stdout.trim() === "" ? "" : "-dirty";
    return `${head.stdout.trim()}${dirty}`;
  } catch {
    return null;
  }
}

/** Prints one line (the benchmark is a script: plain stdout is its output). */
function print(line: string): void {
  process.stdout.write(`${line}\n`);
}
