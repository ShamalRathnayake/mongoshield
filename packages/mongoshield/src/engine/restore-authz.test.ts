// Unit tests for choosing and renaming the users and roles a restore writes. The
// commands that write them are tested against a real server in
// test/integration/users-and-roles.test.ts.

import { type Document, UUID } from "mongodb";
import { describe, expect, it } from "vitest";
import { compileNamespaceFilter } from "../mongo/index.ts";
import { selectUsersAndRoles } from "./restore-authz.ts";
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
