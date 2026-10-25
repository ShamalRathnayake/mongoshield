// Restoring one tenant (src/extras/tenant-restore.ts) on a real replica set: three
// collections holding two tenants, a backup, then damage to tenant "acme" (deleted,
// changed and newly created documents) while tenant "globex" keeps changing. Each mode
// must touch acme only, and replace-tenant must put acme back exactly as backed up.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Document } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreTenant } from "../../../src/extras/tenant-restore.ts";
import { silentLogger } from "../../../src/logger.ts";
import { fileStorage } from "../../../src/storage/file.ts";
import type { StorageAdapter } from "../../../src/storage/types.ts";
import { backupDatabaseForTest } from "../../helpers/backup-fixtures.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../../helpers/mongo.ts";
import { runTestCli } from "./cli-utils.ts";

vi.mock("../../../src/cli/commands/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/cli/commands/index.ts")>();
  const { restoreTenantCommand } = await import("../../../src/cli/commands/restore-tenant.ts");
  const commands = [
    ...original.COMMANDS.filter((command) => command.name !== "restore-tenant"),
    restoreTenantCommand,
  ];
  return {
    COMMANDS: commands,
    findCommand: (name: string) => commands.find((command) => command.name === name),
  };
});

const client = useMongoClient();
const COLLECTIONS = ["projects", "tasks", "comments"] as const;

interface TenantDocument {
  _id: number;
  tenantId: string;
  title: string;
}

let workDir: string;
let storageDir: string;
let storage: StorageAdapter;
let database: string;

/** 10 documents per tenant per collection: acme has even _ids, globex odd ones. */
function seedDocuments(collection: string): TenantDocument[] {
  return Array.from({ length: 20 }, (_, id) => ({
    _id: id,
    tenantId: id % 2 === 0 ? "acme" : "globex",
    title: `${collection} ${id}`,
  }));
}

/** Seeds the collections, backs them up once (shared by every test). */
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-tenant-"));
  storageDir = join(workDir, "backups");
  storage = fileStorage({ path: storageDir });
  database = uniqueDb("tenant");
  for (const name of COLLECTIONS) {
    const collection = client().db(database).collection<TenantDocument>(name);
    await collection.insertMany(seedDocuments(name));
    await collection.createIndex({ tenantId: 1 });
  }
  await backupDatabaseForTest(client(), storage, { include: [`${database}.*`] });
});

/** Before each test: back to the backed-up state, then the same damage. */
beforeEach(async () => {
  for (const name of COLLECTIONS) {
    const collection = client().db(database).collection<TenantDocument>(name);
    await collection.deleteMany({});
    await collection.insertMany(seedDocuments(name));
    // acme: two deleted, one changed, one created since the backup.
    await collection.deleteMany({ _id: { $in: [0, 2] } });
    await collection.updateOne({ _id: 4 }, { $set: { title: "vandalised" } });
    await collection.insertOne({ _id: 100, tenantId: "acme", title: "new since backup" });
    // globex keeps working: a change that must survive every restore.
    await collection.updateOne({ _id: 1 }, { $set: { title: "globex edit" } });
  }
});

afterAll(async () => {
  await client().db(database).dropDatabase();
  await rm(workDir, { recursive: true, force: true });
});

function context() {
  return { client: client(), storage, logger: silentLogger };
}

async function documentsOf(name: string, tenantId: string): Promise<Document[]> {
  return client()
    .db(database)
    .collection<TenantDocument>(name)
    .find({ tenantId })
    .sort({ _id: 1 })
    .toArray();
}

