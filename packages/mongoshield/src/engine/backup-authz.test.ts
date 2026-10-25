// Unit tests for capturing users and roles (backup-authz.ts) through a fake client:
// which databases are asked for roles when backing up everything, how odd replies
// are tolerated, and how a missing privilege is reported. Capturing from a real
// server is tested in test/integration/users-and-roles.test.ts.

import { BSON, type Document, type MongoClient, MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { captureUsersAndRoles } from "./backup-authz.ts";

/**
 * Replies by database and command name; a function reply may throw. Fields asked for
 * with `fieldsAsRaw` (the users and roles arrays) are returned as raw BSON elements,
 * as the driver does.
 */
type Replies = Record<string, Record<string, Document | (() => Document)>>;

function fakeClient(replies: Replies, databases: readonly string[] = []) {
  const asked: string[] = [];
  const fake = {
    db: (database: string) => ({
      admin: () => ({
        listDatabases: async () => ({ databases: databases.map((name) => ({ name })) }),
      }),
      command: async (command: Document, options?: { fieldsAsRaw?: Document }) => {
        const name = Object.keys(command)[0] ?? "";
        asked.push(`${database}.${name}`);
        const stored = replies[database]?.[name];
        const reply = (typeof stored === "function" ? stored() : stored) ?? {};
        return asRaw(reply, Object.keys(options?.fieldsAsRaw ?? {}));
      },
    }),
  };
  return { client: fake as unknown as MongoClient, asked };
}

/** `reply` with the documents of the named array fields serialized to BSON. */
function asRaw(reply: Document, fields: readonly string[]): Document {
  const raw: Document = { ...reply };
  for (const field of fields) {
    const value: unknown = reply[field];
    if (!Array.isArray(value)) continue;
    raw[field] = value.map((item: unknown) =>
      typeof item === "object" && item !== null ? BSON.serialize(item) : item,
    );
  }
  return raw;
}

describe("captureUsersAndRoles", () => {
  it("asks every database a user or a user's role belongs to for roles, except $external", async () => {
    const { client, asked } = fakeClient(
      {
        admin: {
          usersInfo: {
            users: [
              {
                _id: "reports.ada",
                db: "reports",
                user: "ada",
                roles: [{ role: "auditor", db: "audit" }, "not a document", { role: "x" }],
                // Computed by the server, not part of the user.
                inheritedRoles: [],
              },
              { _id: "$external.CN=bob", db: "$external", user: "CN=bob", roles: "oops" },
              { _id: "nodb", user: "odd" },
            ],
          },
          rolesInfo: { roles: [{ _id: "admin.ops", role: "ops", db: "admin" }] },
        },
        audit: {
          rolesInfo: {
            roles: [
              { _id: "audit.auditor", role: "auditor", db: "audit", inheritedPrivileges: [] },
              { _id: "audit.auditor", role: "auditor", db: "audit" },
            ],
          },
        },
      },
      ["app", "admin"],
    );
    const captured = await captureUsersAndRoles(client, { kind: "all" });
    const rolesAsked = asked.filter((entry) => entry.endsWith(".rolesInfo")).sort();
    expect(rolesAsked).toEqual([
      "admin.rolesInfo",
      "app.rolesInfo",
      "audit.rolesInfo",
      "reports.rolesInfo",
    ]);
    expect(captured.users.map((user) => user._id)).toEqual([
      "$external.CN=bob",
      "nodb",
      "reports.ada",
    ]);
    expect(captured.users[2]).not.toHaveProperty("inheritedRoles");
    expect(captured.roles.map((role) => role._id)).toEqual([
      "admin.ops",
      "audit.auditor",
      "audit.auditor",
    ]);
    expect(captured.roles[1]).not.toHaveProperty("inheritedPrivileges");
  });

  it("asks only the backed-up databases, and ignores replies without arrays", async () => {
    const { client, asked } = fakeClient({ app: { usersInfo: { users: "none" }, rolesInfo: {} } });
    const captured = await captureUsersAndRoles(client, { kind: "databases", databases: ["app"] });
    expect(captured).toEqual({ users: [], roles: [] });
    expect(asked).toEqual(["app.usersInfo", "app.rolesInfo"]);
  });

  it("names the missing privileges when the server refuses", async () => {
    const { client } = fakeClient({
      app: {
        usersInfo: () => {
          throw new MongoServerError({ message: "not authorized on app", code: 13 });
        },
      },
    });
    const error: unknown = await captureUsersAndRoles(client, {
      kind: "databases",
      databases: ["app"],
    }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_PERMISSION_DENIED")).toBe(true);
    expect(isMongoShieldError(error) ? error.hint : "").toMatch(/viewUser and viewRole/);
  });

  it("reports other failures as backup errors", async () => {
    const { client } = fakeClient({
      app: {
        usersInfo: () => {
          throw new Error("connection reset");
        },
      },
    });
    const error: unknown = await captureUsersAndRoles(client, {
      kind: "databases",
      databases: ["app"],
    }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error)).toBe(true);
    expect(isMongoShieldError(error, "MS_PERMISSION_DENIED")).toBe(false);
  });

  it("stops when aborted", async () => {
    const { client } = fakeClient({});
    const controller = new AbortController();
    controller.abort();
    const error: unknown = await captureUsersAndRoles(
      client,
      { kind: "databases", databases: ["app"] },
      controller.signal,
    ).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
  });
});
