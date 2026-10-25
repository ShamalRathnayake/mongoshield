// The mistakes `restore`, `copy`, `backup` and `drill` catch before connecting to any
// database: each is a usage or config error (exit 2) with a hint and a docs link, and
// none of them echoes a password from the command line.

import { describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { namedMemoryStore } from "../../../test/helpers/cli-backups.ts";

/** Nothing listens on port 1, and nothing here should ever try. */
const UNREACHABLE = "mongodb://admin:s3cr3t-pw@127.0.0.1:1/?serverSelectionTimeoutMS=200";

async function storeWithBackup(): Promise<string> {
  const { url, storage } = await namedMemoryStore();
  await writeTestBackup(storage, { namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }] });
  return url;
}

function expectUsageError(run: { code: number; stderr: string; stdout: string }, message: string) {
  expect(run.code, run.stderr).toBe(2);
  expect(run.stderr).toContain(message);
  expect(run.stderr).toContain("hint");
  expect(run.stderr).toMatch(/docs {2}https:\/\//);
  expect(run.stdout + run.stderr).not.toContain("s3cr3t-pw");
}

describe("mongoshield restore, before connecting", () => {
  it("needs a target", async () => {
    const url = await storeWithBackup();
    const run = await runTestCli(["restore", "--from", url]);
    expectUsageError(run, "No restore target is configured.");
    expect(run.stderr).toContain("Pass --to-uri, set MONGODB_URI");
  });

  it.each([
    [["--at", "last tuesday"], "--at last tuesday is neither a date"],
    [["--drop", "--mode", "insert"], "--drop contradicts --mode insert."],
    [["--rename", "app.*"], '--rename expects key=value (got "app.*").'],
    [["--rename", "a=b", "--rename", "a=c"], '--rename gives "a" twice.'],
    [["--passphrase-env", "UNSET_VAR"], "The environment variable UNSET_VAR"],
    [["--mode", "merge"], "--mode must be one of fail-if-exists, drop, insert, upsert"],
    [["--users-and-roles", "all"], "--users-and-roles must be one of skip, create, replace"],
  ])("rejects %j with exit code 2", async (flags, message) => {
    const url = await storeWithBackup();
    const run = await runTestCli(["restore", "--from", url, "--to-uri", UNREACHABLE, ...flags]);
    expectUsageError(run, message);
  });

  it("refuses a full backup's id next to --at: the journal picks the base backup", async () => {
    const { url, storage } = await namedMemoryStore();
    const full = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
    });
    const run = await runTestCli([
      "restore",
      full.id,
      "--at",
      "2026-01-02T00:00:00Z",
      "--from",
      url,
      "--to-uri",
      UNREACHABLE,
    ]);
    expectUsageError(run, "--at picks its base backup itself");
  });

  it("explains a point in time without a journal (cluster time form)", async () => {
    const url = await storeWithBackup();
    const run = await runTestCli([
      "restore",
      "--at",
      "1794538804:3",
      "--from",
      url,
      "--to-uri",
      UNREACHABLE,
    ]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("hint");
    expect(run.stdout + run.stderr).not.toContain("s3cr3t-pw");
  });
});

describe("mongoshield copy and pull, before connecting", () => {
  it("needs a source", async () => {
    const run = await runTestCli(["copy", "--to", UNREACHABLE]);
    expectUsageError(run, "Copy from where? No source is configured.");
  });

  it.each([
    [["--drop", "--mode", "upsert"], "--drop contradicts --mode upsert."],
    [["--parallelism", "0"], "--parallelism must be a whole number 1–64"],
    [["--rename", "=x"], "--rename expects key=value"],
  ])("rejects %j with exit code 2", async (flags, message) => {
    const run = await runTestCli(["copy", "--from", UNREACHABLE, "--to", UNREACHABLE, ...flags]);
    expectUsageError(run, message);
  });

  it("refuses --mask together with --no-mask in pull", async () => {
    const run = await runTestCli(["pull", "--from", UNREACHABLE, "--mask", "m.ts", "--no-mask"]);
    expectUsageError(run, "--mask contradicts --no-mask.");
  });
});

describe("mongoshield backup, before connecting", () => {
  it("needs a connection string", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["backup", "--to", url]);
    expectUsageError(run, "No MongoDB connection string is configured.");
  });

  it.each([
    [
      ["--recipient", "age1x", "--passphrase-env", "P"],
      "--recipient and --passphrase-env cannot be combined.",
    ],
    [["--label", "env"], '--label expects key=value (got "env").'],
    [["--max-bytes-per-second", "fast"], "--max-bytes-per-second expects a size such as 256MiB"],
    [["--max-duration", "0s"], "--max-duration expects a duration"],
    [["--retain-days", "0"], "--retain-days must be a whole number 1–36500"],
    [["--max-docs-per-second", "-5"], "--max-docs-per-second"],
    [["--compression", "lz4"], "--compression must be one of zstd, gzip, none"],
    [["--recipient", "age1notakey"], "recipient"],
  ])("rejects %j with exit code 2", async (flags, message) => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["backup", "--uri", UNREACHABLE, "--to", url, ...flags]);
    expectUsageError(run, message);
  });
});

describe("mongoshield drill, before connecting", () => {
  it.each([
    [["--sample", "-1"], "--sample"],
    [["--sample", "many"], "--sample must be a whole number"],
    [["--passphrase-env", "UNSET_VAR"], "The environment variable UNSET_VAR"],
  ])("rejects %j with exit code 2", async (flags, message) => {
    const url = await storeWithBackup();
    const run = await runTestCli(["drill", "--from", url, "--target-uri", UNREACHABLE, ...flags]);
    expectUsageError(run, message);
  });

  it("explains a missing assertions file", async () => {
    const url = await storeWithBackup();
    const run = await runTestCli([
      "drill",
      "--from",
      url,
      "--target-uri",
      UNREACHABLE,
      "--assertions",
      "./does-not-exist.ts",
    ]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("does-not-exist.ts");
    expect(run.stdout + run.stderr).not.toContain("s3cr3t-pw");
  });
});
