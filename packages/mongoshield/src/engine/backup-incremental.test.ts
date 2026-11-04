// Unit tests for choosing the parent of an incremental backup and for the chain
// policies (backup-incremental.ts): every rule that makes a backup continuable or not,
// without a database.

import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../catalog/catalog.ts";
import {
  CHAIN_CLUSTER_ID,
  idAt,
  makeChainBase,
  makeIncremental,
  makeManifest,
} from "../catalog/test-fixtures.ts";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import type { Manifest } from "../format/manifest.ts";
import {
  chooseParent,
  fallbackWarning,
  fullBackupDue,
  type ParentRequirements,
  sameSelection,
} from "./backup-incremental.ts";

const DAY = 24 * 60 * 60 * 1000;

function entry(manifest: Manifest): CatalogEntry {
  return { id: manifest.id, startedAt: new Date(manifest.startedAt), status: "complete", manifest };
}

/** The requirements of an incremental of `app.*` on the fixtures' deployment. */
function requirements(overrides: Partial<ParentRequirements> = {}): ParentRequirements {
  return {
    from: "latest",
    deployment: { clusterId: CHAIN_CLUSTER_ID },
    selection: { include: ["app.*"], exclude: [], query: [] },
    labels: {},
    ...overrides,
  };
}

/** The error a function throws (or undefined). */
function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("chooseParent", () => {
  const base = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000);
  const first = makeIncremental(idAt("2026-10-20T01:00:00Z"), base, 2000);

  it("continues the newest end time: an incremental extends its chain", () => {
    const parent = chooseParent([entry(first), entry(base)], requirements());
    expect(parent.manifest.id).toBe(first.id);
    expect(parent.endTime).toEqual({ t: 2000, i: 1 });
    expect(parent.chain).toEqual({ base: base.id, parent: first.id, length: 2 });
  });

  it("starts a chain after a full backup", () => {
    expect(chooseParent([entry(base)], requirements()).chain).toEqual({
      base: base.id,
      parent: base.id,
      length: 1,
    });
  });

  it("skips newer backups of another deployment or selection, or without an end time", () => {
    const entries = [
      entry(
        makeChainBase(idAt("2026-10-21T00:00:00Z"), 9000, {
          source: { topology: "replicaSet", serverVersion: "8.0.0", clusterId: "beef" },
        }),
      ),
      entry(
        makeChainBase(idAt("2026-10-21T01:00:00Z"), 9100, {
          selection: { include: ["*"], exclude: [], query: [] },
        }),
      ),
      entry(
        makeManifest(idAt("2026-10-21T03:00:00Z"), {
          source: { topology: "replicaSet", serverVersion: "8.0.0", clusterId: CHAIN_CLUSTER_ID },
          selection: { include: ["app.*"], exclude: [], query: [] },
        }),
      ),
      entry(base),
    ];
    expect(chooseParent(entries, requirements()).manifest.id).toBe(base.id);
  });

  it("never continues a backup, or a chain, that failed its last verification", () => {
    const failed = (manifest: Manifest, ok: boolean): CatalogEntry => ({
      ...entry(manifest),
      verification: {
        backupId: manifest.id,
        verifiedAt: "2026-10-20T02:00:00.000Z",
        mode: "fast",
        ok,
        filesChecked: 1,
        documentsChecked: 0,
        problemCount: ok ? 0 : 1,
        tool: "mongoshield@test",
      },
    });
    const older = makeChainBase(idAt("2026-10-19T00:00:00Z"), 500);
    // The damaged base: neither it nor its incremental may get a child.
    const entries = [entry(first), failed(base, false), entry(older)];
    expect(chooseParent(entries, requirements()).manifest.id).toBe(older.id);

    const named = errorOf(() => chooseParent(entries, requirements({ from: first.id })));
    expect(isMongoShieldError(named, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(named)).toContain(`its chain holds ${base.id}, which failed`);

    // A passing verification (the newest one counts) makes it usable again.
    expect(chooseParent([entry(first), failed(base, true)], requirements()).manifest.id).toBe(
      first.id,
    );
  });

  it("finds nothing to continue (MS_BACKUP_NOT_FOUND)", () => {
    const error = errorOf(() => chooseParent([], requirements()));
    expect(isMongoShieldError(error, "MS_BACKUP_NOT_FOUND")).toBe(true);
  });

  it.each([
    [
      "no end time",
      makeManifest(idAt("2026-10-20T00:00:00Z"), {
        selection: { include: ["app.*"], exclude: [], query: [] },
        source: { topology: "replicaSet", serverVersion: "8.0.0", clusterId: CHAIN_CLUSTER_ID },
      }),
      'consistency "none"',
    ],
    [
      "another deployment",
      makeChainBase(idAt("2026-10-20T00:00:00Z"), 1, {
        source: { topology: "replicaSet", serverVersion: "8.0.0" },
      }),
      "different deployment",
    ],
    [
      "no recorded selection",
      makeChainBase(idAt("2026-10-20T00:00:00Z"), 1, { selection: undefined }),
      "does not record",
    ],
    [
      "another selection",
      makeChainBase(idAt("2026-10-20T00:00:00Z"), 1, {
        selection: { include: ["*"], exclude: [], query: [] },
      }),
      "different selection",
    ],
    [
      "a query",
      makeChainBase(idAt("2026-10-20T00:00:00Z"), 1, {
        selection: { include: ["app.*"], exclude: [], query: ["app.a"] },
      }),
      "query",
    ],
  ])("explains why a named backup with %s cannot be continued", (_label, manifest, reason) => {
    const error = errorOf(() =>
      chooseParent([entry(manifest)], requirements({ from: manifest.id })),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect((error as Error).message).toContain(reason);
  });

  it("refuses a named parent whose own chain is broken", () => {
    const orphan = makeIncremental(idAt("2026-10-20T01:00:00Z"), base, 2000);
    const error = errorOf(() => chooseParent([entry(orphan)], requirements({ from: orphan.id })));
    expect((error as Error).message).toContain("its own chain is broken");
  });

  it("requires the plan label when the new backup has one", () => {
    const planned = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000, {
      labels: { "mongoshield.plan": "p1" },
    });
    expect(
      chooseParent([entry(planned)], requirements({ labels: { "mongoshield.plan": "p1" } }))
        .manifest.id,
    ).toBe(planned.id);
    const error = errorOf(() =>
      chooseParent([entry(planned)], requirements({ labels: { "mongoshield.plan": "p2" } })),
    );
    expect(isMongoShieldError(error, "MS_BACKUP_NOT_FOUND")).toBe(true);
  });
});

