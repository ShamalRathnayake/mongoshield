// `mongoshield restore-tenant` on the test replica set: confirmations on a terminal
// (yes and no), the upsert confirmation, renames into a new collection, skipped views,
// a tenant that matches nothing, and --json.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileStorage } from "../../src/storage/file.ts";
import { backupDatabaseForTest } from "../helpers/backup-fixtures.ts";
import { KEYS, plain, runTestCli } from "../helpers/cli.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

interface TenantDocument {
  _id: number;
  tenantId: string;
  title: string;
}

let workDir: string;
let storageDir: string;
let database: string;

/** acme has even _ids, globex odd ones. */
function seed(): TenantDocument[] {
  return Array.from({ length: 6 }, (_, id) => ({
    _id: id,
    tenantId: id % 2 === 0 ? "acme" : "globex",
    title: `task ${id}`,
  }));
}

const tasks = () => client().db(database).collection<TenantDocument>("tasks");

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-cli-tenant-"));
  storageDir = join(workDir, "backups");
  database = uniqueDb("cli_tenant");
  await tasks().insertMany(seed());
  // A view cannot be restored per tenant: the plan says so.
  await client()
    .db(database)
    .createCollection("acme_tasks", {
      viewOn: "tasks",
      pipeline: [{ $match: { tenantId: "acme" } }],
    });
  await backupDatabaseForTest(client(), fileStorage({ path: storageDir }), {
    include: [`${database}.*`],
  });
});

beforeEach(async () => {
  await tasks().deleteMany({});
  await tasks().insertMany(seed());
  // acme damaged: one deleted, one changed.
  await tasks().deleteOne({ _id: 0 });
  await tasks().updateOne({ _id: 2 }, { $set: { title: "vandalised" } });
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await rm(workDir, { recursive: true, force: true });
});

const args = (...extra: string[]) => [
  "restore-tenant",
  "--from",
  storageDir,
  "--to-uri",
  mongoUri(),
  "--include",
  `${database}.*`,
  "--filter",
  '{"tenantId":"acme"}',
  ...extra,
];

describe("mongoshield restore-tenant", () => {
  it("asks before replace-tenant on a terminal, and changes nothing when told no", async () => {
    const run = await runTestCli(args("--mode", "replace-tenant"), {
      cwd: workDir,
      terminal: [{ when: "Delete 2 current documents of this tenant", keys: KEYS.enter }],
    });
    expect(run.code).toBe(60);
    expect(plain(run.stderr)).toContain("Cancelled. Nothing was changed.");
    expect(run.stderr).toContain(`Not restored: ${database}.acme_tasks:`);
    expect(await tasks().countDocuments({ tenantId: "acme" })).toBe(2);
  });

  it("restores when the user agrees", async () => {
    const run = await runTestCli(args("--mode", "replace-tenant"), {
      cwd: workDir,
      terminal: [{ when: "Delete 2 current documents", keys: `y${KEYS.enter}` }],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(plain(run.stdout)).toMatch(
      /Restored the tenant in 1 collection \(2 deleted, 3 inserted\)/,
    );
    expect(await tasks().findOne({ _id: 2 })).toMatchObject({ title: "task 2" });
    expect(await tasks().countDocuments({ tenantId: "globex" })).toBe(3);
  });

  it("asks before upserts replace documents, then reports inserted and replaced", async () => {
    const refused = await runTestCli(args("--mode", "upsert"), { cwd: workDir });
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("replace existing documents with --mode upsert");

    const run = await runTestCli(args("--mode", "upsert", "--yes"), { cwd: workDir });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/\(1 inserted, 2 replaced\)/);
    expect(run.stderr).toMatch(/Replace/);
  });

  it("inserts only the missing documents by default, without asking, and says what it skipped", async () => {
    const run = await runTestCli(args(), { cwd: workDir });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/\(1 inserted, 2 skipped \(_id already present\)\)/);
    expect(await tasks().findOne({ _id: 0 })).toMatchObject({ title: "task 0" });
    expect(await tasks().findOne({ _id: 2 })).toMatchObject({ title: "vandalised" });
  });

  it("restores under another name, creating the collection", async () => {
    const sandbox = uniqueDb("cli_tenant_sandbox");
    try {
      const run = await runTestCli(
        args("--rename", `${database}.*=${sandbox}.*`, "--exclude", `${database}.acme_tasks`),
        { cwd: workDir },
      );
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toContain(`${database}.tasks → ${sandbox}.tasks`);
      expect(run.stderr).toContain("creates collection");
      expect(await client().db(sandbox).collection("tasks").countDocuments()).toBe(3);
    } finally {
      await client().db(sandbox).dropDatabase();
    }
  });

  it("finishes without asking when the tenant matches nothing", async () => {
    const nobody = args("--mode", "replace-tenant").map((arg) =>
      arg === '{"tenantId":"acme"}' ? '{"tenantId":"nobody"}' : arg,
    );
    const run = await runTestCli(nobody, { cwd: workDir });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("Nothing to restore: the tenant has no documents");
    expect(run.stderr).not.toContain("Dry run");
  });

  it("takes a per-collection filter alone, and prints the empty plan as JSON", async () => {
    const run = await runTestCli(
      [
        "restore-tenant",
        "--from",
        storageDir,
        "--to-uri",
        mongoUri(),
        "--include",
        `${database}.tasks`,
        "--filter-for",
        `${database}.tasks={"tenantId":"nobody"}`,
        "--json",
      ],
      { cwd: workDir },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({ dryRun: true, totals: { matched: 0, deleted: 0 } });
  });

  it("prints only the result document with --json", async () => {
    const run = await runTestCli(args("--mode", "replace-tenant", "--yes", "--json"), {
      cwd: workDir,
    });
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{ dryRun: boolean; mode: string; totals: { inserted: number } }>();
    expect(result).toMatchObject({
      dryRun: false,
      mode: "replace-tenant",
      totals: { inserted: 3 },
    });
    expect(run.stderr).not.toContain("Tenant restore from backup");
  });
});
