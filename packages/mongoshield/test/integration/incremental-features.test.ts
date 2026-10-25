// Integration tests for everything around an incremental chain: scheduled runs that
// take a full backup when a new chain is due and incrementals in between, verify
// finding broken and damaged links, prune keeping what a chain needs, replicate
// copying parents first, and find / history / diff / drill reading an incremental as
// its base plus the chain's changes.

import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { listBackups } from "../../src/catalog/catalog.ts";
import { resolveChain } from "../../src/catalog/chain.ts";
import { validateConfig } from "../../src/config/load.ts";
import { generateIdentity } from "../../src/crypto/index.ts";
import { rekeyBackups } from "../../src/extras/rekey.ts";
import { replicateBackups } from "../../src/extras/replicate.ts";
import { backupDir, manifestKey } from "../../src/format/layout.ts";
import { isIncrementalManifest, type Manifest } from "../../src/format/manifest.ts";
import { exportBackup } from "../../src/interop/export.ts";
import { runScheduledJob } from "../../src/schedule/runner.ts";
import { MongoShield } from "../../src/shield.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import type { BackupOptions, BackupResult } from "../../src/types.ts";
import { flipByte, replaceStoredFile } from "../helpers/backup-fixtures.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import type { AnyDocument } from "./converge-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

function newDatabase(prefix: string): string {
  const name = uniqueDb(prefix);
  databases.push(name);
  return name;
}

async function seed(database: string, count: number): Promise<void> {
  await client()
    .db(database)
    .collection<AnyDocument>("users")
    .insertMany(Array.from({ length: count }, (_, n) => ({ _id: n, name: `user ${n}`, n })));
}

function shieldOver(storage: MemoryStorage): MongoShield {
  return new MongoShield({ source: { uri: mongoUri() }, storage, compression: "gzip" });
}

/** A full converge backup of `database.*`, then one incremental per change in `changes`. */
async function chainOf(
  shield: MongoShield,
  database: string,
  changes: readonly (() => Promise<unknown>)[],
  options: Partial<BackupOptions> = {},
): Promise<Manifest[]> {
  const include = [`${database}.*`];
  const manifests = [
    await committed(shield.backup({ include, consistency: "converge", ...options })),
  ];
  for (const change of changes) {
    await change();
    manifests.push(await committed(shield.backup({ include, incremental: true, ...options })));
  }
  return manifests;
}

/** The manifest of a backup that must have completed. */
async function committed(result: Promise<BackupResult>): Promise<Manifest> {
  const done = await result;
  if (done.status !== "complete") throw new Error("expected a complete backup");
  return done.manifest;
}

describe("scheduled runs with backup.incremental", () => {
  it("take a full backup when a chain is due, and incrementals in between", async () => {
    const database = newDatabase("inc_sched");
    await seed(database, 20);
    const storage = memoryStorage();
    const shield = shieldOver(storage);
    // About 1.7 s: long enough for two quick runs, short enough to wait out.
    const config = validateConfig({
      source: { uri: mongoUri() },
      storage: "memory://ignored",
      backup: { include: [`${database}.*`], incremental: { fullEveryDays: 0.00002 } },
      schedule: { cron: "0 * * * *", verify: "fast" },
      retention: { last: 10 },
    });
    const run = () => runScheduledJob(shield, config, { verify: "fast" });

    const first = await run();
    expect(first.status, JSON.stringify(first.error)).toBe("success");
    expect(first.backup).toMatchObject({ kind: "full" });
    expect(first.backup?.fullBackupReason).toContain("no backup this incremental");

    await client().db(database).collection<AnyDocument>("users").insertOne({ _id: 1000 });
    const second = await run();
    expect(second.backup).toMatchObject({ kind: "incremental", parent: first.backup?.id });
    expect(second.backup?.changes).toBeGreaterThan(0);
    expect(second.verify?.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 2000));
    const third = await run();
    expect(third.backup).toMatchObject({ kind: "full" });
    expect(third.backup?.fullBackupReason).toContain("older than");

    const fourth = await run();
    expect(fourth.backup).toMatchObject({ kind: "incremental", parent: third.backup?.id });
    await shield.close();
  });

  it("refuses incremental together with maxDurationMs in the config", () => {
    expect(() =>
      validateConfig({
        storage: "./backups",
        backup: { incremental: {}, maxDurationMs: 60_000 },
      }),
    ).toThrow(/incremental cannot be combined with maxDurationMs/);
  });

  it("falls back to a full backup on a standalone-like refusal and when asked to", async () => {
    const database = newDatabase("inc_fallback");
    await seed(database, 5);
    const storage = memoryStorage();
    const shield = shieldOver(storage);
    // A selection with a query can never be incremental: a full backup is taken.
    const result = await shield.backup({
      include: [`${database}.*`],
      query: { [`${database}.users`]: { n: { $gte: 0 } } },
      incremental: { fallbackToFull: true },
    });
    expect(isIncrementalManifest(result.manifest)).toBe(false);
    expect(result.fullBackupReason).toContain("query");
    await shield.close();
  });
});

