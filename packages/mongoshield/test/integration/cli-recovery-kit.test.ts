/**
 * `mongoshield restore` with the recovery kit (src/cli/recovery-kit.ts): an
 * encrypted backup restores without --identity-file when the storage location holds
 * a kit, with the passphrase from MONGOSHIELD_RECOVERY_PASSPHRASE or typed at a
 * prompt, and fails clearly when neither is available or the passphrase is wrong.
 * Unencrypted backups never ask for it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { writeRecoveryKit } from "../../src/crypto/recovery-kit.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { KEYS, runTestCli } from "../helpers/cli.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const PASSPHRASE = "correct horse battery staple";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-kit-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Seeds a small collection and backs it up, encrypted to `recipient` when given. */
async function seededBackup(dbName: string, storage: string, recipient?: string): Promise<string> {
  await client()
    .db(dbName)
    .collection("users")
    .insertMany(
      Array.from({ length: 20 }, (_, index) => ({ _id: index, name: `user ${index}` })) as never,
    );
  const run = await runTestCli(
    [
      "backup",
      "--uri",
      mongoUri(),
      "--to",
      storage,
      "--include",
      `${dbName}.*`,
      "--quiet",
      ...(recipient ? ["--recipient", recipient] : []),
    ],
    { cwd: workDir },
  );
  expect(run.code, run.stderr).toBe(0);
  return run.stdout.trim();
}

/** Restore arguments that write next to the source under `<db>_r<suffix>`. */
function restoreArgs(id: string, storage: string, dbName: string, suffix: string): string[] {
  return [
    "restore",
    id,
    "--from",
    storage,
    "--to-uri",
    mongoUri(),
    "--rename",
    `${dbName}.*=${dbName}_r${suffix}.*`,
  ];
}

async function countOf(dbName: string): Promise<number> {
  return client().db(dbName).collection("users").countDocuments();
}

describe("restore with the recovery kit", () => {
  const dbName = uniqueDb("kit");
  let storage: string;
  let id: string;

  beforeAll(async () => {
    storage = await mkdtemp(join(workDir, "storage-"));
    const key = generateIdentity();
    id = await seededBackup(dbName, storage, key.recipient);
    await writeRecoveryKit(fileStorage({ path: storage }), {
      identity: key.identity,
      passphrase: PASSPHRASE,
      scryptWorkFactor: 10,
    });
  });

  it("uses the kit with the passphrase from MONGOSHIELD_RECOVERY_PASSPHRASE", async () => {
    const run = await runTestCli(restoreArgs(id, storage, dbName, "env"), {
      cwd: workDir,
      env: { MONGOSHIELD_RECOVERY_PASSPHRASE: PASSPHRASE },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("using the recovery kit");
    expect(run.stderr).not.toContain(PASSPHRASE);
    expect(await countOf(`${dbName}_renv`)).toBe(20);
  });

  it("asks for the passphrase on a terminal", async () => {
    const run = await runTestCli(restoreArgs(id, storage, dbName, "tty"), {
      cwd: workDir,
      terminal: [{ when: "Recovery kit passphrase", keys: `${PASSPHRASE}${KEYS.enter}` }],
    });
    expect(run.code, run.stderr).toBe(0);
    expect(await countOf(`${dbName}_rtty`)).toBe(20);
  });

  it("fails with MS_NO_IDENTITY and a hint without a terminal or the variable", async () => {
    const run = await runTestCli(restoreArgs(id, storage, dbName, "none"), { cwd: workDir });
    expect(run.code).toBe(42);
    expect(run.stderr).toContain("MS_NO_IDENTITY");
    expect(run.stderr).toContain("MONGOSHIELD_RECOVERY_PASSPHRASE");
  });

  it("fails with MS_DECRYPTION_FAILED for a wrong passphrase", async () => {
    const wrong = "not the right passphrase";
    const run = await runTestCli(restoreArgs(id, storage, dbName, "wrong"), {
      cwd: workDir,
      env: { MONGOSHIELD_RECOVERY_PASSPHRASE: wrong },
    });
    expect(run.stderr).toContain("MS_DECRYPTION_FAILED");
    expect(run.stderr).not.toContain(wrong);
    expect(run.code).not.toBe(0);
  });
});

describe("restore of an unencrypted backup next to a kit", () => {
  const dbName = uniqueDb("kitplain");

  it("does not ask for the kit passphrase", async () => {
    const storage = await mkdtemp(join(workDir, "storage-"));
    const id = await seededBackup(dbName, storage);
    await writeRecoveryKit(fileStorage({ path: storage }), {
      identity: generateIdentity().identity,
      passphrase: PASSPHRASE,
      scryptWorkFactor: 10,
    });
    const run = await runTestCli(restoreArgs(id, storage, dbName, "plain"), { cwd: workDir });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toContain("recovery kit");
    expect(await countOf(`${dbName}_rplain`)).toBe(20);
  });
});
