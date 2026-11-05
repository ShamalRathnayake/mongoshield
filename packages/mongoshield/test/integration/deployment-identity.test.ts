// Integration tests for telling apart replica sets that share a name
// (src/mongo/deployment.ts, `instanceId`), against the real test replica set: the
// description reads the set's replicaSetId, backups record it, and an incremental
// refuses a parent from a set that only shares the name while still continuing a
// parent written before the field existed (docs/specs/FORMAT.md, "Source identity").

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../../src/engine/backup.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { manifestKey } from "../../src/format/layout.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { writeManifest } from "../../src/format/manifest-io.ts";
import { describeDeployment } from "../../src/mongo/index.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { backupContext } from "./backup-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("identity");
const own = { include: [`${database}.*`] };

/** A complete full backup of the test database. */
async function fullBackup(storage: MemoryStorage): Promise<Manifest> {
  const result = await runBackup(backupContext(client(), storage), {
    ...own,
    consistency: "converge",
  });
  return result.manifest;
}

/**
 * Rewrites a stored manifest with another `source` (another set of the same name, or
 * an old writer that recorded no instanceId), the way storage would hold it.
 */
async function rewriteSource(
  storage: MemoryStorage,
  manifest: Manifest,
  source: Manifest["source"],
): Promise<void> {
  // Manifests are written once (ifNoneMatch), so the old one goes first.
  await storage.delete([manifestKey(manifest.id)]);
  await writeManifest(storage, { ...manifest, source });
}

beforeAll(async () => {
  await client().db(database).collection<{ _id: number }>("items").insertOne({ _id: 1 });
});

afterAll(async () => {
  await client().db(database).dropDatabase();
});

describe("replica set identity", () => {
  it("reads the replica set's replicaSetId and records it in manifests", async () => {
    const deployment = await describeDeployment(client());
    expect(deployment.instanceId).toMatch(/^[0-9a-f]{32}$/);
    const manifest = await fullBackup(memoryStorage());
    expect(manifest.source.instanceId).toBe(deployment.instanceId);
    expect(manifest.source.clusterId).toBe(deployment.clusterId);
  });

  it("refuses to continue a backup of another replica set with the same name", async () => {
    const storage = memoryStorage();
    const parent = await fullBackup(storage);
    await rewriteSource(storage, parent, { ...parent.source, instanceId: "f".repeat(32) });
    const error: unknown = await runBackup(backupContext(client(), storage), {
      ...own,
      incremental: true,
    }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_BACKUP_NOT_FOUND")).toBe(true);
  });

  it("continues a parent written before instanceId was recorded", async () => {
    const storage = memoryStorage();
    const parent = await fullBackup(storage);
    const { instanceId: _instanceId, ...oldSource } = parent.source;
    await rewriteSource(storage, parent, oldSource);
    const result = await runBackup(backupContext(client(), storage), {
      ...own,
      incremental: true,
    });
    expect(result.manifest.chain?.parent).toBe(parent.id);
  });
});
