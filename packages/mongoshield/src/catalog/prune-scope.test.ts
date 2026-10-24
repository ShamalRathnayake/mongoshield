// Scoped retention: several sources/selections share one storage location, and
// pruning one of them never deletes (or even plans over) another's backups.
// Incomplete runs count only when their checkpoint attributes them to the scope.
// Ends with a property test over random mixes of scopes.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkpointKey } from "../engine/backup-checkpoint.ts";
import { isMongoShieldError } from "../errors.ts";
import { backupDir } from "../format/layout.ts";
import { type MemoryStorage, memoryStorage } from "../storage/memory.ts";
import { listBackups } from "./catalog.ts";
import { pruneBackups } from "./prune.ts";
import { isInScope, type PruneScope, validateScope } from "./scope.ts";
import {
  CHAIN_CLUSTER_ID,
  idAt,
  makeChainBase,
  makeIncremental,
  putCheckpoint,
  putCompleteBackup,
  putIncompleteBackup,
  putInvalidBackup,
} from "./test-fixtures.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-20T12:00:00Z");
const SHAPE = "mongoshield.shape";

/** A complete backup of `cluster` with labels `labels`, started at `isoTime`. */
async function putBackupOf(
  storage: MemoryStorage,
  isoTime: string,
  origin: { clusterId?: string; labels?: Record<string, string> },
  suffix = "000000",
): Promise<string> {
  const id = idAt(isoTime, suffix);
  await putCompleteBackup(storage, id, {
    labels: { ...origin.labels },
    source: {
      topology: "replicaSet",
      serverVersion: "8.0.0",
      ...(origin.clusterId === undefined ? {} : { clusterId: origin.clusterId }),
    },
  });
  return id;
}

async function remainingIds(storage: MemoryStorage): Promise<string[]> {
  return (await listBackups(storage)).map((entry) => entry.id).sort();
}

describe("isInScope", () => {
  const origin = { clusterId: "c1", labels: { [SHAPE]: "s1", env: "prod" } };

  it("matches when every given field matches, and ignores fields the scope leaves out", () => {
    expect(isInScope(origin, { clusterId: "c1" })).toBe(true);
    expect(isInScope(origin, { labels: { env: "prod" } })).toBe(true);
    expect(isInScope(origin, { clusterId: "c1", labels: { [SHAPE]: "s1", env: "prod" } })).toBe(
      true,
    );
  });

  it("does not match a different value, or a field the backup does not record", () => {
    expect(isInScope(origin, { clusterId: "c2" })).toBe(false);
    expect(isInScope(origin, { clusterId: "c1", labels: { env: "staging" } })).toBe(false);
    expect(isInScope({ labels: origin.labels }, { clusterId: "c1" })).toBe(false);
    expect(isInScope(origin, { labels: { team: "billing" } })).toBe(false);
    // Names of Object.prototype members are labels like any other.
    expect(isInScope(origin, { labels: { constructor: "Object" } })).toBe(false);
  });
});

