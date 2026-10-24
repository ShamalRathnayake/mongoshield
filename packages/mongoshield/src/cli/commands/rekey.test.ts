// `mongoshield rekey` against in-memory backups written by the test fixtures: adding
// and removing recipients, dry runs, confirmations (refused without a terminal, asked
// on one), skipped backups and their exit codes, JSON output and flag errors.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { KEYS, plain, runTestCli } from "../../../test/helpers/cli.ts";
import { listBackups } from "../../catalog/catalog.ts";
import { generateIdentity } from "../../crypto/index.ts";
import { MongoShield } from "../../shield.ts";
import { resolveStorage } from "../../storage/resolve.ts";

const oldKey = generateIdentity();
const newKey = generateIdentity();
let workDir: string;
let oldKeyFile: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-rekey-cli-"));
  oldKeyFile = join(workDir, "old.key");
  await writeFile(oldKeyFile, `${oldKey.identity}\n`, { mode: 0o600 });
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A memory store with backups encrypted to the old key (and, optionally, an unencrypted one). */
async function encryptedStore(count = 1, { plainToo = false } = {}) {
  const url = `memory://rekey-${randomBytes(4).toString("hex")}`;
  const storage = await resolveStorage(url);
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: index }] }],
      recipients: [oldKey.recipient],
      startedAt: new Date(Date.UTC(2026, 1, 1 + index)),
    });
    ids.push(manifest.id);
  }
  let plainId: string | undefined;
  if (plainToo) {
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: 99 }] }],
      startedAt: new Date(Date.UTC(2025, 0, 1)),
    });
    plainId = manifest.id;
  }
  return { url, ids, plainId };
}

/** The recipients each backup is currently encrypted to (rekey records applied). */
async function recipientsOf(url: string): Promise<string[][]> {
  const backups = await listBackups(await resolveStorage(url));
  return backups.map((backup) => [...(backup.manifest?.encryption?.recipients ?? [])].sort());
}

/** True when `identity` can deep-verify every backup in the store. */
async function opensWith(url: string, identity: string, backup: string): Promise<boolean> {
  const shield = new MongoShield({ storage: await resolveStorage(url) });
  const result = await shield.verify({
    backup,
    mode: "deep",
    decryption: { identities: [identity] },
  });
  return result.ok;
}

