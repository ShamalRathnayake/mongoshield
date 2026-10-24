/**
 * `mongoshield journal start|status`, driven through `runCli` with in-memory streams
 * against the shared test replica set and file storage in a temporary directory.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { CliIo } from "../../src/cli/io.ts";
import { runCli } from "../../src/cli/run.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { waitFor } from "./journal-test-utils.ts";

// Until `journal` is listed in the command registry, add it for this file.
vi.mock("../../src/cli/commands/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/cli/commands/index.ts")>();
  const { journalCommand } = await import("../../src/cli/commands/journal.ts");
  const commands = original.findCommand("journal")
    ? original.COMMANDS
    : [...original.COMMANDS, journalCommand];
  return {
    COMMANDS: commands,
    findCommand: (name: string) => commands.find((command) => command.name === name),
  };
});

const client = useMongoClient();
const database = uniqueDb("jcli");
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-journal-cli-"));
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await rm(workDir, { recursive: true, force: true });
});

/** Runs the CLI with collected output. */
async function cli(args: readonly string[], signal?: AbortSignal, cwd = workDir) {
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        append(chunk.toString());
        done();
      },
    });
  const io: CliIo = {
    stdout: sink((text) => {
      stdout += text;
    }),
    stderr: sink((text) => {
      stderr += text;
    }),
    env: {},
    cwd,
    isTTY: false,
    ...(signal ? { signal } : {}),
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}

it("runs the writer until interrupted, then reports the journal's status", async () => {
  const storage = join(workDir, "storage");
  const stop = new AbortController();
  const running = cli(
    [
      "journal",
      "start",
      "--uri",
      mongoUri(),
      "--to",
      storage,
      "--include",
      `${database}.*`,
      "--segment-seconds",
      "1",
    ],
    stop.signal,
  );
  await client().db(database).collection("items").insertOne({ n: 1 });
  await waitFor(async () => {
    const status = await cli(["journal", "status", "--from", storage, "--json"]);
    return status.code === 0 && JSON.parse(status.stdout).segments > 0;
  });
  stop.abort();
  const started = await running;
  expect(started.stderr).toContain("Journal writer stopped");
  expect(started.code).toBe(0);

  const json = await cli(["journal", "status", "--from", storage, "--json"]);
  const status = JSON.parse(json.stdout);
  expect(status.recoveryPoint).toEqual({ t: expect.any(Number), i: expect.any(Number) });
  expect(status.gaps).toEqual([]);

  const table = await cli(["journal", "status", "--from", storage]);
  expect(table.code).toBe(0);
  expect(table.stdout).toContain("Recovery point");
  expect(table.stdout).toContain("COVERED FROM");

  // The writer stopped, so the recovery point ages past a tiny limit.
  const late = await cli(["journal", "status", "--from", storage, "--max-rpo", "1ms"]);
  expect(late.code).toBe(1);
});

it("rejects an unknown action", async () => {
  const result = await cli(["journal", "rewind"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("Unknown journal action");
});

it("takes segment and gap settings from the config's journal section", async () => {
  const dir = await mkdtemp(join(workDir, "config-"));
  const storage = join(dir, "storage");
  await writeFile(
    join(dir, "mongoshield.config.json"),
    JSON.stringify({
      source: { uri: mongoUri() },
      storage,
      backup: { include: [`${database}.*`] },
      journal: { segmentSeconds: 1, segmentBytes: 2048, onGap: "fail" },
    }),
  );
  const stop = new AbortController();
  const running = cli(["journal", "start"], stop.signal, dir);
  await client().db(database).collection("items").insertOne({ n: 2 });
  // One-second segments (the default would be five minutes): the config was read.
  await waitFor(async () => {
    const status = await cli(["journal", "status", "--json"], undefined, dir);
    return status.code === 0 && JSON.parse(status.stdout).segments > 0;
  });
  stop.abort();
  const started = await running;
  expect(started.code).toBe(0);
  expect(started.stderr).toContain("Segments close after 1.0s or 2.0 KiB");
  expect(started.stderr).toContain("on a gap in the change history: stop");
});

it("lets the flags override the config's journal section", async () => {
  const dir = await mkdtemp(join(workDir, "override-"));
  await writeFile(
    join(dir, "mongoshield.config.json"),
    JSON.stringify({
      source: { uri: mongoUri() },
      storage: join(dir, "storage"),
      backup: { include: [`${database}.*`] },
      journal: { segmentSeconds: 3600, onGap: "fail" },
    }),
  );
  const stop = new AbortController();
  const running = cli(
    ["journal", "start", "--segment-seconds", "2", "--segment-size", "1MiB", "--on-gap", "backup"],
    stop.signal,
    dir,
  );
  await waitFor(async () => {
    const status = await cli(["journal", "status", "--json"], undefined, dir);
    return status.code === 0 && JSON.parse(status.stdout).segments > 0;
  });
  stop.abort();
  const started = await running;
  expect(started.code).toBe(0);
  expect(started.stderr).toContain("Segments close after 2.0s or 1.0 MiB");
  expect(started.stderr).toContain("take a new base backup");
});

it("rejects a journal section the schema does not know", async () => {
  const dir = await mkdtemp(join(workDir, "invalid-"));
  await writeFile(
    join(dir, "mongoshield.config.json"),
    JSON.stringify({ storage: join(dir, "storage"), journal: { segmentSeconds: 0 } }),
  );
  const result = await cli(["journal", "status"], undefined, dir);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("journal.segmentSeconds");
});
