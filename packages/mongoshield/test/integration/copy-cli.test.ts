/**
 * `mongoshield copy` and `mongoshield pull` against the shared test replica set,
 * with mask and subset files in a temporary directory.
 *
 * The commands are run through the same steps as `runCli` (parse → context → run →
 * report errors), driven directly from their specs so these tests do not depend on
 * the command registry.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCommandLine } from "../../src/cli/args.ts";
import type { CommandContext, CommandSpec } from "../../src/cli/command.ts";
import { copyCommand } from "../../src/cli/commands/copy.ts";
import { pullCommand } from "../../src/cli/commands/pull.ts";
import { type CliIo, Output } from "../../src/cli/io.ts";
import { reportError } from "../../src/cli/report-error.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

const SECRET = "cli-test-secret-abcdefghijklmnop";

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-copy-cli-"));
});

afterAll(async () => {
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

/** Runs one command like a script would: no terminal. */
async function run(
  command: CommandSpec,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CliRun> {
  const stdout = collector();
  const stderr = collector();
  const io: CliIo = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env,
    cwd: workDir,
    isTTY: false,
  };
  let out = new Output(io, { json: false, quiet: false, verbose: false, color: false });
  const secrets: string[] = [];
  let code: number;
  try {
    const parsed = parseCommandLine(args, command.name, command.options, 0);
    out = new Output(io, {
      json: parsed.global.json,
      quiet: parsed.global.quiet,
      verbose: parsed.global.verbose,
      color: false,
    });
    const context: CommandContext = {
      io,
      out,
      global: parsed.global,
      flags: parsed.flags,
      positionals: parsed.positionals,
      signal: new AbortController().signal,
      addSecret: (secret) => secrets.push(secret),
    };
    code = await command.run(context);
  } catch (error) {
    code = reportError(error, out, secrets);
  }
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** Seeds users and orders that reference them. */
async function seed(database: string): Promise<void> {
  const db = client().db(database);
  await db.collection("users").insertMany([
    { _id: 1 as never, email: "ada@corp.com" },
    { _id: 2 as never, email: "grace@corp.com" },
  ]);
  await db.collection("orders").insertMany([
    { userId: 1, total: 10 },
    { userId: 1, total: 20 },
  ]);
}

/** Writes a mask file masking ids and emails of `database`. */
async function writeMask(database: string): Promise<string> {
  const path = join(workDir, `mask-${database}.ts`);
  await writeFile(
    path,
    [
      "export default {",
      `  rules: { "${database}.users": { _id: "hash", email: { fake: "email" } }, "${database}.orders": { userId: "hash" } },`,
      "};",
    ].join("\n"),
  );
  return path;
}

describe("mongoshield copy", () => {
  it("shows the plan, copies with masking and keeps the secret out of the output", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seed(source);
    const mask = await writeMask(source);

    const result = await run(
      copyCommand,
      [
        "--from",
        mongoUri(),
        "--to",
        mongoUri(),
        "--include",
        `${source}.*`,
        "--rename",
        `${source}.*=${target}.*`,
        "--mask",
        mask,
      ],
      { MONGOSHIELD_MASK_SECRET: SECRET },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Copy plan:");
    expect(result.stderr).toContain(`${source}.users: _id: hash, email: fake:email`);
    expect(result.stdout).toMatch(/Copied 4 documents into 2 namespaces .* masking 6 values\./);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);

    const users = await client().db(target).collection("users").find().toArray();
    const orders = await client().db(target).collection("orders").find().toArray();
    expect(users.every((user) => /@example\.(com|net|org)$/.test(String(user.email)))).toBe(true);
    const ada = users.filter((user) => orders.some((order) => order.userId === user._id));
    expect(ada).toHaveLength(1);
  });

  it("writes nothing with --dry-run", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seed(source);
    const result = await run(copyCommand, [
      "--from",
      mongoUri(),
      "--to",
      mongoUri(),
      "--include",
      `${source}.*`,
      "--rename",
      `${source}.*=${target}.*`,
      "--dry-run",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Dry run: nothing was written.");
    expect(await client().db(target).listCollections().toArray()).toEqual([]);
  });

  it("shows conflicts in the plan and refuses them", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seed(source);
    await client().db(target).collection("users").insertOne({ stale: true });
    const result = await run(copyCommand, [
      "--from",
      mongoUri(),
      "--to",
      mongoUri(),
      "--include",
      `${source}.*`,
      "--rename",
      `${source}.*=${target}.*`,
    ]);
    expect(result.code).toBe(50);
    expect(result.stderr).toContain("conflict: it already holds 1 documents");
  });

  it("asks before dropping, and drops with --yes", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seed(source);
    await client().db(target).collection("users").insertOne({ stale: true });
    const args = [
      "--from",
      mongoUri(),
      "--to",
      mongoUri(),
      "--include",
      `${source}.users`,
      "--rename",
      `${source}.*=${target}.*`,
      "--drop",
    ];

    const refused = await run(copyCommand, args);
    expect(refused.code).toBe(3);
    expect(await client().db(target).collection("users").countDocuments({ stale: true })).toBe(1);

    const confirmed = await run(copyCommand, [...args, "--yes"]);
    expect(confirmed.code).toBe(0);
    expect(await client().db(target).collection("users").countDocuments({ stale: true })).toBe(0);
  });

  it("copies a subset from a subset file", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seed(source);
    const subset = join(workDir, `subset-${source}.ts`);
    await writeFile(
      subset,
      `export default { filters: { "${source}.orders": { total: 20 } }, follow: [{ from: "${source}.orders.userId", to: "${source}.users._id" }] };`,
    );
    const result = await run(copyCommand, [
      "--from",
      mongoUri(),
      "--to",
      mongoUri(),
      "--include",
      `${source}.*`,
      "--rename",
      `${source}.*=${target}.*`,
      "--subset",
      subset,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: false, documentsCopied: 2 });
    expect(await client().db(target).collection("users").find().toArray()).toEqual([
      { _id: 1, email: "ada@corp.com" },
    ]);
  });

  it("needs --to", async () => {
    const result = await run(copyCommand, ["--from", mongoUri()]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("needs --to");
  });
});

