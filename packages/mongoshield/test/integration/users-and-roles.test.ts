// Integration tests for backing up and restoring users and custom roles on the
// shared replica set. Authorization is not enforced there, but every user-management
// command (usersInfo, createRole, _mergeAuthzCollections, …) works, and password
// authentication does too, which proves that password hashes survive a round trip.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { type Document, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.ts";
import { runBackup } from "../../src/engine/backup.ts";
import { captureUsersAndRoles } from "../../src/engine/backup-authz.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { createUsersWithoutCredentials } from "../../src/engine/restore-authz.ts";
import { verifyBackup } from "../../src/engine/verify.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import type { LogFields, Logger } from "../../src/logger.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const source = uniqueDb("usrc");
const storage = memoryStorage();
const ALICE_PASSWORD = "correct horse battery staple";
const backupWarnings: string[] = [];
let manifest: Manifest;

/** Every database a test created users or roles in, cleaned up at the end. */
const databasesWithUsers = new Set<string>([source]);

function recordingLogger(warnings: string[]): Logger {
  const ignore = (_message: string, _fields?: LogFields): void => {};
  return { debug: ignore, info: ignore, error: ignore, warn: (message) => warnings.push(message) };
}

/** usersInfo / rolesInfo of one database, keyed by name. */
async function usersOf(database: string): Promise<Map<string, Document>> {
  const reply = await client()
    .db(database)
    .command({ usersInfo: 1, showCredentials: true, showCustomData: true });
  return new Map((reply.users as Document[]).map((user) => [String(user.user), user]));
}

async function rolesOf(database: string): Promise<Map<string, Document>> {
  const reply = await client().db(database).command({ rolesInfo: 1, showPrivileges: true });
  return new Map((reply.roles as Document[]).map((role) => [String(role.role), role]));
}

