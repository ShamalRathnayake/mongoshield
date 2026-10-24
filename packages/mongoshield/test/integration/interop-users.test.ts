// Users, custom roles and system.js through the real mongodump and mongorestore:
//
//   mongodump --db app --dumpDbUsersAndRoles (app/$admin.system.users.bson, …)  ┐
//   mongodump --db admin (admin/system.users.bson, …, the full-dump form)       ├→ importMongodump
//                                                                               ┘   → users/roles entries
//   mongoshield backup --users-and-roles → exportBackup → mongorestore --db app --restoreDbUsersAndRoles
//                                                       → mongorestore --nsInclude 'admin.*' (full form)
//
// Authorization is not enforced on the test replica set, but user management works and
// so does password authentication, which proves that password hashes survive.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BSON, Code, type Document, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { exportBackup } from "../../src/interop/export.ts";
import { importMongodump } from "../../src/interop/import.ts";
import { storedDocuments } from "../../src/interop/test-fixtures.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { tool, toolsMissing } from "../helpers/mongo-tools.ts";
import type { AnyDocument } from "./converge-test-utils.ts";

const client = useMongoClient();
const source = uniqueDb("iou");
const PASSWORDS = { alice: "correct horse battery staple", bob: "tr0ub4dor&3" };
const databases = new Set<string>([source]);

/** The raw `admin.system.users` / `admin.system.roles` documents of `database`, by `_id`. */
async function authzDocuments(collection: "system.users" | "system.roles", database: string) {
  const documents = new Map<string, Buffer>();
  const cursor = client().db("admin").collection(collection).find({ db: database }, { raw: true });
  for await (const raw of cursor) {
    const bytes = Buffer.from(raw as unknown as Uint8Array);
    documents.set(String(BSON.deserialize(bytes)._id), bytes);
  }
  return documents;
}

/** The user names of a database. */
async function userNames(database: string): Promise<string[]> {
  const reply = await client().db(database).command({ usersInfo: 1 });
  return (reply.users as Document[]).map((user) => String(user.user)).sort();
}

async function dropUsersAndRoles(database: string): Promise<void> {
  await client().db(database).command({ dropAllUsersFromDatabase: 1 });
  await client().db(database).command({ dropAllRolesFromDatabase: 1 });
}

/** True when `user` can log in with `password`. */
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

const temporaryPaths: string[] = [];
async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mongoshield-interop-users-"));
  temporaryPaths.push(path);
  return path;
}

