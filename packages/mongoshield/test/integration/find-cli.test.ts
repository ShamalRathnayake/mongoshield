// The `mongoshield find` command, driven through `runCli` with in-memory streams.
// The command is added to the registry here with vi.mock, so these tests do not
// depend on how commands/index.ts lists it.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { BSON, type Document, Int32, Long } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../src/cli/io.ts";
import { runCli } from "../../src/cli/run.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { backupDatabaseForTest } from "../helpers/backup-fixtures.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

vi.mock("../../src/cli/commands/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/cli/commands/index.ts")>();
  const { findInBackupCommand } = await import("../../src/cli/commands/find.ts");
  const commands = [...original.COMMANDS, findInBackupCommand];
  return {
    COMMANDS: commands,
    findCommand: (name: string) => commands.find((command) => command.name === name),
  };
});

const client = useMongoClient();

/** Test documents use numbers as _id (the driver assumes ObjectId otherwise). */
interface User {
  _id: number;
  [field: string]: unknown;
}

let workDir: string;
let storageDir: string;
let database: string;

/** 50 users with typed numbers; backed up into file storage before the tests. */
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-find-cli-"));
  storageDir = join(workDir, "backups");
  database = uniqueDb("findcli");
  const users = Array.from({ length: 50 }, (_, index) => ({
    _id: index,
    name: `user${index}`,
    n: new Int32(index),
    big: Long.fromNumber(index * 1000),
    group: index % 2 === 0 ? "even" : "odd",
  }));
  await client().db(database).collection<User>("users").insertMany(users);
  await backupDatabaseForTest(client(), fileStorage({ path: storageDir }), {
    include: [`${database}.*`],
  });
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(args: readonly string[]): Promise<CliRun> {
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

describe("mongoshield find", () => {
  it("prints matching documents as Extended JSON", async () => {
    const run = await cli(["find", "--from", storageDir, `${database}.users`, '{"name":"user7"}']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('"name": "user7"');
    expect(run.stderr).toContain("1 matching document");
  });

  it("writes one JSON array of canonical Extended JSON with --json, keeping BSON types", async () => {
    const run = await cli([
      "find",
      "latest",
      `${database}.users`,
      '{"group":"odd","n":{"$lt":6}}',
      "--from",
      storageDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const documents = BSON.EJSON.parse(run.stdout, { relaxed: false }) as Document[];
    expect(documents.map((document) => document.name)).toEqual(["user1", "user3", "user5"]);
    expect(documents[0]?.n).toBeInstanceOf(Int32);
    expect(documents[0]?.big).toBeInstanceOf(Long);
  });

  it("honours --limit and --projection", async () => {
    const run = await cli([
      "find",
      `${database}.users`,
      "--from",
      storageDir,
      "--limit",
      "2",
      "--projection",
      '{"name":1,"_id":0}',
      "--json",
    ]);
    expect(BSON.EJSON.parse(run.stdout)).toEqual([{ name: "user0" }, { name: "user1" }]);
  });

  it("explains invalid JSON and unsupported operators", async () => {
    const badJson = await cli(["find", `${database}.users`, "{name:1}", "--from", storageDir]);
    expect(badJson.code).toBe(2);
    expect(badJson.stderr).toContain("Extended JSON");
    const unsupported = await cli([
      "find",
      `${database}.users`,
      '{"n":{"$mod":[2,0]}}',
      "--from",
      storageDir,
    ]);
    expect(unsupported.code).toBe(2);
    expect(unsupported.stderr).toContain("$mod");
  });

  it("restores matching documents with --restore, skipping those still present", async () => {
    const users = client().db(database).collection<User>("users");
    await users.deleteMany({ n: { $gte: 40 } });
    const run = await cli([
      "find",
      `${database}.users`,
      '{"n":{"$gte":35}}',
      "--from",
      storageDir,
      "--restore",
      "--to-uri",
      mongoUri(),
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("15 matching documents");
    expect(run.stdout).toContain("10 inserted, 5 skipped");
    expect(await users.countDocuments()).toBe(50);
  });

  it("previews with --dry-run and asks before upserts replace documents", async () => {
    const users = client().db(database).collection<User>("users");
    await users.updateOne({ _id: 3 }, { $set: { name: "changed" } });
    const base = ["find", `${database}.users`, '{"_id":3}', "--from", storageDir, "--restore"];
    const target = ["--to-uri", mongoUri(), "--mode", "upsert"];

    const dryRun = await cli([...base, ...target, "--dry-run"]);
    expect(dryRun.code).toBe(0);
    expect(dryRun.stderr).toContain("1 to replace");
    const refused = await cli([...base, ...target]);
    expect(refused.code).toBe(3); // MS_CONFIRMATION_REQUIRED without a terminal
    expect((await users.findOne({ _id: 3 }))?.name).toBe("changed");

    const confirmed = await cli([...base, ...target, "--yes", "--json"]);
    expect(confirmed.code).toBe(0);
    expect(JSON.parse(confirmed.stdout)).toMatchObject({ matched: 1, replaced: 1 });
    expect((await users.findOne({ _id: 3 }))?.name).toBe("user3");
  });

  it("rejects restore-only flags without --restore", async () => {
    const run = await cli(["find", `${database}.users`, "--from", storageDir, "--mode", "upsert"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--mode needs --restore");
  });
});
