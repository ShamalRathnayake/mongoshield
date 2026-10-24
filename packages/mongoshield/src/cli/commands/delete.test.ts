// `mongoshield delete <id>` against an in-memory store: confirmation (none possible,
// No, yes), --json with the audit line, exact ids only, and the library's refusals
// surfacing with their exit codes.

import { describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { KEYS, plain, runTestCli } from "../../../test/helpers/cli.ts";
import { cliBackupLabels, namedMemoryStore } from "../../../test/helpers/cli-backups.ts";

/** A store with two backups; returns their ids, newest first. */
async function twoBackups() {
  const store = await namedMemoryStore();
  const ids: string[] = [];
  for (const daysAgo of [2, 1]) {
    const manifest = await writeTestBackup(store.storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: daysAgo }] }],
      startedAt: new Date(Date.now() - daysAgo * 86_400_000),
      labels: cliBackupLabels(),
    });
    ids.unshift(manifest.id);
  }
  return { ...store, ids };
}

async function listedIds(url: string): Promise<string[]> {
  const list = await runTestCli(["list", "--from", url, "--json"]);
  return list.json<{ id: string }[]>().map((entry) => entry.id);
}

describe("mongoshield delete", () => {
  it("refuses without a terminal or --yes (exit 3), deleting nothing", async () => {
    const { url, ids } = await twoBackups();
    const run = await runTestCli(["delete", ids[1] ?? "", "--from", url]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("MS_CONFIRMATION_REQUIRED");
    expect(await listedIds(url)).toEqual(ids);
  });

  it("asks on a terminal; No changes nothing, yes deletes", async () => {
    const { url, ids } = await twoBackups();
    const no = await runTestCli(["delete", ids[1] ?? "", "--from", url], {
      terminal: [{ when: "This cannot be undone", keys: KEYS.enter }],
    });
    expect(no.code).toBe(60);
    expect(await listedIds(url)).toEqual(ids);

    const yes = await runTestCli(["delete", ids[1] ?? "", "--from", url, "--by", "alice"], {
      terminal: [{ when: "This cannot be undone", keys: `y${KEYS.enter}` }],
    });
    expect(yes.code, plain(yes.stderr)).toBe(0);
    expect(plain(yes.stdout)).toMatch(/✔ Deleted backup \S+: \d+ objects, .+\./);
    expect(plain(yes.stderr)).toContain(`audit: deleted backup ${ids[1]} (complete,`);
    expect(plain(yes.stderr)).toContain("by alice");
    expect(await listedIds(url)).toEqual([ids[0]]);
  });

  it("deletes with --yes and prints the result as JSON, the audit line on stderr", async () => {
    const { url, ids } = await twoBackups();
    const run = await runTestCli(["delete", ids[0] ?? "", "--yes", "--json", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{
      id: string;
      status: string;
      deletedObjects: number;
      storage: string;
    }>();
    expect(result).toMatchObject({ id: ids[0], status: "complete", storage: expect.any(String) });
    expect(result.deletedObjects).toBeGreaterThan(1);
    expect(run.stderr).toContain(`audit: deleted backup ${ids[0]}`);
    expect(await listedIds(url)).toEqual([ids[1]]);
  });

  it("only accepts an exact id", async () => {
    const { url } = await twoBackups();
    for (const args of [
      ["delete", "--from", url],
      ["delete", "latest", "--from", url],
    ]) {
      const run = await runTestCli([...args, "--yes"]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("Pass its exact id");
    }
  });

  it("reports unknown and protected backups with their exit codes", async () => {
    const { url, ids } = await twoBackups();
    const missing = await runTestCli([
      "delete",
      "2020-01-01T00-00-00Z_000000",
      "--yes",
      "--from",
      url,
    ]);
    expect(missing.code).toBe(30);

    const hold = await runTestCli(["hold", ids[0] ?? "", "--reason", "audit", "--from", url]);
    expect(hold.code, hold.stderr).toBe(0);
    const held = await runTestCli(["delete", ids[0] ?? "", "--yes", "--json", "--from", url]);
    expect(held.code).toBe(35);
    expect(held.json<{ error: { code: string } }>().error.code).toBe("MS_BACKUP_PROTECTED");
    expect(await listedIds(url)).toEqual(ids);
  });
});
