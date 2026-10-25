// Restoring users while other restores do the same on the same server
// (src/engine/restore-authz.ts): each restore stages its users in a temporary `admin`
// collection of its own, so concurrent restores never merge, or drop, each other's
// users; the temporary collections are gone afterwards, and ones a crashed restore
// left behind more than a day ago are cleaned up.

import { type CommandStartedEvent, type Document, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { runRestore } from "../../src/engine/restore.ts";
import { temporaryCollectionTime } from "../../src/engine/restore-authz.ts";
import { silentLogger } from "../../src/logger.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const source = uniqueDb("ucon");
const storage = memoryStorage();
const USERS = 15;
const RESTORES = 4;
let backupId: string;

/** Databases that got users, cleaned up at the end. */
const databasesWithUsers = new Set<string>([source]);

function passwordOf(index: number): string {
  return `password-${index}-of-the-concurrent-restore-test`;
}

/** The user names of a database. */
async function userNames(database: string): Promise<string[]> {
  const reply = await client().db(database).command({ usersInfo: 1 });
  return (reply.users as Document[]).map((user) => String(user.user)).sort();
}

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

async function adminCollectionExists(name: string): Promise<boolean> {
  const infos = await client().db("admin").listCollections({ name }, { nameOnly: true }).toArray();
  return infos.length > 0;
}

/**
 * Restores the backup into `target` with users, on a client of its own that records
 * the temporary collections `_mergeAuthzCollections` read.
 */
async function restoreWithUsers(target: string, temporaries: string[]) {
  databasesWithUsers.add(target);
  const restoring = new MongoClient(mongoUri(), { monitorCommands: true });
  restoring.on("commandStarted", (event: CommandStartedEvent) => {
    if (event.commandName !== "_mergeAuthzCollections") return;
    temporaries.push(String(event.command.tempUsersCollection));
  });
  try {
    return await runRestore(
      { client: restoring, storage, logger: silentLogger },
      {
        backup: backupId,
        rename: { [`${source}.*`]: `${target}.*` },
        usersAndRoles: "create",
      },
    );
  } finally {
    await restoring.close();
  }
}

beforeAll(async () => {
  const db = client().db(source);
  await db.collection("things").insertOne({ name: "thing" });
  for (let index = 0; index < USERS; index++) {
    await db.command({
      createUser: `user${String(index).padStart(2, "0")}`,
      pwd: passwordOf(index),
      roles: [{ role: "read", db: source }],
    });
  }
  const result = await runBackup(
    { client: client(), storage, logger: silentLogger, compression: "zstd", encryption: undefined },
    { include: [`${source}.*`], consistency: "none", includeUsersAndRoles: true },
  );
  backupId = result.manifest.id;
});

afterAll(async () => {
  for (const database of databasesWithUsers) {
    await client().db(database).command({ dropAllUsersFromDatabase: 1 });
    await client().db(database).dropDatabase();
  }
});

describe("concurrent restores with users and roles", () => {
  it("each restore its own users through a temporary collection of its own", async () => {
    const targets = Array.from({ length: RESTORES }, (_, index) => uniqueDb(`ucon_t${index}`));
    const temporaries: string[] = [];
    const results = await Promise.all(
      targets.map((target) => restoreWithUsers(target, temporaries)),
    );

    const expectedNames = Array.from(
      { length: USERS },
      (_, index) => `user${String(index).padStart(2, "0")}`,
    );
    for (const [index, target] of targets.entries()) {
      expect(results[index]?.usersAndRoles).toMatchObject({
        method: "merge",
        passwordResetRequired: [],
      });
      expect(await userNames(target)).toEqual(expectedNames);
      // The password hashes came through: the first and last users can log in.
      expect(await canLogIn(target, "user00", passwordOf(0))).toBe(true);
      expect(await canLogIn(target, `user${USERS - 1}`, passwordOf(USERS - 1))).toBe(true);
    }

    // One temporary collection per restore, none shared, and none left behind.
    expect(temporaries).toHaveLength(RESTORES);
    expect(new Set(temporaries).size).toBe(RESTORES);
    for (const temporary of temporaries) {
      expect(temporary).toMatch(/^admin\.mongoshield_tmp_users_/);
      expect(await adminCollectionExists(temporary.slice("admin.".length))).toBe(false);
    }
  });

  it("drops temporary collections a crashed restore left more than a day ago, and no others", async () => {
    const dayAndAHourAgo = Date.now() - 25 * 60 * 60 * 1000;
    const stale = `mongoshield_tmp_users_${dayAndAHourAgo.toString(36)}_0123456789ab`;
    const recent = `mongoshield_tmp_users_${(Date.now() - 60_000).toString(36)}_0123456789ab`;
    const admin = client().db("admin");
    await admin.collection(stale).insertOne({ leftOver: true });
    await admin.collection(recent).insertOne({ inUse: true });
    try {
      await restoreWithUsers(uniqueDb("ucon_stale"), []);
      expect(await adminCollectionExists(stale)).toBe(false);
      // Less than a day old: possibly another restore's, so it is left alone.
      expect(await adminCollectionExists(recent)).toBe(true);
    } finally {
      await admin
        .collection(stale)
        .drop()
        .catch(() => undefined);
      await admin.collection(recent).drop();
    }
  });
});

describe("temporaryCollectionTime", () => {
  it("reads the creation time from MongoShield's temporary names only", () => {
    const time = Date.UTC(2026, 9, 24);
    expect(temporaryCollectionTime(`mongoshield_tmp_users_${time.toString(36)}_abcdef`)).toBe(time);
    expect(temporaryCollectionTime("tempusers")).toBeUndefined();
    expect(temporaryCollectionTime("mongoshield_tmp_users_notime")).toBeUndefined();
  });
});
