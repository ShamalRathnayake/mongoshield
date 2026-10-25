/**
 * `mongoshield backup` with the P4 flags (--part-size, --max-duration, --resume,
 * --read-preference, --max-docs-per-second, --max-bytes-per-second), driven through
 * `runCli` with in-memory streams like cli.test.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliIo } from "../../src/cli/io.ts";
import { runCli } from "../../src/cli/run.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const database = uniqueDb("rcli");
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-resume-cli-"));
  await client()
    .db(database)
    .collection("events")
    .insertMany(Array.from({ length: 1500 }, (_, index) => ({ index, text: "z".repeat(50) })));
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await rm(workDir, { recursive: true, force: true });
});

function collector(): { stream: Writable; text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { stream, text: () => text };
}

async function cli(args: readonly string[]) {
  const stdout = collector();
  const stderr = collector();
  const io: CliIo = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {},
    cwd: workDir,
    isTTY: false,
  };
  const code = await runCli(args, io);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe("mongoshield backup --max-duration / --resume", () => {
  it("checkpoints, says how to resume, and completes with --resume latest", async () => {
    const storage = await mkdtemp(join(workDir, "storage-"));
    const common = [
      "backup",
      "--uri",
      mongoUri(),
      "--to",
      storage,
      "--include",
      `${database}.*`,
      "--part-size",
      "8KiB",
      "--parallelism",
      "1",
      "--read-preference",
      "secondaryPreferred",
      "--max-bytes-per-second",
      "500MiB",
    ];
    const first = await cli([...common, "--max-duration", "1ms"]);
    expect(first.code, first.stderr).toBe(0);
    const output = first.stdout + first.stderr;
    const id = /--resume (\S+?)`/.exec(output)?.[1];
    expect(output).toContain("checkpointed: resume with");
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const json = await cli([...common, "--max-duration", "1ms", "--resume", "latest", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ status: "checkpointed", id });

    const last = await cli([...common, "--resume", "latest", "--max-docs-per-second", "100000"]);
    expect(last.code, last.stderr).toBe(0);
    expect(last.stdout + last.stderr).toContain("Backup complete.");
    expect(last.stdout).toContain(id ?? "missing id");
  });

  it("rejects durations and sizes it cannot read", async () => {
    const duration = await cli([
      "backup",
      "--uri",
      mongoUri(),
      "--to",
      workDir,
      "--max-duration",
      "15",
    ]);
    expect(duration.code).toBe(2);
    expect(duration.stderr).toMatch(/--max-duration expects a duration/);
    const size = await cli(["backup", "--uri", mongoUri(), "--to", workDir, "--part-size", "big"]);
    expect(size.code).toBe(2);
  });
});
