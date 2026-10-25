// `mongoshield snapshot` and `mongoshield rollback` on the test replica set: the source
// from the environment, extra labels and --json, then rolling back by id, as JSON, on a
// terminal (yes and no), without a safety snapshot and keeping new collections.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEYS, plain, runTestCli } from "../helpers/cli.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

let workDir: string;
let storage: string;
let database: string;
let snapshotId: string;

const accounts = () => client().db(database).collection<{ _id: number; plan: string }>("accounts");

/** Breaks the data the way a failed migration would. */
async function breakData(): Promise<void> {
  await accounts().updateMany({}, { $set: { plan: "BROKEN" } });
  await client().db(database).collection("migration_temp").insertOne({ step: 1 });
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-cli-snapshot-"));
  storage = join(workDir, "backups");
  database = uniqueDb("cli_snapshot");
  await accounts().insertMany([
    { _id: 1, plan: "basic" },
    { _id: 2, plan: "pro" },
  ]);
  await client().db(database).collection("audit").insertOne({ at: new Date() });
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await rm(workDir, { recursive: true, force: true });
});

describe("mongoshield snapshot", () => {
  it("reads the source from MONGODB_URI and prints one JSON document with the labels", async () => {
    const run = await runTestCli(
      [
        "snapshot",
        "v42",
        "--to",
        storage,
        "--include",
        `${database}.*`,
        "--exclude",
        `${database}.audit`,
        "--label",
        "ticket=OPS-1",
        "--json",
      ],
      { cwd: workDir, env: { MONGODB_URI: mongoUri() } },
    );
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{
      id: string;
      label: string;
      manifest: { labels: Record<string, string>; namespaces: { ns: string }[] };
    }>();
    expect(result.label).toBe("v42");
    expect(result.manifest.labels).toMatchObject({
      ticket: "OPS-1",
      "mongoshield.snapshot": "v42",
    });
    expect(result.manifest.namespaces.map((entry) => entry.ns)).toEqual([`${database}.accounts`]);
    snapshotId = result.id;
  });

  it("refuses --retain-days on storage without object lock", async () => {
    const run = await runTestCli(
      [
        "snapshot",
        "locked",
        "--uri",
        mongoUri(),
        "--to",
        storage,
        "--include",
        `${database}.*`,
        "--retain-days",
        "1",
      ],
      { cwd: workDir },
    );
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("✖ MS_");
    expect(run.stderr).toContain("docs");
  });

  it("prints a summary and the id on a terminal-less run", async () => {
    const run = await runTestCli(
      [
        "snapshot",
        "v43",
        "--uri",
        mongoUri(),
        "--to",
        storage,
        "--include",
        `${database}.accounts`,
      ],
      { cwd: workDir },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/Snapshot "v43": 2 documents in 1 namespace/);
    expect(run.stderr).toContain("Roll back with: mongoshield rollback v43");
    expect(run.stdout.trim()).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("mongoshield rollback", () => {
  const base = () => ["rollback", "--uri", mongoUri(), "--from", storage];

  it("previews a rollback by --id as one JSON document", async () => {
    await breakData();
    const run = await runTestCli([...base(), "--id", snapshotId, "--dry-run", "--json"], {
      cwd: workDir,
    });
    expect(run.code, run.stderr).toBe(0);
    const preview = run.json<{ snapshotId: string; dryRun: boolean; newCollections: string[] }>();
    expect(preview).toMatchObject({ snapshotId, dryRun: true });
    expect(preview.newCollections).toContain(`${database}.migration_temp`);
    expect(run.stderr).toBe("");
    expect(await accounts().countDocuments({ plan: "BROKEN" })).toBe(2);
  });

  it("rolls back to a plain backup by --id, naming it by id, and honours --exclude", async () => {
    const backup = await runTestCli(
      ["backup", "--uri", mongoUri(), "--to", storage, "--include", `${database}.*`, "--quiet"],
      { cwd: workDir },
    );
    expect(backup.code, backup.stderr).toBe(0);
    const plainId = backup.stdout.trim();
    const run = await runTestCli(
      [...base(), "--id", plainId, "--dry-run", "--exclude", `${database}.audit`],
      { cwd: workDir },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(`Rollback plan: snapshot ${plainId} from`);
    expect(run.stderr).toMatch(/NAMESPACE\s+TYPE\s+SNAPSHOT DOCS\s+LIVE DOCS\s+ACTION/);
    expect(run.stderr).not.toMatch(new RegExp(`${database}\\.audit\\s`));
    expect(run.stderr).toContain("Dry run: nothing was written.");
  });

  it("changes nothing when the user answers no on a terminal", async () => {
    const run = await runTestCli([...base(), "v42"], {
      cwd: workDir,
      terminal: [
        {
          when: "and drop 1 collection created since (a safety snapshot is taken first)?",
          keys: KEYS.enter,
        },
      ],
    });
    expect(run.code).toBe(60);
    expect(plain(run.stderr)).toContain("Cancelled. Nothing was changed.");
    expect(await accounts().countDocuments({ plan: "BROKEN" })).toBe(2);
  });

  it("rolls back on yes, keeping new collections and without a safety snapshot", async () => {
    const run = await runTestCli([...base(), "v42", "--keep-new", "--no-safety-snapshot"], {
      cwd: workDir,
      terminal: [{ when: "with snapshot", keys: `y${KEYS.enter}` }],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    // Joined across the prompt's wrapped lines.
    const stderr = plain(run.stderr).replace(/\s*\n[│└]?\s*/g, " ");
    expect(stderr).not.toContain("a safety snapshot is taken first");
    expect(stderr).not.toContain("drop 1 collection");
    expect(stderr).toContain("keep (--keep-new)");
    expect(stderr).not.toContain("Safety snapshot");
    expect(plain(run.stdout)).toMatch(/Rolled back 1 namespace to \S+ \(2 documents, .+\)\.\n$/);
    expect(await accounts().countDocuments({ plan: "BROKEN" })).toBe(0);
    const names = (await client().db(database).listCollections().toArray()).map(
      (info) => info.name,
    );
    expect(names).toContain("migration_temp");
  });

  it("prints the result as JSON with --yes, keeping the safety snapshot id", async () => {
    await breakData();
    const run = await runTestCli([...base(), "v42", "--yes", "--json", "--mode", "drop"], {
      cwd: workDir,
    });
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{ safetySnapshotId?: string; dropsNew: boolean; dryRun: boolean }>();
    expect(result.dryRun).toBe(false);
    expect(result.dropsNew).toBe(true);
    expect(result.safetySnapshotId).toMatch(/^\d{4}-/);
    expect(await accounts().countDocuments({ plan: "BROKEN" })).toBe(0);
  });

  it("tells where the safety snapshot is in the human summary", async () => {
    await breakData();
    const run = await runTestCli([...base(), "v42", "--yes", "--include", `${database}.accounts`], {
      cwd: workDir,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toMatch(
      /Safety snapshot \S+ holds the data as it was before the rollback\./,
    );
  });
});
