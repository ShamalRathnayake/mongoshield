// `mongoshield find --restore` paths not covered by find-cli.test.ts: nothing matching,
// restoring into a new collection, and confirming upserts on a terminal.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileStorage } from "../../src/storage/file.ts";
import { backupDatabaseForTest } from "../helpers/backup-fixtures.ts";
import { KEYS, plain, runTestCli } from "../helpers/cli.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

let workDir: string;
let storageDir: string;
let database: string;

const users = () => client().db(database).collection<{ _id: number; name: string }>("users");

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-cli-find-restore-"));
  storageDir = join(workDir, "backups");
  database = uniqueDb("cli_find_restore");
  await users().insertMany([
    { _id: 1, name: "Ada" },
    { _id: 2, name: "Bob" },
  ]);
  await backupDatabaseForTest(client(), fileStorage({ path: storageDir }), {
    include: [`${database}.*`],
  });
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await rm(workDir, { recursive: true, force: true });
});

const find = (...extra: string[]) => [
  "find",
  `${database}.users`,
  "--from",
  storageDir,
  "--restore",
  "--to-uri",
  mongoUri(),
  ...extra,
];

describe("mongoshield find --restore", () => {
  it("restores nothing, without asking, when nothing matches", async () => {
    const run = await runTestCli([...find("--mode", "upsert"), '{"name":"nobody"}'], {
      cwd: workDir,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("0 matching documents");
    expect(run.stderr).toContain("Nothing to restore: no backed-up document matches.");
    expect(run.stderr).not.toContain("Dry run");
    expect(run.stdout).toBe("");
  });

  it("restores into a collection that does not exist yet with --to-namespace --create", async () => {
    const target = `${database}.users_restored`;
    const run = await runTestCli(
      [...find("--to-namespace", target, "--create"), '{"name":"Ada"}'],
      { cwd: workDir },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(`${target} does not exist and will be created`);
    expect(run.stdout).toMatch(/Restored 1 document into .+users_restored \(1 inserted, 0 skipped/);
    expect(await client().db(database).collection("users_restored").countDocuments()).toBe(1);
  });

  it("asks on a terminal before upserts replace documents, and replaces them on yes", async () => {
    await users().updateOne({ _id: 2 }, { $set: { name: "Bob (edited)" } });
    const run = await runTestCli([...find("--mode", "upsert"), '{"_id":2}'], {
      cwd: workDir,
      terminal: [{ when: "Replace 1 existing document in", keys: `y${KEYS.enter}` }],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(plain(run.stderr)).toContain("1 to replace");
    expect(plain(run.stdout)).toContain("(0 inserted, 1 replaced)");
    expect(await users().findOne({ _id: 2 })).toMatchObject({ name: "Bob" });
  });
});
