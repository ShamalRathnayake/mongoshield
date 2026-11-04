/**
 * Unit tests for choosing the base backup of a point-in-time restore: the newest
 * SUITABLE base is used, never merely the newest one (journal/base-suitability.ts).
 * Manifests only; no journal is needed for a restore to exactly a base's own time.
 */

import { describe, expect, it } from "vitest";
import { CHAIN_CLUSTER_ID, idAt, makeChainBase } from "../catalog/test-fixtures.ts";
import { isMongoShieldError, type MongoShieldError } from "../errors.ts";
import type { Manifest, NamespaceEntry } from "../format/manifest.ts";
import { writeManifest } from "../format/manifest-io.ts";
import { memoryStorage } from "../storage/memory.ts";
import { compileBaseRequest, whyNotBase } from "./base-suitability.ts";
import { planPointInTimeRestore } from "./plan.ts";

/** A manifest entry for `ns` (contents do not matter for planning). */
function entry(ns: string): NamespaceEntry {
  const [db = "", collection = ""] = ns.split(".");
  return {
    ns,
    db,
    collection,
    type: "collection",
    documents: 0,
    bytesRaw: 0,
    files: [],
    metadata: { key: `${db}/${collection}.metadata.json`, size: 0, sha256: "0".repeat(64) },
  };
}

/** The nightly `app.*` job's base and the hourly `app.users` job's base, newer. */
function nightlyAndHourly(): { nightly: Manifest; hourly: Manifest } {
  const nightly = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000, {
    namespaces: [entry("app.users"), entry("app.orders")],
  });
  const hourly = makeChainBase(idAt("2026-10-20T01:00:00Z"), 2000, {
    namespaces: [entry("app.users")],
    selection: { include: ["app.users"], exclude: [], query: [] },
  });
  return { nightly, hourly };
}

async function failure(promise: Promise<unknown>): Promise<MongoShieldError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isMongoShieldError(error))
    throw new Error(`expected a MongoShieldError, got ${String(error)}`);
  return error;
}