describe("point in time with backup: latest", () => {
  it("uses a chain when no journal covers the time, and lists the chains when none does", async () => {
    const database = newDatabase("inc_latest_at");
    await seed(database, 10);
    const storage = memoryStorage();
    const shield = shieldOver(storage);
    const users = client().db(database).collection<AnyDocument>("users");
    const [base, first, second] = await chainOf(shield, database, [
      () => users.deleteOne({ _id: 0 }),
      () => users.deleteOne({ _id: 1 }),
    ]);
    if (base === undefined || first?.consistency.to === undefined || second === undefined) {
      throw new Error("chain");
    }

    // Exactly the end of the first incremental: _id 0 deleted, _id 1 still there.
    const target = newDatabase("inc_latest_at_dst");
    const result = await shield.restore({
      backup: "latest",
      at: first.consistency.to,
      rename: { [`${database}.*`]: `${target}.*` },
    });
    expect(result.plan.chain).toEqual({ baseBackupId: base.id, incrementals: [first.id] });
    expect(result.pointInTime?.baseBackupId).toBe(base.id);
    expect(await client().db(target).collection("users").countDocuments()).toBe(9);

    const tooLate = await shield
      .restore({ backup: "latest", at: { t: (second.consistency.to?.t ?? 0) + 3600, i: 0 } })
      .catch((error: unknown) => error);
    expect(tooLate).toMatchObject({ code: "MS_CHANGE_HISTORY_LOST" });
    expect((tooLate as Error).message).toContain(`(chain of ${second.id})`);

    const full = await shield
      .restore({ backup: base.id, at: first.consistency.to, dryRun: true })
      .catch((error: unknown) => error);
    expect(full).toMatchObject({ code: "MS_CONFIG_INVALID" });
    expect((full as Error).message).toContain("is a full backup");
    await shield.close();
  });
});

