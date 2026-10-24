/**
 * The `mongoshield` CLI, driven through `runCli` with in-memory streams,
 * against the shared test replica set and file storage in a temporary directory.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/cli/commands/index.ts";
import type { CliIo } from "../../src/cli/io.ts";
import { runCli } from "../../src/cli/run.ts";
import { identityToRecipient, parseIdentityFile } from "../../src/crypto/index.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** What one CLI run printed and returned. */
interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-cli-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A writable stream that collects everything written to it. */
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

/** Runs the CLI like a script would: no terminal, empty environment unless given. */
async function cli(args: readonly string[], options: RunOptions = {}): Promise<CliRun> {
  const stdout = collector();
  const stderr = collector();
  const io: CliIo = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: options.env ?? {},
    cwd: options.cwd ?? workDir,
    isTTY: false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const code = await runCli(args, io);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** A fresh storage directory for one test. */
async function newStorage(): Promise<string> {
  return mkdtemp(join(workDir, "storage-"));
}

/** Test documents with numeric ids (the driver assumes ObjectId otherwise). */
interface NumberedDocument {
  _id: number;
  name?: string;
  marker?: boolean;
}

/** Seeds a database with two collections and an index. */
async function seed(dbName: string): Promise<void> {
  const db = client().db(dbName);
  await db
    .collection<NumberedDocument>("users")
    .insertMany(Array.from({ length: 50 }, (_, index) => ({ _id: index, name: `user ${index}` })));
  await db.collection("users").createIndex({ name: 1 }, { name: "by_name" });
  await db.collection("orders").insertMany([{ total: 10 }, { total: 20 }, { total: 30 }]);
}

/** The documents of a collection, sorted by _id, for comparisons. */
async function documentsOf(dbName: string, collection: string): Promise<unknown[]> {
  return client().db(dbName).collection(collection).find().sort({ _id: 1 }).toArray();
}

/** Runs a backup and returns its id. */
async function backup(dbName: string, storage: string, extra: readonly string[] = []) {
  const run = await cli([
    "backup",
    "--uri",
    mongoUri(),
    "--to",
    storage,
    "--include",
    `${dbName}.*`,
    "--quiet",
    ...extra,
  ]);
  expect(run.code, run.stderr).toBe(0);
  return run.stdout.trim();
}

describe("mongoshield --help", () => {
  it("lists every command on the overview page", async () => {
    const run = await cli(["--help"]);
    expect(run.code).toBe(0);
    for (const command of COMMANDS) expect(run.stdout).toContain(command.name);
    expect(run.stdout).toContain("--json");
  });

  it("prints the overview when run without arguments", async () => {
    const run = await cli([]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage");
  });

  it.each(COMMANDS.map((command) => command.name))(
    "documents `%s` with usage, options and examples",
    async (name) => {
      const run = await cli([name, "--help"]);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain(`mongoshield ${name}`);
      expect(run.stdout).toContain("Global options");
      expect(run.stdout).toContain("Examples");
      expect(run.stderr).toBe("");
    },
  );

  it("supports `mongoshield help <command>`", async () => {
    const run = await cli(["help", "restore"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("--rename");
  });

  it("prints the version with --version", async () => {
    const run = await cli(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^mongoshield \d+\.\d+\.\d+/);
  });
});

describe("usage errors", () => {
  it("suggests the closest command for a typo and exits with 2", async () => {
    const run = await cli(["bakup"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("MS_CONFIG_INVALID");
    expect(run.stderr).toContain("mongoshield backup");
  });

  it("rejects unknown flags with a suggestion", async () => {
    const run = await cli(["list", "--form", "./x"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Did you mean --from?");
  });

  it("rejects values outside a flag's choices", async () => {
    const run = await cli(["backup", "--compression", "lz4"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("zstd, gzip, none");
  });

  it("prints errors as one JSON document on stdout with --json", async () => {
    const run = await cli(["bakup", "--json"]);
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.stdout) as { error: { code: string; exitCode: number } };
    expect(parsed.error.code).toBe("MS_CONFIG_INVALID");
    expect(parsed.error.exitCode).toBe(2);
  });

  it("never accepts a passphrase variable that is not set", async () => {
    const run = await cli(["backup", "--to", "./x", "--passphrase-env", "MISSING_VAR"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("MISSING_VAR");
  });
});

describe("mongoshield keygen", () => {
  it("writes the identity with mode 0600 and prints the matching public key", async () => {
    const path = join(workDir, "keygen.key");
    const run = await cli(["keygen", "--output", path]);
    expect(run.code, run.stderr).toBe(0);

    const identities = parseIdentityFile(await readFile(path, "utf8"));
    expect(run.stdout.trim()).toBe(identityToRecipient(identities[0] ?? ""));
    expect(run.stdout).not.toContain("AGE-SECRET-KEY");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing key file", async () => {
    const path = join(workDir, "existing.key");
    await writeFile(path, "keep me");
    const run = await cli(["keygen", "--output", path]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("refusing to overwrite");
    expect(await readFile(path, "utf8")).toBe("keep me");
  });

  it("prints both keys with a warning when no file is given", async () => {
    const run = await cli(["keygen", "--json"]);
    expect(run.code).toBe(0);
    const keys = JSON.parse(run.stdout) as { identity: string; recipient: string };
    expect(identityToRecipient(keys.identity)).toBe(keys.recipient);
    expect(run.stderr).toContain("secret");
  });
});

describe("mongoshield init", () => {
  it("writes a config with env-var references and a generated key pair, without a terminal", async () => {
    const project = await mkdtemp(join(workDir, "init-"));
    const run = await cli(["init", "--yes", "--storage", "s3://acme/prod", "--keygen"], {
      cwd: project,
    });
    expect(run.code, run.stderr).toBe(0);

    const config = await readFile(join(project, "mongoshield.config.ts"), "utf8");
    const identities = parseIdentityFile(await readFile(join(project, "mongoshield.key"), "utf8"));
    expect(config).toContain("defineConfig");
    expect(config).toContain("process.env.MONGODB_URI");
    expect(config).toContain('"s3://acme/prod"');
    expect(config).toContain(identityToRecipient(identities[0] ?? ""));
    expect(config).not.toContain("AGE-SECRET-KEY");
    expect(run.stderr).toContain(".gitignore");
    expect(run.stdout).toContain("Next steps");
  });

  it("never overwrites an existing config", async () => {
    const project = await mkdtemp(join(workDir, "init-"));
    await writeFile(join(project, "mongoshield.config.ts"), "export default {}");
    const run = await cli(["init", "--yes"], { cwd: project });
    expect(run.code).toBe(2);
    expect(await readFile(join(project, "mongoshield.config.ts"), "utf8")).toBe(
      "export default {}",
    );
  });
});

describe("connection errors", () => {
  it("reports MS_CONNECTION_FAILED with exit code 10 and never prints the password", async () => {
    const password = "s3cretPassw0rd";
    const uri = `mongodb://admin:${password}@127.0.0.1:1/?serverSelectionTimeoutMS=300`;
    const run = await cli(["backup", "--uri", uri, "--to", await newStorage()]);

    expect(run.code).toBe(10);
    expect(run.stderr).toContain("MS_CONNECTION_FAILED");
    expect(run.stderr).toContain("hint");
    expect(`${run.stdout}${run.stderr}`).not.toContain(password);
  });

  it("keeps the password out of --verbose stack traces too", async () => {
    const password = "an0therSecret";
    const uri = `mongodb://admin:${password}@127.0.0.1:1/?serverSelectionTimeoutMS=300`;
    const run = await cli(["backup", "--uri", uri, "--to", await newStorage(), "--verbose"]);
    expect(run.code).toBe(10);
    expect(`${run.stdout}${run.stderr}`).not.toContain(password);
  });
});

describe("backup → list → inspect → verify → restore", () => {
  const dbName = uniqueDb("cli");
  let storage: string;
  let backupId: string;

  beforeAll(async () => {
    await seed(dbName);
    storage = await newStorage();
  });

  it("backs up and prints a summary", async () => {
    const run = await cli([
      "backup",
      "--uri",
      mongoUri(),
      "--to",
      storage,
      "--include",
      `${dbName}.*`,
      "--label",
      "env=test",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("Backup id");
    expect(run.stdout).toContain("53");
    // "auto" is converge on the test replica set; the summary says how many changes.
    expect(run.stdout).toMatch(/Consistency\s+converge \(\d+ changes during the backup/);
    backupId = /Backup id\s+(\S+)/.exec(run.stdout)?.[1] ?? "";
    expect(backupId).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("lists it as JSON with the full manifest", async () => {
    const run = await cli(["list", "--from", storage, "--json"]);
    expect(run.code).toBe(0);
    const entries = JSON.parse(run.stdout) as {
      id: string;
      status: string;
      manifest: { labels: Record<string, string> };
    }[];
    expect(entries.map((entry) => entry.id)).toEqual([backupId]);
    expect(entries[0]?.status).toBe("complete");
    // Plus the selection's shape label, which scopes `mongoshield prune`.
    expect(entries[0]?.manifest.labels).toEqual({
      env: "test",
      "mongoshield.shape": expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it("lists it as a table", async () => {
    const run = await cli(["list", "--from", storage]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(backupId);
    expect(run.stdout).toContain("complete");
    expect(run.stdout).toContain("VERIFIED");
  });

  it("inspects it, with one row per namespace", async () => {
    const run = await cli(["inspect", backupId, "--from", storage]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`${dbName}.users`);
    expect(run.stdout).toContain(`${dbName}.orders`);
    expect(run.stdout).toContain("env=test");
    expect(run.stdout).toMatch(/Consistency\s+converge \(/);
  });

  it("accepts every consistency mode on the command line", async () => {
    for (const mode of ["converge", "none"]) {
      const run = await cli([
        "backup",
        "--uri",
        mongoUri(),
        "--to",
        await newStorage(),
        "--include",
        `${dbName}.users`,
        "--consistency",
        mode,
      ]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toMatch(new RegExp(`Consistency\\s+${mode}`));
    }
  });

  it("verifies it and records the result for list", async () => {
    const verify = await cli(["verify", backupId, "--from", storage]);
    expect(verify.code, verify.stderr).toBe(0);
    expect(verify.stdout).toContain("intact");

    const list = await cli(["list", "--from", storage]);
    expect(list.stdout).toContain("✓ fast");
  });

  it("restores under another name and the data matches", async () => {
    const target = `${dbName}_r`;
    const run = await cli([
      "restore",
      backupId,
      "--from",
      storage,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${dbName}.*=${target}.*`,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(`${target}.users`);
    expect(run.stdout).toContain("Restored 53 documents");

    expect(await documentsOf(target, "users")).toEqual(await documentsOf(dbName, "users"));
    expect(await documentsOf(target, "orders")).toEqual(await documentsOf(dbName, "orders"));
    const indexes = await client().db(target).collection("users").indexes();
    expect(indexes.map((index) => index.name)).toContain("by_name");
  });

  it("refuses to restore over existing data in the default mode", async () => {
    const run = await cli([
      "restore",
      "--from",
      storage,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${dbName}.*=${dbName}_r.*`,
    ]);
    expect(run.code).toBe(50);
    expect(run.stderr).toContain("MS_RESTORE_CONFLICT");
  });

  it("refuses to drop without --yes when nobody can confirm", async () => {
    const target = `${dbName}_r`;
    await client()
      .db(target)
      .collection<NumberedDocument>("users")
      .insertOne({ _id: 9999, marker: true });
    const run = await cli([
      "restore",
      "--from",
      storage,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${dbName}.*=${target}.*`,
      "--drop",
    ]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("MS_CONFIRMATION_REQUIRED");
    expect(run.stderr).toContain("--yes");
    expect(await client().db(target).collection("users").countDocuments({ marker: true })).toBe(1);
  });

  it("drops and replaces with --drop --yes", async () => {
    const target = `${dbName}_r`;
    const run = await cli([
      "restore",
      "--from",
      storage,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${dbName}.*=${target}.*`,
      "--drop",
      "--yes",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(await documentsOf(target, "users")).toEqual(await documentsOf(dbName, "users"));
  });

  it("writes nothing with --dry-run", async () => {
    const target = `${dbName}_dry`;
    const run = await cli([
      "restore",
      "--from",
      storage,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${dbName}.*=${target}.*`,
      "--dry-run",
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { dryRun: boolean; plan: { entries: unknown[] } };
    expect(result.dryRun).toBe(true);
    expect(result.plan.entries).toHaveLength(2);
    expect(await client().db(target).listCollections().toArray()).toEqual([]);
  });

  it("explains when the filters select nothing", async () => {
    const run = await cli([
      "restore",
      "--from",
      storage,
      "--to-uri",
      mongoUri(),
      "--include",
      "nothing.*",
      "--dry-run",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("include/exclude");
  });
});

describe("encrypted backups", () => {
  const dbName = uniqueDb("clienc");

  it("restores with the identity file and fails clearly without it", async () => {
    await seed(dbName);
    const storage = await newStorage();
    const keyFile = join(workDir, `${dbName}.key`);
    const keygen = await cli(["keygen", "--output", keyFile, "--quiet"]);
    const recipient = keygen.stdout.trim();

    const id = await backup(dbName, storage, ["--recipient", recipient]);
    const inspect = await cli(["inspect", id, "--from", storage]);
    expect(inspect.stdout).toContain(recipient);

    const restoreArgs = ["restore", id, "--from", storage, "--to-uri", mongoUri()];
    const rename = ["--rename", `${dbName}.*=${dbName}_r.*`];
    const withoutKey = await cli([...restoreArgs, ...rename]);
    expect(withoutKey.code).toBe(42);
    expect(withoutKey.stderr).toContain("MS_NO_IDENTITY");

    const deep = await cli(["verify", id, "--from", storage, "--deep", "--identity-file", keyFile]);
    expect(deep.code, deep.stderr).toBe(0);

    const withKey = await cli([...restoreArgs, ...rename, "--identity-file", keyFile]);
    expect(withKey.code, withKey.stderr).toBe(0);
    expect(await documentsOf(`${dbName}_r`, "users")).toEqual(await documentsOf(dbName, "users"));
  });
});

describe("mongoshield prune, hold and release", () => {
  const dbName = uniqueDb("cliprune");
  let storage: string;
  let older: string;
  let newer: string;

  beforeAll(async () => {
    await seed(dbName);
    storage = await newStorage();
    older = await backup(dbName, storage);
    newer = await backup(dbName, storage);
  });

  /** Prunes the selection the backups were taken with (prune's default scope). */
  function prune(...flags: string[]) {
    return cli(["prune", "--from", storage, "--include", `${dbName}.*`, ...flags]);
  }

  async function ids(): Promise<string[]> {
    const run = await cli(["list", "--from", storage, "--json"]);
    return (JSON.parse(run.stdout) as { id: string }[]).map((entry) => entry.id);
  }

  it("shows the plan and deletes nothing with --dry-run", async () => {
    const run = await prune("--last", "1", "--dry-run");
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("remove");
    expect(run.stdout).toContain("would delete 1 backup");
    expect(await ids()).toEqual([newer, older]);
  });

  it("needs a policy", async () => {
    const run = await prune();
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("retention");
  });

  it("refuses to delete without --yes when nobody can confirm", async () => {
    const run = await prune("--last", "1");
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("MS_CONFIRMATION_REQUIRED");
    expect(await ids()).toEqual([newer, older]);
  });

  it("never prunes a held backup, and prunes it once released", async () => {
    const hold = await cli(["hold", older, "--from", storage, "--reason", "audit"]);
    expect(hold.code, hold.stderr).toBe(0);
    expect((await cli(["list", "--from", storage])).stdout).toContain("held");

    const keep = await prune("--last", "1", "--yes");
    expect(keep.code, keep.stderr).toBe(0);
    expect(await ids()).toEqual([newer, older]);

    const release = await cli(["release", older, "--from", storage]);
    expect(release.code, release.stderr).toBe(0);
    const pruned = await prune("--last", "1", "--yes", "--json");
    expect(pruned.code, pruned.stderr).toBe(0);
    expect((JSON.parse(pruned.stdout) as { deletedBackups: number }).deletedBackups).toBe(1);
    expect(await ids()).toEqual([newer]);
  });

  it("labels backups with their selection and prunes one selection without touching another", async () => {
    const otherDb = uniqueDb("cliprune_other");
    await seed(otherDb);
    const shared = await newStorage();
    const ours = [await backup(dbName, shared), await backup(dbName, shared)];
    const theirs = [await backup(otherDb, shared), await backup(otherDb, shared)];

    const listed = await cli(["list", "--from", shared, "--json"]);
    const labels = (
      JSON.parse(listed.stdout) as { manifest?: { labels: Record<string, string> } }[]
    ).map((entry) => entry.manifest?.labels["mongoshield.shape"]);
    expect(new Set(labels).size).toBe(2);

    // With --uri, prune reads the deployment's cluster id from the source itself.
    const run = await cli([
      "prune",
      "--from",
      shared,
      "--uri",
      mongoUri(),
      "--include",
      `${dbName}.*`,
      "--last",
      "1",
      "--yes",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("2 backups of other sources/selections were left alone.");
    const remaining = await cli(["list", "--from", shared, "--json"]);
    expect(
      (JSON.parse(remaining.stdout) as { id: string }[]).map((entry) => entry.id).sort(),
    ).toEqual([ours[1], ...theirs].sort());
    await client().db(otherDb).dropDatabase();
  });
});

describe("cancellation", () => {
  it("stops cleanly with MS_ABORTED when the signal is already aborted", async () => {
    const dbName = uniqueDb("clicancel");
    await seed(dbName);
    const run = await cli(
      ["backup", "--uri", mongoUri(), "--to", await newStorage(), "--include", `${dbName}.*`],
      { signal: AbortSignal.abort() },
    );
    expect(run.code).toBe(60);
    expect(run.stderr).toContain("MS_ABORTED");
  });
});
