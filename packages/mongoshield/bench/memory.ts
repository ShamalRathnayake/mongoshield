/**
 * Memory benchmark for backups: checks that peak memory depends on `parallelism`,
 * not on the size of the database (docs/specs/PARTS-AND-RESUME.md, section 5).
 *
 *   node bench/memory.ts [--docs 300000] [--doc-bytes 1024] [--heap-mib 128]
 *                        [--parallelism 4] [--part-size-mib 64] [--compression zstd]
 *                        [--uri mongodb://…]
 *
 * It seeds `--docs` documents of about `--doc-bytes` bytes into a scratch database
 * (in a throwaway mongod from mongodb-memory-server unless `--uri` is given; set
 * MONGOMS_SYSTEM_BINARY to use an installed mongod), then runs the backup in a
 * CHILD process started with `--max-old-space-size=<heap-mib>`, so a backup that
 * buffered the database would crash instead of passing. The child samples its own
 * RSS every 20 ms and reports throughput and peak memory; the parent prints them.
 * The backup goes to a temporary directory (file storage, `--compression`, zstd by
 * default), which is deleted afterwards.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MongoClient } from "mongodb";
import { runBackup } from "../src/engine/backup.ts";
import { silentLogger } from "../src/logger.ts";
import { fileStorage } from "../src/storage/file.ts";

const MIB = 1024 * 1024;
const DATABASE = "mongoshield_bench_memory";
const SEED_BATCH = 5000;

const { values } = parseArgs({
  options: {
    docs: { type: "string", default: "300000" },
    "doc-bytes": { type: "string", default: "1024" },
    "heap-mib": { type: "string", default: "128" },
    parallelism: { type: "string", default: "4" },
    "part-size-mib": { type: "string", default: "64" },
    compression: { type: "string", default: "zstd" },
    uri: { type: "string" },
    // Internal: set when this file runs as the measured child process.
    child: { type: "boolean", default: false },
    storage: { type: "string" },
  },
});

/** What the child reports on stdout, as one JSON line. */
interface ChildReport {
  readonly documents: number;
  readonly bytesRaw: number;
  readonly bytesStored: number;
  readonly files: number;
  readonly durationMs: number;
  readonly peakRssBytes: number;
  readonly peakHeapBytes: number;
  /** Buffers outside the JavaScript heap (cursor batches, stream chunks). */
  readonly peakArrayBufferBytes: number;
}

if (values.child) {
  await runChild();
} else {
  await runParent();
}

// ---------------------------------------------------------------------------
// Parent: seed, spawn, report
// ---------------------------------------------------------------------------

async function runParent(): Promise<void> {
  const documents = Number(values.docs);
  const documentBytes = Number(values["doc-bytes"]);
  const { uri, stop } = await startDatabase(values.uri);
  const storage = await mkdtemp(join(tmpdir(), "mongoshield-bench-"));
  try {
    print(`Seeding ${documents.toLocaleString("en-US")} documents of ~${documentBytes} B…`);
    await seed(uri, documents, documentBytes);

    const heapMib = Number(values["heap-mib"]);
    print(`Backing up in a child process with --max-old-space-size=${heapMib}…`);
    const report = await spawnChild(uri, storage, heapMib);

    const seconds = report.durationMs / 1000;
    const rows: [string, string][] = [
      ["documents", report.documents.toLocaleString("en-US")],
      ["raw data", `${(report.bytesRaw / MIB).toFixed(1)} MiB`],
      [
        `stored (${values.compression})`,
        `${(report.bytesStored / MIB).toFixed(1)} MiB in ${report.files} data files`,
      ],
      ["parallelism", String(values.parallelism)],
      ["part size", `${values["part-size-mib"]} MiB`],
      ["heap limit", `${heapMib} MiB`],
      ["duration", `${seconds.toFixed(1)} s`],
      [
        "throughput",
        `${Math.round(report.documents / seconds).toLocaleString("en-US")} docs/s, ${(report.bytesRaw / MIB / seconds).toFixed(1)} MiB/s`,
      ],
      ["peak RSS", `${(report.peakRssBytes / MIB).toFixed(1)} MiB`],
      ["peak heap used", `${(report.peakHeapBytes / MIB).toFixed(1)} MiB`],
      ["peak buffers", `${(report.peakArrayBufferBytes / MIB).toFixed(1)} MiB (outside the heap)`],
    ];
    for (const [label, value] of rows) print(`  ${label.padEnd(16)} ${value}`);
  } finally {
    await rm(storage, { recursive: true, force: true });
    await stop();
  }
}

