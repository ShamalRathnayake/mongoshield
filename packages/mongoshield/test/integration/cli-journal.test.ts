/**
 * `mongoshield journal start` paths not covered by journal-cli.test.ts: encrypted
 * segments (--recipient), filters, the heartbeat and webhook secret, a writer stopped
 * before it starts, and encryption the journal cannot use.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { runTestCli } from "../helpers/cli.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { waitFor } from "./journal-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("jcli2");
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-cli-journal-"));
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await rm(workDir, { recursive: true, force: true });
});

describe("mongoshield journal start", () => {
  it("writes segments encrypted to --recipient, honouring --include/--exclude, and keeps secrets out of the output", async () => {
    const storage = await mkdtemp(join(workDir, "enc-"));
    const { recipient } = generateIdentity();
    const stop = new AbortController();
    const running = runTestCli(
      [
        "journal",
        "start",
        "--uri",
        mongoUri(),
        "--to",
        storage,
        "--include",
        `${database}.*`,
        "--exclude",
        `${database}.skipped`,
        "--recipient",
        recipient,
        "--segment-seconds",
        "1",
        // Nothing listens there: a failing heartbeat is only a warning.
        "--heartbeat",
        "http://127.0.0.1:1/ping",
      ],
      { signal: stop.signal, env: { MONGOSHIELD_WEBHOOK_SECRET: "whsec-journal-secret" } },
    );
    await client().db(database).collection("items").insertOne({ n: 1 });
    await waitFor(async () => {
      const status = await runTestCli(["journal", "status", "--from", storage, "--json"]);
      return status.code === 0 && status.json<{ segments: number }>().segments > 0;
    });
    stop.abort();
    const started = await running;
    expect(started.code, started.stderr).toBe(0);
    expect(started.stderr).toContain("Journal writer stopped. Recovery point: ");
    expect(started.stderr).toMatch(/\d+ segments written\./);
    expect(started.stdout + started.stderr).not.toContain("whsec-journal-secret");
    expect(await readdir(storage)).toContain("journal");
  });

  it("starts and stops at once when already cancelled", async () => {
    const storage = await mkdtemp(join(workDir, "cancelled-"));
    const stop = new AbortController();
    stop.abort();
    const run = await runTestCli(
      ["journal", "start", "--uri", mongoUri(), "--to", storage, "--include", `${database}.*`],
      { signal: stop.signal },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("Stopping: committing the current segment…");
    expect(run.stderr).toMatch(/Journal writer stopped\./);
  });

  it("refuses passphrase encryption from the config with an explanation", async () => {
    const cwd = await mkdtemp(join(workDir, "pass-"));
    await writeFile(
      join(cwd, "mongoshield.config.json"),
      JSON.stringify({
        source: { uri: mongoUri() },
        storage: join(cwd, "storage"),
        backup: { include: [`${database}.*`] },
        encryption: { passphrase: "journal-passphrase-value" },
      }),
    );
    const run = await runTestCli(["journal", "start"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr.toLowerCase()).toContain("passphrase");
    expect(run.stderr).not.toContain("journal-passphrase-value");
  });
});
