// Integration tests for checkPrivileges / assertPrivileges.
//
// The test server runs without access control, so an unauthenticated client is allowed
// everything. Users can still be created and authenticated, and `connectionStatus`
// reports their privileges, so the matching logic is tested with real role data.

import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../../src/errors.ts";
import { assertPrivileges, checkPrivileges } from "../../src/mongo/index.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const adminClient = useMongoClient();
const database = uniqueDb("priv");
const password = "privilege-test-pw";

/** Clients opened as test users, closed after the file. */
const userClients: MongoClient[] = [];

function uriWithCredentials(user: string, authSource: string): string {
  const url = new URL(mongoUri());
  url.username = user;
  url.password = password;
  url.searchParams.set("authSource", authSource);
  return url.toString();
}

/** Creates a user in `userDb` with the given roles and returns a client logged in as it. */
async function clientWithRoles(
  name: string,
  roles: readonly (string | { role: string; db: string })[],
  userDb = database,
): Promise<MongoClient> {
  await adminClient().db(userDb).command({ createUser: name, pwd: password, roles });
  const client = new MongoClient(uriWithCredentials(name, userDb));
  userClients.push(client);
  return client;
}

beforeAll(async () => {
  await adminClient().db(database).collection("orders").insertOne({ total: 1 });
  // A role that may read one collection only.
  await adminClient()
    .db(database)
    .command({
      createRole: "ordersReader",
      privileges: [
        { resource: { db: database, collection: "orders" }, actions: ["find", "listIndexes"] },
        { resource: { db: database, collection: "" }, actions: ["listCollections"] },
      ],
      roles: [],
    });
  // A role with a database-wide resource only (built-in roles also name system.js).
  await adminClient()
    .db(database)
    .command({
      createRole: "databaseWriter",
      privileges: [
        {
          resource: { db: database, collection: "" },
          actions: [
            "listCollections",
            "insert",
            "createCollection",
            "createIndex",
            "dropCollection",
          ],
        },
      ],
      roles: [],
    });
});

afterAll(async () => {
  for (const client of userClients) await client.close();
  const db = adminClient().db(database);
  await db.command({ dropAllUsersFromDatabase: 1 });
  await db.command({ dropAllRolesFromDatabase: 1 });
  await db.dropDatabase();
  const admin = adminClient().db("admin");
  for (const user of [`backup_${database}`, `restore_${database}`]) {
    await admin.command({ dropUser: user }).catch(() => undefined);
  }
});

