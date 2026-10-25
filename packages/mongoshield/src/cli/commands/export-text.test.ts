// `mongoshield export --format jsonl|csv` against an in-memory backup (no database):
// flag checks, filters, the summary on stdout or stderr, and --json.

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { resolveStorage } from "../../storage/resolve.ts";

const url = `memory://export-text-${randomUUID()}`;
let cwd: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mongoshield-export-text-"));
  await writeTestBackup(await resolveStorage(url), {
    namespaces: [
      {
        ns: "app.users",
        documents: [
          { _id: 1, name: "Ada", active: true },
          { _id: 2, name: "Bob", active: false },
        ],
      },
    ],
  });
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const base = ["export", "--from", url, "--namespace", "app.users"];

describe("mongoshield export --format jsonl|csv arguments", () => {
  it.each([
    [
      ["--format", "jsonl", "--output", "-", "--include", "app.*"],
      "--include only applies to --format directory or archive.",
    ],
    [["--format", "csv", "--output", "-", "--gzip"], "--gzip only applies"],
    [["--format", "jsonl"], "Where to? Pass --output <file>, or --output - for stdout."],
    [["--format", "jsonl", "--output="], "Where to?"],
    [["--format", "jsonl", "--output", "-", "--json"], "--json cannot be combined with --output -"],
  ])("%j fails with exit code 2", async (args, message) => {
    const run = await runTestCli([...base, ...args], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr + run.stdout).toContain(message);
  });

  it("needs --namespace", async () => {
    const run = await runTestCli(["export", "--from", url, "--format", "csv", "--output", "-"], {
      cwd,
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--format csv exports one collection: pass --namespace");
  });

  it("explains a filter that is not a JSON object", async () => {
    const run = await runTestCli(
      [...base, "--format", "jsonl", "--output", "-", "--filter", "[]"],
      {
        cwd,
      },
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("The filter must be a JSON object.");
  });
});

describe("mongoshield export --format jsonl|csv", () => {
  it("writes only the matching documents to a relative path, with the summary on stdout", async () => {
    const run = await runTestCli(
      [...base, "--format", "jsonl", "--output", "active.jsonl", "--filter", '{"active":true}'],
      { cwd },
    );
    expect(run.code, run.stderr).toBe(0);
    const lines = (await readFile(join(cwd, "active.jsonl"), "utf8")).trimEnd().split("\n");
    expect(lines).toEqual(['{"_id":1,"name":"Ada","active":true}']);
    expect(run.stdout).toMatch(/Documents\s+1/);
    expect(run.stdout).toContain(join(cwd, "active.jsonl"));
    expect(run.stderr).toContain("Export complete.");
  });

  it("keeps stdout for the data and prints the summary on stderr with --output -", async () => {
    const run = await runTestCli(
      [
        ...base,
        "--format",
        "csv",
        "--fields",
        "_id, name",
        "--output",
        "-",
        "--ejson",
        "canonical",
      ],
      { cwd },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.split("\n")[0]).toBe("_id,name");
    expect(run.stdout).not.toContain("Documents");
    expect(run.stderr).toMatch(/Output\s+stdout/);
  });

  it("prints the result as one JSON document with --json", async () => {
    const run = await runTestCli(
      [...base, "--format", "jsonl", "--output", join(cwd, "all.jsonl"), "--json"],
      { cwd },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({
      namespace: "app.users",
      format: "jsonl",
      documents: 2,
      output: join(cwd, "all.jsonl"),
    });
  });
});
