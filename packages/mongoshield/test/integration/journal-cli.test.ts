/**
 * `mongoshield journal start|status`, driven through `runCli` with in-memory streams
 * against the shared test replica set and file storage in a temporary directory.
 */

import { mkdtemp, rm } from "node:fs/promises";
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
async function cli(args: readonly string[], signal?: AbortSignal) {
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
    cwd: workDir,
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
