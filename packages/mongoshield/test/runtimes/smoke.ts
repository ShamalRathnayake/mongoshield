/**
 * End-to-end smoke scenarios for the BUILT package, run under Node.js, Bun or Deno.
 *
 * `run.ts` starts a mongod (and optionally an S3 mock), then runs this file once
 * per runtime:
 *
 *   node smoke.ts   bun smoke.ts   deno run -A smoke.ts
 *
 * with the connection details in the environment:
 *
 *   SMOKE_MONGODB_URI   replica-set URI (required)
 *   SMOKE_S3_ENDPOINT   S3-compatible endpoint, e.g. http://127.0.0.1:9090 (optional)
 *   SMOKE_S3_BUCKET     bucket to use on that endpoint (optional, default "smoke")
 *
 * It imports `mongoshield` by its package name, so the `exports` map of
 * package.json is exercised exactly as an application would use it. Only
 * runtime-neutral APIs are used here (node:* built-ins that Bun and Deno
 * implement), so a failure points at MongoShield, not at this script.
 *
 * Output: one line per scenario ("ok"/"FAIL"/"skip"), then a JSON summary line
 * starting with `SMOKE_RESULT ` that the runner parses. Exit code 1 if any failed.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { Binary, BSON, type Db, MongoClient, ObjectId } from "mongodb";
import type { StorageAdapter } from "../../src/index.ts";

/**
 * Imports a BUILT entry point by its package name (resolved through the
 * `exports` map to dist/), typed with the matching source module. Typing from
 * src/ keeps `pnpm typecheck` independent of whether dist/ has been built.
 */
async function importBuilt<Module>(specifier: string): Promise<Module> {
  return (await import(specifier)) as Module;
}

const { generateIdentity, MongoShield } =
  await importBuilt<typeof import("../../src/index.ts")>("mongoshield");
const { fileStorage } = await importBuilt<typeof import("../../src/storage/file.ts")>(
  "mongoshield/storage/file",
);
const { memoryStorage } = await importBuilt<typeof import("../../src/storage/memory.ts")>(
  "mongoshield/storage/memory",
);

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

/** What a scenario reports: nothing (passed), or a reason it was skipped. */
type ScenarioOutcome = undefined | { readonly skipped: string };

/** One named end-to-end check. Throwing means it failed. */
interface Scenario {
  readonly name: string;
  readonly run: () => Promise<ScenarioOutcome>;
}

/** A finished scenario, as printed in the JSON summary. */
interface ScenarioResult {
  readonly name: string;
  readonly status: "ok" | "fail" | "skip";
  readonly durationMs: number;
  readonly detail?: string;
}

/** Which runtime is executing this file, for the report only (never for behaviour). */
function runtimeName(): string {
  const versions: Record<string, string | undefined> = { ...process.versions };
  if (versions.bun !== undefined) return `bun ${versions.bun}`;
  if (versions.deno !== undefined) return `deno ${versions.deno}`;
  return `node ${process.versions.node}`;
}

/** Fails the current scenario with `message` unless `condition` holds. */
function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Reads the MongoShield error code of a rejection, or a description of what else it was. */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) return String(error.code);
  return `non-MongoShield error: ${String(error)}`;
}

/** Runs `operation` and returns the code it fails with. Fails if it succeeds. */
async function expectFailure(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return errorCode(error);
  }
  throw new Error("expected the operation to fail, but it succeeded");
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MONGODB_URI = process.env.SMOKE_MONGODB_URI ?? "";
const client = new MongoClient(MONGODB_URI);

/** A unique database name, so scenarios (and runtimes) never see each other's data. */
function uniqueDbName(prefix: string): string {
  return `smoke_${prefix}_${randomBytes(4).toString("hex")}`;
}

/**
 * Fills `db.docs` with `count` documents covering the common BSON types, plus a
 * secondary index, so a restore proves more than "the bytes came back".
 */