describe("verify on an incremental", () => {
  it("checks the whole chain and names a damaged or missing link", async () => {
    const database = newDatabase("inc_verify");
    await seed(database, 30);
    const storage = memoryStorage();
    const shield = shieldOver(storage);
    const users = client().db(database).collection<AnyDocument>("users");
    const [base, first, second] = await chainOf(shield, database, [
      () => users.deleteOne({ _id: 1 }),
      () => users.updateOne({ _id: 2 }, { $set: { name: "changed" } }),
    ]);
    if (base === undefined || first === undefined || second === undefined) throw new Error("chain");

    for (const mode of ["fast", "deep"] as const) {
      const report = await shield.verify({ backup: second.id, mode });
      expect(report.ok, JSON.stringify(report.problems)).toBe(true);
      expect(report.chain).toEqual({
        baseBackupId: base.id,
        length: 2,
        members: [base.id, first.id, second.id],
        scope: "full",
      });
    }

    // Damage a data file of the base: verifying the newest incremental finds it.
    await replaceStoredFile(storage, base, base.namespaces[0]?.files[0]?.key ?? "", (bytes) =>
      flipByte(bytes, 10),
    );
    const damaged = await shield.verify({ backup: second.id });
    expect(damaged.ok).toBe(false);
    expect(damaged.problems[0]?.subject.startsWith(`${base.id}/`)).toBe(true);
    // `chain: "links"` only checks the links, so it does not read the base's files.
    const links = await shield.verify({ backup: second.id, chain: "links" });
    expect(links.ok).toBe(true);
    expect(links.chain?.scope).toBe("links");

    // A missing middle member: a broken link, and a restore that refuses to start.
    await storage.delete([manifestKey(first.id)]);
    const broken = await shield.verify({ backup: second.id, chain: "links" });
    expect(broken.ok).toBe(false);
    expect(broken.problems).toContainEqual({
      subject: `chain ${second.id}`,
      problem: expect.stringContaining(`its parent ${first.id}`),
    });
    const restore = await shield
      .restore({ backup: second.id, dryRun: true })
      .catch((error: unknown) => error);
    expect(restore).toMatchObject({ code: "MS_BACKUP_NOT_FOUND" });
    await shield.close();
  });
});