/** True when `user` can log in to the replica set with `password`. */
async function canLogIn(database: string, user: string, password: string): Promise<boolean> {
  const login = new MongoClient(mongoUri(), {
    auth: { username: user, password },
    authSource: database,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await login.db(database).command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await login.close();
  }
}

/** Restores the shared backup with `rename` from `source` into `target`. */
async function restoreInto(
  target: string,
  usersAndRoles: "skip" | "create" | "replace" | undefined,
  mode: "fail-if-exists" | "drop" = "fail-if-exists",
) {
  databasesWithUsers.add(target);
  return runRestore(
    { client: client(), storage, logger: silentLogger },
    {
      backup: manifest.id,
      rename: { [`${source}.*`]: `${target}.*` },
      mode,
      ...(usersAndRoles === undefined ? {} : { usersAndRoles }),
    },
  );
}

beforeAll(async () => {
  const db = client().db(source);
  await db.collection("things").insertOne({ name: "thing" });
  await db.command({
    createRole: "baseReader",
    privileges: [{ resource: { db: source, collection: "things" }, actions: ["find"] }],
    roles: [],
  });
  await db.command({
    createRole: "editor",
    privileges: [{ resource: { db: source, collection: "" }, actions: ["insert"] }],
    roles: [{ role: "baseReader", db: source }],
  });
  await db.command({
    createUser: "alice",
    pwd: ALICE_PASSWORD,
    roles: [{ role: "editor", db: source }],
    customData: { team: "data" },
  });
  await db.command({
    createUser: "bob",
    pwd: "bob-password",
    roles: [{ role: "read", db: source }],
  });

  const result = await runBackup(
    {
      client: client(),
      storage,
      logger: recordingLogger(backupWarnings),
      compression: "zstd",
      encryption: undefined,
    },
    { include: [`${source}.*`], consistency: "none", includeUsersAndRoles: true },
  );
  manifest = result.manifest;
});

afterAll(async () => {
  for (const database of databasesWithUsers) {
    await client().db(database).command({ dropAllUsersFromDatabase: 1 });
    await client().db(database).command({ dropAllRolesFromDatabase: 1 });
  }
});

describe("backing up users and roles", () => {
  it("stores them as users and roles entries under admin", () => {
    const users = manifest.namespaces.find((entry) => entry.type === "users");
    const roles = manifest.namespaces.find((entry) => entry.type === "roles");
    expect(users).toMatchObject({ ns: "admin.system.users", documents: 2 });
    expect(roles).toMatchObject({ ns: "admin.system.roles", documents: 2 });
    expect(users?.files[0]?.key).toBe("admin/system.users.bson.zst");
    expect(manifest.totals.namespaces).toBe(manifest.namespaces.length);
  });

  it("warns that unencrypted backups hold password hashes in the clear", () => {
    expect(backupWarnings.some((warning) => warning.includes("without encryption"))).toBe(true);
  });

  it("passes a deep verify", async () => {
    const report = await verifyBackup(
      { storage, logger: silentLogger },
      { backup: manifest.id, mode: "deep" },
    );
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("reads every database's users with forAllDBs when backing up everything", async () => {
    const captured = await captureUsersAndRoles(client(), { kind: "all" });
    const ids = captured.users.map((user) => String(user._id));
    expect(ids).toEqual(expect.arrayContaining([`${source}.alice`, `${source}.bob`]));
    expect(captured.roles.map((role) => String(role._id))).toEqual(
      expect.arrayContaining([`${source}.baseReader`, `${source}.editor`]),
    );
    // Trimmed to the stored document shape: no computed fields.
    expect(captured.users[0]).not.toHaveProperty("mechanisms");
    expect(captured.roles[0]).not.toHaveProperty("inheritedPrivileges");
  });
});

describe("restoring users and roles", () => {
  it("leaves them out by default", async () => {
    const target = uniqueDb("uskp");
    const result = await restoreInto(target, undefined);
    expect(result.usersAndRoles).toBeUndefined();
    expect((await usersOf(target)).size).toBe(0);
    expect((await rolesOf(target)).size).toBe(0);
  });

  it("recreates roles and users in a renamed database, password hashes included", async () => {
    const target = uniqueDb("ucrt");
    const result = await restoreInto(target, "create");

    expect(result.usersAndRoles).toMatchObject({
      mode: "create",
      method: "merge",
      rolesCreated: [`${target}.baseReader`, `${target}.editor`],
      usersCreated: [`${target}.alice`, `${target}.bob`],
      passwordResetRequired: [],
    });

    const roles = await rolesOf(target);
    expect(roles.get("editor")?.roles).toEqual([{ role: "baseReader", db: target }]);
    expect(roles.get("baseReader")?.privileges).toEqual([
      { resource: { db: target, collection: "things" }, actions: ["find"] },
    ]);

    const users = await usersOf(target);
    const alice = users.get("alice");
    expect(alice?.roles).toEqual([{ role: "editor", db: target }]);
    expect(alice?.customData).toEqual({ team: "data" });
    const original = (await usersOf(source)).get("alice");
    expect(alice?.credentials).toEqual(original?.credentials);
    expect(await canLogIn(target, "alice", ALICE_PASSWORD)).toBe(true);
    expect(await canLogIn(target, "alice", "not the password")).toBe(false);
  });

  it("keeps existing users and roles in create mode", async () => {
    const target = uniqueDb("ukep");
    await restoreInto(target, "create");
    await client()
      .db(target)
      .command({ updateUser: "bob", customData: { changed: true } });

    const again = await restoreInto(target, "create", "drop");
    expect(again.usersAndRoles).toMatchObject({
      rolesCreated: [],
      rolesKept: [`${target}.baseReader`, `${target}.editor`],
      usersCreated: [],
      usersKept: [`${target}.alice`, `${target}.bob`],
    });
    expect((await usersOf(target)).get("bob")?.customData).toEqual({ changed: true });
  });

  it("overwrites existing users and roles in replace mode, and nothing else", async () => {
    const target = uniqueDb("urpl");
    await restoreInto(target, "create");
    const db = client().db(target);
    await db.command({ updateUser: "alice", pwd: "changed-password", customData: { team: "x" } });
    await db.command({ updateRole: "baseReader", privileges: [] });
    await db.command({ createUser: "carol", pwd: "carol-password", roles: [] });

    const result = await restoreInto(target, "replace", "drop");
    expect(result.usersAndRoles).toMatchObject({
      mode: "replace",
      method: "merge",
      rolesReplaced: [`${target}.baseReader`, `${target}.editor`],
      usersReplaced: [`${target}.alice`, `${target}.bob`],
    });

    const users = await usersOf(target);
    expect(users.get("alice")?.customData).toEqual({ team: "data" });
    expect(await canLogIn(target, "alice", ALICE_PASSWORD)).toBe(true);
    expect(users.has("carol")).toBe(true);
    expect((await rolesOf(target)).get("baseReader")?.privileges).toEqual([
      { resource: { db: target, collection: "things" }, actions: ["find"] },
    ]);
  });

  it("restores only the users of databases the patterns select", async () => {
    const target = uniqueDb("uflt");
    databasesWithUsers.add(target);
    const result = await runRestore(
      { client: client(), storage, logger: silentLogger },
      {
        backup: manifest.id,
        include: [`${source}.things`],
        rename: { [`${source}.*`]: `${target}.*` },
        usersAndRoles: "create",
      },
    );
    expect(result.usersAndRoles?.usersCreated).toEqual([]);
    expect((await usersOf(target)).size).toBe(0);
  });

  it("falls back to createUser with a random password when hashes cannot be restored", async () => {
    const target = uniqueDb("ufbk");
    const certificate = `CN=${target}`;
    databasesWithUsers.add(target);
    await client().db(target).command({ createRole: "editor", privileges: [], roles: [] });
    const users: Document[] = [
      {
        _id: `${target}.dave`,
        user: "dave",
        db: target,
        credentials: { "SCRAM-SHA-256": {} },
        roles: [{ role: "editor", db: target }],
        customData: { team: "ops" },
      },
      {
        _id: `$external.${certificate}`,
        user: certificate,
        db: "$external",
        credentials: { external: true },
        roles: [],
      },
    ];

    const outcome = await createUsersWithoutCredentials(client(), users, {
      mode: "create",
      logger: silentLogger,
    });
    expect(outcome).toMatchObject({
      method: "createUser",
      usersCreated: [`${target}.dave`, `$external.${certificate}`],
      passwordResetRequired: [`${target}.dave`],
    });
    await client().db("$external").command({ dropUser: certificate });
    const dave = (await usersOf(target)).get("dave");
    expect(dave?.roles).toEqual([{ role: "editor", db: target }]);
    expect(dave?.customData).toEqual({ team: "ops" });
    expect(Object.keys(dave?.credentials ?? {})).toEqual(["SCRAM-SHA-256"]);
  });
});

describe("the CLI", () => {
  /** Runs the CLI like a script: no terminal, empty environment. */
  async function cli(args: readonly string[], cwd: string) {
    let stdout = "";
    let stderr = "";
    const sink = (append: (text: string) => void) =>
      new Writable({
        write(chunk: Buffer | string, _encoding, done) {
          append(chunk.toString());
          done();
        },
      });
    const code = await runCli(args, {
      stdout: sink((text) => {
        stdout += text;
      }),
      stderr: sink((text) => {
        stderr += text;
      }),
      env: {},
      cwd,
      isTTY: false,
    });
    return { code, stdout, stderr };
  }

  it("backs up with --users-and-roles and restores with --users-and-roles create", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "mongoshield-users-"));
    const target = uniqueDb("ucli");
    databasesWithUsers.add(target);
    try {
      const backup = await cli(
        [
          "backup",
          "--uri",
          mongoUri(),
          "--to",
          "./backups",
          "--include",
          `${source}.*`,
          "--consistency",
          "none",
          "--users-and-roles",
          "--quiet",
        ],
        workDir,
      );
      expect(backup.code, backup.stderr).toBe(0);

      const restore = await cli(
        [
          "restore",
          backup.stdout.trim(),
          "--from",
          "./backups",
          "--to-uri",
          mongoUri(),
          "--rename",
          `${source}.*=${target}.*`,
          "--users-and-roles",
          "create",
        ],
        workDir,
      );
      expect(restore.code, restore.stderr).toBe(0);
      expect(restore.stdout).toContain("Restored 2 roles and 2 users");
      expect([...(await usersOf(target)).keys()].sort()).toEqual(["alice", "bob"]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
