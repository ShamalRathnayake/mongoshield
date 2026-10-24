// Integration tests for the user-management steps of restore-authz.ts, called directly
// with hand-made users and roles: replacing roles with their full definition, inherited
// roles, the createUser fallback for every kind of user, and how server refusals are
// reported. The full backup → restore round trip is in users-and-roles.test.ts.

import type { Document } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import {
  createUsersWithoutCredentials,
  restoreRoles,
  restoreUsers,
} from "../../src/engine/restore-authz.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { silentLogger } from "../../src/logger.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const databases: string[] = [];

/** A database for one test; its users and roles are dropped at the end. */
function newDatabase(): string {
  const database = uniqueDb("authz");
  databases.push(database);
  return database;
}

/** Users created in `$external`, dropped at the end. */
const externalUsers: string[] = [];

afterAll(async () => {
  for (const user of externalUsers) {
    await client().db("$external").command({ dropUser: user });
  }
  for (const database of databases) {
    await client().db(database).command({ dropAllUsersFromDatabase: 1 });
    await client().db(database).command({ dropAllRolesFromDatabase: 1 });
  }
});

async function roleInfo(database: string, role: string): Promise<Document | undefined> {
  const reply = await client()
    .db(database)
    .command({ rolesInfo: role, showPrivileges: true, showAuthenticationRestrictions: true });
  return (reply.roles as Document[])[0];
}

async function userInfo(database: string, user: string): Promise<Document | undefined> {
  const reply = await client().db(database).command({ usersInfo: user, showCustomData: true });
  return (reply.users as Document[])[0];
}

const findOn = (database: string, collection: string) => ({
  resource: { db: database, collection },
  actions: ["find"],
});

describe("restoreRoles", () => {
  it("creates roles first, then grants the roles they inherit from each other", async () => {
    const database = newDatabase();
    const outcome = await restoreRoles(
      client(),
      [
        // `child` inherits from `parent`, which comes later in the list.
        {
          _id: `${database}.child`,
          role: "child",
          db: database,
          privileges: [findOn(database, "a")],
          roles: [{ role: "parent", db: database }],
        },
        {
          _id: `${database}.parent`,
          role: "parent",
          db: database,
          privileges: [findOn(database, "b")],
          roles: [],
          authenticationRestrictions: [{ clientSource: ["127.0.0.1"] }],
        },
      ],
      { mode: "create", logger: silentLogger },
    );
    expect(outcome.rolesCreated).toEqual([`${database}.child`, `${database}.parent`]);
    expect((await roleInfo(database, "child"))?.roles).toEqual([{ role: "parent", db: database }]);
    expect((await roleInfo(database, "parent"))?.authenticationRestrictions).toEqual([
      [{ clientSource: ["127.0.0.1"] }],
    ]);
  });

  it("replaces an existing role's privileges, roles and restrictions in replace mode", async () => {
    const database = newDatabase();
    await client()
      .db(database)
      .command({ createRole: "r", privileges: [findOn(database, "old")], roles: [] });
    const role = {
      _id: `${database}.r`,
      role: "r",
      db: database,
      privileges: [findOn(database, "new")],
      roles: [{ role: "read", db: database }],
    };

    const kept = await restoreRoles(client(), [role], { mode: "create", logger: silentLogger });
    expect(kept).toEqual({ rolesCreated: [], rolesReplaced: [], rolesKept: [`${database}.r`] });
    expect((await roleInfo(database, "r"))?.privileges).toEqual([findOn(database, "old")]);

    const added = {
      _id: `${database}.added`,
      role: "added",
      db: database,
      privileges: [],
      roles: [],
    };
    const replaced = await restoreRoles(client(), [role, added], {
      mode: "replace",
      logger: silentLogger,
    });
    expect(replaced.rolesCreated).toEqual([`${database}.added`]);
    expect(replaced.rolesReplaced).toEqual([`${database}.r`]);
    const info = await roleInfo(database, "r");
    expect(info?.privileges).toEqual([findOn(database, "new")]);
    expect(info?.roles).toEqual([{ role: "read", db: database }]);
  });

  it("reports a role the server refuses as MS_RESTORE_FAILED, naming the step", async () => {
    const database = newDatabase();
    const error = await restoreRoles(
      client(),
      [
        {
          _id: `${database}.bad`,
          role: "bad",
          db: database,
          privileges: [{ resource: { db: database, collection: "" }, actions: ["noSuchAction"] }],
        },
      ],
      { mode: "create", logger: silentLogger },
    ).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_RESTORE_FAILED")).toBe(true);
    expect(String(error)).toContain(`Creating role ${database}.bad failed`);
  });

  it("reports a database whose roles cannot be listed", async () => {
    const error = await restoreRoles(client(), [{ _id: "bad name.r", role: "r", db: "bad name" }], {
      mode: "create",
      logger: silentLogger,
    }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error)).toBe(true);
  });
});