describe("planPointInTimeRestore: choosing the base", () => {
  it("passes over a newer base that does not cover what the restore selects", async () => {
    const storage = memoryStorage();
    const { nightly, hourly } = nightlyAndHourly();
    for (const manifest of [nightly, hourly]) await writeManifest(storage, manifest);

    // At the hourly base's own time: the hourly base would need no journal, but it lacks
    // app.orders; the nightly one needs a journal that does not exist here.
    const error = await failure(planPointInTimeRestore(storage, { t: 2000, i: 1 }));
    expect(error.code).toBe("MS_CHANGE_HISTORY_LOST");
    expect(error.message).toContain(`${hourly.id}: it does not cover app.orders`);
    expect(error.details?.skippedBases).toEqual([
      { id: hourly.id, reason: expect.stringContaining("app.orders") },
    ]);
  });

  it("uses the narrower base when the restore selects only what it covers", async () => {
    const storage = memoryStorage();
    const { nightly, hourly } = nightlyAndHourly();
    for (const manifest of [nightly, hourly]) await writeManifest(storage, manifest);

    const plan = await planPointInTimeRestore(
      storage,
      { t: 2000, i: 1 },
      {
        include: ["app.users"],
      },
    );
    expect(plan.baseBackupId).toBe(hourly.id);
    expect(plan.baseSelection).toEqual({ include: ["app.users"], exclude: [] });
  });

  it("passes over a base taken with a query on a selected namespace", async () => {
    const storage = memoryStorage();
    const queried = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000, {
      namespaces: [entry("app.users")],
      selection: { include: ["app.*"], exclude: [], query: ["app.users"] },
    });
    await writeManifest(storage, queried);
    const error = await failure(planPointInTimeRestore(storage, { t: 1000, i: 1 }));
    expect(error.message).toContain("it holds only the documents of a query for app.users");

    // Leaving the queried namespace out makes the base suitable again.
    const plan = await planPointInTimeRestore(
      storage,
      { t: 1000, i: 1 },
      {
        exclude: ["app.users"],
      },
    );
    expect(plan.baseBackupId).toBe(queried.id);
  });

  it("only uses bases of the given deployment, and without one takes the newest with a warning", async () => {
    const storage = memoryStorage();
    const production = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000);
    const staging = makeChainBase(idAt("2026-10-20T00:30:00Z"), 1000, {
      source: { topology: "replicaSet", serverVersion: "8.0.0", clusterId: "staging" },
    });
    for (const manifest of [production, staging]) await writeManifest(storage, manifest);

    // No identity: not refused (the incremental-chain fallback needs a plan or an
    // MS_CHANGE_HISTORY_LOST), but the choice is announced.
    const guessed = await planPointInTimeRestore(storage, { t: 1000, i: 1 });
    expect(guessed.baseBackupId).toBe(staging.id);
    expect(guessed.warnings).toEqual([expect.stringContaining(CHAIN_CLUSTER_ID)]);

    const plan = await planPointInTimeRestore(
      storage,
      { t: 1000, i: 1 },
      {
        clusterId: production.source.clusterId,
      },
    );
    expect(plan.baseBackupId).toBe(production.id);
    expect(plan.warnings).toEqual([]);
  });

  it("tells two replica sets with one set name apart by their instanceId", async () => {
    const storage = memoryStorage();
    const source = (instanceId: string) => ({
      source: {
        topology: "replicaSet" as const,
        serverVersion: "8.0.0",
        clusterId: CHAIN_CLUSTER_ID,
        instanceId,
      },
    });
    const prod = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000, source("prod"));
    const staging = makeChainBase(idAt("2026-10-20T00:30:00Z"), 1000, source("staging"));
    for (const manifest of [prod, staging]) await writeManifest(storage, manifest);

    const plan = await planPointInTimeRestore(
      storage,
      { t: 1000, i: 1 },
      { clusterId: CHAIN_CLUSTER_ID, instanceId: "prod" },
    );
    expect(plan.baseBackupId).toBe(prod.id);
    const guessed = await planPointInTimeRestore(storage, { t: 1000, i: 1 });
    expect(guessed.baseBackupId).toBe(staging.id);
    expect(guessed.warnings).toEqual([expect.stringContaining("instance prod")]);
  });

  it("judges each base by its own deployment's backups when no deployment is given", async () => {
    const storage = memoryStorage();
    // Staging's newer base covers what staging has; production's collections must not
    // make it look incomplete.
    const production = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000, {
      namespaces: [entry("app.users"), entry("app.orders")],
    });
    const staging = makeChainBase(idAt("2026-10-20T00:30:00Z"), 1000, {
      source: { topology: "replicaSet", serverVersion: "8.0.0", clusterId: "staging" },
      namespaces: [entry("app.users")],
      selection: { include: ["app.users"], exclude: [], query: [] },
    });
    for (const manifest of [production, staging]) await writeManifest(storage, manifest);

    const plan = await planPointInTimeRestore(storage, { t: 1000, i: 1 });
    expect(plan.baseBackupId).toBe(staging.id);
    // With production's identity, staging's base is another deployment's.
    const pinned = await planPointInTimeRestore(
      storage,
      { t: 1000, i: 1 },
      { clusterId: CHAIN_CLUSTER_ID },
    );
    expect(pinned.baseBackupId).toBe(production.id);
  });
});

describe("whyNotBase", () => {
  it("accepts a base whose selection would have backed up a collection created later", () => {
    const base = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000, {
      namespaces: [entry("app.users")],
    });
    // app.invoices exists in a later backup only: created after the base.
    const later = makeChainBase(idAt("2026-10-21T00:00:00Z"), 5000, {
      namespaces: [entry("app.users"), entry("app.invoices")],
    });
    const request = compileBaseRequest({}, [
      { id: later.id, startedAt: new Date(later.startedAt), status: "complete", manifest: later },
    ]);
    expect(whyNotBase(base, request)).toBeUndefined();
  });

  it("accepts manifests written before selections were recorded", () => {
    const { selection: _selection, ...legacy } = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1);
    expect(whyNotBase(legacy, compileBaseRequest({ include: ["x.y"] }, []))).toBeUndefined();
  });
});