describe("prune, replicate and the read-side features on a chain", () => {
  it("keep the chain an incremental needs and copy parents first", async () => {
    const database = newDatabase("inc_prune");
    await seed(database, 10);
    const storage = memoryStorage();
    const shield = shieldOver(storage);
    const users = client().db(database).collection<AnyDocument>("users");
    const chain = await chainOf(shield, database, [
      () => users.insertOne({ _id: 100 }),
      () => users.insertOne({ _id: 101 }),
    ]);

    const pruned = await shield.prune({ last: 1 });
    expect(pruned.deletedBackups).toBe(0);
    expect(pruned.plan.keep).toHaveLength(3);

    const offsite = memoryStorage({ name: "offsite" });
    const copied = await replicateBackups(storage, offsite, { backups: "latest" });
    expect(copied.backups.map((backup) => backup.backupId)).toEqual(
      chain.map((manifest) => manifest.id),
    );
    const entries = await listBackups(offsite);
    const newest = chain.at(-1);
    if (newest === undefined) throw new Error("chain");
    expect(resolveChain(entries, newest).incrementals).toHaveLength(2);
    await shield.close();
  });

  it("rekeys the whole chain of an incremental, so its restore needs only the new key", async () => {
    const database = newDatabase("inc_rekey");
    await seed(database, 5);
    const storage = memoryStorage();
    const oldKey = generateIdentity();
    const newKey = generateIdentity();
    const shield = new MongoShield({
      source: { uri: mongoUri() },
      storage,
      encryption: { recipients: [oldKey.recipient] },
    });
    const users = client().db(database).collection<AnyDocument>("users");
    const chain = await chainOf(shield, database, [() => users.deleteOne({ _id: 0 })]);
    const newest = chain.at(-1);
    if (newest === undefined) throw new Error("chain");

    const result = await rekeyBackups(storage, {
      backups: [newest.id],
      addRecipients: [newKey.recipient],
      removeRecipients: [oldKey.recipient],
      decryption: { identities: [oldKey.identity] },
    });
    expect(result.backups.map((backup) => backup.backupId)).toEqual(chain.map((m) => m.id));

    const target = newDatabase("inc_rekey_dst");
    await shield.restore({
      backup: newest.id,
      rename: { [`${database}.*`]: `${target}.*` },
      decryption: { identities: [newKey.identity] },
    });
    expect(await client().db(target).collection("users").countDocuments()).toBe(4);
    await shield.close();
  });

  it("find, history, diff and drill read an incremental as its chain", async () => {
    const database = newDatabase("inc_read");
    await seed(database, 10);
    const storage = memoryStorage();
    const shield = shieldOver(storage);
    const users = client().db(database).collection<AnyDocument>("users");
    const [base, first] = await chainOf(shield, database, [
      async () => {
        await users.updateOne({ _id: 3 }, { $set: { name: "renamed" } });
        await users.deleteOne({ _id: 4 });
        await users.insertOne({ _id: 50, name: "new" });
      },
    ]);
    if (base === undefined || first === undefined) throw new Error("chain");
    const namespace = `${database}.users`;

    const found = [];
    for await (const document of shield.find({ backup: first.id, namespace })) found.push(document);
    expect(found.map((document) => Number(document._id)).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 5, 6, 7, 8, 9, 50,
    ]);
    expect(found.find((document) => Number(document._id) === 3)?.name).toBe("renamed");

    const history = await shield.history({ namespace, id: 3, journal: false });
    expect(
      history.versions.map((version) => version.kind === "backup" && version.backupId),
    ).toEqual([first.id, base.id]);
    const [newer, older] = history.versions;
    expect(newer?.kind === "backup" && newer.document?.name).toBe("renamed");
    expect(older?.kind === "backup" && older.document?.name).toBe("user 3");

    const diff = await shield.diff({ from: base.id, to: first.id });
    expect(diff.to).toEqual({ kind: "backup", backupId: first.id });
    expect(diff.identical).toBe(false);
    const usersDiff = diff.namespaces.find((entry) => entry.namespace === namespace);
    expect(usersDiff?.documents).toMatchObject({ added: 1, removed: 1, changed: 1 });

    // A mongodump export has no place for change events: refused, naming the base.
    const exported = await exportBackup(storage, first.id, {
      format: "archive",
      output: new PassThrough(),
    }).catch((error: unknown) => error);
    expect(exported).toMatchObject({ code: "MS_CONFIG_INVALID" });
    expect((exported as Error).message).toContain("incremental backup");

    const drill = await shield.drill({
      backup: first.id,
      target: { uri: mongoUri() },
      allowSameDeployment: true,
    });
    expect(drill.ok, JSON.stringify(drill.problems)).toBe(true);
    expect(drill.backupId).toBe(first.id);
    expect(drill.documentsRestored).toBe(10);
    // Only temporary databases were written: the source is untouched.
    expect(await users.countDocuments()).toBe(10);
    await shield.close();
  });

  it("restores users and roles from the newest member that holds them", async () => {
    const database = newDatabase("inc_authz");
    await seed(database, 3);
    const storage = memoryStorage();
    const shield = shieldOver(storage);
    const db = client().db(database);
    await db.command({ createRole: "first_role", privileges: [], roles: [] });
    const [, incremental] = await chainOf(
      shield,
      database,
      [() => db.command({ createRole: "second_role", privileges: [], roles: [] })],
      { includeUsersAndRoles: true },
    );
    if (incremental === undefined) throw new Error("chain");
    expect(incremental.namespaces.map((entry) => [entry.type, entry.content])).toEqual([
      ["collection", "metadata"],
      ["roles", "full"],
      ["users", "full"],
    ]);

    const target = newDatabase("inc_authz_dst");
    const result = await shield.restore({
      backup: incremental.id,
      rename: { [`${database}.*`]: `${target}.*` },
      usersAndRoles: "create",
    });
    expect([...(result.usersAndRoles?.rolesCreated ?? [])].sort()).toEqual([
      `${target}.first_role`,
      `${target}.second_role`,
    ]);
    await client().db(target).command({ dropAllRolesFromDatabase: 1 });
    await db.command({ dropAllRolesFromDatabase: 1 });
    await shield.close();
  });

  it("deletes nothing of its own when an incremental fails (no files left behind)", async () => {
    const database = newDatabase("inc_clean");
    await seed(database, 3);
    const storage = memoryStorage();
    const shield = shieldOver(storage);
    const [base] = await chainOf(shield, database, []);
    if (base === undefined) throw new Error("chain");
    const refused = await shield
      .backup({
        include: [`${database}.*`],
        incremental: true,
        beforeCommit: async () => {
          throw new Error("refused by the hook");
        },
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    const keys = storage.keys().filter((key) => !key.startsWith(backupDir(base.id)));
    expect(keys).toEqual([]);
    await shield.close();
  });
});
