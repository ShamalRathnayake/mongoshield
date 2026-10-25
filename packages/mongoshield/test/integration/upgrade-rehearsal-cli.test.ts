// `mongoshield rehearse-upgrade` through `runCli`: a backup of the shared test replica
// set (MongoDB 7.0 locally) rehearsed on MongoDB 8.0.13, on an ephemeral server and on
// a scratch deployment, as text and as JSON; the analysis-only mode; usage errors; and
// the rehearsal showing up in `inspect`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoShield } from "../../src/shield.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { runTestCli } from "../helpers/cli.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const TARGET_VERSION = "8.0.13";

const client = useMongoClient();
const good = uniqueDb("upcli");
const broken = uniqueDb("upclibad");
let workDir: string;
let storageDir: string;
let goodId: string;
let brokenId: string;
let sourceVersion: string;
let scratch: MongoMemoryReplSet;
const savedSystemBinary = process.env.MONGOMS_SYSTEM_BINARY;

beforeAll(async () => {
  // Let mongodb-memory-server download 8.0 instead of using the shared 7.0 binary.
  delete process.env.MONGOMS_SYSTEM_BINARY;
  sourceVersion = String((await client().db("admin").command({ buildInfo: 1 })).version);
  await client()
    .db(good)
    .collection("users")
    .insertMany(Array.from({ length: 30 }, (_, index) => ({ index })));
  // A backup that breaks on 6.0 and later: a view calling a removed JavaScript function.
  await client()
    .db(broken)
    .collection("orders")
    .insertOne({ tags: ["a"] });
  await client()
    .db(broken)
    .createCollection("tagged", {
      viewOn: "orders",
      pipeline: [
        {
          $addFields: {
            n: {
              $function: {
                body: "function(t) { return Array.concat(t, []).length; }",
                args: ["$tags"],
                lang: "js",
              },
            },
          },
        },
      ],
    });

  workDir = await mkdtemp(join(tmpdir(), "mongoshield-rehearse-cli-"));
  storageDir = join(workDir, "backups");
  const shield = new MongoShield({
    source: { uri: mongoUri() },
    storage: fileStorage({ path: storageDir }),
  });
  try {
    goodId = (await shield.backup({ include: [`${good}.*`] })).id;
    brokenId = (await shield.backup({ include: [`${broken}.*`] })).id;
  } finally {
    await shield.close();
  }
  scratch = await MongoMemoryReplSet.create({
    replSet: { name: "clirehearsal", count: 1, storageEngine: "wiredTiger" },
    binary: { version: TARGET_VERSION },
  });
});

afterAll(async () => {
  await scratch?.stop();
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
  if (savedSystemBinary !== undefined) process.env.MONGOMS_SYSTEM_BINARY = savedSystemBinary;
});

/** Runs the CLI in the work directory. */
function cli(args: readonly string[]) {
  return runTestCli(args, { cwd: workDir });
}

describe("mongoshield rehearse-upgrade", () => {
  it("rehearses on an ephemeral server, prints the analysis and the checks, exits 0", async () => {
    const run = await cli([
      "rehearse-upgrade",
      goodId,
      "--from",
      storageDir,
      "--target-version",
      TARGET_VERSION,
      "--keep",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(`Rehearsing MongoDB ${TARGET_VERSION} on an ephemeral mongod`);
    expect(run.stdout).toContain(`Compatibility MongoDB ${sourceVersion} → ${TARGET_VERSION}`);
    expect(run.stdout).toMatch(
      new RegExp(
        `Restore into MongoDB ${TARGET_VERSION.replaceAll(".", "\\.")} \\(an ephemeral server\\)`,
      ),
    );
    expect(run.stdout).toMatch(new RegExp(`${good}\\.users\\s+validate\\s+passed`));
    expect(run.stdout).toContain("Rehearsal passed");
    expect(run.stderr).toContain("--keep kept nothing: the ephemeral server was deleted");

    // `inspect` shows the rehearsal with the version it proved.
    const inspect = await cli(["inspect", goodId, "--from", storageDir]);
    expect(inspect.stdout).toContain(`upgrade rehearsal on MongoDB ${TARGET_VERSION} ✓`);
    expect(inspect.stdout).toMatch(/DRILLED\s+RESULT\s+MONGODB/);
  });

  it("rehearses on --target-uri and prints JSON", async () => {
    const run = await cli([
      "rehearse-upgrade",
      goodId,
      "--from",
      storageDir,
      "--target-version",
      "8.0",
      "--target-uri",
      scratch.getUri(),
      "--sample",
      "5",
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const report = run.json<{
      ok: boolean;
      ephemeral: boolean;
      serverVersion: string;
      drill: { namespaces: { sampled: number }[] };
    }>();
    expect(report).toMatchObject({ ok: true, ephemeral: false, serverVersion: TARGET_VERSION });
    expect(report.drill.namespaces[0]?.sampled).toBe(5);
  });

  it("fails with exit code 33 and lists the problems", async () => {
    const run = await cli([
      "rehearse-upgrade",
      brokenId,
      "--from",
      storageDir,
      "--target-version",
      "8.0",
      "--target-uri",
      scratch.getUri(),
      "--keep",
    ]);
    expect(run.code).toBe(33);
    expect(run.stdout).toContain("✖ problem");
    expect(run.stdout).toContain("javascript-removed-functions, MongoDB 6.0: https://");
    expect(run.stdout).toContain(`view:${broken}.tagged: querying the view fails`);
    expect(run.stdout).toContain("Rehearsal failed");
    expect(run.stderr).toContain("Kept the temporary databases: msdrill_");
  });

  it("--analyze-only checks the notes without a server", async () => {
    const clean = await cli([
      "rehearse-upgrade",
      goodId,
      "--from",
      storageDir,
      "--target-version",
      "8.0",
      "--analyze-only",
    ]);
    expect(clean.code, clean.stderr).toBe(0);
    expect(clean.stdout).toContain("No compatibility problems");

    const bad = await cli([
      "rehearse-upgrade",
      brokenId,
      "--from",
      storageDir,
      "--target-version",
      "8.0",
      "--analyze-only",
      "--json",
    ]);
    expect(bad.code).toBe(33);
    expect(bad.json()).toMatchObject({ backupId: brokenId, ok: false });

    const text = await cli([
      "rehearse-upgrade",
      brokenId,
      "--from",
      storageDir,
      "--target-version",
      "8.0",
      "--analyze-only",
    ]);
    expect(text.stdout).toMatch(/✖ 1 compatibility problem in backup/);
  });

  it("explains usage mistakes with exit code 2", async () => {
    const missing = await cli(["rehearse-upgrade", "--from", storageDir]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("--target-version");

    for (const flags of [["--target-uri", scratch.getUri()], ["--keep"], ["--sample", "3"]]) {
      const run = await cli([
        "rehearse-upgrade",
        "--from",
        storageDir,
        "--target-version",
        "8.0",
        "--analyze-only",
        ...flags,
      ]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("has no effect with --analyze-only");
    }

    const invalid = await cli([
      "rehearse-upgrade",
      "--from",
      storageDir,
      "--target-version",
      "eight",
      "--analyze-only",
    ]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('"eight" is not a MongoDB version');
  });

  it("asks for an exact version when it would have to download a server", async () => {
    const run = await cli([
      "rehearse-upgrade",
      goodId,
      "--from",
      storageDir,
      "--target-version",
      "8.0",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("needs an exact version to download");
  });
});
