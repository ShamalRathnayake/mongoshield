// Unit tests for choosing and renaming the users and roles a restore writes. The
// commands that write them are tested against a real server in
// test/integration/users-and-roles.test.ts.

import { type Document, UUID } from "mongodb";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import { compileNamespaceFilter } from "../mongo/index.ts";
import { memoryStorage } from "../storage/memory.ts";
import { sourceFromManifest } from "./read-pipeline.ts";
import { planUsersAndRoles, readUsersAndRoles, selectUsersAndRoles } from "./restore-authz.ts";
import { compileRenameMap } from "./restore-rename.ts";

const userId = new UUID();

const BACKUP: { users: Document[]; roles: Document[] } = {
  users: [
    {
      _id: "app.alice",
      userId,
      user: "alice",
      db: "app",
      credentials: {
        "SCRAM-SHA-256": { iterationCount: 15000, salt: "s", storedKey: "k", serverKey: "v" },
      },
      roles: [
        { role: "readWrite", db: "app" },
        { role: "reporting", db: "app" },
        { role: "clusterMonitor", db: "admin" },
      ],
    },
    { _id: "admin.root", user: "root", db: "admin", roles: [{ role: "root", db: "admin" }] },
  ],
  roles: [
    {
      _id: "app.reporting",
      role: "reporting",
      db: "app",
      privileges: [
        { resource: { db: "app", collection: "orders" }, actions: ["find"] },
        { resource: { db: "app", collection: "" }, actions: ["listCollections"] },
        { resource: { db: "", collection: "" }, actions: ["find"] },
        { resource: { cluster: true }, actions: ["serverStatus"] },
      ],
      roles: [{ role: "read", db: "app" }],
    },
  ],
};

const everything = {
  filter: compileNamespaceFilter({}),
  rename: compileRenameMap(undefined),
};

describe("selectUsersAndRoles", () => {
  it("keeps everything as it was without patterns or renames", () => {
    const selected = selectUsersAndRoles(BACKUP, everything);
    expect(selected.users).toEqual(BACKUP.users);
    expect(selected.roles).toEqual(BACKUP.roles);
  });

  it("keeps only the databases the include/exclude patterns select", () => {
    const appOnly = selectUsersAndRoles(BACKUP, {
      ...everything,
      filter: compileNamespaceFilter({ include: ["app.*"] }),
    });
    expect(appOnly.users.map((user) => user._id)).toEqual(["app.alice"]);
    expect(appOnly.roles.map((role) => role._id)).toEqual(["app.reporting"]);

    const oneCollection = selectUsersAndRoles(BACKUP, {
      ...everything,
      filter: compileNamespaceFilter({ include: ["app.orders"] }),
    });
    expect(oneCollection.users).toEqual([]);

    const excluded = selectUsersAndRoles(BACKUP, {
      ...everything,
      filter: compileNamespaceFilter({ exclude: ["admin.*"] }),
    });
    expect(excluded.users.map((user) => user._id)).toEqual(["app.alice"]);
  });

  it("moves users and roles of a renamed database, with their references", () => {
    const selected = selectUsersAndRoles(BACKUP, {
      filter: compileNamespaceFilter({ include: ["app.*"] }),
      rename: compileRenameMap({ "app.*": "app2.*", "app.orders": "app2.purchases" }),
    });
    const [alice] = selected.users;
    expect(alice?._id).toBe("app2.alice");
    expect(alice?.db).toBe("app2");
    expect(alice?.roles).toEqual([
      { role: "readWrite", db: "app2" },
      { role: "reporting", db: "app2" },
      { role: "clusterMonitor", db: "admin" },
    ]);
    // A different user than the original, which may still exist: a new userId.
    expect(alice?.userId).toBeInstanceOf(UUID);
    expect(String(alice?.userId)).not.toBe(String(userId));
    // The password hashes are kept as they are (they do not depend on the database).
    expect(alice?.credentials).toEqual(BACKUP.users[0]?.credentials);

    const [reporting] = selected.roles;
    expect(reporting?._id).toBe("app2.reporting");
    expect(reporting?.db).toBe("app2");
    expect(reporting?.roles).toEqual([{ role: "read", db: "app2" }]);
    expect(reporting?.privileges).toEqual([
      { resource: { db: "app2", collection: "purchases" }, actions: ["find"] },
      { resource: { db: "app2", collection: "" }, actions: ["listCollections"] },
      { resource: { db: "", collection: "" }, actions: ["find"] },
      { resource: { cluster: true }, actions: ["serverStatus"] },
    ]);
  });

  it("keeps the userId when the database is not renamed", () => {
    const selected = selectUsersAndRoles(BACKUP, everything);
    expect(selected.users[0]?.userId).toBe(userId);
  });
});

