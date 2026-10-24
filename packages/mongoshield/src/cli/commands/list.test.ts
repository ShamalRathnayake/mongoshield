// `mongoshield list` against an in-memory store: empty storage, the table with complete,
// incomplete and invalid backups, and the --json document.

import { describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import {
  namedMemoryStore,
  writeIncompleteBackup,
  writeInvalidBackup,
} from "../../../test/helpers/cli-backups.ts";

describe("mongoshield list", () => {
  it("says how to create the first backup when storage is empty", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["list", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`No backups in ${url} yet. Create one with: mongoshield backup`);
  });

  it("prints an empty JSON array with --json", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["list", "--from", url, "--json"]);
    expect(run.code).toBe(0);
    expect(run.json()).toEqual([]);
    expect(run.stderr).toBe("");
  });

  it("lists complete, incomplete and invalid backups, newest first, with dashes for unknown totals", async () => {
    const { url, storage } = await namedMemoryStore();
    const complete = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }, { _id: 2 }] }],
      startedAt: new Date(Date.now() - 3 * 3_600_000),
    });
    const incomplete = await writeIncompleteBackup(storage, new Date(Date.now() - 2 * 3_600_000));
    const invalid = await writeInvalidBackup(storage, new Date(Date.now() - 3_600_000));

    const run = await runTestCli(["list", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+CREATED\s+STATUS\s+KIND\s+NS\s+DOCUMENTS\s+SIZE\s+ENCRYPTED/);
    // Newest first: invalid (1h ago), incomplete (2h), complete (3h).
    expect(lines[1]).toContain(invalid);
    expect(lines[2]).toContain(incomplete);
    expect(lines[3]).toContain(complete.id);
    expect(lines[1]).toContain("–");
    expect(lines[3]).toMatch(/complete\s+full\s+1\s+2\s/);
    // The footer counts complete backups and goes to stderr.
    expect(run.stderr).toContain("3 backups (1 complete)");
    expect(run.stderr).toContain(`in ${url}`);
  });

  it("prints every catalog entry, manifests included, as one JSON document", async () => {
    const { url, storage } = await namedMemoryStore();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
    });
    const run = await runTestCli(["list", "--from", url, "--json"]);
    expect(run.code).toBe(0);
    const entries = run.json<{ id: string; status: string; manifest: { id: string } }[]>();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: manifest.id, status: "complete" });
    expect(entries[0]?.manifest.id).toBe(manifest.id);
  });

  it("explains unknown storage schemes with exit code 2", async () => {
    const run = await runTestCli(["list", "--from", "ftp://example.com/backups"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("docs");
  });
});
