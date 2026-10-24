/**
 * Inspecting a live deployment for the connection pages, against the real test
 * replica set: the privilege check for a limited and a fully privileged user,
 * a URI that sets its own server selection timeout, and the namespace tree with
 * views, time series collections and hidden system collections.
 */

import { randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { namespaceTree, testConnection } from "../../src/server/mongo-inspect.ts";
import { mongoUri, uniqueDb, uriWithPassword } from "../helpers/console.ts";

const db = uniqueDb("inspect");
let client: MongoClient;

/** A URI that authenticates as a new user with `roles`. */
async function uriForRoles(roles: { role: string; db: string }[]): Promise<string> {
  const username = `inspect_${randomBytes(4).toString("hex")}`;
  const password = `Pw-${randomBytes(8).toString("hex")}`;
  await client.db("admin").command({ createUser: username, pwd: password, roles });
  const url = new URL(mongoUri());
  url.username = username;
  url.password = password;
  url.searchParams.set("authSource", "admin");
  return url.toString();
}

beforeAll(async () => {
  client = new MongoClient(mongoUri());
  await client.connect();
  const database = client.db(db);
  await database.collection<{ _id: number }>("users").insertMany([{ _id: 1 }, { _id: 2 }]);
  await database.createCollection("active_users", {
    viewOn: "users",
    pipeline: [{ $match: { _id: 1 } }],
  });
  await database.createCollection("metrics", { timeseries: { timeField: "at" } });
});

afterAll(async () => {
  await client.db(db).dropDatabase();
  await client.close();
});

describe("testConnection", () => {
  it("reports what a read-only user is missing for backups and restores", async () => {
    const result = await testConnection(await uriForRoles([{ role: "read", db }]));
    expect(result.ok).toBe(true);
    expect(result.topology).toBe("replicaSet");
    expect(result.missingBackupPrivileges).toContain("listDatabases on the cluster");
    expect(result.missingBackupPrivileges).toContain("find on all databases");
    expect(result.missingRestorePrivileges).toContain("insert on all databases");
  });

  it("reports nothing missing for a fully privileged user", async () => {
    const { uri } = await uriWithPassword();
    const result = await testConnection(uri);
    expect(result).toMatchObject({
      ok: true,
      missingBackupPrivileges: [],
      missingRestorePrivileges: [],
    });
    expect(result.serverVersion).toMatch(/^\d+\.\d+/);
  });

  it("keeps the URI's own server selection timeout and scrubs the password on failure", async () => {
    const result = await testConnection(
      "mongodb://app:Inspect-Secret-1@127.0.0.1:9/?serverSelectionTimeoutMS=200",
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MS_CONNECTION_FAILED");
    expect(JSON.stringify(result)).not.toContain("Inspect-Secret-1");
  });
});

describe("namespaceTree", () => {
  it("lists collections, views and time series without system collections", async () => {
    const tree = await namespaceTree(mongoUri());
    const node = tree.find((database) => database.name === db);
    expect(node?.collections).toEqual([
      { name: "active_users", type: "view", estimatedDocuments: 0, indexes: 0 },
      expect.objectContaining({ name: "metrics", type: "timeseries" }),
      { name: "users", type: "collection", estimatedDocuments: 2, indexes: 1 },
    ]);
    expect(tree.some((database) => ["admin", "config", "local"].includes(database.name))).toBe(
      false,
    );
  });
});
