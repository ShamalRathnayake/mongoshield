// Diff (src/extras/diff.ts): two backups with known differences (documents added,
// removed and changed, an index added, a validator changed, a collection dropped and
// one created), the same comparison through spill files, a backup against the live
// deployment, and the CLI.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BSON, type Document } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { diffBackups } from "../../../src/extras/diff.ts";
import { silentLogger } from "../../../src/logger.ts";
import { fileStorage } from "../../../src/storage/file.ts";
import { memoryStorage } from "../../../src/storage/memory.ts";
import { backupDatabaseForTest, writeTestBackup } from "../../helpers/backup-fixtures.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../../helpers/mongo.ts";
import { runTestCli } from "./cli-utils.ts";

vi.mock("../../../src/cli/commands/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/cli/commands/index.ts")>();
  const { diffCommand } = await import("../../../src/cli/commands/diff.ts");
  const commands = [...original.COMMANDS.filter((command) => command.name !== "diff"), diffCommand];
  return {
    COMMANDS: commands,
    findCommand: (name: string) => commands.find((command) => command.name === name),
  };
});

const client = useMongoClient();

const ID_INDEX = { v: 2, key: { _id: 1 }, name: "_id_" };

/** users 0-99; orders 0-49; logs (dropped later). */
const usersA: Document[] = Array.from({ length: 100 }, (_, id) => ({
  _id: id,
  name: `user ${id}`,
}));
/** users: 0-4 removed, 100-102 added, 10/20/30 changed. */
const usersB: Document[] = [
  ...usersA
    .filter((user) => Number(user._id) >= 5)
    .map((user) =>
      [10, 20, 30].includes(Number(user._id)) ? { ...user, name: `renamed ${user._id}` } : user,
    ),
  { _id: 100, name: "user 100" },
  { _id: 101, name: "user 101" },
  { _id: 102, name: "user 102" },
];

function backupA(storage: ReturnType<typeof memoryStorage>) {
  return writeTestBackup(storage, {
    startedAt: new Date("2026-10-01T03:00:00Z"),
    namespaces: [
      { ns: "app.users", documents: usersA, options: { validator: { name: { $type: "string" } } } },
      { ns: "app.orders", documents: Array.from({ length: 50 }, (_, id) => ({ _id: id })) },
      { ns: "app.logs", documents: [{ _id: 1 }] },
    ],
  });
}

function backupB(storage: ReturnType<typeof memoryStorage>) {
  return writeTestBackup(storage, {
    startedAt: new Date("2026-10-02T03:00:00Z"),
    namespaces: [
      {
        ns: "app.users",
        documents: usersB,
        // Split into parts to read a multi-part namespace too.
        documentsPerPart: 30,
        options: { validator: { name: { $type: "int" } } },
        indexes: [ID_INDEX, { v: 2, key: { name: 1 }, name: "name_1" }],
      },
      { ns: "app.orders", documents: Array.from({ length: 50 }, (_, id) => ({ _id: id })) },
      { ns: "app.events", documents: [{ _id: 1 }, { _id: 2 }] },
    ],
  });
}

