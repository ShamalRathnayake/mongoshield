/**
 * `mongoshield drill`, driven through `runCli` with in-memory streams against the
 * shared test replica set. The command is not in the command registry yet (that
 * file is shared), so this test adds it to the registry through a module mock.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../src/cli/io.ts";
import { runCli } from "../../src/cli/run.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { backupDatabaseForTest } from "../helpers/backup-fixtures.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

vi.mock("../../src/cli/commands/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/cli/commands/index.ts")>();
  const { drillCommand } = await import("../../src/cli/commands/drill.ts");
  return {
    ...original,
    COMMANDS: [...original.COMMANDS, drillCommand],
    findCommand: (name: string) => (name === "drill" ? drillCommand : original.findCommand(name)),
  };
});

const client = useMongoClient();
const database = uniqueDb("dcli");
let workDir: string;
let storageDir: string;
let backupId: string;

beforeAll(async () => {
  await client()
    .db(database)
    .collection("users")
    .insertMany(Array.from({ length: 40 }, (_, index) => ({ index })));
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-drill-cli-"));
  storageDir = join(workDir, "backups");
  const manifest = await backupDatabaseForTest(client(), fileStorage({ path: storageDir }), {
    include: [`${database}.*`],
  });
  backupId = manifest.id;
});

afterAll(async () => {
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

/** Runs the CLI like a script: no terminal, empty environment. */
async function cli(args: readonly string[]) {
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
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}

describe("mongoshield drill", () => {
  it("drills a backup, prints the RTO and exits 0", async () => {
    const run = await cli([
      "drill",
      backupId,
      "--from",
      storageDir,
      "--target-uri",
      mongoUri(),
      "--sample",
      "10",
    ]);
    expect(run.stderr).not.toMatch(/error/i);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^RTO \d/m);
    expect(run.stdout).toContain(`${database}.users`);
    expect(run.stdout).toContain("Drill passed");
  });

  it("runs an assertions file and exits 33 when an assertion fails", async () => {
    const file = join(workDir, "drill.ts");
    await writeFile(
      file,
      [
        'import type { Db } from "mongodb";',
        "export default {",
        `  ${JSON.stringify(database)}: async (db: Db) => {`,
        '    const count = await db.collection("users").countDocuments();',
        '    throw new Error("saw " + count + " users, want 41");',
        "  },",
        "};",
      ].join("\n"),
    );
    const run = await cli([
      "drill",
      "--from",
      storageDir,
      "--target-uri",
      mongoUri(),
      "--assertions",
      "./drill.ts",
    ]);
    expect(run.code).toBe(33);
    expect(run.stdout).toContain(`assertions:${database}: saw 40 users, want 41`);
  });

  it("prints the report as JSON with --json", async () => {
    const run = await cli(["drill", "--from", storageDir, "--target-uri", mongoUri(), "--json"]);
    expect(run.code).toBe(0);
    const report: unknown = JSON.parse(run.stdout);
    expect(report).toMatchObject({ backupId, ok: true, restored: true, kept: false });
  });

  it("refuses to run without a scratch target", async () => {
    const run = await cli(["drill", "--from", storageDir]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--target-uri");
  });
  it("shows the drills in list (latest check) and inspect (history, newest first)", async () => {
    // The tests above drilled this backup three times: passed, failed, passed.
    const list = await cli(["list", "--from", storageDir]);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/drill ✓ \(RTO \d+(ms|s)\)/);

    const inspect = await cli(["inspect", backupId, "--from", storageDir]);
    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain("Last drill");
    expect(inspect.stdout).toContain("DRILLED");
    const results = inspect.stdout.match(/\b(passed|failed)\b/g);
    expect(results).toEqual(["passed", "failed", "passed"]);

    const json = await cli(["inspect", backupId, "--from", storageDir, "--json"]);
    const entry = JSON.parse(json.stdout) as { lastDrill: unknown; drills: { ok: boolean }[] };
    expect(entry.drills.map((drill) => drill.ok)).toEqual([true, false, true]);
    expect(entry.lastDrill).toEqual(entry.drills[0]);
  });
});
