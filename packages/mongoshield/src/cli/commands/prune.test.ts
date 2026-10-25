// `mongoshield prune` against an in-memory store: policies from flags and from the
// config file, the plan table, dry runs, confirmation (yes, no, and none possible), --json,
// and scopes: several sources/selections sharing one location never prune each other.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { KEYS, plain, runTestCli } from "../../../test/helpers/cli.ts";
import {
  cliBackupLabels,
  namedMemoryStore,
  writeIncompleteBackup,
} from "../../../test/helpers/cli-backups.ts";
import type { StorageAdapter } from "../../storage/types.ts";

const DAY = 86_400_000;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-prune-cli-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A store with three backups, one day apart; returns their ids newest first. */
async function threeBackups() {
  const store = await namedMemoryStore();
  const ids: string[] = [];
  for (const daysAgo of [3, 2, 1]) {
    const manifest = await writeTestBackup(store.storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: daysAgo }] }],
      startedAt: new Date(Date.now() - daysAgo * DAY),
      // As `mongoshield backup` labels them, so they are in prune's default scope.
      labels: cliBackupLabels(),
    });
    ids.unshift(manifest.id);
  }
  return { ...store, ids };
}

async function backupCount(url: string): Promise<number> {
  const list = await runTestCli(["list", "--from", url, "--json"]);
  return list.json<unknown[]>().length;
}

describe("mongoshield prune", () => {
  it("prints the plan newest first and deletes nothing with --dry-run", async () => {
    const { url, ids } = await threeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--dry-run", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    const rows = run.stderr.split("\n").filter((line) => /^\d{4}-/.test(line));
    expect(rows.map((row) => row.split(/\s+/)[0])).toEqual(ids);
    expect(rows[0]).toMatch(/keep/);
    expect(rows[1]).toMatch(/remove/);
    expect(run.stdout).toContain("Dry run: would delete 2 backups. Nothing was deleted.");
    expect(await backupCount(url)).toBe(3);
  });

  it("keeps a verified older backup for --min-verified, and still lists the plan newest first", async () => {
    const { url, ids } = await threeBackups();
    const oldest = ids[2] ?? "";
    expect((await runTestCli(["verify", oldest, "--from", url])).code).toBe(0);
    const run = await runTestCli([
      "prune",
      "--last",
      "1",
      "--min-verified",
      "1",
      "--dry-run",
      "--from",
      url,
    ]);
    expect(run.code, run.stderr).toBe(0);
    const rows = run.stderr.split("\n").filter((line) => /^\d{4}-/.test(line));
    expect(rows.map((row) => row.split(/\s+/)[0])).toEqual(ids);
    expect(rows.map((row) => row.split(/\s+/)[1])).toEqual(["keep", "remove", "keep"]);
    expect(run.stdout).toContain("would delete 1 backup.");
  });

  it("says when there is nothing to prune", async () => {
    const { url } = await threeBackups();
    const run = await runTestCli(["prune", "--last", "5", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("✔ Nothing to prune: every backup is kept.");
  });

  it("says when storage is empty", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["prune", "--daily", "7", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("There are no backups to prune.");
  });

  it("refuses to delete without a terminal or --yes (exit 3), keeping every backup", async () => {
    const { url } = await threeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--from", url]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("MS_CONFIRMATION_REQUIRED");
    expect(run.stderr).toContain("Refusing to delete 2 backups without confirmation");
    expect(run.stderr).toContain("re-run with --yes");
    expect(await backupCount(url)).toBe(3);
  });

  it("asks on a terminal, and answering No changes nothing (exit 60)", async () => {
    const { url } = await threeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--from", url], {
      terminal: [{ when: "Permanently delete 2 backups", keys: KEYS.enter }],
    });
    expect(run.code).toBe(60);
    expect(plain(run.stderr)).toContain("Cancelled. Nothing was changed.");
    expect(run.stdout).toBe("");
    expect(await backupCount(url)).toBe(3);
  });

  it("deletes after the user says yes on a terminal", async () => {
    const { url } = await threeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--from", url], {
      terminal: [{ when: "Permanently delete 2 backups", keys: `y${KEYS.enter}` }],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    // On a terminal the check mark is green.
    expect(run.stdout).toContain("\u001b[32m✔");
    expect(plain(run.stdout)).toMatch(/✔ Deleted 2 backups \(\d+ objects, .+\)\./);
    expect(await backupCount(url)).toBe(1);
  });

  it("deletes with --yes and prints the policy and result as JSON", async () => {
    const { url, ids } = await threeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--yes", "--json", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{
      policy: Record<string, number>;
      dryRun: boolean;
      deletedBackups: number;
      plan: { keep: { id: string }[] };
    }>();
    expect(result.policy).toEqual({ last: 1 });
    expect(result).toMatchObject({ dryRun: false, deletedBackups: 2 });
    expect(result.plan.keep.map((entry) => entry.id)).toEqual([ids[0]]);
    // The plan table is not printed with --json.
    expect(run.stderr).toBe("");
  });

  it("takes the policy and min-verified from the config file", async () => {
    const { url } = await threeBackups();
    const cwd = await mkdtemp(join(workDir, "config-"));
    await writeFile(
      join(cwd, "mongoshield.config.json"),
      JSON.stringify({ storage: url, retention: { last: 2, minVerified: 0 } }),
    );
    const run = await runTestCli(["prune", "--dry-run", "--json"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    expect(run.json<{ policy: unknown }>().policy).toEqual({ last: 2, minVerified: 0 });
  });

  it("lets --min-verified override the config, and count flags replace its counts", async () => {
    const { url } = await threeBackups();
    const cwd = await mkdtemp(join(workDir, "config-"));
    await writeFile(
      join(cwd, "mongoshield.config.json"),
      JSON.stringify({ storage: url, retention: { daily: 7, minVerified: 1 } }),
    );
    const run = await runTestCli(
      ["prune", "--last", "1", "--min-verified", "0", "--dry-run", "--json"],
      { cwd },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.json<{ policy: unknown }>().policy).toEqual({ last: 1, minVerified: 0 });
  });

  it.each([
    [["--last", "0"], "--last must be a whole number ≥ 1"],
    [["--daily", "seven"], '--daily must be a whole number ≥ 1 (got "seven")'],
    [[], "No retention policy is configured."],
  ])("rejects %j with exit code 2", async (flags, message) => {
    const { url } = await threeBackups();
    const run = await runTestCli(["prune", ...flags, "--from", url]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(await backupCount(url)).toBe(3);
  });
});

/** Three backups of one selection (and optionally cluster), a day apart; ids newest first. */
async function seriesOf(
  storage: StorageAdapter,
  options: { include?: string[]; clusterId?: string; labels?: Record<string, string> },
  hoursOffset = 0,
): Promise<string[]> {
  const ids: string[] = [];
  for (const daysAgo of [3, 2, 1]) {
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: daysAgo }] }],
      startedAt: new Date(Date.now() - daysAgo * DAY - hoursOffset * 3_600_000),
      labels: { ...cliBackupLabels({ include: options.include }), ...options.labels },
      ...(options.clusterId === undefined ? {} : { clusterId: options.clusterId }),
    });
    ids.unshift(manifest.id);
  }
  return ids;
}