async function seedVariedDocuments(db: Db, count: number): Promise<void> {
  const documents = [];
  for (let index = 0; index < count; index++) {
    documents.push({
      _id: new ObjectId(),
      index,
      name: `user ${index} ✓ ünïcödé`,
      createdAt: new Date(1_700_000_000_000 + index * 1000),
      tags: ["a", "b", String(index % 7)],
      nested: { level: { deeper: index * 1.5, flag: index % 2 === 0 } },
      blob: new Binary(randomBytes(64)),
      // Repetitive text, so compression has something to do.
      note: "lorem ipsum dolor sit amet ".repeat(8),
    });
  }
  await db.collection("docs").insertMany(documents);
  await db.collection("docs").createIndex({ index: 1 }, { unique: true });
}

/**
 * Fills `db.blobs` with incompressible binary documents totalling about
 * `totalBytes`, for the memory and cancellation scenarios.
 */
async function seedLargeDocuments(db: Db, totalBytes: number): Promise<void> {
  const documentSize = 64 * 1024; // 64 KiB per document
  const count = Math.ceil(totalBytes / documentSize);
  const batchSize = 100;
  for (let start = 0; start < count; start += batchSize) {
    const batch = [];
    for (let index = start; index < Math.min(count, start + batchSize); index++) {
      batch.push({ index, payload: new Binary(randomBytes(documentSize)) });
    }
    await db.collection("blobs").insertMany(batch);
  }
}

/**
 * SHA-256 over every document of every collection of `db`, in `_id` order.
 * Two databases with the same fingerprint hold byte-identical documents.
 */
async function fingerprint(db: Db): Promise<string> {
  const hash = createHash("sha256");
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((collection) => collection.name)
    .sort();
  for (const name of collections) {
    hash.update(`collection:${name}\n`);
    for await (const document of db.collection(name).find().sort({ _id: 1 })) {
      hash.update(BSON.serialize(document));
    }
  }
  return hash.digest("hex");
}

/** Lists the names of the indexes on `db.docs`, sorted. */
async function indexNames(db: Db): Promise<string[]> {
  const indexes = await db.collection("docs").listIndexes().toArray();
  return indexes.map((index) => String(index.name)).sort();
}

/** Creates a temporary directory that `cleanup()` removes at the end. */
const temporaryDirectories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mongoshield-smoke-"));
  temporaryDirectories.push(path);
  return path;
}

/** Recursively lists every file under `directory` (paths relative to the system root). */
async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}

// ---------------------------------------------------------------------------
// The round trip every storage/compression/encryption combination goes through
// ---------------------------------------------------------------------------

/** One combination of settings for `roundTrip()`. */
interface RoundTripSettings {
  readonly storage: StorageAdapter;
  readonly compression: "zstd" | "gzip" | "none";
  readonly encryption?: { readonly recipients: string[] } | { readonly passphrase: string };
  readonly decryption?: { readonly identities: string[] } | { readonly passphrase: string };
}

/**
 * backup → deep verify → restore under a new name, then proves the restored
 * database holds exactly the original documents and indexes.
 */