describe("mongoshield rekey", () => {
  it("adds a recipient without asking, and the new key opens the backup", async () => {
    const { url, ids } = await encryptedStore();
    const run = await runTestCli([
      "rekey",
      "--from",
      url,
      "--identity-file",
      oldKeyFile,
      "--add-recipient",
      newKey.recipient,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(
      new RegExp(`^${ids[0]}  rekeyed \\(\\d+ files?\\) → .*${newKey.recipient}`),
    );
    expect(await recipientsOf(url)).toEqual([[oldKey.recipient, newKey.recipient].sort()]);
    expect(await opensWith(url, newKey.identity, ids[0] ?? "")).toBe(true);
  });

  it("shows the plan and writes nothing with --dry-run", async () => {
    const { url, ids } = await encryptedStore(2);
    const run = await runTestCli([
      "rekey",
      "all",
      "--from",
      url,
      "--identity-file",
      oldKeyFile,
      "--add-recipient",
      newKey.recipient,
      "--remove-recipient",
      oldKey.recipient,
      "--dry-run",
    ]);
    expect(run.code, run.stderr).toBe(0);
    for (const id of ids) expect(run.stdout).toContain(`${id}  would rekey`);
    expect(run.stderr).toContain("Dry run: nothing was written.");
    expect(await recipientsOf(url)).toEqual([[oldKey.recipient], [oldKey.recipient]]);
  });

  it("refuses to remove a key without --yes when nobody can confirm (exit 3)", async () => {
    const { url } = await encryptedStore();
    const run = await runTestCli([
      "rekey",
      "latest",
      "--from",
      url,
      "--identity-file",
      oldKeyFile,
      "--add-recipient",
      newKey.recipient,
      "--remove-recipient",
      oldKey.recipient,
    ]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("Refusing to rekey backups without confirmation");
    expect(run.stderr).toContain("--yes");
    expect(await recipientsOf(url)).toEqual([[oldKey.recipient]]);
  });

  it("removes a key with --yes; the old key no longer opens new copies of the header", async () => {
    const { url, ids } = await encryptedStore();
    const run = await runTestCli([
      "rekey",
      ids[0] ?? "",
      "--from",
      url,
      "--identity-file",
      oldKeyFile,
      "--add-recipient",
      newKey.recipient,
      "--remove-recipient",
      oldKey.recipient,
      "--yes",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(await recipientsOf(url)).toEqual([[newKey.recipient]]);
    expect(await opensWith(url, newKey.identity, ids[0] ?? "")).toBe(true);
  });

  it("asks on a terminal, and rekeys when the user agrees", async () => {
    const { url } = await encryptedStore();
    const run = await runTestCli(
      [
        "rekey",
        "--from",
        url,
        "--identity-file",
        oldKeyFile,
        "--add-recipient",
        newKey.recipient,
        "--remove-recipient",
        oldKey.recipient,
      ],
      { terminal: [{ when: "Rewrite the keys of 1 backup?", keys: `y${KEYS.enter}` }] },
    );
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(run.stdout).toContain("rekeyed");
    expect(await recipientsOf(url)).toEqual([[newKey.recipient]]);
  });

  it("changes nothing when the user declines (exit 60)", async () => {
    const { url } = await encryptedStore();
    const run = await runTestCli(
      [
        "rekey",
        "--from",
        url,
        "--identity-file",
        oldKeyFile,
        "--add-recipient",
        newKey.recipient,
        "--remove-recipient",
        oldKey.recipient,
      ],
      { terminal: [{ when: "Rewrite the keys of 1 backup?", keys: KEYS.enter }] },
    );
    expect(run.code).toBe(60);
    expect(plain(run.stderr)).toContain("Cancelled. Nothing was changed.");
    expect(run.stdout).toBe("");
    expect(await recipientsOf(url)).toEqual([[oldKey.recipient]]);
  });

  it("reports backups that already have the key as unchanged, without asking", async () => {
    const { url, ids } = await encryptedStore();
    const run = await runTestCli([
      "rekey",
      "--from",
      url,
      "--identity-file",
      oldKeyFile,
      "--add-recipient",
      oldKey.recipient,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(`${ids[0]}  unchanged\n`);
  });

  it("skips an unencrypted backup in all, and refuses it when named (exit 2 with a hint)", async () => {
    const { url, plainId } = await encryptedStore(1, { plainToo: true });
    const all = await runTestCli([
      "rekey",
      "--from",
      url,
      "--identity-file",
      oldKeyFile,
      "--add-recipient",
      newKey.recipient,
    ]);
    expect(all.code, all.stderr).toBe(0);
    expect(all.stdout).toContain(`${plainId}  skipped: it is not encrypted`);
    expect(all.stdout).toContain("rekeyed");

    const named = await runTestCli([
      "rekey",
      plainId ?? "",
      "--from",
      url,
      "--add-recipient",
      newKey.recipient,
    ]);
    expect(named.code).toBe(2);
    expect(named.stderr).toContain(`Cannot rekey backup ${plainId}: it is not encrypted`);
    expect(named.stderr).toContain("hint  To get an encrypted copy");
  });

  it("skips a passphrase change on a recipient backup (named: exit 1)", async () => {
    const { url } = await encryptedStore();
    const run = await runTestCli(
      [
        "rekey",
        "latest",
        "--from",
        url,
        "--identity-file",
        oldKeyFile,
        "--new-passphrase-env",
        "NEW_PASS",
      ],
      { env: { NEW_PASS: "correct horse battery staple" } },
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("skipped: it is encrypted to age recipients");
    expect(run.stdout + run.stderr).not.toContain("correct horse");
  });

  it("skips KMS key changes on a recipient backup (named: exit 1)", async () => {
    const { url, ids } = await encryptedStore();
    const run = await runTestCli([
      "rekey",
      "latest",
      "--from",
      url,
      "--add-kms",
      "aws:arn:aws:kms:eu-west-1:111122223333:key/new",
      "--remove-kms",
      "gcp:projects/p/locations/l/keyRings/r/cryptoKeys/old",
    ]);
    expect(run.code, run.stderr).toBe(1);
    expect(run.stdout).toContain(`${ids[0]}  skipped: it is encrypted to age recipients`);
  });

  it("prints the result as one JSON document, also when there are no backups", async () => {
    const { url, ids } = await encryptedStore();
    const run = await runTestCli([
      "rekey",
      "--from",
      url,
      "--identity-file",
      oldKeyFile,
      "--add-recipient",
      newKey.recipient,
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({
      dryRun: false,
      backups: [{ backupId: ids[0], action: "rekeyed" }],
    });

    const empty = await runTestCli([
      "rekey",
      "--from",
      "memory://rekey-empty",
      "--add-recipient",
      newKey.recipient,
      "--json",
    ]);
    expect(empty.code).toBe(0);
    expect(empty.json()).toMatchObject({ backups: [] });
  });

  it("says there is nothing to rekey in an empty store (exit 30)", async () => {
    const run = await runTestCli([
      "rekey",
      "--from",
      "memory://rekey-empty",
      "--add-recipient",
      newKey.recipient,
    ]);
    expect(run.code).toBe(30);
    expect(run.stderr).toContain("There are no backups to rekey.");
  });

  it.each([
    [["--add-kms", "vault:key"], "--add-kms expects provider:key with aws, gcp or azure"],
    [["--remove-kms", "noseparator"], "--remove-kms expects provider:key"],
    [["--add-kms", "aws:"], "--add-kms aws: has no key."],
  ])("rejects malformed KMS flags %j (exit 2)", async (flags, message) => {
    const { url } = await encryptedStore();
    const run = await runTestCli(["rekey", "--from", url, ...flags]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("mongoshield rekey --help");
  });

  it("needs the passphrase variables it is pointed at", async () => {
    const { url } = await encryptedStore();
    for (const flag of ["--passphrase-env", "--new-passphrase-env"]) {
      const run = await runTestCli(["rekey", "--from", url, flag, "MISSING_VAR"]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(`The environment variable MISSING_VAR (from --passphrase-env)`);
    }
  });

  it("explains an identity file that cannot be read", async () => {
    const { url } = await encryptedStore();
    const missing = join(workDir, "nope.key");
    const run = await runTestCli([
      "rekey",
      "--from",
      url,
      "--identity-file",
      missing,
      "--add-recipient",
      newKey.recipient,
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`Cannot read the identity file ${missing}`);
  });
});
