// `mongoshield hold` and `mongoshield release` against an in-memory store.

import { describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { namedMemoryStore } from "../../../test/helpers/cli-backups.ts";

async function storeWithBackup() {
  const store = await namedMemoryStore();
  const manifest = await writeTestBackup(store.storage, {
    namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
  });
  return { ...store, id: manifest.id };
}

describe("mongoshield hold", () => {
  it("needs a reason (exit code 2, with a hint)", async () => {
    const { url } = await storeWithBackup();
    for (const args of [[], ["--reason", "   "]]) {
      const run = await runTestCli(["hold", "latest", "--from", url, ...args]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("A hold needs a reason.");
      expect(run.stderr).toContain(
        'hint  Say why the backup must be kept, e.g. --reason "audit 2026".',
      );
      expect(run.stderr).toMatch(/docs {2}https:\/\/\S+#ms_config_invalid/);
    }
  });

  it("needs the backup to be named: no implicit latest", async () => {
    const { url } = await storeWithBackup();
    const run = await runTestCli(["hold", "--reason", "audit", "--from", url]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('Which backup? Pass an id or "latest".');
  });

  it("places a hold with the given --by and prints the record as JSON", async () => {
    const { url, id } = await storeWithBackup();
    const run = await runTestCli([
      "hold",
      id,
      "--reason",
      " legal case 4471 ",
      "--by",
      "alice",
      "--from",
      url,
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({ backupId: id, reason: "legal case 4471", by: "alice" });

    const list = await runTestCli(["list", "--from", url, "--json"]);
    expect(list.json<{ hold?: { by: string } }[]>()[0]?.hold?.by).toBe("alice");
  });

  it("defaults --by to user@host and prints a confirmation line", async () => {
    const { url, id } = await storeWithBackup();
    const run = await runTestCli(["hold", "latest", "--reason", "migration", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`✔ Backup ${id} is on hold: migration`);
    const list = await runTestCli(["list", "--from", url, "--json"]);
    expect(list.json<{ hold?: { by?: string } }[]>()[0]?.hold?.by).toMatch(/.@./);
  });

  it("fails with MS_BACKUP_NOT_FOUND for an unknown id", async () => {
    const { url } = await storeWithBackup();
    const run = await runTestCli([
      "hold",
      "2020-01-01T00-00-00Z_abcdef",
      "--reason",
      "x",
      "--from",
      url,
    ]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("2020-01-01T00-00-00Z_abcdef");
  });
});

describe("mongoshield release", () => {
  it("says there was nothing to release when the backup is not held", async () => {
    const { url, id } = await storeWithBackup();
    const run = await runTestCli(["release", "latest", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`Backup ${id} was not on hold; nothing to release.`);
  });

  it("releases a hold, and reports it as JSON", async () => {
    const { url, id } = await storeWithBackup();
    await runTestCli(["hold", id, "--reason", "audit", "--from", url]);

    const json = await runTestCli(["release", id, "--from", url, "--json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(json.json()).toEqual({ backupId: id, released: true });

    const again = await runTestCli(["release", id, "--from", url, "--json"]);
    expect(again.json()).toEqual({ backupId: id, released: false });
  });

  it("prints a confirmation line when a hold was released", async () => {
    const { url, id } = await storeWithBackup();
    await runTestCli(["hold", id, "--reason", "audit", "--from", url]);
    const run = await runTestCli(["release", id, "--from", url]);
    expect(run.stdout).toContain(`✔ Released the hold on ${id}.`);
  });

  it("needs the backup to be named", async () => {
    const { url } = await storeWithBackup();
    const run = await runTestCli(["release", "--from", url]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("mongoshield release latest");
  });
});
