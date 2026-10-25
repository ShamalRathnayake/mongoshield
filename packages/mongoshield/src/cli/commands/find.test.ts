// `mongoshield find` against in-memory backups (no database): how the positionals are
// read, filter and projection errors, --json streaming, and the --restore checks that
// happen before connecting. Restoring itself is in test/integration/find-cli.test.ts.

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { resolveStorage } from "../../storage/resolve.ts";

const url = `memory://find-${randomUUID()}`;
let olderId: string;

beforeAll(async () => {
  const storage = await resolveStorage(url);
  const older = await writeTestBackup(storage, {
    startedAt: new Date("2026-06-01T00:00:00Z"),
    namespaces: [{ ns: "app.users", documents: [{ _id: 1, name: "old Ada" }] }],
  });
  olderId = older.id;
  await writeTestBackup(storage, {
    startedAt: new Date("2026-06-02T00:00:00Z"),
    namespaces: [
      {
        ns: "app.users",
        documents: [
          { _id: 1, name: "Ada", city: "Oslo" },
          { _id: 2, name: "Bob", city: "Bergen" },
        ],
      },
    ],
  });
});

describe("mongoshield find arguments", () => {
  it.each([
    [["find"], "Which collection?"],
    [["find", "users"], '"users" is not a namespace'],
    [["find", "latest", ".users"], '".users" is not a namespace'],
    [["find", "latest", "app.", "{}"], '"app." is not a namespace'],
    [["find", "app.users", "--dry-run"], "--dry-run needs --restore"],
    [["find", "app.users", "--to-uri", "mongodb://localhost"], "--to-uri needs --restore"],
  ])("%j is a usage error (exit code 2)", async (args, message) => {
    const run = await runTestCli([...args, "--from", url]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
  });

  it.each([
    [["latest", "app.users", "[1, 2]"], "The filter must be a JSON object."],
    [["app.users", "--projection", "{name:1}"], "The projection is not valid Extended JSON"],
  ])("explains a bad filter or projection %j", async (args, message) => {
    const run = await runTestCli(["find", ...args, "--from", url]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("hint");
  });
});

describe("mongoshield find output", () => {
  it("reads `<backup> <namespace>` as a backup and a collection", async () => {
    const run = await runTestCli(["find", olderId, "app.users", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('"name": "old Ada"');
    expect(run.stderr).toContain(`1 matching document in app.users (backup ${olderId}`);
  });

  it("reads `<backup> <namespace> <filter>`", async () => {
    const run = await runTestCli([
      "find",
      "latest",
      "app.users",
      '{"city":"Bergen"}',
      "--from",
      url,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('"name": "Bob"');
    expect(run.stdout).not.toContain("Ada");
  });

  it("writes an empty JSON array when nothing matches", async () => {
    const run = await runTestCli([
      "find",
      "app.users",
      '{"name":"nobody"}',
      "--from",
      url,
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe("[]\n");
    expect(run.json()).toEqual([]);
  });

  it("prints nothing but the documents with --quiet", async () => {
    const run = await runTestCli(["find", "app.users", "--from", url, "--quiet", "--limit", "1"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain('"_id": 1');
    expect(run.stdout).not.toContain('"_id": 2');
  });
});

describe("mongoshield find --restore before connecting", () => {
  it("refuses --limit and --projection with --restore", async () => {
    const run = await runTestCli(["find", "app.users", "--from", url, "--restore", "--limit", "1"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--limit and --projection cannot be used with --restore");
  });

  it("needs a restore target", async () => {
    const run = await runTestCli(["find", "app.users", "--from", url, "--restore"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("No restore target is configured.");
    expect(run.stderr).toContain("--to-uri");
  });

  it("needs the variable named by --passphrase-env", async () => {
    const run = await runTestCli([
      "find",
      "app.users",
      "--from",
      url,
      "--passphrase-env",
      "MS_FIND_PASSPHRASE",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("MS_FIND_PASSPHRASE");
  });

  it("never prints the password of a --to-uri", async () => {
    const run = await runTestCli([
      "find",
      "app.users",
      "--from",
      url,
      "--restore",
      "--limit",
      "1",
      "--to-uri",
      "mongodb://app:hunter2secret@localhost:1/?serverSelectionTimeoutMS=100",
    ]);
    expect(run.code).toBe(2);
    expect(run.stdout + run.stderr).not.toContain("hunter2secret");
  });
});
