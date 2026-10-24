// A replica set with access control on (`--auth`, a keyfile and a root user created by
// the harness), where the server enforces every privilege. The single-node set the
// integration tests use runs without access control, so this is the only place that
// proves MongoShield works, or fails, exactly as documented for each role:
//
//   role                         backup             restore              notes
//   backup (admin)               yes, `auto`→none   MS_PERMISSION_DENIED no change streams
//   restore (admin)              MS_PERMISSION_…    yes, bypasses        no find/update
//                                                   validation
//   readAnyDatabase (admin)      yes, converge      MS_PERMISSION_DENIED
//   readWrite (one database)     that database      that database,       no bypass…Validation
//                                                   with validation
//   read (one database)          that database      MS_PERMISSION_DENIED
//   mongoshieldBackup (custom)   yes, converge                           least privilege
//
// Plus: users and roles round trips (`_mergeAuthzCollections` with the `restore` role,
// the `createUser` fallback without it), wrong passwords (MS_AUTH_FAILED), and no
// password ever showing up in an error, a hint, its details or a log line.

import type { Document } from "mongodb";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../../src/errors.ts";
import type { LogFields, Logger } from "../../src/logger.ts";
import { MongoShield } from "../../src/shield.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import type { SourceOptions } from "../../src/types.ts";
import { uniqueDb } from "../helpers/mongo.ts";
import { type ReplicaSetDeployment, ROOT_PASSWORD, startReplicaSet } from "./deployments.ts";

let deployment: ReplicaSetDeployment;
const source = uniqueDb("ac_src");
const storage = memoryStorage();
/** Every log line any shield in this file wrote, as text, to search for passwords. */
const logLines: string[] = [];
/** Every error any test caught, to search for passwords. */
const caughtErrors: unknown[] = [];
const shields: MongoShield[] = [];

/**
 * The least-privilege role for converge backups, as documented in
 * docs/specs/CONSISTENCY.md ("Least-privilege role"): read and watch every database,
 * list databases. Nothing else.
 */
const LEAST_PRIVILEGE_ROLE: Document = {
  createRole: "mongoshieldBackup",
  privileges: [
    {
      resource: { db: "", collection: "" },
      actions: ["find", "changeStream", "listCollections", "listIndexes", "collStats"],
    },
    { resource: { cluster: true }, actions: ["listDatabases"] },
  ],
  roles: [],
};

/** Test users: name → roles. Every one gets its own password (see passwordOf). */
const USERS: Record<string, readonly Document[]> = {
  backupUser: [{ role: "backup", db: "admin" }],
  restoreUser: [{ role: "restore", db: "admin" }],
  readAnyUser: [{ role: "readAnyDatabase", db: "admin" }],
  leastPrivilegeUser: [{ role: "mongoshieldBackup", db: "admin" }],
  sourceReader: [{ role: "read", db: source }],
  // readWrite on the restore targets of this file (their names start with ac_rw_).
  targetWriter: [
    { role: "readWrite", db: "ac_rw_validated" },
    { role: "readWrite", db: "ac_rw_copy" },
    { role: "readWrite", db: "ac_rw_converge" },
  ],
  // May manage users (and write data) but not merge them: no `restore` role.
  authzBackupUser: [
    { role: "backup", db: "admin" },
    { role: "mongoshieldViewAuthz", db: "admin" },
  ],
  // May manage users and write data anywhere, which includes reading a temporary
  // users collection in admin: merges like the restore role.
  userAdmin: [
    { role: "userAdminAnyDatabase", db: "admin" },
    { role: "readWriteAnyDatabase", db: "admin" },
  ],
  // May manage users and write the restore target, but not write in admin: users
  // cannot be merged with their hashes, so they are created with createUser.
  userCreator: [
    { role: "userAdminAnyDatabase", db: "admin" },
    { role: "readWrite", db: "ac_rw_users" },
  ],
};

/**
 * A distinct password per user, with characters that must be percent-encoded in a
 * URI (`@`, `:`, `/`, `%`), so both spellings can be searched for in messages.
 */
function passwordOf(user: string): string {
  return `S3cr%t:${user}/p@ss`;
}

/** Every password this file uses, raw and percent-encoded. */
function allPasswords(): string[] {
  const raw = [ROOT_PASSWORD, ...Object.keys(USERS).map(passwordOf), "Wrong:pass/w0rd@x"];
  return [...raw, ...raw.map(encodeURIComponent)];
}

