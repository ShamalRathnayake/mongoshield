/**
 * `mongoshield backup`, `restore`, `copy` and `drill` through `runCli` against the
 * shared test replica set, covering the paths the older CLI tests leave out: --json
 * results, encryption summaries, checkpoints with --quiet, interactive confirmations
 * (answered Yes and No through a fake terminal), insert/upsert modes, users and roles
 * that already exist, search indexes the deployment cannot build, masks without a
 * secret, and drills with views and kept databases.
 *
 * Backups live in named in-memory stores (`memory://…`), shared by every run in
 * this process.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { flipByte, replaceStoredFile, writeTestBackup } from "../helpers/backup-fixtures.ts";
import { KEYS, plain, runTestCli, type TestCliOptions } from "../helpers/cli.ts";
import { namedMemoryStore } from "../helpers/cli-backups.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const source = uniqueDb("clidata");
const PASSPHRASE = "data commands passphrase";
const databasesToDrop = new Set<string>([source]);

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-cli-data-"));
  const db = client().db(source);
  await db.collection<{ _id: number; name: string; pad: string }>("users").insertMany(
    Array.from({ length: 50 }, (_, index) => ({
      _id: index,
      name: `user ${index}`,
      pad: "x".repeat(200),
    })),
  );
  await db.collection("orders").insertMany([{ total: 10 }, { total: 20 }]);
  await db.createCollection("big_users", {
    viewOn: "users",
    pipeline: [{ $match: { _id: { $gte: 25 } } }],
  });
});

afterAll(async () => {
  for (const name of databasesToDrop) {
    const db = client().db(name);
    await db.command({ dropAllUsersFromDatabase: 1 }).catch(() => undefined);
    await db.command({ dropAllRolesFromDatabase: 1 }).catch(() => undefined);
    await db.dropDatabase();
  }
  await rm(workDir, { recursive: true, force: true });
});

/** A new database name, dropped after the file. */
function scratchDb(prefix: string): string {
  const name = uniqueDb(prefix);
  databasesToDrop.add(name);
  return name;
}

function cli(args: readonly string[], options: TestCliOptions = {}) {
  return runTestCli(args, { cwd: workDir, ...options });
}

/** Backs up the source database into a new store and returns both. */
async function backupSource(extra: readonly string[] = [], options: TestCliOptions = {}) {
  const { url } = await namedMemoryStore();
  const run = await cli(
    ["backup", "--uri", mongoUri(), "--to", url, "--include", `${source}.*`, "--quiet", ...extra],
    options,
  );
  expect(run.code, run.stderr).toBe(0);
  return { url, id: run.stdout.trim() };
}

async function count(database: string, collection: string): Promise<number> {
  return client().db(database).collection(collection).countDocuments();
}