describe("restoreTenant", () => {
  it("replace-tenant puts the tenant back exactly as backed up in every collection", async () => {
    const result = await restoreTenant(context(), {
      backup: "latest",
      tenantFilter: { tenantId: "acme" },
      include: [`${database}.*`],
      mode: "replace-tenant",
    });

    expect(result.namespaces).toHaveLength(3);
    for (const namespace of result.namespaces) {
      // 9 current acme documents deleted (10 - 2 deleted + 1 created), 10 inserted.
      expect(namespace).toMatchObject({ matched: 10, deleted: 9, inserted: 10, skipped: 0 });
    }
    for (const name of COLLECTIONS) {
      const expected = seedDocuments(name).filter((document) => document.tenantId === "acme");
      expect(await documentsOf(name, "acme")).toEqual(expected);
      const globex = await documentsOf(name, "globex");
      expect(globex.find((document) => document._id === 1)?.title).toBe("globex edit");
      expect(globex).toHaveLength(10);
    }
  });

  it("counts deletes and inserts in a dry run without writing", async () => {
    const plan = await restoreTenant(context(), {
      backup: "latest",
      tenantFilter: { tenantId: "acme" },
      include: [`${database}.*`],
      mode: "replace-tenant",
      dryRun: true,
    });
    expect(plan.totals).toEqual({
      matched: 30,
      deleted: 27,
      inserted: 30,
      replaced: 0,
      skipped: 0,
    });
    expect(await documentsOf("tasks", "acme")).toHaveLength(9);
  });

  it("insert mode only adds the missing documents and keeps newer ones", async () => {
    const result = await restoreTenant(context(), {
      backup: "latest",
      tenantFilter: { tenantId: "acme" },
      include: [`${database}.tasks`],
    });
    expect(result.totals).toMatchObject({ matched: 10, inserted: 2, skipped: 8, deleted: 0 });
    const acme = await documentsOf("tasks", "acme");
    expect(acme.find((document) => document._id === 4)?.title).toBe("vandalised");
    expect(acme.find((document) => document._id === 100)).toBeDefined();
  });

  it("upsert mode also replaces the changed documents", async () => {
    const result = await restoreTenant(context(), {
      backup: "latest",
      tenantFilter: { tenantId: "acme" },
      include: [`${database}.tasks`],
      mode: "upsert",
    });
    expect(result.totals).toMatchObject({ inserted: 2, replaced: 8 });
    const acme = await documentsOf("tasks", "acme");
    expect(acme.find((document) => document._id === 4)?.title).toBe("tasks 4");
  });

  it("uses per-namespace filters and renames into a sandbox", async () => {
    const sandbox = uniqueDb("tenant_sandbox");
    const result = await restoreTenant(context(), {
      backup: "latest",
      tenantFilterByNamespace: { [`${database}.projects`]: { tenantId: "globex", _id: 1 } },
      rename: { [`${database}.*`]: `${sandbox}.*` },
    });
    expect(result.namespaces).toEqual([
      expect.objectContaining({
        targetNamespace: `${sandbox}.projects`,
        matched: 1,
        inserted: 1,
        createsCollection: true,
      }),
    ]);
    const restored = await client().db(sandbox).collection("projects").find().toArray();
    expect(restored).toEqual([{ _id: 1, tenantId: "globex", title: "projects 1" }]);
    // Created with the backed-up indexes.
    const indexes = await client().db(sandbox).collection("projects").indexes();
    expect(indexes.map((index) => index.name)).toContain("tenantId_1");
    await client().db(sandbox).dropDatabase();
  });

  it("refuses an empty filter and unknown namespaces in the filter map", async () => {
    await expect(
      restoreTenant(context(), { backup: "latest", tenantFilter: {}, mode: "replace-tenant" }),
    ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
    await expect(
      restoreTenant(context(), {
        backup: "latest",
        tenantFilterByNamespace: { [`${database}.typo`]: { tenantId: "acme" } },
      }),
    ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
  });
});

describe("mongoshield restore-tenant", () => {
  const baseArgs = () => [
    "restore-tenant",
    "--from",
    storageDir,
    "--to-uri",
    mongoUri(),
    "--include",
    `${database}.*`,
    "--filter",
    '{"tenantId":"acme"}',
  ];

  it("prints the plan and writes nothing with --dry-run", async () => {
    const run = await runTestCli([...baseArgs(), "--mode", "replace-tenant", "--dry-run"], workDir);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(`${database}.tasks`);
    expect(run.stderr).toContain("Dry run");
    expect(await documentsOf("tasks", "acme")).toHaveLength(9);
  });

  it("refuses replace-tenant without --yes when nobody can confirm", async () => {
    const run = await runTestCli([...baseArgs(), "--mode", "replace-tenant"], workDir);
    expect(run.code).toBe(3);
    expect(await documentsOf("tasks", "acme")).toHaveLength(9);
  });

  it("restores the tenant with --yes", async () => {
    const run = await runTestCli([...baseArgs(), "--mode", "replace-tenant", "--yes"], workDir);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Restored the tenant in 3 collections");
    expect(await documentsOf("tasks", "acme")).toHaveLength(10);
  });
});
