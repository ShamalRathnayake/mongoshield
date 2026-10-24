// `mongoshield replicate`: copying backups between in-memory stores (memory://name is
// one shared store per name), the selection forms, dry runs, JSON output, progress on
// a terminal versus a pipe, and the usage errors.

import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { listBackups } from "../../catalog/catalog.ts";
import { resolveStorage } from "../../storage/resolve.ts";

/** A fresh, uniquely named memory store URL. */
function memoryUrl(): string {
  return `memory://repl-${randomBytes(4).toString("hex")}`;
}

/** A memory store holding `count` small backups, oldest first; returns the URL and ids. */
async function storeWithBackups(count: number): Promise<{ url: string; ids: string[] }> {
  const url = memoryUrl();
  const storage = await resolveStorage(url);
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: index, name: `user ${index}` }] }],
      startedAt: new Date(Date.UTC(2026, 0, 1 + index)),
    });
    ids.push(manifest.id);
  }
  return { url, ids };
}

async function backupIdsIn(url: string): Promise<string[]> {
  const backups = await listBackups(await resolveStorage(url));
  return backups.map((backup) => backup.id).sort();
}

describe("mongoshield replicate", () => {
  it("needs --to (exit 2 with an example)", async () => {
    const run = await runTestCli(["replicate", "--from", memoryUrl()]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Where to? Pass --to <storage-url>.");
    expect(run.stderr).toContain("mongoshield replicate --to s3://");
  });

  it("copies every backup by default and reports a one-line summary", async () => {
    const { url, ids } = await storeWithBackups(2);
    const to = memoryUrl();
    const run = await runTestCli(["replicate", "--from", url, "--to", to]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(
      new RegExp(`${url} → memory://.*: copied 2 backups, updated 0, 0 already there`),
    );
    expect(await backupIdsIn(to)).toEqual([...ids].sort());

    // A second run finds everything there.
    const again = await runTestCli(["replicate", "all", "--from", url, "--to", to]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("copied 0 backups, updated 0, 2 already there");
  });

  it("copies only the newest backup with latest, or the ones named with --id or the positional", async () => {
    const { url, ids } = await storeWithBackups(3);
    const [first, second, third] = ids as [string, string, string];

    const latest = memoryUrl();
    expect((await runTestCli(["replicate", "latest", "--from", url, "--to", latest])).code).toBe(0);
    expect(await backupIdsIn(latest)).toEqual([third]);

    const named = memoryUrl();
    const byPositional = await runTestCli(["replicate", first, "--from", url, "--to", named]);
    expect(byPositional.stdout).toContain("copied 1 backup,");
    expect(await backupIdsIn(named)).toEqual([first]);

    const byFlag = memoryUrl();
    const run = await runTestCli([
      "replicate",
      "--id",
      first,
      "--id",
      second,
      "--from",
      url,
      "--to",
      byFlag,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(await backupIdsIn(byFlag)).toEqual([first, second].sort());
  });

  it("plans without copying in a dry run", async () => {
    const { url } = await storeWithBackups(2);
    const to = memoryUrl();
    const run = await runTestCli(["replicate", "--from", url, "--to", to, "--dry-run"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(
      /^Dry run \(memory:\/\/.* → memory:\/\/.*\): would copy 2 backups, update 0 backups \(.+\); 0 backups already there\.\n$/,
    );
    expect(await backupIdsIn(to)).toEqual([]);
  });

  it("prints the result as one JSON document", async () => {
    const { url, ids } = await storeWithBackups(1);
    const run = await runTestCli([
      "replicate",
      "--from",
      url,
      "--to",
      memoryUrl(),
      "--json",
      "--no-verify",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({
      dryRun: false,
      erasuresCopied: 0,
      backups: [{ backupId: ids[0], action: "copied" }],
    });
  });

  it("copies the erasure ledger and says so", async () => {
    const { url } = await storeWithBackups(1);
    const source = await resolveStorage(url);
    await source.put("erasures/2026-01-01T00-00-00Z_test.json", Buffer.from("{}"), {
      contentType: "application/json",
    });
    const to = memoryUrl();
    const run = await runTestCli(["replicate", "--from", url, "--to", to]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("Copied 1 erasure record.");
  });

  it("resolves a relative --to against the working directory", async () => {
    const { url, ids } = await storeWithBackups(1);
    const cwd = await mkdtemp(join(tmpdir(), "mongoshield-replicate-"));
    try {
      const run = await runTestCli(["replicate", "--from", url, "--to", "offsite"], { cwd });
      expect(run.code, run.stderr).toBe(0);
      expect(await readdir(join(cwd, "offsite", "backups"))).toEqual(ids);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses --retain-days on storage without object lock, and out-of-range values", async () => {
    const { url } = await storeWithBackups(1);
    const noLock = await runTestCli([
      "replicate",
      "--from",
      url,
      "--to",
      memoryUrl(),
      "--retain-days",
      "30",
    ]);
    expect(noLock.code).toBe(2);
    expect(noLock.stderr).toContain("Object Lock");

    const zero = await runTestCli([
      "replicate",
      "--from",
      url,
      "--to",
      memoryUrl(),
      "--retain-days",
      "0",
    ]);
    expect(zero.code).toBe(2);
    expect(zero.stderr).toContain("--retain-days must be a whole number 1–36500");
  });

  it("shows live progress on a terminal and clears it at the end", async () => {
    const { url } = await storeWithBackups(1);
    const run = await runTestCli(["replicate", "--from", url, "--to", memoryUrl()], {
      isTTY: true,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/: \d+ files?, /);
    // The last thing on stderr is the "erase line" sequence: no stale progress line remains.
    expect(run.stderr.endsWith("\r\u001b[2K")).toBe(true);
  });

  it("writes no terminal control codes when piped or with --json", async () => {
    const { url } = await storeWithBackups(1);
    for (const extra of [[], ["--json"]]) {
      const run = await runTestCli(["replicate", "--from", url, "--to", memoryUrl(), ...extra]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).not.toContain("\u001b");
      expect(run.stderr).not.toContain("\r");
    }
  });

  it("refuses to replicate a store onto itself", async () => {
    const { url } = await storeWithBackups(1);
    const run = await runTestCli(["replicate", "--from", url, "--to", url]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("onto itself");
  });
});