describe("checkPrivileges", () => {
  it("allows everything when no user is authenticated (auth disabled)", async () => {
    const result = await checkPrivileges(adminClient(), {
      operation: "restore",
      databases: [database],
      allDatabases: true,
    });
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it("passes a backup for a user with the read role on the database", async () => {
    const reader = await clientWithRoles("reader", [{ role: "read", db: database }]);
    const result = await checkPrivileges(reader, { operation: "backup", databases: [database] });
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it("reports every missing restore action for a read-only user", async () => {
    const reader = await clientWithRoles("reader2", [{ role: "read", db: database }]);
    const result = await checkPrivileges(reader, { operation: "restore", databases: [database] });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      `insert on database ${database}`,
      `createCollection on database ${database}`,
      `createIndex on database ${database}`,
      `dropCollection on database ${database}`,
    ]);
  });

  it("requires listDatabases for an all-database backup", async () => {
    const reader = await clientWithRoles("reader3", [{ role: "read", db: database }]);
    const result = await checkPrivileges(reader, {
      operation: "backup",
      databases: [database],
      allDatabases: true,
    });
    expect(result.missing).toEqual(["listDatabases on the cluster"]);
  });

  it("reports databases the user cannot read", async () => {
    const reader = await clientWithRoles("reader4", [{ role: "read", db: database }]);
    const other = uniqueDb("other");
    const result = await checkPrivileges(reader, { operation: "backup", databases: [other] });
    expect(result.missing).toEqual([
      `listCollections on database ${other}`,
      `find on database ${other}`,
      `listIndexes on database ${other}`,
    ]);
  });

  it("accepts collection-level grants when namespaces are given", async () => {
    const narrow = await clientWithRoles("narrow", [{ role: "ordersReader", db: database }]);
    const byNamespace = await checkPrivileges(narrow, {
      operation: "backup",
      databases: [database],
      namespaces: [`${database}.orders`],
    });
    expect(byNamespace).toEqual({ ok: true, missing: [] });

    const byDatabase = await checkPrivileges(narrow, {
      operation: "backup",
      databases: [database],
    });
    expect(byDatabase.missing).toEqual([
      `find on database ${database}`,
      `listIndexes on database ${database}`,
    ]);

    const otherCollection = await checkPrivileges(narrow, {
      operation: "backup",
      databases: [database],
      namespaces: [`${database}.customers`],
    });
    expect(otherCollection.missing).toEqual([
      `find on ${database}.customers`,
      `listIndexes on ${database}.customers`,
    ]);
  });

  it("does not let a database-wide grant cover system collections", async () => {
    const writer = await clientWithRoles("writer", [{ role: "databaseWriter", db: database }]);
    const result = await checkPrivileges(writer, {
      operation: "restore",
      databases: [database],
      namespaces: [`${database}.orders`, `${database}.system.js`],
    });
    // `{ db, collection: "" }` covers non-system collections only, as on the server.
    expect(result.missing).toEqual([
      `insert on ${database}.system.js`,
      `createCollection on ${database}.system.js`,
      `createIndex on ${database}.system.js`,
      `dropCollection on ${database}.system.js`,
    ]);
  });

  it("checks extra actions such as update for upsert restores", async () => {
    const writer = await clientWithRoles("writer2", [{ role: "readWrite", db: database }]);
    const result = await checkPrivileges(writer, {
      operation: "restore",
      databases: [database],
      extraActions: ["update", "find"],
    });
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it("passes the built-in backup and restore roles", async () => {
    const backup = await clientWithRoles(`backup_${database}`, ["backup"], "admin");
    const restore = await clientWithRoles(`restore_${database}`, ["restore"], "admin");
    const namespaces = [`${database}.orders`, `${database}.system.js`];

    expect(
      await checkPrivileges(backup, {
        operation: "backup",
        databases: [database],
        namespaces,
        allDatabases: true,
      }),
    ).toEqual({ ok: true, missing: [] });
    expect(
      await checkPrivileges(restore, { operation: "restore", databases: [database], namespaces }),
    ).toEqual({ ok: true, missing: [] });
  });

  it("shows that the restore role cannot update (upserts need readWrite)", async () => {
    const restore = new MongoClient(uriWithCredentials(`restore_${database}`, "admin"));
    userClients.push(restore);
    const result = await checkPrivileges(restore, {
      operation: "restore",
      databases: [database],
      extraActions: ["update"],
    });
    expect(result.missing).toEqual([`update on database ${database}`]);
  });
});

describe("assertPrivileges", () => {
  it("returns quietly when everything is granted", async () => {
    await expect(
      assertPrivileges(adminClient(), { operation: "backup", databases: [database] }),
    ).resolves.toBeUndefined();
  });

  it("throws MS_PERMISSION_DENIED naming the built-in role", async () => {
    const reader = await clientWithRoles("reader5", [{ role: "read", db: database }]);
    let caught: unknown;
    try {
      await assertPrivileges(reader, { operation: "restore", databases: [database] });
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_PERMISSION_DENIED")).toBe(true);
    if (!isMongoShieldError(caught)) return;
    expect(caught.message).toContain(`insert on database ${database}`);
    expect(caught.hint).toContain("`restore`");
    expect(caught.details).toMatchObject({ operation: "restore" });
  });
});
