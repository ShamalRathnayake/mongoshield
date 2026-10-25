/**
 * `mongoshield run` through `runCli` against the shared test replica set: the human
 * report (details table, guard warnings, guard failures), --quiet, and the
 * --verify / --no-prune overrides. The JSON report, notifications and locks are
 * covered in schedule.test.ts; failures without a database in
 * src/cli/commands/schedule.test.ts.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listBackups } from "../../src/catalog/catalog.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { runTestCli } from "../helpers/cli.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-cli-run-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A project directory with a config for a fresh, seeded database. */
async function project(extra: Record<string, unknown> = {}) {
  const dbName = uniqueDb("clirun");
  await client()
    .db(dbName)
    .collection("users")
    .insertMany(Array.from({ length: 40 }, (_, index) => ({ n: index })));
  const cwd = await mkdtemp(join(workDir, "project-"));
  const storage = join(cwd, "backups");
  await writeFile(
    join(cwd, "mongoshield.config.json"),
    JSON.stringify({
      source: { uri: mongoUri() },
      storage,
      compression: "gzip",
      backup: { include: [`${dbName}.*`] },
      schedule: { cron: "15 3 * * *" },
      ...extra,
    }),
  );
  return { dbName, cwd, storage };
}

describe("mongoshield run: retention.scopeLabels", () => {
  it("keeps two plans with the same source and selection in one storage apart", async () => {
    const { dbName, cwd, storage } = await project();
    // A second config: same source, same selection, same storage, another plan label.
    const base = {
      source: { uri: mongoUri() },
      storage,
      compression: "gzip",
      schedule: { cron: "15 3 * * *" },
    };
    const write = (file: string, plan: string): Promise<void> =>
      writeFile(
        join(cwd, file),
        JSON.stringify({
          ...base,
          backup: { include: [`${dbName}.*`] },
          retention: { last: 1, scopeLabels: { "mongoshield.plan": plan } },
        }),
      );
    await write("nightly.json", "nightly");
    await write("hourly.json", "hourly");
    try {
      for (const config of ["nightly.json", "hourly.json", "hourly.json", "nightly.json"]) {
        const run = await runTestCli(["run", "--config", config, "--quiet"], { cwd });
        expect(run.code, run.stderr).toBe(0);
      }
      const backups = await listBackups(fileStorage({ path: storage }));
      const plans = backups.map((entry) => entry.manifest?.labels["mongoshield.plan"]).sort();
      // "last: 1" per plan: one each, not one in total.
      expect(plans).toEqual(["hourly", "nightly"]);
    } finally {
      await client().db(dbName).dropDatabase();
    }
  });
});

describe("mongoshield run (human output)", () => {
  it("prints the summary on stderr and the details on stdout", async () => {
    const { dbName, cwd } = await project({ retention: { last: 1 } });
    try {
      const run = await runTestCli(["run"], { cwd });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toMatch(
        /✔ Backup \S+ succeeded: 1 namespaces, 40 documents, verified \(fast\)\./,
      );
      expect(run.stdout).toMatch(/Backup id\s+\S+/);
      expect(run.stdout).toMatch(/Data\s+.+ raw → .+ stored/);
      expect(run.stdout).toMatch(/Verify\s+fast: ok/);
      expect(run.stdout).toMatch(/Pruned\s+0 backup\(s\), 1 kept/);
      expect(run.stdout).toMatch(/Lock\s+storage/);
      expect(run.stdout).toMatch(/Duration\s+\S+/);
    } finally {
      await client().db(dbName).dropDatabase();
    }
  });

  it("prints only the backup id with --quiet", async () => {
    const { dbName, cwd, storage } = await project();
    try {
      const run = await runTestCli(["run", "--quiet"], { cwd });
      expect(run.code, run.stderr).toBe(0);
      const backups = await listBackups(fileStorage({ path: storage }));
      expect(run.stdout).toBe(`${backups[0]?.id}\n`);
    } finally {
      await client().db(dbName).dropDatabase();
    }
  });

  it("skips verification and pruning when told to", async () => {
    const { dbName, cwd, storage } = await project({ retention: { last: 1 } });
    try {
      for (let round = 0; round < 2; round++) {
        const run = await runTestCli(["run", "--verify", "none", "--no-prune"], { cwd });
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).not.toContain("Verify");
        expect(run.stdout).not.toContain("Pruned");
      }
      // retention says last 1, but nothing was pruned.
      expect(await listBackups(fileStorage({ path: storage }))).toHaveLength(2);
    } finally {
      await client().db(dbName).dropDatabase();
    }
  });

  it("reports a deep verify, and the guard warning when data shrinks (action: warn)", async () => {
    const { dbName, cwd } = await project({
      guard: { maxDocumentDropPercent: 10, action: "warn" },
    });
    try {
      const first = await runTestCli(["run", "--verify", "deep"], { cwd });
      expect(first.code, first.stderr).toBe(0);
      expect(first.stdout).toMatch(/Verify\s+deep: ok/);
      expect(first.stdout).toMatch(/Guard\s+ok/);

      await client()
        .db(dbName)
        .collection("users")
        .deleteMany({ n: { $gte: 5 } });
      const second = await runTestCli(["run"], { cwd });
      expect(second.code, second.stderr).toBe(0);
      expect(second.stdout).toMatch(/Guard\s+1 warning\(s\)/);
      expect(second.stderr).toContain(`▲ ${dbName}.users`);
    } finally {
      await client().db(dbName).dropDatabase();
    }
  });

  it("lists the guard's findings under a refused backup (action: fail)", async () => {
    const { dbName, cwd } = await project({ guard: { maxDocumentDropPercent: 10 } });
    try {
      expect((await runTestCli(["run"], { cwd })).code).toBe(0);
      await client()
        .db(dbName)
        .collection("users")
        .deleteMany({ n: { $gte: 5 } });
      const run = await runTestCli(["run"], { cwd });
      expect(run.code).toBe(34);
      expect(run.stdout).toMatch(/^✖ Backup failed during backup: /);
      expect(run.stdout).toContain(`  • ${dbName}.users`);
    } finally {
      await client().db(dbName).dropDatabase();
    }
  });
});
