// `mongoshield verify` against an in-memory store: intact and damaged backups, fast and
// deep mode, keys from files and passphrases from the environment, and --json.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  flipByte,
  replaceStoredFile,
  writeTestBackup,
} from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { namedMemoryStore } from "../../../test/helpers/cli-backups.ts";
import { generateIdentity } from "../../crypto/index.ts";
import { identityFileText } from "./keygen.ts";

const documents = [
  { _id: 1, name: "Ada" },
  { _id: 2, name: "Grace" },
];

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-verify-cli-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A store holding one backup whose first data file has a flipped byte. */
async function damagedBackup() {
  const store = await namedMemoryStore();
  const manifest = await writeTestBackup(store.storage, {
    namespaces: [{ ns: "app.users", documents }],
  });
  const file = manifest.namespaces[0]?.files[0];
  if (!file) throw new Error("fixture has no data file");
  await replaceStoredFile(store.storage, manifest, file.key, (bytes) => flipByte(bytes, -2));
  return { ...store, manifest };
}

describe("mongoshield verify", () => {
  it("reports an intact backup in fast mode (exit 0)", async () => {
    const { url, storage } = await namedMemoryStore();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents }],
    });
    const run = await runTestCli(["verify", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(
      new RegExp(`✔ Backup ${manifest.id} is intact: \\d+ files, .* checked \\(fast\\) in `),
    );
    expect(run.stdout).not.toContain("document");
  });

  it("counts documents in deep mode", async () => {
    const { url, storage } = await namedMemoryStore();
    await writeTestBackup(storage, { namespaces: [{ ns: "app.users", documents }] });
    const run = await runTestCli(["verify", "latest", "--deep", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("2 documents checked (deep)");
  });

  it("lists each problem and exits with 33 (MS_INTEGRITY_FAILED) for a damaged backup", async () => {
    const { url, manifest } = await damagedBackup();
    const run = await runTestCli(["verify", manifest.id, "--from", url]);
    expect(run.code).toBe(33);
    expect(run.stdout).toMatch(new RegExp(`✖ Backup ${manifest.id} has 1 problem: `));
    expect(run.stdout).toMatch(/ {2}• .+: .+/);
    expect(run.stderr).toContain("Do not rely on this backup. Exit code 33 (MS_INTEGRITY_FAILED).");
  });

  it("prints the failed report as one JSON document, still exiting with 33", async () => {
    const { url, manifest } = await damagedBackup();
    const run = await runTestCli(["verify", "--from", url, "--json"]);
    expect(run.code).toBe(33);
    const report = run.json<{ ok: boolean; backupId: string; problems: unknown[] }>();
    expect(report).toMatchObject({ ok: false, backupId: manifest.id });
    expect(report.problems).toHaveLength(1);
    expect(run.stderr).toBe("");
  });

  it("decrypts deep checks with --passphrase-env, keeping the passphrase out of the output", async () => {
    const { url, storage } = await namedMemoryStore();
    const passphrase = "correct horse battery staple";
    await writeTestBackup(storage, { namespaces: [{ ns: "app.users", documents }], passphrase });

    const run = await runTestCli(
      ["verify", "--deep", "--from", url, "--passphrase-env", "BACKUP_PASS"],
      { env: { BACKUP_PASS: passphrase } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("2 documents checked (deep)");

    const wrong = await runTestCli(
      ["verify", "--deep", "--from", url, "--passphrase-env", "BACKUP_PASS", "--verbose"],
      { env: { BACKUP_PASS: "not it" } },
    );
    expect(wrong.code).not.toBe(0);
    expect(wrong.stdout + wrong.stderr).not.toContain("not it");
  });

  it("refuses an unset --passphrase-env variable before reading anything (exit 2)", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["verify", "--from", url, "--passphrase-env", "NOPE"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "The environment variable NOPE (from --passphrase-env) is not set",
    );
  });

  it("decrypts deep checks with --identity-file", async () => {
    const { url, storage } = await namedMemoryStore();
    const { identity, recipient } = generateIdentity();
    await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents }],
      recipients: [recipient],
    });
    const keyFile = join(workDir, "verify.key");
    await writeFile(keyFile, identityFileText(identity, recipient), { mode: 0o600 });

    const run = await runTestCli(["verify", "--deep", "--from", url, "--identity-file", keyFile]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("2 documents checked (deep)");
    expect(run.stdout + run.stderr).not.toContain(identity);
  });

  it("draws and clears a live progress line on a terminal", async () => {
    const { url, storage } = await namedMemoryStore();
    await writeTestBackup(storage, { namespaces: [{ ns: "app.users", documents }] });
    const run = await runTestCli(["verify", "--from", url], { isTTY: true });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("Verifying…");
    // The live line is erased again ("\r" + erase line) before the result.
    expect(run.stderr.endsWith("\r\u001b[2K")).toBe(true);
  });

  it("passes --drill on to the drill command, which needs a scratch target", async () => {
    const { url } = await namedMemoryStore();
    const run = await runTestCli(["verify", "--drill", "--from", url]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("pass --target-uri");
  });
});