describe("mongoshield backup", () => {
  it("reads the URI from MONGODB_URI, honours --exclude and --compression, and prints JSON", async () => {
    const { url } = await namedMemoryStore();
    const run = await cli(
      [
        "backup",
        "--to",
        url,
        "--include",
        `${source}.*`,
        "--exclude",
        `${source}.orders`,
        "--compression",
        "gzip",
        "--read-preference",
        "primary",
        "--json",
      ],
      { env: { MONGODB_URI: mongoUri() } },
    );
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{
      status: string;
      manifest: { compression: string; namespaces: { ns: string }[] };
    }>();
    expect(result.status).toBe("complete");
    expect(result.manifest.compression).toBe("gzip");
    const namespaces = result.manifest.namespaces.map((entry) => entry.ns);
    expect(namespaces).toContain(`${source}.users`);
    expect(namespaces).not.toContain(`${source}.orders`);
  });

  it("summarises passphrase encryption, keeping the passphrase out of the output", async () => {
    const { url } = await namedMemoryStore();
    const run = await cli(
      [
        "backup",
        "--uri",
        mongoUri(),
        "--to",
        url,
        "--include",
        `${source}.orders`,
        "--passphrase-env",
        "PASS",
        "--read-preference",
        "primaryPreferred",
      ],
      { env: { PASS: PASSPHRASE } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/Encryption\s+age \(passphrase\)/);
    expect(run.stdout).toMatch(/Namespaces\s+1 \(in 1 database\)/);
    expect(run.stdout + run.stderr).not.toContain(PASSPHRASE);
  });

  it("summarises recipient encryption", async () => {
    const { url } = await namedMemoryStore();
    const { recipient } = generateIdentity();
    const run = await cli([
      "backup",
      "--uri",
      mongoUri(),
      "--to",
      url,
      "--include",
      `${source}.orders`,
      "--recipient",
      recipient,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/Encryption\s+age \(1 recipient\)/);
  });

  it("prints only the id of a checkpointed run with --quiet", async () => {
    const { url } = await namedMemoryStore();
    const run = await cli([
      "backup",
      "--uri",
      mongoUri(),
      "--to",
      url,
      "--include",
      `${source}.users`,
      "--part-size",
      "4KiB",
      "--parallelism",
      "1",
      "--max-duration",
      "1ms",
      "--quiet",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const id = run.stdout.trim();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const list = await cli(["list", "--from", url, "--json"]);
    expect(list.json<{ id: string; status: string }[]>()).toEqual([
      expect.objectContaining({ id, status: "incomplete" }),
    ]);
  });
});

describe("mongoshield restore", () => {
  let backup: { url: string; id: string };
  let encrypted: { url: string; id: string };

  beforeAll(async () => {
    backup = await backupSource();
    encrypted = await backupSource(["--passphrase-env", "PASS"], { env: { PASS: PASSPHRASE } });
  });

  it("restores with --json and --exclude, printing only the result document", async () => {
    const target = scratchDb("rjson");
    const run = await cli([
      "restore",
      backup.id,
      "--from",
      backup.url,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${source}.*=${target}.*`,
      "--exclude",
      `${source}.orders`,
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{ documentsRestored: number; plan: { entries: { to: string }[] } }>();
    expect(result.documentsRestored).toBe(50);
    expect(result.plan.entries.map((entry) => entry.to)).not.toContain(`${target}.orders`);
    expect(await count(target, "users")).toBe(50);
    expect(run.stderr).not.toContain("Restore plan");
  });

  it("prints a dry-run result as JSON and writes nothing", async () => {
    const target = scratchDb("rdry");
    const run = await cli([
      "restore",
      "--from",
      backup.url,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${source}.*=${target}.*`,
      "--dry-run",
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({ dryRun: true, documentsRestored: 0 });
    expect(await count(target, "users")).toBe(0);
  });

  it("shows the plan and writes nothing with --dry-run", async () => {
    const target = scratchDb("rdry2");
    const run = await cli([
      "restore",
      "--from",
      backup.url,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${source}.*=${target}.*`,
      "--dry-run",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(`Restore plan: backup ${backup.id} from ${backup.url}`);
    expect(run.stderr).toContain("3 namespaces, 52 documents.");
    expect(run.stderr).toContain("✔ Dry run: nothing was written.");
    expect(run.stdout).toBe("");
    expect(await count(target, "users")).toBe(0);
  });

  it("asks before inserting into collections that hold documents; No changes nothing (exit 60)", async () => {
    const target = scratchDb("rins");
    const rename = `${source}.*=${target}.*`;
    const first = await cli([
      "restore",
      "--from",
      backup.url,
      "--to-uri",
      mongoUri(),
      "--rename",
      rename,
      "--include",
      `${source}.users`,
    ]);
    expect(first.code, first.stderr).toBe(0);

    const run = await cli(
      [
        "restore",
        "--from",
        backup.url,
        "--to-uri",
        mongoUri(),
        "--rename",
        rename,
        "--mode",
        "insert",
      ],
      { terminal: [{ when: "that already have documents?", keys: KEYS.enter }] },
    );
    expect(run.code).toBe(60);
    const stderr = plain(run.stderr);
    expect(stderr).toContain("Insert into 1 collection in");
    expect(stderr).toMatch(/insert/);
    expect(stderr).toContain("Cancelled. Nothing was changed.");
    expect(await count(target, "users")).toBe(50);
    expect(await count(target, "orders")).toBe(0);
  });

  it("asks before upserting, then merges into the existing documents", async () => {
    const target = scratchDb("rups");
    const rename = `${source}.*=${target}.*`;
    await cli(["restore", "--from", backup.url, "--to-uri", mongoUri(), "--rename", rename]);
    await client()
      .db(target)
      .collection<{ _id: number }>("users")
      .updateOne({ _id: 1 }, { $set: { name: "changed" } });

    const run = await cli(
      [
        "restore",
        "--from",
        backup.url,
        "--to-uri",
        mongoUri(),
        "--rename",
        rename,
        "--mode",
        "upsert",
      ],
      { terminal: [{ when: "replacing documents with the same _id?", keys: `y${KEYS.enter}` }] },
    );
    expect(run.code, plain(run.stderr)).toBe(0);
    const plan = plain(run.stderr);
    expect(plan).toMatch(new RegExp(`${target}\\.users\\s+collection\\s+50\\s+50\\s+upsert`));
    // Views cannot be merged into: an existing view is left as it is.
    expect(plan).toMatch(new RegExp(`${target}\\.big_users\\s+view\\s+0\\s+\\S+\\s+skip`));
    expect(plain(run.stdout)).toContain("Restored 52 documents");
    const restored = await client()
      .db(target)
      .collection<{ _id: number; name: string }>("users")
      .findOne({ _id: 1 });
    expect(restored?.name).toBe("user 1");
  });

  it("refuses --verify-first with --no-verify-first after showing the plan", async () => {
    const target = scratchDb("rvf");
    const run = await cli([
      "restore",
      "--from",
      backup.url,
      "--to-uri",
      mongoUri(),
      "--rename",
      `${source}.*=${target}.*`,
      "--verify-first",
      "--no-verify-first",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Restore plan");
    expect(run.stderr).toContain("--verify-first contradicts --no-verify-first.");
    expect(await count(target, "users")).toBe(0);
  });

  it("accepts --verify-first and --no-verify-first on their own", async () => {
    const target = scratchDb("rvf2");
    const rename = `${source}.*=${target}.*`;
    const checked = await cli([
      "restore",
      "--from",
      backup.url,
      "--to-uri",
      mongoUri(),
      "--rename",
      rename,
      "--verify-first",
    ]);
    expect(checked.code, checked.stderr).toBe(0);
    const unchecked = await cli([
      "restore",
      "--from",
      backup.url,
      "--to-uri",
      mongoUri(),
      "--rename",
      rename,
      "--drop",
      "--yes",
      "--no-verify-first",
    ]);
    expect(unchecked.code, unchecked.stderr).toBe(0);
    expect(await count(target, "users")).toBe(50);
  });

  it("restores a passphrase-encrypted backup with --passphrase-env", async () => {
    const target = scratchDb("renc");
    const run = await cli(
      [
        "restore",
        "--from",
        encrypted.url,
        "--to-uri",
        mongoUri(),
        "--rename",
        `${source}.*=${target}.*`,
        "--passphrase-env",
        "PASS",
      ],
      { env: { PASS: PASSPHRASE } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(await count(target, "users")).toBe(50);
    expect(run.stdout + run.stderr).not.toContain(PASSPHRASE);
  });

  it("warns about search indexes the target cannot build", async () => {
    const target = scratchDb("rsearch");
    const { url, storage } = await namedMemoryStore();
    await writeTestBackup(storage, {
      namespaces: [
        {
          ns: `${target}.articles`,
          documents: [{ _id: 1, title: "hello" }],
          searchIndexes: [
            { name: "default", type: "search", definition: { mappings: { dynamic: true } } },
          ],
        },
      ],
    });
    const run = await cli(["restore", "--from", url, "--to-uri", mongoUri()]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(
      `The target does not support Atlas Search; not created: ${target}.articles default.`,
    );
    expect(await count(target, "articles")).toBe(1);
  });

  it("keeps users that already exist in create mode, and says so", async () => {
    const withUsers = scratchDb("rusrc");
    const target = scratchDb("rusrt");
    await client()
      .db(withUsers)
      .collection("things")
      .insertOne({ _id: 1 } as never);
    await client()
      .db(withUsers)
      .command({ createUser: "keeper", pwd: "keeper-password-1", roles: [] });
    const { url } = await namedMemoryStore();
    const backupRun = await cli([
      "backup",
      "--uri",
      mongoUri(),
      "--to",
      url,
      "--include",
      `${withUsers}.*`,
      "--users-and-roles",
      "--quiet",
    ]);
    expect(backupRun.code, backupRun.stderr).toBe(0);

    const restore = (extra: string[]) =>
      cli([
        "restore",
        "--from",
        url,
        "--to-uri",
        mongoUri(),
        "--rename",
        `${withUsers}.*=${target}.*`,
        "--users-and-roles",
        "create",
        ...extra,
      ]);
    const first = await restore([]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("Restored 0 roles and 1 user.");
    const second = await restore(["--drop", "--yes"]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain(
      "Restored 0 roles and 0 users (1 already existed and were kept).",
    );
    expect(second.stdout + second.stderr).not.toContain("keeper-password-1");
  });
});

describe("mongoshield copy", () => {
  it("prints a dry-run result as JSON with --exclude, --rename and --parallelism", async () => {
    const target = scratchDb("cdry");
    const run = await cli([
      "copy",
      "--from",
      mongoUri(),
      "--to",
      mongoUri(),
      "--include",
      `${source}.*`,
      "--exclude",
      `${source}.orders`,
      "--rename",
      `${source}.*=${target}.*`,
      "--parallelism",
      "2",
      "--dry-run",
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{ dryRun: boolean; plan: { entries: { to: string }[] } }>();
    expect(result.dryRun).toBe(true);
    expect(result.plan.entries.map((entry) => entry.to)).toContain(`${target}.users`);
    expect(result.plan.entries.map((entry) => entry.to)).not.toContain(`${target}.orders`);
    expect(await count(target, "users")).toBe(0);
  });

  it("asks before inserting into or upserting over existing data", async () => {
    const target = scratchDb("cask");
    const base = [
      "copy",
      "--from",
      mongoUri(),
      "--to",
      mongoUri(),
      "--include",
      `${source}.users`,
      "--rename",
      `${source}.*=${target}.*`,
    ];
    const first = await cli(base);
    expect(first.code, first.stderr).toBe(0);

    const refused = await cli([...base, "--mode", "insert"], {
      terminal: [{ when: "that already have documents?", keys: KEYS.enter }],
    });
    expect(refused.code).toBe(60);
    expect(await count(target, "users")).toBe(50);

    const upserted = await cli([...base, "--mode", "upsert"], {
      terminal: [{ when: "replacing documents with the same _id?", keys: `y${KEYS.enter}` }],
    });
    expect(upserted.code, plain(upserted.stderr)).toBe(0);
    expect(plain(upserted.stdout)).toContain("Copied 50 documents");
    expect(await count(target, "users")).toBe(50);
  });

  it("shows a subset's selection in the plan", async () => {
    const target = scratchDb("csub");
    const subsetFile = join(workDir, "subset.ts");
    await writeFile(
      subsetFile,
      `export default { filters: { "${source}.users": { _id: { $lt: 5 } } } };\n`,
    );
    const run = await cli([
      "copy",
      "--from",
      mongoUri(),
      "--to",
      mongoUri(),
      "--include",
      `${source}.users`,
      "--include",
      `${source}.orders`,
      "--rename",
      `${source}.*=${target}.*`,
      "--subset",
      subsetFile,
    ]);
    expect(run.code, run.stderr).toBe(0);
    const usersRow = run.stderr.split("\n").find((line) => line.includes(`${target}.users`));
    const ordersRow = run.stderr.split("\n").find((line) => line.includes(`${target}.orders`));
    expect(usersRow).not.toMatch(/\sall\s/);
    expect(ordersRow).toMatch(/\sall\s/);
    expect(await count(target, "users")).toBe(5);
  });

  it("applies a mask that needs no secret, and names the collections no rule covers", async () => {
    const target = scratchDb("cmask");
    const maskFile = join(workDir, "redact-mask.ts");
    await writeFile(
      maskFile,
      `export default { rules: { "${source}.users": { name: "redact" } } };\n`,
    );
    const run = await cli([
      "copy",
      "--from",
      mongoUri(),
      "--to",
      mongoUri(),
      "--include",
      `${source}.users`,
      "--include",
      `${source}.orders`,
      "--rename",
      `${source}.*=${target}.*`,
      "--mask",
      maskFile,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("1 rule");
    expect(run.stderr).toContain(`No mask rule applies to: ${source}.orders`);
    expect(run.stdout).toMatch(/masking \d+ values?\./);
    const copied = await client()
      .db(target)
      .collection<{ _id: number; name?: unknown }>("users")
      .findOne({ _id: 1 });
    expect(copied?.name).not.toBe("user 1");
  });
});

describe("mongoshield drill", () => {
  it("drills with --prefix, filters and --keep, listing views and the kept databases", async () => {
    const { url } = await backupSource();
    const prefix = `kd${Date.now() % 100_000}_`;
    const run = await cli([
      "drill",
      "--from",
      url,
      "--target-uri",
      mongoUri(),
      "--allow-same-deployment",
      "--prefix",
      prefix,
      "--include",
      `${source}.*`,
      "--exclude",
      `${source}.orders`,
      "--keep",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`${source}\\.big_users\\s+view\\s+-\\s+-\\s+-\\s+ok`));
    expect(run.stdout).not.toContain(`${source}.orders`);
    const kept = /Kept the temporary databases: (.+)\. Drop them when done\./.exec(run.stderr)?.[1];
    expect(kept).toBeDefined();
    for (const name of (kept ?? "").split(", ")) {
      expect(name.startsWith(prefix)).toBe(true);
      databasesToDrop.add(name);
    }
  });

  it("takes the scratch deployment from MONGOSHIELD_DRILL_URI when --target-uri is absent", async () => {
    const { url } = await backupSource();
    const run = await cli(
      ["drill", "--from", url, "--allow-same-deployment", "--include", `${source}.users`, "--json"],
      { env: { MONGOSHIELD_DRILL_URI: mongoUri() } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.json<{ ok: boolean }>().ok).toBe(true);

    const missing = await cli(["drill", "--from", url]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("MONGOSHIELD_DRILL_URI");
  });

  it("drills a passphrase-encrypted backup with --passphrase-env", async () => {
    const { url } = await backupSource(["--passphrase-env", "PASS"], { env: { PASS: PASSPHRASE } });
    const run = await cli(
      [
        "drill",
        "--from",
        url,
        "--target-uri",
        mongoUri(),
        "--allow-same-deployment",
        "--passphrase-env",
        "PASS",
        "--sample",
        "5",
      ],
      { env: { PASS: PASSPHRASE } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("✔ Drill passed");
    expect(run.stdout).toMatch(
      new RegExp(`${source}\\.users\\s+collection\\s+50/50\\s+\\d+/\\d+\\s+5\\s+ok`),
    );
    expect(run.stdout + run.stderr).not.toContain(PASSPHRASE);
  });

  it("reports a restore that failed (exit 33) when a data file is damaged", async () => {
    const database = scratchDb("dbad");
    const { url, storage } = await namedMemoryStore();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: `${database}.items`, documents: [{ _id: 1 }, { _id: 2 }] }],
    });
    const file = manifest.namespaces[0]?.files[0];
    if (!file) throw new Error("fixture has no data file");
    await replaceStoredFile(storage, manifest, file.key, (bytes) => flipByte(bytes, -2));

    const run = await cli([
      "drill",
      "--from",
      url,
      "--target-uri",
      mongoUri(),
      "--allow-same-deployment",
    ]);
    expect(run.code).toBe(33);
    expect(run.stdout).toMatch(/^RTO .*, failed\)$/m);
    expect(run.stdout).toContain("✖ Drill failed:");
  });
});
