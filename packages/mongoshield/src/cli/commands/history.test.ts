// `mongoshield history` against in-memory backups (no database): argument checks, how
// each version is described relative to the one before, and the --json document.

import { randomUUID } from "node:crypto";
import type { Document } from "mongodb";
import { describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { resolveStorage } from "../../storage/resolve.ts";

/** A fresh named in-memory store, shared with the CLI through its `memory://` URL. */
async function newStore(): Promise<{ url: string; write: WriteBackup }> {
  const url = `memory://history-${randomUUID()}`;
  const storage = await resolveStorage(url);
  const write: WriteBackup = (at, documents) =>
    writeTestBackup(storage, {
      startedAt: new Date(at),
      namespaces: [{ ns: "app.users", documents }],
    }).then(() => undefined);
  return { url, write };
}

/** Writes one backup of app.users holding `documents`, started at `at`. */
type WriteBackup = (at: string, documents: readonly Document[]) => Promise<void>;

describe("mongoshield history arguments", () => {
  it("needs a namespace and an _id (exit code 2, with a hint)", async () => {
    const run = await runTestCli(["history", "app.users"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Pass a namespace and an _id");
    expect(run.stderr).toContain("mongoshield history --help");
    expect(run.stderr).toContain("docs");
  });

  it.each(["0", "-1", "1.5", "lots"])("rejects --backups %s", async (value) => {
    // `=` form: a separate "-1" would be read as a flag.
    const run = await runTestCli(["history", "app.users", "1", `--backups=${value}`]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`--backups expects a number ≥ 1 or "all" (got "${value}")`);
  });

  it("needs the variable named by --passphrase-env to be set", async () => {
    const run = await runTestCli([
      "history",
      "app.users",
      "1",
      "--from",
      "memory://nothing",
      "--passphrase-env",
      "MS_TEST_PASSPHRASE",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("MS_TEST_PASSPHRASE");
  });
});

describe("mongoshield history output", () => {
  it("describes first, unchanged, gone, re-created and changed versions, newest first", async () => {
    const store = await newStore();
    await store.write("2026-01-01T00:00:00Z", [{ _id: 7, name: "Ada", city: "Oslo" }]);
    await store.write("2026-01-02T00:00:00Z", [{ _id: 7, name: "Ada", city: "Oslo" }]);
    await store.write("2026-01-03T00:00:00Z", [{ _id: 8, name: "someone else" }]);
    await store.write("2026-01-04T00:00:00Z", [{ _id: 7, name: "Ada L.", zip: "0150" }]);
    await store.write("2026-01-05T00:00:00Z", [
      { _id: 7, name: "Ada L.", zip: "0150", note: "x".repeat(200) },
    ]);

    const run = await runTestCli([
      "history",
      "app.users",
      "7",
      "--from",
      store.url,
      "--backups",
      "all",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    // Five backups, newest first (by completion time), each with its description below it.
    const headlines = lines.filter((line) => !line.startsWith("    "));
    expect(headlines).toHaveLength(5);
    expect(headlines[0]).toMatch(/^2026-01-05 00:00:01Z {2}backup \S+ {2}present$/);
    expect(headlines[2]).toMatch(/^2026-01-03 00:00:01Z {2}backup \S+ {2}absent$/);

    const text = run.stdout;
    expect(text).toContain("    (first known version)");
    expect(text).toContain("    (no changes)");
    expect(text).toContain("    (document gone)");
    expect(text).toContain("    (document created)");
    // The long value is cut to one short line.
    expect(text).toMatch(/\+ note: "x+…\n/);
    expect(run.stderr).toContain("Searched 5 backups of app.users and no journal (none exists).");
  });

  it("shows field changes between consecutive versions", async () => {
    const store = await newStore();
    await store.write("2026-02-01T00:00:00Z", [{ _id: "ada", name: "Ada", fax: "1" }]);
    await store.write("2026-02-02T00:00:00Z", [{ _id: "ada", name: "Ada L.", phone: "2" }]);
    const run = await runTestCli(["history", "app.users", '"ada"', "--from", store.url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('~ name: "Ada" → "Ada L."');
    expect(run.stdout).toContain('- fax: "1"');
    expect(run.stdout).toContain('+ phone: "2"');
  });

  it("says so when no backup holds the document, and when the journal is skipped", async () => {
    const store = await newStore();
    const run = await runTestCli([
      "history",
      "app.users",
      "1",
      "--from",
      store.url,
      "--skip-journal",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe("No version of this document was found.\n");
    expect(run.stderr).toContain(
      "Searched 0 backups of app.users and no journal (--skip-journal).",
    );
  });

  it("only searches as many backups as --backups says", async () => {
    const store = await newStore();
    await store.write("2026-03-01T00:00:00Z", [{ _id: 1 }]);
    await store.write("2026-03-02T00:00:00Z", [{ _id: 1 }]);
    const run = await runTestCli([
      "history",
      "app.users",
      "1",
      "--from",
      store.url,
      "--backups",
      "1",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("Searched 1 backup of app.users");
  });

  it("prints one canonical Extended JSON document with --json", async () => {
    const store = await newStore();
    await store.write("2026-04-01T00:00:00Z", [{ _id: 1, n: 1.5 }]);
    const run = await runTestCli(["history", "app.users", "1", "--from", store.url, "--json"]);
    expect(run.code, run.stderr).toBe(0);
    const history = run.json<{ namespace: string; versions: { document: unknown }[] }>();
    expect(history.namespace).toBe("app.users");
    expect(history.versions[0]?.document).toEqual({
      _id: { $numberInt: "1" },
      n: { $numberDouble: "1.5" },
    });
    expect(run.stderr).toBe("");
  });
});