async function roundTrip(settings: RoundTripSettings): Promise<void> {
  const sourceName = uniqueDbName("src");
  const targetName = `${sourceName}_restored`;
  const source = client.db(sourceName);
  await seedVariedDocuments(source, 1500);

  const shield = new MongoShield({
    source: { client },
    storage: settings.storage,
    compression: settings.compression,
    ...(settings.encryption ? { encryption: settings.encryption } : {}),
  });

  const backup = await shield.backup({ include: [`${sourceName}.*`] });
  check(backup.manifest.compression === settings.compression, "manifest has the wrong compression");

  const report = await shield.verify({
    backup: backup.id,
    mode: "deep",
    ...(settings.decryption ? { decryption: settings.decryption } : {}),
  });
  check(report.ok, `deep verify found problems: ${JSON.stringify(report.problems)}`);
  check(
    report.documentsChecked === 1500,
    `deep verify parsed ${report.documentsChecked} documents`,
  );

  await shield.restore({
    backup: backup.id,
    rename: { [`${sourceName}.*`]: `${targetName}.*` },
    ...(settings.decryption ? { decryption: settings.decryption } : {}),
  });

  const target = client.db(targetName);
  check((await fingerprint(source)) === (await fingerprint(target)), "restored documents differ");
  check(
    JSON.stringify(await indexNames(source)) === JSON.stringify(await indexNames(target)),
    "restored indexes differ",
  );
  await source.dropDatabase();
  await target.dropDatabase();
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * A storage adapter that slows down every upload: each chunk is held for a
 * moment before it reaches the real adapter. If backpressure works, MongoShield
 * reads from MongoDB only as fast as this consumer drains, so memory stays flat.
 */
function slowStorage(inner: StorageAdapter, delayMs: number): StorageAdapter {
  return {
    kind: inner.kind,
    location: inner.location,
    capabilities: inner.capabilities,
    put(key, body, options) {
      if (!(body instanceof Readable)) return inner.put(key, body, options);
      const slow = new Transform({
        // A small buffer, so the delay is felt upstream instead of absorbed here.
        highWaterMark: 16 * 1024,
        transform(chunk, _encoding, done) {
          globalThis.setTimeout(() => done(null, chunk), delayMs);
        },
      });
      body.on("error", (error) => slow.destroy(error));
      return inner.put(key, body.pipe(slow), options);
    },
    get: (key, options) => inner.get(key, options),
    head: (key, options) => inner.head(key, options),
    list: (prefix, options) => inner.list(prefix, options),
    listPrefixes: (prefix, options) => inner.listPrefixes(prefix, options),
    delete: (keys, options) => inner.delete(keys, options),
  };
}

/** What `stallingStorage` observed while its consumer stood still. */
interface StallObservation {
  /** Resident memory when the stall began, or undefined if it never began. */
  rssBefore?: number;
  /** Resident memory when the stall ended. */
  rssAfter?: number;
}

/**
 * A storage adapter whose upload stops reading for `stallMs` once it has
 * received `afterBytes`, then continues at full speed. While it stands still,
 * a pipeline that respects backpressure stops reading from MongoDB too, so
 * memory must not grow; one that ignores it keeps buffering the collection.
 *
 * Measuring growth DURING a stall (instead of the peak of a whole run) keeps
 * garbage-collector timing out of the result: nothing new is allocated by a
 * correct pipeline in that window, whatever the runtime's GC does.
 */
function stallingStorage(
  inner: StorageAdapter,
  afterBytes: number,
  stallMs: number,
  observation: StallObservation,
): StorageAdapter {
  return {
    ...slowStorage(inner, 0),
    put(key, body, options) {
      if (!(body instanceof Readable)) return inner.put(key, body, options);
      let received = 0;
      let stalled = false;
      const gate = new Transform({
        highWaterMark: 16 * 1024,
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          if (stalled || received < afterBytes) {
            done(null, chunk);
            return;
          }
          stalled = true;
          observation.rssBefore = process.memoryUsage().rss;
          globalThis.setTimeout(() => {
            observation.rssAfter = process.memoryUsage().rss;
            done(null, chunk);
          }, stallMs);
        },
      });
      body.on("error", (error) => gate.destroy(error));
      return inner.put(key, body.pipe(gate), options);
    },
  };
}

