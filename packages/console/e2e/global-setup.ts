/**
 * Playwright global setup for the console's end-to-end tests: everything a real
 * deployment has, started once for the whole run.
 *
 *   1. a real mongod (single-node replica set, with authentication) from
 *      mongodb-memory-server, seeded with the data the journeys back up and restore
 *   2. a temporary data directory, with room for a local storage location inside it
 *      (the console only allows local storage under its data directory)
 *   3. the BUILT console (`dist/server/main.mjs`, exactly what `mongoshield-console`
 *      runs) on a random free port, its stdout and stderr captured in a log file so
 *      the first-run test can read the one-time setup link from it like an operator
 *
 * What the tests need is handed over in `E2E_*` environment variables (Playwright
 * starts its workers after global setup, so they inherit them); see `e2e/env.ts`.
 * The returned function is the teardown: it stops the console with SIGTERM (as
 * Docker would), stops mongod and removes the temporary directory.
 *
 * Locally, set MONGOMS_SYSTEM_BINARY to an installed mongod to skip the download;
 * CI sets MONGOMS_VERSION instead.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { E2E_MONGO_PASSWORD, E2E_MONGO_USER, E2E_SECRET, SEED } from "./env.ts";

/** The built server; `pnpm build` must have run (the CI job and the npm script make sure). */
const SERVER_ENTRY = fileURLToPath(new URL("../dist/server/main.mjs", import.meta.url));
/** How long the console may take to print its setup link and answer /healthz. */
const STARTUP_TIMEOUT_MS = 30_000;

/** Starts mongod and the console; returns the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `${SERVER_ENTRY} does not exist. Build the library and the console first: ` +
        "`pnpm --filter mongoshield build && pnpm --filter @mongoshield/console build`.",
    );
  }

  const root = await mkdtemp(join(tmpdir(), "ms-console-e2e-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const logFile = join(root, "server.log");

  const replSet = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      storageEngine: "wiredTiger",
      // With authentication on, the connection string the tests type into the
      // console carries a real password, so "the secret is never shown again" is
      // checked against a secret that matters.
      auth: { enable: true, customRootName: E2E_MONGO_USER, customRootPwd: E2E_MONGO_PASSWORD },
    },
  });
  await replSet.waitUntilRunning();
  const mongoUri = withCredentials(replSet.getUri());
  await seed(mongoUri);

  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  const server = startConsole({ dataDir, port, logFile });
  try {
    await waitForStartup(server, logFile, baseUrl);
  } catch (error) {
    server.kill("SIGKILL");
    await replSet.stop();
    throw error;
  }

  process.env.E2E_BASE_URL = baseUrl;
  process.env.E2E_MONGO_URI = mongoUri;
  process.env.E2E_DATA_DIR = dataDir;
  process.env.E2E_SERVER_LOG = logFile;

  return async () => {
    await stopConsole(server);
    await replSet.stop();
    // Keep the directory when asked, to look at console.json, audit.jsonl and the log.
    if (process.env.E2E_KEEP_DATA !== "1") await rm(root, { recursive: true, force: true });
  };
}

/** `mongodb://127.0.0.1:1234/?replicaSet=x` → the same with the root user and its password. */
function withCredentials(uri: string): string {
  const url = new URL(uri);
  url.username = E2E_MONGO_USER;
  url.password = E2E_MONGO_PASSWORD;
  url.searchParams.set("authSource", "admin");
  return url.toString();
}

/**
 * The data the journeys work with: `shop.orders` has enough documents for the
 * document browser to page through, `shop.customers` and `crm.contacts` make the
 * namespace picker and the restore choices non-trivial.
 */
async function seed(mongoUri: string): Promise<void> {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const shop = client.db(SEED.database);
    await shop.collection<{ _id: number }>(SEED.orders).insertMany(
      Array.from({ length: SEED.orderCount }, (_unused, index) => ({
        _id: index + 1,
        sku: `SKU-${String(index + 1).padStart(4, "0")}`,
        status: index % 3 === 0 ? "open" : "paid",
        quantity: (index % 5) + 1,
      })),
    );
    await shop.collection<{ _id: string }>(SEED.customers).insertMany(
      Array.from({ length: SEED.customerCount }, (_unused, index) => ({
        _id: `customer-${index + 1}`,
        name: `Customer ${index + 1}`,
      })),
    );
    await client
      .db("crm")
      .collection("contacts")
      .insertMany([{ name: "Ada" }, { name: "Grace" }]);
  } finally {
    await client.close();
  }
}

/** A port nobody listens on right now (the OS picks it). */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Runs `node dist/server/main.mjs` with a production-like environment. */
function startConsole(options: { dataDir: string; port: number; logFile: string }): ChildProcess {
  const log = createWriteStream(options.logFile);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      PATH: process.env.PATH ?? "",
      MONGOSHIELD_SECRET: E2E_SECRET,
      MONGOSHIELD_DATA_DIR: options.dataDir,
      PORT: String(options.port),
      HOST: "127.0.0.1",
      // Short, so the teardown does not wait a minute for a job that is still running.
      MONGOSHIELD_SHUTDOWN_GRACE_SECONDS: "5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once("exit", () => log.end());
  return child;
}

/** Waits until the setup link is in the log and the server answers. */
async function waitForStartup(server: ChildProcess, logFile: string, baseUrl: string) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`The console exited with ${server.exitCode}:\n${await readLog(logFile)}`);
    }
    const printedLink = (await readLog(logFile)).includes("/setup?token=");
    if (printedLink && (await answers(`${baseUrl}/healthz`))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `The console did not start within ${STARTUP_TIMEOUT_MS} ms:\n${await readLog(logFile)}`,
  );
}

async function readLog(logFile: string): Promise<string> {
  try {
    return await readFile(logFile, "utf8");
  } catch {
    return "";
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** SIGTERM, then SIGKILL if the console has not exited within ten seconds. */
async function stopConsole(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server.kill("SIGTERM");
  const timer = setTimeout(() => server.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}
