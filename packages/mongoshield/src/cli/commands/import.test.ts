// `mongoshield import` into an in-memory store, from the mongodump fixtures: directories,
// one-database directories, archives (file and stdin, gzipped or not), encryption,
// labels, --dumped-at, --json and --quiet, and every flag mistake.

import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { namedMemoryStore } from "../../../test/helpers/cli-backups.ts";
import { generateIdentity } from "../../crypto/index.ts";

const FIXTURES = fileURLToPath(new URL("../../../test/fixtures/mongodump/", import.meta.url));

interface ImportJson {
  id: string;
  manifest: {
    compression: string;
    labels: Record<string, string>;
    completedAt: string;
    encryption: { recipients: string[] } | null;
    namespaces: { ns: string }[];
  };
}

describe("mongoshield import", () => {
  it("imports a dump directory and prints a summary with the next step", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["import", "dump", "--to", url], { cwd: FIXTURES });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(`Importing dump → ${url}`);
    expect(run.stderr).toContain("✔ Import complete.");
    expect(run.stdout).toMatch(/Backup id\s+\d{4}-/);
    expect(run.stdout).toMatch(/Skipped\s+\d+ namespace/);
    expect(run.stderr).toMatch(/Next: mongoshield verify \S+ --deep/);
  });

  it("prints only the id with --quiet", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["import", `${FIXTURES}dump`, "--to", url, "--quiet"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f]{6}$/);
  });

  it("imports one database's directory under --database, with labels, --dumped-at and gzip compression", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli([
      "import",
      `${FIXTURES}dump/app`,
      "--database",
      "restored",
      "--to",
      url,
      "--compression",
      "gzip",
      "--label",
      "source=legacy",
      "--dumped-at",
      "2026-01-31T02:00:00Z",
      "--include",
      "restored.*",
      "--exclude",
      "restored.capped",
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<ImportJson>();
    expect(result.manifest.compression).toBe("gzip");
    expect(result.manifest.labels).toMatchObject({ source: "legacy" });
    expect(result.manifest.completedAt).toBe("2026-01-31T02:00:00.000Z");
    const namespaces = result.manifest.namespaces.map((entry) => entry.ns);
    expect(namespaces).toContain("restored.users");
    expect(namespaces).not.toContain("restored.capped");
  });

  it("imports an archive file (gzip detected) encrypted for a recipient", async () => {
    const { url } = await namedMemoryStore();
    const { recipient } = generateIdentity();
    const run = await runTestCli([
      "import",
      `${FIXTURES}app.archive.gz`,
      "--to",
      url,
      "--recipient",
      recipient,
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.json<ImportJson>().manifest.encryption?.recipients).toEqual([recipient]);
  });

  it("reads an archive from stdin with --gzip, encrypted with a passphrase from the environment", async () => {
    const { url } = await namedMemoryStore();
    const passphrase = "import passphrase words";
    const run = await runTestCli(
      ["import", "-", "--gzip", "--to", url, "--passphrase-env", "PASS", "--json"],
      { stdin: createReadStream(`${FIXTURES}app.archive.gz`), env: { PASS: passphrase } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.json<ImportJson>().manifest.encryption?.recipients).toEqual(["scrypt"]);
    expect(run.stdout + run.stderr).not.toContain(passphrase);
  });

  it("says where the archive comes from when it is stdin", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["import", "-", "--to", url], {
      stdin: createReadStream(`${FIXTURES}app.archive`),
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(`Importing archive from stdin → ${url}`);
  });

  it.each([
    [["import", "--to", "memory://x"], "Which dump? Pass the mongodump directory or archive file."],
    [["import", "-", "--to", "memory://x"], "There is no standard input to read the archive from."],
    [["import", "missing-dir", "--to", "memory://x"], "Cannot read"],
    [
      ["import", "dump", "--to", "memory://x", "--dumped-at", "yesterday"],
      '--dumped-at expects a date such as 2026-01-31T02:00:00Z (got "yesterday").',
    ],
    [
      ["import", "dump", "--to", "memory://x", "--recipient", "age1x", "--passphrase-env", "P"],
      "--recipient and --passphrase-env cannot be combined.",
    ],
    [["import", "dump", "--to", "memory://x", "--label", "novalue"], "--label expects key=value"],
  ])("rejects %j with exit code 2", async (args, message) => {
    const run = await runTestCli(args, { cwd: FIXTURES });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("docs  https://");
  });

  it("rejects an invalid recipient before reading the dump", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["import", "dump", "--to", url, "--recipient", "age1nope"], {
      cwd: FIXTURES,
    });
    expect(run.code).toBe(2);
    const list = await runTestCli(["list", "--from", url, "--json"]);
    expect(list.json<unknown[]>()).toEqual([]);
  });
});