describe("chooseParent and replica sets that share a name", () => {
  const withInstance = (instanceId: string | undefined): Partial<Manifest> => ({
    source: {
      topology: "replicaSet",
      serverVersion: "8.0.0",
      clusterId: CHAIN_CLUSTER_ID,
      ...(instanceId === undefined ? {} : { instanceId }),
    },
  });

  it("never continues a backup of another replica set with the same name", () => {
    const staging = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000, withInstance("staging"));
    const prod = makeChainBase(idAt("2026-10-19T00:00:00Z"), 500, withInstance("prod"));
    const ofProd = requirements({
      deployment: { clusterId: CHAIN_CLUSTER_ID, instanceId: "prod" },
    });
    // The staging backup is newer, but it is not this deployment's.
    expect(chooseParent([entry(staging), entry(prod)], ofProd).manifest.id).toBe(prod.id);
    const error = errorOf(() => chooseParent([entry(staging)], { ...ofProd, from: staging.id }));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(error)).toContain("different deployment");
  });

  it("keeps continuing chains written before instanceId was recorded", () => {
    const old = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000, withInstance(undefined));
    const ofProd = requirements({
      deployment: { clusterId: CHAIN_CLUSTER_ID, instanceId: "prod" },
    });
    expect(chooseParent([entry(old)], ofProd).manifest.id).toBe(old.id);
  });
});

describe("fallbackWarning", () => {
  it("warns about MS_SNAPSHOT_TOO_OLD, which repeats on every run, and nothing routine", () => {
    const tooOld = new MongoShieldError("MS_SNAPSHOT_TOO_OLD", "snapshot too old");
    expect(fallbackWarning(tooOld)).toContain("minSnapshotHistoryWindowInSeconds");
    for (const code of [
      "MS_BACKUP_NOT_FOUND",
      "MS_CHANGE_HISTORY_LOST",
      "MS_CONFIG_INVALID",
    ] as const) {
      expect(fallbackWarning(new MongoShieldError(code, "x"))).toBeUndefined();
    }
  });
});

describe("fullBackupDue", () => {
  const base = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000);
  const first = makeIncremental(idAt("2026-10-20T01:00:00Z"), base, 2000);
  const entries = [entry(first), entry(base)];
  const parent = chooseParent(entries, requirements());
  const completed = Date.parse(base.completedAt);

  it("asks for a full backup once the chain's base is older than fullAfterMs", () => {
    expect(
      fullBackupDue(entries, parent, { fullAfterMs: 7 * DAY }, new Date(completed + DAY)),
    ).toBeUndefined();
    expect(
      fullBackupDue(entries, parent, { fullAfterMs: 7 * DAY }, new Date(completed + 8 * DAY)),
    ).toContain("older than 7 days");
    expect(
      fullBackupDue(entries, parent, { fullAfterMs: 12 * 3_600_000 }, new Date(completed + DAY)),
    ).toContain("12 hours");
  });

  it("asks for a full backup once the chain is maxChainLength long", () => {
    // The next incremental would be #2.
    expect(fullBackupDue(entries, parent, { maxChainLength: 2 }, new Date())).toBeUndefined();
    expect(fullBackupDue(entries, parent, { maxChainLength: 1 }, new Date())).toContain(
      "maxChainLength",
    );
  });

  it("asks for nothing without a policy", () => {
    expect(fullBackupDue(entries, parent, {}, new Date(completed + 365 * DAY))).toBeUndefined();
  });
});

describe("sameSelection", () => {
  it("ignores pattern order but not content", () => {
    const a = { include: ["b.*", "a.*"], exclude: [], query: [] };
    expect(sameSelection(a, { include: ["a.*", "b.*"], exclude: [], query: [] })).toBe(true);
    expect(sameSelection(a, { include: ["a.*"], exclude: [], query: [] })).toBe(false);
    expect(sameSelection(a, { include: ["a.*", "b.*"], exclude: ["a.x"], query: [] })).toBe(false);
  });
});