/** The ids `mongoshield list` reports, newest first. */
async function listedIds(url: string): Promise<string[]> {
  const list = await runTestCli(["list", "--from", url, "--json"]);
  return list.json<{ id: string }[]>().map((entry) => entry.id);
}

describe("mongoshield prune with several sources/selections in one storage", () => {
  it("prunes only the configured selection and says how many backups it left alone", async () => {
    const { url, storage } = await namedMemoryStore();
    const app = await seriesOf(storage, { include: ["app.*"] });
    const analytics = await seriesOf(storage, { include: ["analytics.*"] }, 1);

    const run = await runTestCli([
      "prune",
      "--include",
      "app.*",
      "--last",
      "1",
      "--yes",
      "--from",
      url,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/Deleted 2 backups/);
    expect(run.stdout).toContain("3 backups of other sources/selections were left alone.");
    expect((await listedIds(url)).sort()).toEqual([app[0], ...analytics].sort());
  });

  it("leaves every backup of other selections alone by default (the config selects everything)", async () => {
    const { url, storage } = await namedMemoryStore();
    const app = await seriesOf(storage, { include: ["app.*"] });
    const everything = await seriesOf(storage, {}, 1);

    const run = await runTestCli(["prune", "--last", "1", "--yes", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect((await listedIds(url)).sort()).toEqual([everything[0], ...app].sort());
  });

  it("takes the selection from the config file's backup section", async () => {
    const { url, storage } = await namedMemoryStore();
    const app = await seriesOf(storage, { include: ["app.*"] });
    const analytics = await seriesOf(storage, { include: ["analytics.*"] }, 1);
    const cwd = await mkdtemp(join(workDir, "scope-config-"));
    await writeFile(
      join(cwd, "mongoshield.config.json"),
      JSON.stringify({
        storage: url,
        backup: { include: ["analytics.*"] },
        retention: { last: 1 },
      }),
    );
    const run = await runTestCli(["prune", "--yes"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    expect((await listedIds(url)).sort()).toEqual([analytics[0], ...app].sort());
  });

  it("scopes by --scope-label instead of the selection", async () => {
    const { url, storage } = await namedMemoryStore();
    const billing = await seriesOf(storage, { labels: { team: "billing" } });
    const search = await seriesOf(storage, { labels: { team: "search" } }, 1);
    const run = await runTestCli([
      "prune",
      "--scope-label",
      "team=billing",
      "--last",
      "1",
      "--yes",
      "--json",
      "--from",
      url,
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{
      scope: unknown;
      deletedBackups: number;
      outOfScope: { id: string; reason: string }[];
    }>();
    expect(result.scope).toEqual({ labels: { team: "billing" } });
    expect(result.deletedBackups).toBe(2);
    expect(result.outOfScope.map((entry) => entry.id).sort()).toEqual([...search].sort());
    expect(result.outOfScope.every((entry) => entry.reason === "other-scope")).toBe(true);
    expect((await listedIds(url)).sort()).toEqual([billing[0], ...search].sort());
  });

  it("scopes by the config's retention.scopeLabels, like mongoshield run", async () => {
    const { url, storage } = await namedMemoryStore();
    const nightly = await seriesOf(storage, { labels: { "mongoshield.plan": "nightly" } });
    const hourly = await seriesOf(storage, { labels: { "mongoshield.plan": "hourly" } }, 1);
    const cwd = await mkdtemp(join(workDir, "scope-labels-config-"));
    await writeFile(
      join(cwd, "mongoshield.config.json"),
      JSON.stringify({
        storage: url,
        retention: { last: 1, scopeLabels: { "mongoshield.plan": "nightly" } },
      }),
    );
    const run = await runTestCli(["prune", "--yes", "--json"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    expect(run.json<{ scope: unknown }>().scope).toEqual({
      labels: { "mongoshield.plan": "nightly" },
    });
    expect((await listedIds(url)).sort()).toEqual([nightly[0], ...hourly].sort());
  });

  it("uses the one deployment the matching backups come from, and refuses when there are several", async () => {
    const { url, storage } = await namedMemoryStore();
    await seriesOf(storage, { clusterId: "cluster-a" });
    const single = await runTestCli(["prune", "--last", "1", "--dry-run", "--json", "--from", url]);
    expect(single.code, single.stderr).toBe(0);
    expect(single.json<{ scope: { clusterId?: string } }>().scope.clusterId).toBe("cluster-a");

    await seriesOf(storage, { clusterId: "cluster-b" }, 1);
    const run = await runTestCli(["prune", "--last", "1", "--yes", "--from", url]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Backups of 2 deployments");
    expect(run.stderr).toContain("--all-sources");
    expect(await listedIds(url)).toHaveLength(6);
  });

  it("reports incomplete runs it cannot attribute instead of deleting them", async () => {
    const { url, storage } = await namedMemoryStore();
    await seriesOf(storage, {});
    await writeIncompleteBackup(storage, new Date(Date.now() - 10 * DAY));
    const run = await runTestCli(["prune", "--last", "5", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("1 backup of other sources/selections was left alone.");
    expect(run.stderr).toContain("1 incomplete run among them cannot be attributed to a source");
    expect(await listedIds(url)).toHaveLength(4);
  });

  describe("--all-sources", () => {
    async function twoSelections() {
      const { url, storage } = await namedMemoryStore();
      const app = await seriesOf(storage, { include: ["app.*"], clusterId: "cluster-a" });
      const analytics = await seriesOf(
        storage,
        { include: ["analytics.*"], clusterId: "cluster-b" },
        1,
      );
      return { url, app, analytics };
    }

    it("refuses without a terminal or --yes, deleting nothing", async () => {
      const { url } = await twoSelections();
      const run = await runTestCli(["prune", "--all-sources", "--last", "1", "--from", url]);
      expect(run.code).toBe(3);
      expect(run.stderr).toContain("Refusing to delete 5 backups across all sources");
      expect(await listedIds(url)).toHaveLength(6);
    });

    it("lists what it would delete per source/selection, and answering No changes nothing", async () => {
      const { url, app, analytics } = await twoSelections();
      const run = await runTestCli(["prune", "--all-sources", "--last", "1", "--from", url], {
        terminal: [
          { when: "Permanently delete 5 backups of 2 sources/selections", keys: KEYS.enter },
        ],
      });
      expect(run.code).toBe(60);
      const output = plain(run.stderr);
      expect(output).toContain(
        "Applying the policy to every backup in the storage (--all-sources).",
      );
      expect(output).toContain("Backups to delete, by source/selection:");
      const appRow = output.split("\n").find((line) => line.includes("cluster cluster-a"));
      const analyticsRow = output.split("\n").find((line) => line.includes("cluster cluster-b"));
      expect(appRow).toContain(
        `selection ${cliBackupLabels({ include: ["app.*"] })["mongoshield.shape"]}`,
      );
      expect(appRow).toContain(`${app[1]}, ${app[2]}`);
      // Each analytics backup is an hour older than its app twin, so `--last 1` over the
      // whole storage keeps only the newest app backup.
      expect(analyticsRow).toContain(analytics.join(", "));
      expect(await listedIds(url)).toHaveLength(6);
    });

    it("applies the policy to the whole storage with --yes", async () => {
      const { url, app } = await twoSelections();
      const run = await runTestCli([
        "prune",
        "--all-sources",
        "--last",
        "1",
        "--yes",
        "--from",
        url,
      ]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/Deleted 5 backups/);
      expect(run.stdout).not.toContain("left alone");
      expect(await listedIds(url)).toEqual([app[0]]);
    });

    it("cannot be combined with a scope", async () => {
      const { url } = await twoSelections();
      const run = await runTestCli([
        "prune",
        "--all-sources",
        "--scope-label",
        "team=x",
        "--last",
        "1",
        "--from",
        url,
      ]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("--all-sources and --scope-label cannot be combined.");
    });
  });
});