describe("validateScope", () => {
  it.each([{}, { labels: {} }, { clusterId: "" }])("rejects the scope %j", (scope) => {
    expect(() => validateScope(scope)).toThrow(/prune scope/);
  });

  it("accepts a cluster, labels, or both", () => {
    expect(() => validateScope({ clusterId: "c1" })).not.toThrow();
    expect(() => validateScope({ labels: { env: "prod" } })).not.toThrow();
  });

  it("makes pruneBackups refuse an empty scope instead of pruning everything", async () => {
    const storage = memoryStorage();
    await putBackupOf(storage, "2026-10-18T03:00:00Z", {});
    await putBackupOf(storage, "2026-10-19T03:00:00Z", {});
    const error = await pruneBackups(storage, { last: 1 }, { now: NOW, scope: {} }).catch(
      (caught: unknown) => caught,
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(await remainingIds(storage)).toHaveLength(2);
  });
});

describe("pruneBackups and incremental chains", () => {
  it("deletes an old chain whole and keeps the chain of the newest incremental", async () => {
    const storage = memoryStorage();
    const oldBase = makeChainBase(idAt("2026-10-18T00:00:00Z"), 1000);
    const oldInc = makeIncremental(idAt("2026-10-18T01:00:00Z"), oldBase, 2000);
    const base = makeChainBase(idAt("2026-10-19T00:00:00Z"), 3000);
    const first = makeIncremental(idAt("2026-10-19T01:00:00Z"), base, 4000);
    const second = makeIncremental(idAt("2026-10-19T02:00:00Z"), first, 5000);
    for (const manifest of [oldBase, oldInc, base, first, second]) {
      await putCompleteBackup(storage, manifest.id, manifest);
    }

    const result = await pruneBackups(storage, { last: 1 }, { now: NOW });

    expect(await remainingIds(storage)).toEqual([base.id, first.id, second.id]);
    // Deleted newest first: a prune stopped halfway never leaves a hole in a chain.
    expect(result.plan.remove.map((removed) => removed.id)).toEqual([oldInc.id, oldBase.id]);
  });

  it("keeps an in-scope backup that another scope's incremental depends on", async () => {
    const storage = memoryStorage();
    const base = makeChainBase(idAt("2026-10-18T00:00:00Z"), 1000, {
      labels: { [SHAPE]: "mine" },
    });
    const newer = makeChainBase(idAt("2026-10-19T00:00:00Z"), 3000, {
      labels: { [SHAPE]: "mine" },
    });
    // Chained explicitly (`--from`) by a job with other labels: out of this scope.
    const theirs = makeIncremental(idAt("2026-10-18T05:00:00Z"), base, 2000, {
      labels: { [SHAPE]: "theirs" },
    });
    for (const manifest of [base, newer, theirs]) {
      await putCompleteBackup(storage, manifest.id, manifest);
    }

    const result = await pruneBackups(
      storage,
      { last: 1 },
      { now: NOW, scope: { clusterId: CHAIN_CLUSTER_ID, labels: { [SHAPE]: "mine" } } },
    );

    expect(result.plan.remove).toEqual([]);
    expect(result.plan.keep.find((kept) => kept.id === base.id)?.reasons).toEqual([
      `needed by incremental ${theirs.id} (outside this scope)`,
    ]);
    expect(await remainingIds(storage)).toEqual([base.id, theirs.id, newer.id].sort());
  });
});

describe("pruneBackups with a scope", () => {
  it("never deletes the backups of another selection in the same storage", async () => {
    const storage = memoryStorage();
    // An hourly backup of one collection next to a nightly full backup: with an
    // unscoped `last: 2` the older nightly backups would all be deleted.
    const nightly = [
      await putBackupOf(storage, "2026-10-17T03:00:00Z", {
        clusterId: "c1",
        labels: { [SHAPE]: "full" },
      }),
      await putBackupOf(storage, "2026-10-18T03:00:00Z", {
        clusterId: "c1",
        labels: { [SHAPE]: "full" },
      }),
    ];
    const hourly: string[] = [];
    for (const hour of ["08", "09", "10", "11"]) {
      hourly.push(
        await putBackupOf(storage, `2026-10-20T${hour}:00:00Z`, {
          clusterId: "c1",
          labels: { [SHAPE]: "orders" },
        }),
      );
    }

    const result = await pruneBackups(
      storage,
      { last: 2 },
      { now: NOW, scope: { clusterId: "c1", labels: { [SHAPE]: "orders" } } },
    );

    expect(result.deletedBackups).toBe(2);
    expect(result.plan.remove.map((removed) => removed.id).sort()).toEqual(hourly.slice(0, 2));
    expect(await remainingIds(storage)).toEqual([...nightly, ...hourly.slice(2)].sort());
    // The other selection's backups are reported, not planned over.
    expect(result.outOfScope).toEqual([
      { id: nightly[1], status: "complete", reason: "other-scope" },
      { id: nightly[0], status: "complete", reason: "other-scope" },
    ]);
    const planned = [...result.plan.keep, ...result.plan.remove].map((entry) => entry.id);
    expect(planned).not.toContain(nightly[0]);
  });

  it("never deletes the backups of another cluster with the same selection", async () => {
    const storage = memoryStorage();
    const clusterA = await putBackupOf(storage, "2026-10-17T03:00:00Z", {
      clusterId: "a",
      labels: { [SHAPE]: "s" },
    });
    const clusterB = [
      await putBackupOf(storage, "2026-10-18T03:00:00Z", {
        clusterId: "b",
        labels: { [SHAPE]: "s" },
      }),
      await putBackupOf(storage, "2026-10-19T03:00:00Z", {
        clusterId: "b",
        labels: { [SHAPE]: "s" },
      }),
    ];
    const result = await pruneBackups(
      storage,
      { last: 1 },
      { now: NOW, scope: { clusterId: "b", labels: { [SHAPE]: "s" } } },
    );
    expect(result.deletedBackups).toBe(1);
    expect(await remainingIds(storage)).toEqual([clusterA, clusterB[1]].sort());
    expect(result.outOfScope.map((backup) => backup.id)).toEqual([clusterA]);
  });

  it("keeps the newest backup of each scope, even when another scope's backups are newer", async () => {
    const storage = memoryStorage();
    const old = await putBackupOf(storage, "2026-09-01T03:00:00Z", { labels: { plan: "monthly" } });
    await putBackupOf(storage, "2026-10-19T03:00:00Z", { labels: { plan: "daily" } });
    await putBackupOf(storage, "2026-10-20T03:00:00Z", { labels: { plan: "daily" } });
    const result = await pruneBackups(
      storage,
      { last: 1 },
      { now: NOW, scope: { labels: { plan: "monthly" } } },
    );
    expect(result.plan.keep.map((kept) => kept.id)).toEqual([old]);
    expect(result.deletedBackups).toBe(0);
  });

  it("leaves backups that record no cluster id out of a cluster scope", async () => {
    const storage = memoryStorage();
    const legacy = await putBackupOf(storage, "2026-10-17T03:00:00Z", { labels: { [SHAPE]: "s" } });
    await putBackupOf(storage, "2026-10-18T03:00:00Z", {
      clusterId: "c1",
      labels: { [SHAPE]: "s" },
    });
    await putBackupOf(storage, "2026-10-19T03:00:00Z", {
      clusterId: "c1",
      labels: { [SHAPE]: "s" },
    });
    const result = await pruneBackups(
      storage,
      { last: 1 },
      { now: NOW, scope: { clusterId: "c1", labels: { [SHAPE]: "s" } } },
    );
    expect(result.deletedBackups).toBe(1);
    expect(await remainingIds(storage)).toContain(legacy);
  });

  it("prunes an idle checkpointed run that its checkpoint attributes to the scope", async () => {
    const storage = memoryStorage();
    await putBackupOf(storage, "2026-10-19T03:00:00Z", {
      clusterId: "c1",
      labels: { [SHAPE]: "s" },
    });
    const ours = idAt("2026-10-01T03:00:00Z", "00000a");
    await putIncompleteBackup(storage, ours);
    await putCheckpoint(storage, ours, { clusterId: "c1", labels: { [SHAPE]: "s" } });

    const result = await pruneBackups(
      storage,
      { last: 3 },
      { now: new Date(Date.now() + 2 * DAY), scope: { clusterId: "c1", labels: { [SHAPE]: "s" } } },
    );

    expect(result.plan.remove.map((removed) => removed.id)).toEqual([ours]);
    expect(storage.keys().filter((key) => key.startsWith(backupDir(ours)))).toEqual([]);
    expect(await storage.head(checkpointKey(ours))).toBeUndefined();
  });

  it("keeps incomplete runs of other scopes, and those it cannot attribute, and reports them", async () => {
    const storage = memoryStorage();
    await putBackupOf(storage, "2026-10-19T03:00:00Z", {
      clusterId: "c1",
      labels: { [SHAPE]: "s" },
    });
    const theirs = idAt("2026-10-01T03:00:00Z", "00000b");
    await putIncompleteBackup(storage, theirs);
    await putCheckpoint(storage, theirs, { clusterId: "c2", labels: { [SHAPE]: "s" } });
    const crashed = idAt("2026-10-02T03:00:00Z", "00000c");
    await putIncompleteBackup(storage, crashed);
    const damaged = idAt("2026-10-03T03:00:00Z", "00000d");
    await putIncompleteBackup(storage, damaged);
    await storage.put(checkpointKey(damaged), Buffer.from("{ not json"));
    const broken = idAt("2026-10-04T03:00:00Z", "00000e");
    await putInvalidBackup(storage, broken);

    const result = await pruneBackups(
      storage,
      { last: 1 },
      { now: new Date(Date.now() + 2 * DAY), scope: { clusterId: "c1", labels: { [SHAPE]: "s" } } },
    );

    expect(result.deletedBackups).toBe(0);
    expect(await remainingIds(storage)).toHaveLength(5);
    expect(await storage.head(checkpointKey(theirs))).toBeDefined();
    expect(result.outOfScope).toEqual([
      { id: broken, status: "invalid", reason: "invalid" },
      { id: damaged, status: "incomplete", reason: "unattributed" },
      { id: crashed, status: "incomplete", reason: "unattributed" },
      { id: theirs, status: "incomplete", reason: "other-scope" },
    ]);
    // The invalid manifest is still worth a warning, scope or not.
    expect(result.plan.warnings.some((warning) => warning.includes(broken))).toBe(true);
  });

  it("reports nothing out of scope without a scope, and prunes the whole location", async () => {
    const storage = memoryStorage();
    await putBackupOf(storage, "2026-10-18T03:00:00Z", { clusterId: "a" });
    await putBackupOf(storage, "2026-10-19T03:00:00Z", { clusterId: "b" });
    const result = await pruneBackups(storage, { last: 1 }, { now: NOW });
    expect(result.outOfScope).toEqual([]);
    expect(result.deletedBackups).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Property: pruning scope A only ever deletes backups of scope A
// ---------------------------------------------------------------------------

/** Where a generated backup comes from; `undefined` fields are not recorded. */
interface GeneratedOrigin {
  readonly cluster: "c1" | "c2" | undefined;
  readonly shape: "s1" | "s2" | undefined;
}

/** One generated backup directory. */
interface GeneratedBackup {
  readonly origin: GeneratedOrigin;
  readonly kind: "complete" | "checkpointed" | "crashed" | "invalid";
  /** Hours before the newest possible start; also makes ids unique with `index`. */
  readonly hoursAgo: number;
}

const originArbitrary: fc.Arbitrary<GeneratedOrigin> = fc.record({
  cluster: fc.constantFrom("c1" as const, "c2" as const, undefined),
  shape: fc.constantFrom("s1" as const, "s2" as const, undefined),
});

const backupArbitrary: fc.Arbitrary<GeneratedBackup> = fc.record({
  origin: originArbitrary,
  kind: fc.constantFrom(
    "complete" as const,
    "complete" as const,
    "complete" as const,
    "checkpointed" as const,
    "crashed" as const,
    "invalid" as const,
  ),
  hoursAgo: fc.integer({ min: 0, max: 24 * 60 }),
});

const scopeArbitrary: fc.Arbitrary<PruneScope> = fc.constantFrom<PruneScope>(
  { clusterId: "c1" },
  { labels: { [SHAPE]: "s1" } },
  { clusterId: "c1", labels: { [SHAPE]: "s1" } },
  { clusterId: "c2", labels: { [SHAPE]: "s2" } },
);

/** The test's own reading of the scope rule, independent of `isInScope`. */
function belongsTo(backup: GeneratedBackup, scope: PruneScope): boolean {
  if (backup.kind === "invalid" || backup.kind === "crashed") return false;
  if (scope.clusterId !== undefined && backup.origin.cluster !== scope.clusterId) return false;
  const wanted = scope.labels?.[SHAPE];
  return wanted === undefined || backup.origin.shape === wanted;
}

/** Writes one generated backup and returns its id. */
async function putGenerated(
  storage: MemoryStorage,
  backup: GeneratedBackup,
  index: number,
): Promise<string> {
  const start = Date.parse("2026-08-01T00:00:00Z") - backup.hoursAgo * 3_600_000;
  const iso = new Date(start).toISOString();
  const id = idAt(iso, index.toString(16).padStart(6, "0"));
  const origin = {
    ...(backup.origin.cluster === undefined ? {} : { clusterId: backup.origin.cluster }),
    labels: backup.origin.shape === undefined ? {} : { [SHAPE]: backup.origin.shape },
  };
  switch (backup.kind) {
    case "complete":
      await putBackupOf(storage, iso, origin, index.toString(16).padStart(6, "0"));
      break;
    case "checkpointed":
      await putIncompleteBackup(storage, id);
      await putCheckpoint(storage, id, origin);
      break;
    case "crashed":
      await putIncompleteBackup(storage, id);
      break;
    case "invalid":
      await putInvalidBackup(storage, id);
      break;
  }
  return id;
}

describe("pruneBackups with a scope (property)", () => {
  it("only ever deletes backups of the scope, whatever the mix of scopes and policy", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(backupArbitrary, { minLength: 1, maxLength: 14 }),
        scopeArbitrary,
        fc.record({
          last: fc.integer({ min: 1, max: 3 }),
          daily: fc.integer({ min: 0, max: 3 }),
        }),
        fc.boolean(),
        async (generated, scope, policy, dryRun) => {
          const storage = memoryStorage();
          const ids: string[] = [];
          for (const [index, backup] of generated.entries()) {
            ids.push(await putGenerated(storage, backup, index));
          }
          const keysBefore = new Map(
            ids.map((id) => [id, storage.keys().filter((key) => key.startsWith(backupDir(id)))]),
          );

          // Two days ahead, so idle incomplete runs are past their grace period.
          const result = await pruneBackups(storage, policy, {
            now: new Date(Date.now() + 2 * DAY),
            scope,
            dryRun,
          });

          const outOfScope = new Set(result.outOfScope.map((backup) => backup.id));
          for (const [index, backup] of generated.entries()) {
            const id = ids[index] ?? "";
            const inScope = belongsTo(backup, scope);
            // Exactly the backups outside the scope are reported as such.
            expect(outOfScope.has(id), id).toBe(!inScope);
            if (!inScope) {
              // ...and every one of their objects is still there.
              const keysNow = storage.keys().filter((key) => key.startsWith(backupDir(id)));
              expect(keysNow, id).toEqual(keysBefore.get(id));
              if (backup.kind === "checkpointed") {
                expect(await storage.head(checkpointKey(id)), id).toBeDefined();
              }
            }
          }
          for (const removed of result.plan.remove) {
            const index = ids.indexOf(removed.id);
            const backup = generated[index];
            expect(backup !== undefined && belongsTo(backup, scope), removed.id).toBe(true);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