describe("createUsersWithoutCredentials", () => {
  it("creates password, external and passwordless users with the right options", async () => {
    const database = newDatabase();
    const externalUser = `CN=${database}`;
    externalUsers.push(externalUser);
    const outcome = await createUsersWithoutCredentials(
      client(),
      [
        {
          _id: `${database}.scram`,
          user: "scram",
          db: database,
          credentials: { "SCRAM-SHA-256": {} },
          roles: [{ role: "read", db: database }],
          customData: { team: "billing" },
          authenticationRestrictions: [{ clientSource: ["127.0.0.1"] }],
        },
        // No SCRAM credentials recorded: the server picks the default mechanisms.
        { _id: `${database}.plain`, user: "plain", db: database, roles: [] },
        // Authenticated outside MongoDB (x.509, LDAP, …): no password at all.
        {
          _id: `$external.${externalUser}`,
          user: externalUser,
          db: "$external",
          credentials: { external: true },
          roles: [],
        },
      ],
      { mode: "create", logger: silentLogger },
    );
    expect(outcome).toMatchObject({
      method: "createUser",
      usersCreated: [`${database}.scram`, `${database}.plain`, `$external.${externalUser}`],
      passwordResetRequired: [`${database}.scram`, `${database}.plain`],
    });
    expect(await userInfo("$external", externalUser)).toBeDefined();
    const scram = await userInfo(database, "scram");
    expect(scram?.customData).toEqual({ team: "billing" });
    expect(scram?.mechanisms).toEqual(["SCRAM-SHA-256"]);
  });

  it("keeps existing users in create mode and updates them (not their password) in replace mode", async () => {
    const database = newDatabase();
    await client()
      .db(database)
      .command({ createUser: "u", pwd: "secret", roles: [], customData: { v: 1 } });
    const user = {
      _id: `${database}.u`,
      user: "u",
      db: database,
      roles: [{ role: "read", db: database }],
      customData: { v: 2 },
    };

    const kept = await createUsersWithoutCredentials(client(), [user], {
      mode: "create",
      logger: silentLogger,
    });
    expect(kept.usersKept).toEqual([`${database}.u`]);

    const replaced = await createUsersWithoutCredentials(client(), [user], {
      mode: "replace",
      logger: silentLogger,
    });
    expect(replaced.usersReplaced).toEqual([`${database}.u`]);
    expect(replaced.passwordResetRequired).toEqual([]);
    const info = await userInfo(database, "u");
    expect(info?.customData).toEqual({ v: 2 });
    expect(info?.roles).toEqual([{ role: "read", db: database }]);
  });
});

describe("restoreUsers", () => {
  it("writes nothing and keeps everyone when every user exists in create mode", async () => {
    const database = newDatabase();
    await client().db(database).command({ createUser: "kept", pwd: "secret", roles: [] });
    const outcome = await restoreUsers(
      client(),
      [{ _id: `${database}.kept`, user: "kept", db: database, roles: [] }],
      { mode: "create", logger: silentLogger },
    );
    expect(outcome).toEqual({
      usersCreated: [],
      usersReplaced: [],
      usersKept: [`${database}.kept`],
      method: "merge",
      passwordResetRequired: [],
    });
  });
});