describe("selectUsersAndRoles with incomplete documents", () => {
  it("skips users and roles without a name or database, and keeps odd references as they are", () => {
    const selected = selectUsersAndRoles(
      {
        users: [
          { _id: "x", db: "app" },
          { _id: "y", user: "nodb" },
          { _id: "app.bob", user: "bob", db: "app", roles: [{ role: "custom" }, "not a document"] },
        ],
        roles: [
          { _id: "z", role: "nodb" },
          {
            _id: "app.r",
            role: "r",
            db: "app",
            privileges: [{ resource: "nonsense", actions: ["find"] }, { actions: ["find"] }],
          },
        ],
      },
      { filter: compileNamespaceFilter({}), rename: compileRenameMap({ "app.*": "app2.*" }) },
    );
    expect(selected.users).toEqual([
      // No userId in the backup: none is invented for the moved user.
      { _id: "app2.bob", user: "bob", db: "app2", roles: [{ role: "custom" }] },
    ]);
    expect(selected.roles).toEqual([
      {
        _id: "app2.r",
        role: "r",
        db: "app2",
        privileges: [{ resource: "nonsense", actions: ["find"] }, { actions: ["find"] }],
        roles: [],
      },
    ]);
  });
});

/** A manifest with only the fields planUsersAndRoles reads. */
function manifestWith(namespaces: Manifest["namespaces"]): Manifest {
  return {
    formatVersion: 1,
    id: "2026-01-01T00-00-00Z_abcdef",
    tool: "test",
    status: "complete",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    source: { topology: "replicaSet", serverVersion: "7.0.0" },
    consistency: { mode: "none" },
    compression: "none",
    encryption: null,
    labels: {},
    namespaces,
    totals: { namespaces: namespaces.length, documents: 0, bytesRaw: 0, bytesStored: 0 },
  };
}

/** A logger that records which level each message was logged at. */
function levelLogger(messages: string[]): Logger {
  return {
    debug: () => {},
    info: (message) => messages.push(`info: ${message}`),
    warn: (message) => messages.push(`warn: ${message}`),
    error: () => {},
  };
}

const USERS_ENTRY: Manifest["namespaces"][number] = {
  ns: "admin.system.users",
  db: "admin",
  collection: "system.users",
  type: "users",
  documents: 0,
  bytesRaw: 0,
  files: [],
  metadata: { key: "admin/system.users.metadata.json", size: 0, sha256: "0".repeat(64) },
};

describe("planUsersAndRoles", () => {
  const storage = memoryStorage();
  const plan = (mode: "skip" | "create" | undefined, manifest: Manifest, messages: string[]) =>
    planUsersAndRoles({
      mode,
      manifest,
      source: sourceFromManifest(storage, manifest, undefined),
      filter: compileNamespaceFilter({}),
      rename: compileRenameMap(undefined),
      logger: levelLogger(messages),
      signal: undefined,
    });

  it("says so when the backup holds users and roles that are skipped", async () => {
    const messages: string[] = [];
    expect(await plan(undefined, manifestWith([USERS_ENTRY]), messages)).toBeUndefined();
    expect(messages).toEqual([expect.stringMatching(/^info: The backup holds users and roles/)]);
    const quiet: string[] = [];
    expect(await plan("skip", manifestWith([]), quiet)).toBeUndefined();
    expect(quiet).toEqual([]);
  });

  it("warns when users and roles are asked for but the backup has none", async () => {
    const messages: string[] = [];
    expect(await plan("create", manifestWith([]), messages)).toBeUndefined();
    expect(messages).toEqual([expect.stringMatching(/^warn: The backup holds no users and roles/)]);
  });

  it("reads nothing from a backup without users and roles", async () => {
    const manifest = manifestWith([]);
    expect(
      await readUsersAndRoles(
        sourceFromManifest(storage, manifest, undefined),
        manifest,
        undefined,
      ),
    ).toBeUndefined();
  });

  it("selects users from an entry with no data files (an empty users collection)", async () => {
    const messages: string[] = [];
    const planned = await plan("create", manifestWith([USERS_ENTRY]), messages);
    expect(planned).toEqual({ mode: "create", users: [], roles: [] });
    expect(messages).toEqual(["info: Users and roles to restore"]);
  });
});