describe.skipIf(toolsMissing)("users, roles and system.js with mongodump and mongorestore", () => {
  let expectedUsers: Map<string, Buffer>;
  let expectedRoles: Map<string, Buffer>;

  beforeAll(async () => {
    const db = client().db(source);
    await db.collection("things").insertMany([{ n: 1 }, { n: 2 }]);
    await db
      .collection<AnyDocument>("system.js")
      .insertOne({ _id: "add", value: new Code("function (a, b) { return a + b; }") });
    await db.command({
      createRole: "thingReader",
      privileges: [{ resource: { db: source, collection: "things" }, actions: ["find"] }],
      roles: [],
    });
    await db.command({
      createRole: "lead",
      privileges: [],
      roles: ["thingReader", { role: "read", db: source }],
    });
    await db.command({
      createUser: "alice",
      pwd: PASSWORDS.alice,
      roles: ["lead"],
      customData: { team: "ops" },
    });
    await db.command({
      createUser: "bob",
      pwd: PASSWORDS.bob,
      roles: [{ role: "readWrite", db: source }],
      mechanisms: ["SCRAM-SHA-256"],
    });
    expectedUsers = await authzDocuments("system.users", source);
    expectedRoles = await authzDocuments("system.roles", source);
    expect(expectedUsers.size).toBe(2);
    expect(expectedRoles.size).toBe(2);
  });

  afterAll(async () => {
    for (const database of databases) {
      await dropUsersAndRoles(database).catch(() => undefined);
      await client().db(database).dropDatabase();
    }
    for (const path of temporaryPaths) await rm(path, { recursive: true, force: true });
  });

  /** The imported users and roles must be the server's documents, byte for byte. */
  async function expectImportedAuthz(
    storage: StorageAdapter,
    result: Awaited<ReturnType<typeof importMongodump>>,
  ) {
    const authzTypes = result.manifest.namespaces.filter(
      (entry) => entry.type === "users" || entry.type === "roles",
    );
    expect(authzTypes.map((entry) => [entry.ns, entry.type])).toEqual([
      ["admin.system.roles", "roles"],
      ["admin.system.users", "users"],
    ]);
    const users = await storedDocuments(storage, result.manifest, "admin.system.users");
    const roles = await storedDocuments(storage, result.manifest, "admin.system.roles");
    expect(users).toEqual(
      [...expectedUsers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, bytes]) => bytes),
    );
    expect(roles).toEqual(
      [...expectedRoles.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, bytes]) => bytes),
    );
  }

  describe("mongodump → importMongodump", () => {
    it("imports --dumpDbUsersAndRoles users and roles, and system.js, from a directory", async () => {
      const out = await tempDirectory();
      await tool("mongodump", ["--db", source, "--dumpDbUsersAndRoles", "--out", out]);
      const storage = memoryStorage();
      const result = await importMongodump({ directory: out }, storage);
      expect(result.skipped).toEqual([
        {
          ns: `${source}.$admin.system.version`,
          reason: expect.stringContaining("auth schema version"),
        },
      ]);
      expect(result.manifest.namespaces.map((entry) => entry.ns)).toContain(`${source}.system.js`);
      await expectImportedAuthz(storage, result);

      // Restoring with MongoShield brings back users that can log in with their passwords.
      const target = uniqueDb("iou_r");
      databases.add(target);
      await runRestore(
        { client: client(), storage, logger: silentLogger },
        { backup: result.id, rename: { [`${source}.*`]: `${target}.*` }, usersAndRoles: "create" },
      );
      expect(await canLogIn(target, "alice", PASSWORDS.alice)).toBe(true);
      expect(await canLogIn(target, "bob", PASSWORDS.bob)).toBe(true);
      expect(await userNames(target)).toEqual(["alice", "bob"]);
      const js = await client().db(target).collection("system.js").find().toArray();
      expect(js.map((entry) => entry._id)).toEqual(["add"]);
    });

    it("imports --dumpDbUsersAndRoles users and roles from a gzipped archive", async () => {
      const archive = join(await tempDirectory(), "dump.archive.gz");
      await tool("mongodump", [
        "--db",
        source,
        "--dumpDbUsersAndRoles",
        `--archive=${archive}`,
        "--gzip",
      ]);
      const storage = memoryStorage();
      await expectImportedAuthz(storage, await importMongodump({ archive }, storage));
    });

    it("imports the users of the selected databases from a full dump's admin database", async () => {
      // `mongodump --db admin` writes admin/system.users.bson with every user of the server.
      const out = await tempDirectory();
      await tool("mongodump", ["--db", "admin", "--out", out]);
      const storage = memoryStorage();
      const result = await importMongodump({ directory: out }, storage, {
        include: [`${source}.*`],
      });
      await expectImportedAuthz(storage, result);
    });
  });

  describe("mongoshield backup → exportBackup → mongorestore", () => {
    let storage: StorageAdapter;
    let backupId: string;

    beforeAll(async () => {
      storage = memoryStorage();
      const result = await runBackup(
        {
          client: client(),
          storage,
          logger: silentLogger,
          compression: "zstd",
          encryption: undefined,
        },
        { include: [`${source}.*`], includeUsersAndRoles: true },
      );
      backupId = result.id;
    });

    async function expectRestoredUsers(): Promise<void> {
      // mongorestore merges the exported documents in unchanged (userId and hashes included).
      expect(await authzDocuments("system.users", source)).toEqual(expectedUsers);
      expect(await authzDocuments("system.roles", source)).toEqual(expectedRoles);
      expect(await canLogIn(source, "alice", PASSWORDS.alice)).toBe(true);
      expect(await canLogIn(source, "bob", PASSWORDS.bob)).toBe(true);
    }

    it("writes users and roles in both mongodump forms", async () => {
      const output = join(await tempDirectory(), "dump");
      const summary = await exportBackup(storage, backupId, { format: "directory", output });
      expect(summary.usersAndRoles).toEqual({ users: 2, roles: 2 });
      expect((await readdir(join(output, "admin"))).sort()).toEqual([
        "system.roles.bson",
        "system.users.bson",
        "system.version.bson",
      ]);
      expect((await readdir(join(output, source))).sort()).toEqual([
        "$admin.system.roles.bson",
        "$admin.system.users.bson",
        "$admin.system.version.bson",
        "system.js.bson",
        "system.js.metadata.json",
        "things.bson",
        "things.metadata.json",
      ]);
    });

    it("restores users with mongorestore --restoreDbUsersAndRoles from a directory", async () => {
      const output = join(await tempDirectory(), "dump");
      await exportBackup(storage, backupId, { format: "directory", output });
      await dropUsersAndRoles(source);
      await tool("mongorestore", [
        "--db",
        source,
        "--restoreDbUsersAndRoles",
        "--drop",
        join(output, source),
      ]);
      await expectRestoredUsers();
      const js = await client().db(source).collection("system.js").find().toArray();
      expect(js.map((entry) => entry._id)).toEqual(["add"]);
    });

    it("restores users with mongorestore --restoreDbUsersAndRoles from a gzipped archive", async () => {
      const output = join(await tempDirectory(), "backup.archive.gz");
      await exportBackup(storage, backupId, { format: "archive", output, gzip: true });
      await dropUsersAndRoles(source);
      await tool("mongorestore", [
        "--gzip",
        `--archive=${output}`,
        "--db",
        source,
        "--restoreDbUsersAndRoles",
        "--drop",
      ]);
      await expectRestoredUsers();
    });

    it("restores users with a full mongorestore from admin/system.users.bson", async () => {
      const output = join(await tempDirectory(), "dump");
      await exportBackup(storage, backupId, { format: "directory", output });
      await dropUsersAndRoles(source);
      await tool("mongorestore", ["--dir", output, "--nsInclude", "admin.*"]);
      await expectRestoredUsers();
    });

    it("leaves out users and roles when the patterns do not select their database", async () => {
      // Like restore: `app.things` selects one collection, `app.*` would select app's users.
      const output = join(await tempDirectory(), "dump");
      const summary = await exportBackup(storage, backupId, {
        format: "directory",
        output,
        include: [`${source}.things`],
      });
      expect(summary.usersAndRoles).toEqual({ users: 0, roles: 0 });
      expect(await readdir(output)).not.toContain("admin");
    });
  });
});
