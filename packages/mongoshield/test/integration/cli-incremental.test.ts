// `mongoshield backup --incremental [--from <id>]` end to end, with what the other
// commands show and do with the chain: list (KIND), inspect (Kind), verify (Chain),
// restore of an incremental (the plan names the chain) and `--at` inside the chain.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTestCli } from "../helpers/cli.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import type { AnyDocument } from "./converge-test-utils.ts";

const client = useMongoClient();
let workDir: string;
const source = uniqueDb("cli_inc");
const target = uniqueDb("cli_inc_dst");

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-cli-inc-"));
  await client()
    .db(source)
    .collection<AnyDocument>("users")
    .insertMany(Array.from({ length: 20 }, (_, n) => ({ _id: n, n })));
});

afterAll(async () => {
  await client().db(source).dropDatabase();
  await client().db(target).dropDatabase();
  await rm(workDir, { recursive: true, force: true });
});

/** `mongoshield backup` of the source into the work directory, with extra flags. */
function backup(...flags: string[]) {
  return runTestCli([
    "backup",
    "--uri",
    mongoUri(),
    "--to",
    workDir,
    "--include",
    `${source}.*`,
    "--quiet",
    ...flags,
  ]);
}

describe("mongoshield backup --incremental", () => {
  let fullId = "";
  let firstId = "";
  let secondId = "";
  /** The end of the first incremental's window, as `t:i` for `--at`. */
  let firstEnd = "";

  it("refuses --from without --incremental", async () => {
    const run = await backup("--from", "2026-01-01T00-00-00Z_abcdef");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--from only applies to incremental backups");
  });

  it("explains that a first incremental needs a full backup", async () => {
    const run = await backup("--incremental");
    expect(run.code).toBe(30);
    expect(run.stderr).toContain("Take a full backup");
  });

  it("takes a full backup, then incrementals that continue it", async () => {
    const full = await backup();
    expect(full.code, full.stderr).toBe(0);
    fullId = full.stdout.trim();

    const users = client().db(source).collection<AnyDocument>("users");
    await users.deleteMany({ _id: { $lt: 5 } });
    const first = await runTestCli([
      "backup",
      "--uri",
      mongoUri(),
      "--to",
      workDir,
      "--include",
      `${source}.*`,
      "--incremental",
    ]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toContain("Incremental backup complete.");
    expect(first.stdout).toMatch(new RegExp(`Parent\\s+${fullId}`));
    expect(first.stdout).toMatch(/Changes\s+5/);
    firstId = /Backup id\s+(\S+)/.exec(first.stdout)?.[1] ?? "";
    const inspected = await runTestCli(["inspect", firstId, "--from", workDir, "--json"]);
    const to = inspected.json<{ manifest: { consistency: { to: { t: number; i: number } } } }>()
      .manifest.consistency.to;
    firstEnd = `${to.t}:${to.i}`;

    await users.insertOne({ _id: 100, n: 100 });
    const second = await backup("--incremental", "--from", firstId);
    expect(second.code, second.stderr).toBe(0);
    secondId = second.stdout.trim();
  });

  it("shows the kind in list, the chain in inspect and verify", async () => {
    const list = await runTestCli(["list", "--from", workDir]);
    expect(list.stdout).toMatch(new RegExp(`${secondId}.*incr #2`));
    expect(list.stdout).toMatch(new RegExp(`${fullId}.*full`));

    const inspect = await runTestCli(["inspect", secondId, "--from", workDir]);
    expect(inspect.stdout).toMatch(
      new RegExp(`Kind\\s+incremental #2, after ${firstId} \\(base ${fullId}\\)`),
    );
    const inspectBase = await runTestCli(["inspect", fullId, "--from", workDir]);
    expect(inspectBase.stdout).toMatch(/Kind\s+full, base of 2 incremental backups/);

    const verify = await runTestCli(["verify", secondId, "--from", workDir]);
    expect(verify.code, verify.stderr).toBe(0);
    expect(verify.stderr).toContain(`Chain: incremental #2 after base ${fullId}`);
    expect(verify.stderr).toContain("files and links of 3 backups checked");
  });

  it("restores the newest incremental through its chain", async () => {
    const run = await runTestCli([
      "restore",
      secondId,
      "--from",
      workDir,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${source}.*=${target}.*`,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(
      `Incremental chain: base ${fullId}, then the changes of 2 incremental backups replayed in order`,
    );
    expect(run.stdout).toMatch(/Replayed \d+ change events? of 2 incremental backups/);
    const ids = await client()
      .db(target)
      .collection<AnyDocument>("users")
      .find({}, { projection: { _id: 1 } })
      .toArray();
    expect(ids.map((doc) => doc._id).sort((a, b) => Number(a) - Number(b))).toEqual([
      ...Array.from({ length: 15 }, (_, n) => n + 5),
      100,
    ]);
  });

  it("restores to a time inside the chain with --at and the incremental's id", async () => {
    await client().db(target).dropDatabase();
    const run = await runTestCli([
      "restore",
      secondId,
      "--at",
      firstEnd,
      "--from",
      workDir,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${source}.*=${target}.*`,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(`Point in time: the chain of ${secondId}`);
    // The insert of _id 100 came after the first incremental: not restored.
    expect(await client().db(target).collection("users").countDocuments()).toBe(15);
  });
});
