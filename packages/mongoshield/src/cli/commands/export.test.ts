// `mongoshield export` (mongodump directory and archive) from an in-memory store:
// flag checks, filters, gzip, encrypted backups, stdout streaming and --json.

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { namedMemoryStore } from "../../../test/helpers/cli-backups.ts";
import { generateIdentity } from "../../crypto/index.ts";
import { identityFileText } from "./keygen.ts";

/** The magic number every mongodump archive starts with (0x8199e26d, little-endian). */
const ARCHIVE_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81]);

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-export-cli-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function twoDatabaseBackup(options: { passphrase?: string; recipients?: string[] } = {}) {
  const store = await namedMemoryStore();
  const manifest = await writeTestBackup(store.storage, {
    namespaces: [
      { ns: "app.users", documents: [{ _id: 1, name: "Ada" }] },
      { ns: "app.audit", documents: [{ _id: 1 }] },
      { ns: "crm.leads", documents: [{ _id: 1 }] },
    ],
    ...options,
  });
  return { ...store, manifest };
}

describe("mongoshield export", () => {
  it.each([
    [[], "Where to? Pass --output <directory>"],
    [["--output", ""], "Where to? Pass --output <directory>"],
    [["--output", "-"], "--output - (stdout) needs --format archive"],
    [
      ["--output", "-", "--format", "archive", "--json"],
      "--json cannot be combined with --output -",
    ],
    [["--output", "x", "--fields", "a"], "--fields needs --format jsonl or csv."],
  ])("rejects %j with exit code 2", async (flags, message) => {
    const { url } = await twoDatabaseBackup();
    const run = await runTestCli(["export", "--from", url, ...flags], { cwd: workDir });
    expect(run.code).toBe(2);
    // With --json the error is the JSON document on stdout.
    expect(run.stdout + run.stderr).toContain(message);
    expect(run.stdout + run.stderr).toContain("mongoshield export --help");
  });

  it("writes a mongodump directory with --include/--exclude and says how to restore it", async () => {
    const { url, manifest } = await twoDatabaseBackup();
    const run = await runTestCli(
      [
        "export",
        "--from",
        url,
        "--output",
        "dump-filtered",
        "--include",
        "app.*",
        "--exclude",
        "app.audit",
      ],
      { cwd: workDir },
    );
    expect(run.code, run.stderr).toBe(0);
    const output = join(workDir, "dump-filtered");
    const databases = await readdir(output);
    expect(databases).toContain("app");
    expect(databases).not.toContain("crm");
    const files = await readdir(join(output, "app"));
    expect(files).toContain("users.bson");
    expect(files).not.toContain("audit.bson");
    expect(run.stdout).toContain(manifest.id);
    expect(run.stdout).toMatch(/Format\s+directory\n/);
    expect(run.stderr).toContain("✔ Export complete.");
    expect(run.stderr).toContain(`Restore with: mongorestore --uri <target> --dir ${output}`);
  });

  it("gzips the directory with --gzip, and the restore hint says --gzip", async () => {
    const { url } = await twoDatabaseBackup();
    const output = join(workDir, "dump-gzip");
    const run = await runTestCli(["export", "--from", url, "--output", output, "--gzip"]);
    expect(run.code, run.stderr).toBe(0);
    expect(await readdir(join(output, "app"))).toContain("users.bson.gz");
    expect(run.stdout).toMatch(/Format\s+directory \(gzip\)/);
    expect(run.stderr).toContain("mongorestore --uri <target> --gzip --dir");
  });

  it("writes a gzipped archive file and prints the summary as JSON", async () => {
    const { url, manifest } = await twoDatabaseBackup();
    const output = join(workDir, "app.archive.gz");
    const run = await runTestCli([
      "export",
      "--from",
      url,
      "--format",
      "archive",
      "--gzip",
      "--output",
      output,
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({ backupId: manifest.id, format: "archive", gzip: true });
    const archive = gunzipSync(await readFile(output));
    expect(archive.subarray(0, 4)).toEqual(ARCHIVE_MAGIC);
  });

  it("names the archive in the restore hint", async () => {
    const { url } = await twoDatabaseBackup();
    const output = join(workDir, "plain.archive");
    const run = await runTestCli([
      "export",
      "--from",
      url,
      "--format",
      "archive",
      "--output",
      output,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(`mongorestore --uri <target> --archive=${output}`);
    expect((await stat(output)).size).toBeGreaterThan(0);
  });

  it("streams an archive to stdout and keeps every message on stderr", async () => {
    const { url } = await twoDatabaseBackup();
    const run = await runTestCli([
      "export",
      "--from",
      url,
      "--format",
      "archive",
      "--output",
      "-",
      "--include",
      "crm.*",
    ]);
    expect(run.code, run.stderr).toBe(0);
    // stdout holds only the archive (collected as text here, so check its start loosely).
    expect(run.stdout.length).toBeGreaterThan(0);
    expect(run.stdout).not.toContain("Export complete");
    expect(run.stderr).toContain("→ stdout");
    expect(run.stderr).toMatch(/Output\s+stdout/);
    expect(run.stderr).not.toContain("Restore with:");
  });

  it("decrypts with --passphrase-env and with --identity-file", async () => {
    const passphrase = "export passphrase";
    const withPassphrase = await twoDatabaseBackup({ passphrase });
    const first = await runTestCli(
      [
        "export",
        "--from",
        withPassphrase.url,
        "--output",
        join(workDir, "dump-passphrase"),
        "--passphrase-env",
        "PASS",
      ],
      { env: { PASS: passphrase } },
    );
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout + first.stderr).not.toContain(passphrase);

    const { identity, recipient } = generateIdentity();
    const withKey = await twoDatabaseBackup({ recipients: [recipient] });
    const keyFile = join(workDir, "export.key");
    await writeFile(keyFile, identityFileText(identity, recipient), { mode: 0o600 });
    const second = await runTestCli([
      "export",
      "--from",
      withKey.url,
      "--output",
      join(workDir, "dump-identity"),
      "--identity-file",
      keyFile,
    ]);
    expect(second.code, second.stderr).toBe(0);
    expect(await readdir(join(workDir, "dump-identity"))).toEqual(
      expect.arrayContaining(["app", "crm"]),
    );
  });

  it("fails without the key for an encrypted backup, with a hint", async () => {
    const { url } = await twoDatabaseBackup({ passphrase: "secret words" });
    const run = await runTestCli(["export", "--from", url, "--output", join(workDir, "nokey")]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("hint");
    expect(run.stderr).toContain("docs");
  });
});