const scenarios: Scenario[] = [
  {
    name: "every package entry point loads",
    run: async () => {
      // The optional SDK-backed entry points must load without their SDKs being
      // touched: they import them lazily, on first use.
      const entryPoints = [
        "mongoshield",
        "mongoshield/storage/file",
        "mongoshield/storage/memory",
        "mongoshield/storage/s3",
        "mongoshield/storage/gcs",
        "mongoshield/storage/azure",
        "mongoshield/storage/sftp",
        "mongoshield/kms",
        "mongoshield/testing",
      ];
      for (const specifier of entryPoints) {
        const module: Record<string, unknown> = await import(specifier);
        check(Object.keys(module).length > 0, `${specifier} exports nothing`);
      }
      return undefined;
    },
  },
  {
    name: "zstd + age recipients on file storage: backup, deep verify, restore",
    run: async () => {
      const identity = generateIdentity();
      await roundTrip({
        storage: fileStorage({ path: await temporaryDirectory() }),
        compression: "zstd",
        encryption: { recipients: [identity.recipient] },
        decryption: { identities: [identity.identity] },
      });
      return undefined;
    },
  },
  {
    name: "gzip + passphrase (scrypt) on memory storage: backup, deep verify, restore",
    run: async () => {
      const passphrase = "correct horse battery staple";
      await roundTrip({
        storage: memoryStorage(),
        compression: "gzip",
        encryption: { passphrase },
        decryption: { passphrase },
      });
      return undefined;
    },
  },
  {
    name: "uncompressed, unencrypted on file storage: backup, deep verify, restore",
    run: async () => {
      await roundTrip({
        storage: fileStorage({ path: await temporaryDirectory() }),
        compression: "none",
      });
      return undefined;
    },
  },
  {
    name: "zstd + age recipients on S3: backup, deep verify, restore",
    run: async () => {
      const endpoint = process.env.SMOKE_S3_ENDPOINT;
      if (!endpoint) return { skipped: "SMOKE_S3_ENDPOINT is not set (no S3 mock running)" };
      const { s3Storage } =
        await importBuilt<typeof import("../../src/storage/s3.ts")>("mongoshield/storage/s3");
      const { S3Client } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({
        region: "us-east-1",
        endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: "smoke", secretAccessKey: "smoke" },
        // S3Mock does not return per-part checksums, which the SDK's default
        // checksum mode needs for multipart uploads (see the s3 adapter docs).
        requestChecksumCalculation: "WHEN_REQUIRED",
      });
      const identity = generateIdentity();
      await roundTrip({
        storage: s3Storage({
          client: s3,
          bucket: process.env.SMOKE_S3_BUCKET ?? "smoke",
          prefix: `${runtimeName().split(" ")[0]}-${randomBytes(4).toString("hex")}/`,
        }),
        compression: "zstd",
        encryption: { recipients: [identity.recipient] },
        decryption: { identities: [identity.identity] },
      });
      s3.destroy();
      return undefined;
    },
  },
  {
    // Damaged data must surface as MS_INTEGRITY_FAILED / a verify problem, never
    // crash the process. Random payloads are stored by zstd as raw blocks, so a
    // flipped byte is only noticed by the frame checksum, after far more output
    // than zlib's 16 KiB buffer: the case where Deno's zstd threw an uncaught error.
    name: "a damaged zstd file is reported, not crashed on",
    run: async () => {
      const sourceName = uniqueDbName("corrupt");
      const source = client.db(sourceName);
      await seedLargeDocuments(source, 2 * 1024 * 1024);
      const directory = await temporaryDirectory();
      const shield = new MongoShield({
        source: { client },
        storage: fileStorage({ path: directory }),
        compression: "zstd",
      });
      const backup = await shield.backup({ include: [`${sourceName}.*`] });

      // Flip one byte in the middle of the compressed documents.
      const dataFile = (await listFiles(directory)).find((path) => path.endsWith(".bson.zst"));
      check(dataFile !== undefined, "no .bson.zst file in the backup");
      const bytes = await readFile(dataFile);
      const middle = Math.floor(bytes.length / 2);
      bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
      await writeFile(dataFile, bytes);

      // Deep verify checks the decompressed content, not only the stored digest.
      const report = await shield.verify({ backup: backup.id, mode: "deep" });
      check(!report.ok, "deep verify did not notice the damage");
      const code = await expectFailure(() =>
        shield.restore({ backup: backup.id, rename: { [`${sourceName}.*`]: `${sourceName}_r.*` } }),
      );
      check(code === "MS_INTEGRITY_FAILED", `restore failed with ${code}`);
      await source.dropDatabase();
      await client.db(`${sourceName}_r`).dropDatabase();
      return undefined;
    },
  },
  {
    name: "an AbortSignal cancels a running backup with MS_ABORTED",
    run: async () => {
      const sourceName = uniqueDbName("abort");
      const source = client.db(sourceName);
      await seedLargeDocuments(source, 16 * 1024 * 1024);
      const shield = new MongoShield({
        // A slow consumer keeps the backup running long enough to be cancelled.
        storage: slowStorage(memoryStorage(), 5),
        source: { client },
      });
      const controller = new AbortController();
      const started = Date.now();
      // Cancel as soon as the first progress event shows the backup is under way.
      const code = await expectFailure(() =>
        shield.backup({
          include: [`${sourceName}.*`],
          signal: controller.signal,
          onProgress: () => controller.abort(),
        }),
      );
      check(code === "MS_ABORTED", `backup failed with ${code} instead of MS_ABORTED`);
      check(Date.now() - started < 30_000, "cancellation took longer than 30 s");
      await source.dropDatabase();
      return undefined;
    },
  },
  {
    // If streams ignored backpressure, the rest of the collection would pile up
    // in memory while the storage consumer stands still. 96 MiB of random
    // (incompressible) data; the consumer stalls for 1.5 s after 8 MiB, which is
    // ample time for a local mongod to deliver the remaining 88 MiB.
    name: "backpressure: a stalled storage consumer stops reads from MongoDB",
    run: async () => {
      const dataSize = 96 * 1024 * 1024;
      const sourceName = uniqueDbName("pressure");
      const source = client.db(sourceName);
      await seedLargeDocuments(source, dataSize);
      const observation: StallObservation = {};
      const shield = new MongoShield({
        source: { client },
        storage: stallingStorage(
          fileStorage({ path: await temporaryDirectory() }),
          8 * 1024 * 1024,
          1500,
          observation,
        ),
        compression: "none",
      });
      await shield.backup({ include: [`${sourceName}.*`] });

      const { rssBefore, rssAfter } = observation;
      check(rssBefore !== undefined && rssAfter !== undefined, "the consumer never stalled");
      const growth = rssAfter - rssBefore;
      // A few batches of the driver and the stream buffers may still arrive
      // after the stall begins; 32 MiB leaves room for those but not for the
      // 88 MiB that broken backpressure would buffer.
      check(
        growth < 32 * 1024 * 1024,
        `memory grew by ${Math.round(growth / 1048576)} MiB while the consumer stood still`,
      );
      await source.dropDatabase();
      return undefined;
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  if (MONGODB_URI === "") {
    process.stderr.write("SMOKE_MONGODB_URI is not set. Run test/runtimes/run.ts instead.\n");
    return 2;
  }
  await client.connect();
  const results: ScenarioResult[] = [];
  const only = process.env.SMOKE_ONLY; // optional substring filter, for debugging

  for (const scenario of scenarios) {
    if (only && !scenario.name.includes(only)) continue;
    const started = Date.now();
    try {
      const outcome = await scenario.run();
      const durationMs = Date.now() - started;
      if (outcome === undefined) {
        results.push({ name: scenario.name, status: "ok", durationMs });
        process.stdout.write(`  ok    ${scenario.name} (${durationMs} ms)\n`);
      } else {
        results.push({ name: scenario.name, status: "skip", durationMs, detail: outcome.skipped });
        process.stdout.write(`  skip  ${scenario.name}: ${outcome.skipped}\n`);
      }
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      results.push({
        name: scenario.name,
        status: "fail",
        durationMs: Date.now() - started,
        detail,
      });
      process.stdout.write(`  FAIL  ${scenario.name}\n${indent(detail)}\n`);
    }
  }

  await client.close();
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
  process.stdout.write(`SMOKE_RESULT ${JSON.stringify({ runtime: runtimeName(), results })}\n`);
  return results.some((result) => result.status === "fail") ? 1 : 0;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n");
}

process.exitCode = await main();
