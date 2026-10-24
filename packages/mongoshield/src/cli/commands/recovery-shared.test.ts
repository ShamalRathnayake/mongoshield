// The recovery commands (history, diff, find, export --format jsonl) on encrypted
// in-memory backups: --identity-file and --passphrase-env unlock them, and without a
// key the error says what is missing, never printing the passphrase.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { generateIdentity } from "../../crypto/index.ts";
import { resolveStorage } from "../../storage/resolve.ts";

const PASSPHRASE = "correct horse battery staple";
const recipientStore = `memory://recovery-recipient-${randomUUID()}`;
const passphraseStore = `memory://recovery-passphrase-${randomUUID()}`;
let cwd: string;
let identityFile: string;
let firstId: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mongoshield-recovery-shared-"));
  const { identity, recipient } = generateIdentity();
  identityFile = join(cwd, "backup.key");
  await writeFile(identityFile, `${identity}\n`, { mode: 0o600 });

  const storage = await resolveStorage(recipientStore);
  const first = await writeTestBackup(storage, {
    recipients: [recipient],
    startedAt: new Date("2026-07-01T00:00:00Z"),
    namespaces: [{ ns: "app.users", documents: [{ _id: 1, name: "Ada" }] }],
  });
  firstId = first.id;
  await writeTestBackup(storage, {
    recipients: [recipient],
    startedAt: new Date("2026-07-02T00:00:00Z"),
    namespaces: [{ ns: "app.users", documents: [{ _id: 1, name: "Ada L." }] }],
  });
  await writeTestBackup(await resolveStorage(passphraseStore), {
    passphrase: PASSPHRASE,
    namespaces: [{ ns: "app.users", documents: [{ _id: 1, name: "Ada" }] }],
  });
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("recovery commands on encrypted backups", () => {
  it("history decrypts with --identity-file", async () => {
    const run = await runTestCli(
      ["history", "app.users", "1", "--from", recipientStore, "--identity-file", identityFile],
      { cwd },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('~ name: "Ada" → "Ada L."');
  });

  it("diff decrypts with --identity-file", async () => {
    const run = await runTestCli(
      ["diff", firstId, "--from", recipientStore, "--identity-file", "backup.key"],
      { cwd },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/app\.users\s+1 → 1\s+0\s+0\s+1/);
  });

  it("find decrypts with --passphrase-env, and never prints the passphrase", async () => {
    const run = await runTestCli(
      ["find", "app.users", "--from", passphraseStore, "--passphrase-env", "BACKUP_PASSPHRASE"],
      { cwd, env: { BACKUP_PASSPHRASE: PASSPHRASE } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('"name": "Ada"');
    expect(run.stdout + run.stderr).not.toContain(PASSPHRASE);
  });

  it("export --format jsonl decrypts with --passphrase-env", async () => {
    const run = await runTestCli(
      [
        "export",
        "--from",
        passphraseStore,
        "--format",
        "jsonl",
        "--namespace",
        "app.users",
        "--output",
        "-",
        "--passphrase-env",
        "BACKUP_PASSPHRASE",
      ],
      { cwd, env: { BACKUP_PASSPHRASE: PASSPHRASE } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('{"_id":1,"name":"Ada"}\n');
  });

  it("explains a wrong passphrase without printing it", async () => {
    const wrong = "not the passphrase at all";
    const run = await runTestCli(
      ["find", "app.users", "--from", passphraseStore, "--passphrase-env", "BACKUP_PASSPHRASE"],
      { cwd, env: { BACKUP_PASSPHRASE: wrong } },
    );
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("✖ MS_");
    expect(run.stderr).not.toContain(wrong);
  });

  it("explains that a key is needed when none is given", async () => {
    const run = await runTestCli(["history", "app.users", "1", "--from", recipientStore], { cwd });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("✖ MS_");
    expect(run.stderr).toContain("hint");
  });
});
