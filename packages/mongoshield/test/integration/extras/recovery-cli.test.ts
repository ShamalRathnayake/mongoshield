/**
 * The recovery CLI commands (snapshot, rollback, erase, erasures, replicate, rekey),
 * driven through `runCli` with in-memory streams against the test replica set and file
 * storage in a temporary directory.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommandSpec } from "../../../src/cli/command.ts";
import { eraseCommand } from "../../../src/cli/commands/erase.ts";
import { erasuresCommand } from "../../../src/cli/commands/erasures.ts";
import { COMMANDS, findCommand } from "../../../src/cli/commands/index.ts";
import { rekeyCommand } from "../../../src/cli/commands/rekey.ts";
import { replicateCommand } from "../../../src/cli/commands/replicate.ts";
import { rollbackCommand } from "../../../src/cli/commands/rollback.ts";
import { snapshotCommand } from "../../../src/cli/commands/snapshot.ts";
import type { CliIo } from "../../../src/cli/io.ts";
import { runCli } from "../../../src/cli/run.ts";
import { generateIdentity, MongoShield } from "../../../src/index.ts";
import { fileStorage } from "../../../src/storage/file.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../../helpers/mongo.ts";

const client = useMongoClient();
let workDir: string;

// The commands are registered in src/cli/commands/index.ts by the maintainer; until
// then, add them here so these tests exercise them through the real dispatcher.
for (const command of [
  snapshotCommand,
  rollbackCommand,
  eraseCommand,
  erasuresCommand,
  replicateCommand,
  rekeyCommand,
]) {
  if (findCommand(command.name) === undefined) (COMMANDS as CommandSpec[]).push(command);
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-recovery-cli-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function collector(): { stream: Writable; text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { stream, text: () => text };
}

/** Runs the CLI like a script would: no terminal. */
async function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  const stdout = collector();
  const stderr = collector();
  const io: CliIo = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env,
    cwd: workDir,
    isTTY: false,
  };
  const code = await runCli(args, io);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function newStorage(): Promise<string> {
  return mkdtemp(join(workDir, "storage-"));
}

describe("mongoshield snapshot / rollback", () => {
  it("snapshots, refuses to roll back without --yes, then rolls back with it", async () => {
    const database = uniqueDb("cli_snap");
    const storage = await newStorage();
    const accounts = client().db(database).collection("accounts");
    await accounts.insertMany([{ plan: "basic" }, { plan: "basic" }]);
    try {
      const taken = await cli([
        "snapshot",
        "v7",
        "--uri",
        mongoUri(),
        "--to",
        storage,
        "--include",
        `${database}.*`,
        "--quiet",
      ]);
      expect(taken.code, taken.stderr).toBe(0);
      expect(taken.stdout.trim()).toMatch(/^\d{4}-/);
      await accounts.updateMany({}, { $set: { plan: "BROKEN" } });

      const base = ["rollback", "v7", "--uri", mongoUri(), "--from", storage];
      const refused = await cli(base);
      expect(refused.code).toBe(3);
      expect(refused.stderr).toContain("Rollback plan");

      const done = await cli([...base, "--yes"]);
      expect(done.code, done.stderr).toBe(0);
      expect(done.stdout).toContain("Rolled back 1 namespace");
      expect(await accounts.countDocuments({ plan: "basic" })).toBe(2);
    } finally {
      await client().db(database).dropDatabase();
    }
  });
});

describe("mongoshield erase / erasures", () => {
  it("records an erasure, deletes live data with --now, and lists it without the email", async () => {
    const database = uniqueDb("cli_erase");
    const storage = await newStorage();
    const users = client().db(database).collection("users");
    await users.insertMany([{ email: "ada@example.com" }, { email: "bob@example.com" }]);
    const env = { MONGOSHIELD_ERASURE_SECRET: "cli-erasure-secret-0123" };
    try {
      const erased = await cli(
        [
          "erase",
          `${database}.users`,
          '{"email": "ada@example.com"}',
          "--reason",
          "GDPR request 1",
          "--now",
          "--uri",
          mongoUri(),
          "--to",
          storage,
        ],
        env,
      );
      expect(erased.code, erased.stderr).toBe(0);
      expect(await users.countDocuments()).toBe(1);

      const listed = await cli(["erasures", "list", "--from", storage, "--json"], env);
      expect(listed.code, listed.stderr).toBe(0);
      expect(listed.stdout).not.toContain("ada@example.com");
      const records = JSON.parse(listed.stdout) as { reason: string }[];
      expect(records.map((record) => record.reason)).toEqual(["GDPR request 1"]);

      const applied = await cli(
        [
          "erasures",
          "apply",
          "--uri",
          mongoUri(),
          "--from",
          storage,
          "--include",
          `${database}.*`,
          "--yes",
        ],
        env,
      );
      expect(applied.code, applied.stderr).toBe(0);
      expect(applied.stdout).toContain("Deleted 0 documents");
    } finally {
      await client().db(database).dropDatabase();
    }
  });
});

describe("mongoshield replicate / rekey", () => {
  it("copies backups to a second location and rekeys them there", async () => {
    const database = uniqueDb("cli_repl");
    const primary = await newStorage();
    const offsite = await newStorage();
    await client()
      .db(database)
      .collection("items")
      .insertMany([{ n: 1 }, { n: 2 }]);
    const oldKey = generateIdentity();
    const newKey = generateIdentity();
    try {
      const shield = new MongoShield({
        source: { uri: mongoUri() },
        storage: fileStorage({ path: primary }),
        encryption: { recipients: [oldKey.recipient] },
      });
      const backup = await shield.backup({ include: [`${database}.*`], consistency: "none" });

      const replicated = await cli(["replicate", "latest", "--from", primary, "--to", offsite]);
      expect(replicated.code, replicated.stderr).toBe(0);
      expect(replicated.stdout).toContain("copied 1 backup");
      expect(await readdir(join(offsite, "backups"))).toEqual([backup.id]);

      const keyFile = join(workDir, "old.key");
      await writeFile(keyFile, `${oldKey.identity}\n`, { mode: 0o600 });
      const rekeyed = await cli([
        "rekey",
        backup.id,
        "--from",
        offsite,
        "--identity-file",
        keyFile,
        "--add-recipient",
        newKey.recipient,
        "--remove-recipient",
        oldKey.recipient,
        "--yes",
      ]);
      expect(rekeyed.code, rekeyed.stderr).toBe(0);
      expect(rekeyed.stdout).toContain("rekeyed");

      const replica = new MongoShield({ storage: fileStorage({ path: offsite }) });
      const deep = await replica.verify({
        backup: backup.id,
        mode: "deep",
        decryption: { identities: [newKey.identity] },
      });
      expect(deep.ok).toBe(true);
    } finally {
      await client().db(database).dropDatabase();
    }
  });
});