describe("diffBackups between two backups", () => {
  const storage = memoryStorage();
  let fromId: string;
  let toId: string;

  beforeAll(async () => {
    fromId = (await backupA(storage)).id;
    toId = (await backupB(storage)).id;
  });

  it("reports document, index and option differences per namespace", async () => {
    const result = await diffBackups(
      { storage, logger: silentLogger },
      { from: fromId, to: toId, examples: 5 },
    );
    expect(result.identical).toBe(false);
    expect(result.namespaces.map((namespace) => [namespace.namespace, namespace.presence])).toEqual(
      [
        ["app.events", "only-to"],
        ["app.logs", "only-from"],
        ["app.orders", "both"],
        ["app.users", "both"],
      ],
    );

    const users = result.namespaces.find((namespace) => namespace.namespace === "app.users");
    expect(users?.documents).toEqual({
      from: 100,
      to: 98,
      added: 3,
      removed: 5,
      changed: 3,
      unchanged: 92,
    });
    expect(users?.examples.changed.map(Number).sort((a, b) => a - b)).toEqual([10, 20, 30]);
    expect(users?.examples.removed.map(Number).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(users?.indexes).toEqual({ added: ["name_1"], removed: [], changed: [] });
    expect(users?.options).toEqual(["validator"]);

    const orders = result.namespaces.find((namespace) => namespace.namespace === "app.orders");
    expect(orders?.identical).toBe(true);
  });

  it("gives the same counts when collections are compared through spill files", async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), "mongoshield-diff-test-"));
    try {
      const result = await diffBackups(
        { storage, logger: silentLogger },
        { from: fromId, to: toId, maxRecordsInMemory: 8, workDirectory },
      );
      expect(result.spilled).toBe(true);
      const users = result.namespaces.find((namespace) => namespace.namespace === "app.users");
      expect(users?.documents).toMatchObject({ added: 3, removed: 5, changed: 3, unchanged: 92 });
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });

  it("validates its limits", async () => {
    await expect(
      diffBackups({ storage, logger: silentLogger }, { from: fromId, to: toId, examples: -1 }),
    ).rejects.toThrow(/examples must be a whole number/);
  });

  it("honours include and exclude", async () => {
    const result = await diffBackups(
      { storage, logger: silentLogger },
      { from: fromId, to: toId, include: ["app.*"], exclude: ["app.users", "app.e*", "app.l*"] },
    );
    expect(result.namespaces.map((namespace) => namespace.namespace)).toEqual(["app.orders"]);
    expect(result.identical).toBe(true);
  });
});

describe("diffBackups against the live deployment", () => {
  let database: string;
  let workDir: string;
  let storageDir: string;

  beforeAll(async () => {
    database = uniqueDb("difflive");
    workDir = await mkdtemp(join(tmpdir(), "mongoshield-difflive-"));
    storageDir = join(workDir, "backups");
    const items = client().db(database).collection<{ _id: number; qty: number }>("items");
    await items.insertMany(Array.from({ length: 20 }, (_, id) => ({ _id: id, qty: id })));
    await backupDatabaseForTest(client(), fileStorage({ path: storageDir }), {
      include: [`${database}.*`],
    });
    // Live changes after the backup.
    await items.deleteOne({ _id: 0 });
    await items.updateOne({ _id: 1 }, { $set: { qty: 1000 } });
    await items.insertOne({ _id: 50, qty: 50 });
    await items.createIndex({ qty: 1 });
  });

  afterAll(async () => {
    await client().db(database).dropDatabase();
    await rm(workDir, { recursive: true, force: true });
  });

  it("compares the backup with the live collections of its databases", async () => {
    const result = await diffBackups(
      { storage: fileStorage({ path: storageDir }), logger: silentLogger },
      { from: "latest", to: { live: client() } },
    );
    expect(result.to).toEqual({ kind: "live" });
    expect(result.namespaces.map((namespace) => namespace.namespace)).toEqual([
      `${database}.items`,
    ]);
    const [items] = result.namespaces;
    expect(items?.documents).toMatchObject({ from: 20, to: 20, added: 1, removed: 1, changed: 1 });
    const ids = (values: readonly unknown[] | undefined) => (values ?? []).map(Number);
    expect(ids(items?.examples.added)).toEqual([50]);
    expect(ids(items?.examples.removed)).toEqual([0]);
    expect(ids(items?.examples.changed)).toEqual([1]);
    expect(items?.indexes.added).toEqual(["qty_1"]);
  });

  it("prints a summary and details through the CLI", async () => {
    const run = await runTestCli(
      ["diff", "latest", "--from", storageDir, "--live", mongoUri(), "--details"],
      workDir,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`${database}.items`);
    expect(run.stdout).toContain("indexes added: qty_1");
    expect(run.stdout).toContain("added: 50");
  });

  it("prints canonical Extended JSON with --json", async () => {
    const run = await runTestCli(
      ["diff", "latest", "--from", storageDir, "--live", mongoUri(), "--json"],
      workDir,
    );
    expect(run.code).toBe(0);
    const parsed = BSON.EJSON.parse(run.stdout) as { identical: boolean };
    expect(parsed.identical).toBe(false);
  });
});