describe("mongoshield pull", () => {
  it("refuses a target that is not on this machine", async () => {
    const result = await run(pullCommand, [
      "--from",
      mongoUri(),
      "--to",
      "mongodb://db.example.com:27017",
      "--mask",
      "x.ts",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("pull only writes to a MongoDB on this machine");
  });

  it("requires a mask, or --no-mask with --yes", async () => {
    const noMask = await run(pullCommand, ["--from", mongoUri()]);
    expect(noMask.code).toBe(2);
    expect(noMask.stderr).toContain("pull needs a mask file");

    const unconfirmed = await run(pullCommand, ["--from", mongoUri(), "--no-mask"]);
    expect(unconfirmed.code).toBe(3);

    const contradiction = await run(pullCommand, [
      "--from",
      mongoUri(),
      "--no-mask",
      "--mask",
      "m.ts",
    ]);
    expect(contradiction.code).toBe(2);
  });

  it("pulls a masked copy into a local deployment", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seed(source);
    const mask = await writeMask(source);
    const result = await run(
      pullCommand,
      [
        "--to",
        mongoUri(),
        "--include",
        `${source}.*`,
        "--rename",
        `${source}.*=${target}.*`,
        "--mask",
        mask,
      ],
      { MONGODB_URI: mongoUri(), MONGOSHIELD_MASK_SECRET: SECRET },
    );
    expect(result.code).toBe(0);
    const emails = (await client().db(target).collection("users").find().toArray()).map(
      (user) => user.email,
    );
    expect(emails).not.toContain("ada@corp.com");
  });

  it("pulls unmasked data only with --no-mask --yes, and says so", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seed(source);
    const result = await run(pullCommand, [
      "--from",
      mongoUri(),
      "--to",
      mongoUri(),
      "--include",
      `${source}.users`,
      "--rename",
      `${source}.*=${target}.*`,
      "--no-mask",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("WITHOUT masking");
    expect(await client().db(target).collection("users").countDocuments()).toBe(2);
  });
});