function recordingLogger(): Logger {
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      logLines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

/** The connection settings for `user` with its own password. */
function as(user: string, password = passwordOf(user)): SourceOptions {
  return { uri: deployment.uriFor(user, password) };
}

/** A shield connecting as `user` (no source when `user` is undefined). */
function shieldAs(user: string | undefined, backups: StorageAdapter = storage): MongoShield {
  const shield = new MongoShield({
    ...(user === undefined ? {} : { source: as(user) }),
    storage: backups,
    logger: recordingLogger(),
  });
  shields.push(shield);
  return shield;
}

/** Runs `task`, expecting a MongoShieldError with `code`, and returns it. */
async function expectFailure(
  task: () => Promise<unknown>,
  code: string,
): Promise<MongoShieldError> {
  let caught: unknown;
  try {
    await task();
  } catch (error) {
    caught = error;
  }
  caughtErrors.push(caught);
  expect(caught, `expected ${code}`).toBeInstanceOf(MongoShieldError);
  if (!(caught instanceof MongoShieldError)) throw new Error("unreachable");
  expect(caught.code, caught.message).toBe(code);
  return caught;
}

let noneBackupId: string;
let convergeBackupId: string;
/** Where the users-and-roles backup is kept (its own storage, so "latest" stays unambiguous). */
let storageForUsers: StorageAdapter = storage;

beforeAll(async () => {
  deployment = await startReplicaSet({ members: 1, auth: true });
  const admin = deployment.admin;
  await admin.db("admin").command(LEAST_PRIVILEGE_ROLE);
  // What includeUsersAndRoles needs on top of the backup role (see backup-authz.ts).
  await admin.db("admin").command({
    createRole: "mongoshieldViewAuthz",
    privileges: [{ resource: { db: "", collection: "" }, actions: ["viewUser", "viewRole"] }],
    roles: [],
  });
  for (const [user, roles] of Object.entries(USERS)) {
    await admin.db("admin").command({ createUser: user, pwd: passwordOf(user), roles });
  }
  const db = admin.db(source);
  await db
    .collection<{ _id: number; total: number }>("orders")
    .insertMany(Array.from({ length: 300 }, (_, n) => ({ _id: n, total: n })));
  await db.collection<{ _id: number }>("orders").createIndex({ total: 1 });
  // A validator that one existing document breaks (added after it was written): a
  // restore can only write that document when it may bypass validation.
  await db.collection<{ _id: string; total: number | string }>("invoices").insertMany([
    { _id: "ok", total: 1 },
    { _id: "legacy", total: "not a number" },
  ]);
  await db.command({
    collMod: "invoices",
    validator: { $jsonSchema: { properties: { total: { bsonType: "number" } } } },
    validationLevel: "moderate",
  });
  // A database-local user and custom role, for the users-and-roles round trip.
  await db.command({
    createRole: "ordersAuditor",
    privileges: [{ resource: { db: source, collection: "orders" }, actions: ["find"] }],
    roles: [],
  });
  await db.command({
    createUser: "appUser",
    pwd: passwordOf("appUser"),
    roles: [{ role: "ordersAuditor", db: source }],
  });
});

afterAll(async () => {
  for (const shield of shields) await shield.close();
  // Nothing anyone wrote may contain a password, raw or percent-encoded.
  const texts = [
    ...logLines,
    ...caughtErrors.map((error) =>
      error instanceof MongoShieldError
        ? JSON.stringify({
            message: error.message,
            hint: error.hint,
            details: error.details,
            stack: error.stack,
          })
        : String(error),
    ),
  ];
  try {
    for (const password of allPasswords()) {
      for (const text of texts) expect(text.includes(password), text).toBe(false);
    }
  } finally {
    await deployment?.stop();
  }
});

describe("the built-in backup role", () => {
  it("backs up with consistency none and warns which privileges converge needs", async () => {
    const result = await shieldAs("backupUser").backup({ include: [`${source}.*`] });
    noneBackupId = result.id;
    expect(result.manifest.consistency.mode).toBe("none");
    const warning = result.manifest.consistency.warning ?? "";
    expect(warning).toMatch(/change stream/i);
    expect(warning).toMatch(/readAnyDatabase|changeStream/);
    expect(logLines.some((line) => line.startsWith("warn") && line.includes(warning))).toBe(true);
    expect(result.manifest.totals.documents).toBe(302);
  });

  it("fails an explicit converge backup with MS_PERMISSION_DENIED", async () => {
    const error = await expectFailure(
      () => shieldAs("backupUser").backup({ include: [`${source}.*`], consistency: "converge" }),
      "MS_PERMISSION_DENIED",
    );
    expect(error.hint).toMatch(/readAnyDatabase|changeStream/);
  });

  it("cannot restore: MS_PERMISSION_DENIED naming the restore role", async () => {
    const error = await expectFailure(
      () =>
        shieldAs("backupUser").restore({
          backup: noneBackupId,
          rename: { [`${source}.*`]: "ac_backup_restore.*" },
        }),
      "MS_PERMISSION_DENIED",
    );
    expect(error.message).toContain("insert");
    expect(error.hint).toContain("`restore`");
  });

  it("backs up every database, which needs listDatabases (the role has it)", async () => {
    const result = await shieldAs("backupUser").backup({ exclude: ["admin.*", "config.*"] });
    expect(result.manifest.namespaces.map((entry) => entry.ns)).toContain(`${source}.orders`);
  });
});

describe("readAnyDatabase and the least-privilege role", () => {
  it("gets converge with readAnyDatabase", async () => {
    const result = await shieldAs("readAnyUser").backup({ include: [`${source}.*`] });
    convergeBackupId = result.id;
    expect(result.manifest.consistency.mode).toBe("converge");
    expect(result.manifest.consistency.warning).toBeUndefined();
  });

  it("gets converge with the documented least-privilege role", async () => {
    const result = await shieldAs("leastPrivilegeUser").backup({ include: [`${source}.*`] });
    expect(result.manifest.consistency.mode).toBe("converge");
    expect(result.manifest.consistency.warning).toBeUndefined();
    expect(result.manifest.totals.documents).toBe(302);
  });

  it("cannot restore with readAnyDatabase", async () => {
    const error = await expectFailure(
      () =>
        shieldAs("readAnyUser").restore({
          backup: convergeBackupId,
          rename: { [`${source}.*`]: "ac_readany_restore.*" },
        }),
      "MS_PERMISSION_DENIED",
    );
    expect(error.hint).toContain("`restore`");
  });
});

describe("read on one database", () => {
  it("backs up that database with consistency none", async () => {
    const result = await shieldAs("sourceReader").backup({ include: [`${source}.*`] });
    expect(result.manifest.consistency.mode).toBe("none");
    expect(result.manifest.consistency.warning).toMatch(/change stream/i);
  });

  it("cannot back up a database it may not read", async () => {
    const other = uniqueDb("ac_other");
    await deployment.admin
      .db(other)
      .collection("x")
      .insertOne({ _id: 1 } as Document);
    const error = await expectFailure(
      () => shieldAs("sourceReader").backup({ include: [`${other}.*`] }),
      "MS_PERMISSION_DENIED",
    );
    expect(error.message).toContain(other);
  });

  it("cannot restore, and says what is missing", async () => {
    const error = await expectFailure(
      () =>
        shieldAs("sourceReader").restore({
          backup: noneBackupId,
          rename: { [`${source}.*`]: `${source}_copy.*` },
        }),
      "MS_PERMISSION_DENIED",
    );
    expect(error.message).toContain(`listCollections on database ${source}_copy`);
    expect(error.hint).toContain("`restore`");
  });
});

describe("the built-in restore role", () => {
  it("cannot back up", async () => {
    await expectFailure(
      () => shieldAs("restoreUser").backup({ include: [`${source}.*`] }),
      "MS_PERMISSION_DENIED",
    );
  });

  it("restores a backup and bypasses document validation", async () => {
    const target = uniqueDb("ac_restore");
    const result = await shieldAs("restoreUser").restore({
      backup: noneBackupId,
      rename: { [`${source}.*`]: `${target}.*` },
    });
    expect(result.documentsRestored).toBe(302);
    const legacy = await deployment.admin
      .db(target)
      .collection("invoices")
      .findOne({
        _id: "legacy" as never,
      });
    expect(legacy?.total).toBe("not a number");
  });

  it("restores a converge backup, whose replay needs update and remove: MS_PERMISSION_DENIED", async () => {
    const error = await expectFailure(
      () =>
        shieldAs("restoreUser").restore({
          backup: convergeBackupId,
          rename: { [`${source}.*`]: uniqueDb("ac_restore_cv").concat(".*") },
        }),
      "MS_PERMISSION_DENIED",
    );
    expect(error.message).toMatch(/update/);
  });
});

describe("readWrite on the target database", () => {
  it("restores with validation on, and the log says so (bypassDocumentValidation fallback)", async () => {
    const target = "ac_rw_validated";
    const shield = shieldAs("targetWriter");
    const before = logLines.length;
    const error = await expectFailure(
      () =>
        shield.restore({
          backup: noneBackupId,
          include: [`${source}.invoices`],
          rename: { [`${source}.*`]: `${target}.*` },
        }),
      "MS_RESTORE_FAILED",
    );
    // The document that breaks the validator is refused, as documented.
    expect(error.message).toMatch(/validation/i);
    expect(
      logLines
        .slice(before)
        .some((line) => line.startsWith("warn") && line.includes("bypassDocumentValidation")),
    ).toBe(true);
    // Valid documents restore normally under readWrite.
    const result = await shield.restore({
      backup: noneBackupId,
      include: [`${source}.orders`],
      rename: { [`${source}.*`]: `${target}.*` },
    });
    expect(result.documentsRestored).toBe(300);
  });

  it("restores a converge backup (replay needs update and remove, readWrite has them)", async () => {
    const result = await shieldAs("targetWriter").restore({
      backup: convergeBackupId,
      include: [`${source}.orders`],
      rename: { [`${source}.*`]: "ac_rw_converge.*" },
    });
    expect(result.documentsRestored).toBe(300);
  });
});

describe("verify, find and restoreDocuments", () => {
  it("verify and find only read storage: they work whatever the database user", async () => {
    // A shield whose database password is wrong: neither operation connects.
    const shield = new MongoShield({
      source: as("backupUser", "Wrong:pass/w0rd@x"),
      storage,
      logger: recordingLogger(),
    });
    shields.push(shield);
    const fast = await shield.verify({ backup: noneBackupId, mode: "fast" });
    const deep = await shield.verify({ backup: noneBackupId, mode: "deep" });
    expect([fast.ok, deep.ok]).toEqual([true, true]);
    const found: Document[] = [];
    for await (const document of shield.find({
      backup: noneBackupId,
      namespace: `${source}.orders`,
      filter: { total: { $gte: 298 } },
    })) {
      found.push(document);
    }
    // find returns documents losslessly (Int32 stays Int32).
    expect(found.map((document) => Number(document._id))).toEqual([298, 299]);
  });

  it("restoreDocuments needs write privileges on the target", async () => {
    await deployment.admin
      .db(source)
      .collection("orders")
      .deleteOne({ _id: 7 } as Document);
    const error = await expectFailure(
      () =>
        shieldAs("sourceReader").restoreDocuments({
          backup: noneBackupId,
          namespace: `${source}.orders`,
          filter: { _id: 7 },
        }),
      "MS_PERMISSION_DENIED",
    );
    expect(error.hint).toBeDefined();
    const result = await shieldAs("userAdmin").restoreDocuments({
      backup: noneBackupId,
      namespace: `${source}.orders`,
      filter: { _id: 7 },
    });
    expect(result.inserted).toBe(1);
  });
});

describe("copy", () => {
  it("copies with the backup role on the source and readWrite on the target", async () => {
    const result = await shieldAs("backupUser").copy({
      to: as("targetWriter"),
      include: [`${source}.orders`],
      rename: { [`${source}.*`]: "ac_rw_copy.*" },
    });
    expect(result.documentsCopied).toBe(300);
  });

  it("refuses a target the user may not write, before writing anything", async () => {
    const target = uniqueDb("ac_copy_denied");
    const error = await expectFailure(
      () =>
        shieldAs("backupUser").copy({
          to: as("sourceReader"),
          include: [`${source}.orders`],
          rename: { [`${source}.*`]: `${target}.*` },
        }),
      "MS_PERMISSION_DENIED",
    );
    expect(error.message).toContain(target);
    const names = await deployment.admin.db().admin().listDatabases({ nameOnly: true });
    expect(names.databases.map((database) => database.name)).not.toContain(target);
  });
});

describe("users and roles", () => {
  let backupId: string;

  it("needs viewUser and viewRole: the backup role alone is refused, as the hint says", async () => {
    const error = await expectFailure(
      () =>
        shieldAs("backupUser", memoryStorage()).backup({
          include: [`${source}.*`],
          includeUsersAndRoles: true,
        }),
      "MS_PERMISSION_DENIED",
    );
    expect(error.hint).toContain("viewUser");
  });

  it("backs them up with the backup role plus viewUser and viewRole", async () => {
    const backups = memoryStorage();
    const result = await shieldAs("authzBackupUser", backups).backup({
      include: [`${source}.*`],
      includeUsersAndRoles: true,
    });
    backupId = result.id;
    const types = result.manifest.namespaces.map((entry) => entry.type);
    expect(types).toEqual(expect.arrayContaining(["users", "roles"]));
    // Restore from the same storage in the next tests.
    storageForUsers = backups;
  });

  it("restores them with password hashes through _mergeAuthzCollections (restore role)", async () => {
    const target = uniqueDb("ac_users");
    const result = await shieldAs("restoreUser", storageForUsers).restore({
      backup: backupId,
      // The invoice that breaks its validator needs bypassDocumentValidation (not here).
      exclude: [`${source}.invoices`],
      rename: { [`${source}.*`]: `${target}.*` },
      usersAndRoles: "create",
    });
    expect(result.usersAndRoles).toMatchObject({
      method: "merge",
      usersCreated: [`${target}.appUser`],
      rolesCreated: [`${target}.ordersAuditor`],
      passwordResetRequired: [],
    });
    // The original password works for the restored user.
    const login = new MongoClient(deployment.uriFor("appUser", passwordOf("appUser"), target));
    try {
      await expect(login.db(target).command({ ping: 1 })).resolves.toMatchObject({ ok: 1 });
    } finally {
      await login.close();
    }
  });

  it("merges for any user who may write and read admin (readWriteAnyDatabase)", async () => {
    const target = uniqueDb("ac_users2");
    const result = await shieldAs("userAdmin", storageForUsers).restore({
      backup: backupId,
      // The invoice that breaks its validator needs bypassDocumentValidation (not here).
      exclude: [`${source}.invoices`],
      rename: { [`${source}.*`]: `${target}.*` },
      usersAndRoles: "create",
    });
    expect(result.usersAndRoles).toMatchObject({ method: "merge", passwordResetRequired: [] });
  });

  it("falls back to createUser when the user may not merge, and says who needs a new password", async () => {
    const result = await shieldAs("userCreator", storageForUsers).restore({
      backup: backupId,
      exclude: [`${source}.invoices`],
      rename: { [`${source}.*`]: "ac_rw_users.*" },
      usersAndRoles: "create",
    });
    expect(result.usersAndRoles).toMatchObject({
      method: "createUser",
      passwordResetRequired: ["ac_rw_users.appUser"],
    });
    expect(
      logLines.some((line) => line.startsWith("warn") && line.includes("createUser instead")),
    ).toBe(true);
  });
});

describe("credentials", () => {
  it("fails a wrong password with MS_AUTH_FAILED, without the password", async () => {
    const shield = new MongoShield({
      source: as("backupUser", "Wrong:pass/w0rd@x"),
      storage,
      logger: recordingLogger(),
    });
    shields.push(shield);
    const error = await expectFailure(
      () => shield.backup({ include: [`${source}.*`] }),
      "MS_AUTH_FAILED",
    );
    expect(error.message).toContain("backupUser");
    expect(error.hint).toMatch(/authSource/);
  });

  it("fails an unknown user with MS_AUTH_FAILED", async () => {
    await expectFailure(
      () =>
        new MongoShield({ source: as("nobody", "whatever-pw"), storage }).backup({
          include: [`${source}.*`],
        }),
      "MS_AUTH_FAILED",
    );
  });

  it("reports missing privileges as MS_PERMISSION_DENIED, never as a raw server error", () => {
    for (const error of caughtErrors) {
      expect(error).toBeInstanceOf(MongoShieldError);
      if (isMongoShieldError(error, "MS_PERMISSION_DENIED")) expect(error.hint).toBeTruthy();
    }
  });
});