/** Connects to `--uri`, or starts a throwaway single-node replica set. */
async function startDatabase(
  uri: string | undefined,
): Promise<{ readonly uri: string; readonly stop: () => Promise<void> }> {
  if (uri !== undefined) return { uri, stop: async () => {} };
  const { MongoMemoryReplSet } = await import("mongodb-memory-server");
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await replSet.waitUntilRunning();
  return { uri: replSet.getUri(), stop: async () => void (await replSet.stop()) };
}

/** Replaces the bench database with `count` documents of about `bytes` bytes. */
async function seed(uri: string, count: number, bytes: number): Promise<void> {
  const client = new MongoClient(uri);
  try {
    const collection = client.db(DATABASE).collection("events");
    await collection.drop().catch(() => undefined);
    const padding = "x".repeat(Math.max(0, bytes - 60));
    for (let start = 0; start < count; start += SEED_BATCH) {
      const batch = [];
      for (let index = start; index < Math.min(count, start + SEED_BATCH); index++) {
        batch.push({ index, at: new Date(), padding });
      }
      await collection.insertMany(batch, { ordered: false });
    }
  } finally {
    await client.close();
  }
}

/** Runs this file as the child and returns its report. */
function spawnChild(uri: string, storage: string, heapMib: number): Promise<ChildReport> {
  const script = fileURLToPath(import.meta.url);
  const args = [
    `--max-old-space-size=${heapMib}`,
    script,
    "--child",
    "--uri",
    uri,
    "--storage",
    storage,
    "--parallelism",
    String(values.parallelism),
    "--part-size-mib",
    String(values["part-size-mib"]),
    "--compression",
    String(values.compression),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`The backup child exited with code ${code} (out of memory?)`));
        return;
      }
      resolve(JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as ChildReport);
    });
  });
}

// ---------------------------------------------------------------------------
// Child: back up and measure
// ---------------------------------------------------------------------------

async function runChild(): Promise<void> {
  const uri = values.uri;
  const storagePath = values.storage;
  if (uri === undefined || storagePath === undefined) throw new Error("--uri and --storage");

  let peakRssBytes = 0;
  let peakHeapBytes = 0;
  let peakArrayBufferBytes = 0;
  const sample = (): void => {
    const usage = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, usage.rss);
    peakHeapBytes = Math.max(peakHeapBytes, usage.heapUsed);
    peakArrayBufferBytes = Math.max(peakArrayBufferBytes, usage.arrayBuffers);
  };
  const sampler = setInterval(sample, 20);

  const client = new MongoClient(uri);
  try {
    const result = await runBackup(
      {
        client,
        storage: fileStorage({ path: storagePath }),
        logger: silentLogger,
        compression: compressionOf(values.compression),
        encryption: undefined,
      },
      {
        include: [`${DATABASE}.*`],
        consistency: "none",
        parallelism: Number(values.parallelism),
        partSizeBytes: Number(values["part-size-mib"]) * MIB,
      },
    );
    sample();
    const { totals } = result.manifest;
    const report: ChildReport = {
      documents: totals.documents,
      bytesRaw: totals.bytesRaw,
      bytesStored: totals.bytesStored,
      files: result.manifest.namespaces.reduce((sum, entry) => sum + entry.files.length, 0),
      durationMs: result.durationMs,
      peakRssBytes,
      peakHeapBytes,
      peakArrayBufferBytes,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    clearInterval(sampler);
    await client.close();
  }
}

/** The `--compression` flag, checked. */
function compressionOf(value: string | undefined): "zstd" | "gzip" | "none" {
  if (value === "zstd" || value === "gzip" || value === "none") return value;
  throw new Error(`--compression must be zstd, gzip or none (got ${String(value)})`);
}

/** Prints one line (the benchmark is a script: plain stdout is its output). */
function print(line: string): void {
  process.stdout.write(`${line}\n`);
}