describe("diffBackups for a restore preview (rename rules and sampling)", () => {
  let database: string;
  let workDir: string;
  let storageDir: string;
  const storage = () => fileStorage({ path: storageDir });

  beforeAll(async () => {
    database = uniqueDb("diffprev");
    workDir = await mkdtemp(join(tmpdir(), "mongoshield-diffprev-"));
    storageDir = join(workDir, "backups");
    const items = client().db(database).collection<{ _id: number; qty: number }>("items");
    await items.insertMany(Array.from({ length: 200 }, (_, id) => ({ _id: id, qty: id })));
    await backupDatabaseForTest(client(), storage(), { include: [`${database}.*`] });

    // The rename target: a copy of the backup with 0-9 deleted, 10-19 changed and
    // 500-504 added. The source collection itself stays as backed up.
    const copy = client().db(database).collection<{ _id: number; qty: number }>("items_copy");
    await copy.insertMany(
      Array.from({ length: 190 }, (_, index) => {
        const id = index + 10;
        return { _id: id, qty: id < 20 ? -id : id };
      }),
    );
    await copy.insertMany(Array.from({ length: 5 }, (_, index) => ({ _id: 500 + index, qty: 0 })));
    // Never compared: it is not the target of any rule.
    await client().db(database).collection<{ _id: number }>("unrelated").insertOne({ _id: 1 });
  });

  afterAll(async () => {
    await client().db(database).dropDatabase();
    await rm(workDir, { recursive: true, force: true });
  });

  it("compares each backed-up namespace with the namespace the rename rules map it to", async () => {
    const result = await diffBackups(
      { storage: storage(), logger: silentLogger },
      {
        from: "latest",
        to: { live: client() },
        include: [`${database}.items`],
        rename: { [`${database}.items`]: `${database}.items_copy` },
      },
    );
    expect(result.namespaces).toHaveLength(1);
    const [items] = result.namespaces;
    expect(items).toMatchObject({
      namespace: `${database}.items`,
      targetNamespace: `${database}.items_copy`,
      presence: "both",
    });
    expect(items?.documents).toEqual({
      from: 200,
      to: 195,
      added: 5,
      removed: 10,
      changed: 10,
      unchanged: 180,
    });
    expect(items?.sampled).toBeUndefined();
  });

  it("reports a rename target that does not exist yet as only in the backup", async () => {
    const result = await diffBackups(
      { storage: storage(), logger: silentLogger },
      {
        from: "latest",
        to: { live: client() },
        include: [`${database}.items`],
        rename: { [`${database}.*`]: `${database}_missing.*` },
      },
    );
    expect(result.namespaces.map((entry) => [entry.targetNamespace, entry.presence])).toEqual([
      [`${database}_missing.items`, "only-from"],
    ]);
  });

  it("estimates large namespaces from a sample looked up by _id", async () => {
    const result = await diffBackups(
      { storage: storage(), logger: silentLogger },
      {
        from: "latest",
        to: { live: client() },
        include: [`${database}.items`],
        rename: { [`${database}.items`]: `${database}.items_copy` },
        sample: { above: 50, size: 100 },
      },
    );
    const [items] = result.namespaces;
    // The first 100 backed-up documents are 0-99: 10 missing live, 10 changed, 80 equal,
    // scaled by 200/100. Live-only documents follow from the live count: 195 - (200 - 20).
    expect(items?.sampled).toEqual({ documents: 100, of: 200 });
    expect(items?.documents).toEqual({
      from: 200,
      to: 195,
      added: 15,
      removed: 20,
      changed: 20,
      unchanged: 160,
    });
    expect(items?.examples.added).toEqual([]);
    expect((items?.examples.changed ?? []).map(Number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 10),
    );
  });

  it("compares namespaces at or below the sampling size exactly", async () => {
    const result = await diffBackups(
      { storage: storage(), logger: silentLogger },
      {
        from: "latest",
        to: { live: client() },
        include: [`${database}.items`],
        sample: { above: 1000 },
      },
    );
    expect(result.namespaces[0]?.sampled).toBeUndefined();
    expect(result.namespaces[0]?.identical).toBe(true);
  });

  it("refuses sampling against another backup and invalid sample sizes", async () => {
    await expect(
      diffBackups(
        { storage: storage(), logger: silentLogger },
        { from: "latest", to: "latest", sample: { above: 1 } },
      ),
    ).rejects.toThrow(/sample needs the live deployment/);
    await expect(
      diffBackups(
        { storage: storage(), logger: silentLogger },
        { from: "latest", to: { live: client() }, sample: { above: 1, size: 0 } },
      ),
    ).rejects.toThrow(/sample.size must be a whole number/);
  });
});
