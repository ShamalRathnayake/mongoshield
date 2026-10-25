// Unit tests for backup chains (chain.ts): resolving an incremental back to its full
// base, every broken-link rule, cutting a chain at a point in time, and the helpers
// prune, replicate and point-in-time restores rely on.

import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import type { Manifest } from "../format/manifest.ts";
import type { CatalogEntry } from "./catalog.ts";
import {
  backupKindOf,
  chainAncestorIds,
  chainEndTime,
  chainPositionOf,
  chainRanges,
  chainUntil,
  findChainCovering,
  inspectChain,
  resolveChain,
} from "./chain.ts";
import { idAt, makeChainBase, makeIncremental, makeManifest } from "./test-fixtures.ts";

/** A complete catalog entry for a manifest. */
function entry(manifest: Manifest): CatalogEntry {
  return {
    id: manifest.id,
    startedAt: new Date(manifest.startedAt),
    status: "complete",
    manifest,
  };
}

/** full (ends at 1000) → inc1 (2000) → inc2 (3000). */
function chain() {
  const base = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000);
  const first = makeIncremental(idAt("2026-10-20T01:00:00Z"), base, 2000);
  const second = makeIncremental(idAt("2026-10-20T02:00:00Z"), first, 3000);
  return { base, first, second, entries: [entry(second), entry(first), entry(base)] };
}

describe("resolveChain", () => {
  it("follows an incremental back to its base, oldest first", () => {
    const { base, first, second, entries } = chain();
    const resolved = resolveChain(entries, second);
    expect(resolved.base.id).toBe(base.id);
    expect(resolved.incrementals.map((manifest) => manifest.id)).toEqual([first.id, second.id]);
  });

  it("resolves a full backup to itself", () => {
    const { base, entries } = chain();
    expect(resolveChain(entries, base)).toEqual({ base, incrementals: [] });
  });

  it("names a missing parent (MS_BACKUP_NOT_FOUND)", () => {
    const { second, base } = chain();
    let caught: unknown;
    try {
      resolveChain([entry(second), entry(base)], second);
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_BACKUP_NOT_FOUND")).toBe(true);
    expect((caught as Error).message).toContain("does not exist");
  });

  it("reports an incomplete or invalid parent as missing", () => {
    const { first, second, base } = chain();
    const incomplete: CatalogEntry = {
      id: first.id,
      startedAt: new Date(first.startedAt),
      status: "incomplete",
    };
    const invalid: CatalogEntry = { ...incomplete, status: "invalid", error: "bad json" };
    expect(
      inspectChain([entry(second), incomplete, entry(base)], second).problems[0],
    ).toMatchObject({ kind: "missing", problem: expect.stringContaining("incomplete") });
    expect(
      inspectChain([entry(second), invalid, entry(base)], second).problems[0]?.problem,
    ).toContain("bad json");
  });

  it.each([
    [
      "a gap between parent and child",
      (_base: Manifest) =>
        ({
          consistency: { mode: "converge", from: { t: 1500, i: 1 }, to: { t: 2000, i: 1 } },
        }) as Partial<Manifest>,
      "ends at",
    ],
    [
      "another base",
      () =>
        ({
          chain: { base: idAt("2026-01-01T00:00:00Z"), parent: "", length: 1 },
        }) as Partial<Manifest>,
      "names base",
    ],
    [
      "a wrong position",
      (base: Manifest) =>
        ({ chain: { base: base.id, parent: base.id, length: 4 } }) as Partial<Manifest>,
      "incremental #4",
    ],
    [
      "another deployment",
      () =>
        ({
          source: { topology: "replicaSet", serverVersion: "8.0.0", clusterId: "beef" },
        }) as Partial<Manifest>,
      "different",
    ],
  ])("reports %s as a mismatch (MS_INTEGRITY_FAILED)", (_label, change, message) => {
    const base = makeChainBase(idAt("2026-10-20T00:00:00Z"), 1000);
    const changes = change(base);
    const child = makeIncremental(idAt("2026-10-20T01:00:00Z"), base, 2000, {
      ...changes,
      // Keep the parent link unless the case is about it.
      ...(changes.chain === undefined
        ? {}
        : { chain: { ...changes.chain, parent: changes.chain.parent || base.id } }),
    });
    const inspection = inspectChain([entry(child), entry(base)], child);
    expect(inspection.chain).toBeUndefined();
    expect(inspection.problems.map((problem) => problem.problem).join(" ")).toContain(message);
    let caught: unknown;
    try {
      resolveChain([entry(child), entry(base)], child);
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_INTEGRITY_FAILED")).toBe(true);
  });

  it("refuses a parent without an exact end time", () => {
    const base = makeManifest(idAt("2026-10-20T00:00:00Z"), {
      source: { topology: "replicaSet", serverVersion: "8.0.0", clusterId: "c0ffee" },
    });
    const child = makeIncremental(idAt("2026-10-20T01:00:00Z"), base, 2000);
    expect(inspectChain([entry(child), entry(base)], child).problems[0]?.problem).toContain(
      'consistency "none"',
    );
  });

  it("stops on a parent link that loops back into the chain", () => {
    const { base, first } = chain();
    const looping = makeIncremental(idAt("2026-10-20T03:00:00Z"), first, 4000, {
      chain: { base: base.id, parent: idAt("2026-10-20T03:00:00Z"), length: 2 },
    });
    const inspection = inspectChain([entry(looping), entry(first), entry(base)], looping);
    expect(inspection.problems[0]?.problem).toContain("already part of this chain");
  });
});

describe("chain helpers", () => {
  it("describe kind, position and end time", () => {
    const { base, second } = chain();
    expect([backupKindOf(base), backupKindOf(second)]).toEqual(["full", "incremental"]);
    expect([chainPositionOf(base), chainPositionOf(second)]).toEqual([0, 2]);
    expect(chainEndTime(second)).toEqual({ t: 3000, i: 1 });
    const snapshot = makeManifest(idAt("2026-10-20T00:00:00Z"), {
      consistency: { mode: "snapshot", from: { t: 9, i: 2 } },
    });
    expect(chainEndTime(snapshot)).toEqual({ t: 9, i: 2 });
    expect(chainEndTime(makeManifest(idAt("2026-10-20T00:00:00Z")))).toBeUndefined();
  });

  it("list the ancestors of a backup, nearest first, stopping at a missing one", () => {
    const { base, first, second, entries } = chain();
    expect(chainAncestorIds(entries, second.id)).toEqual([first.id, base.id]);
    expect(chainAncestorIds(entries, base.id)).toEqual([]);
    expect(chainAncestorIds([entry(second), entry(base)], second.id)).toEqual([first.id]);
  });

  it("cut a chain at a point in time", () => {
    const { first, entries, second } = chain();
    const resolved = resolveChain(entries, second);
    expect(chainUntil(resolved, { t: 1000, i: 1 }).incrementals).toEqual([]);
    expect(chainUntil(resolved, { t: 1500, i: 0 }).incrementals.map((m) => m.id)).toEqual([
      first.id,
    ]);
    expect(chainUntil(resolved, { t: 2000, i: 1 }).incrementals.map((m) => m.id)).toEqual([
      first.id,
    ]);
    expect(chainUntil(resolved, { t: 2000, i: 2 }).incrementals).toHaveLength(2);
    for (const outside of [
      { t: 999, i: 0 },
      { t: 3000, i: 2 },
    ]) {
      let caught: unknown;
      try {
        chainUntil(resolved, outside);
      } catch (error) {
        caught = error;
      }
      expect(isMongoShieldError(caught, "MS_CHANGE_HISTORY_LOST")).toBe(true);
    }
  });

  it("find the chain covering a time, and every chain's range", () => {
    const { first, second, entries } = chain();
    expect(findChainCovering(entries, { t: 1500, i: 0 })?.id).toBe(first.id);
    expect(findChainCovering(entries, { t: 2500, i: 0 })?.id).toBe(second.id);
    expect(findChainCovering(entries, { t: 3500, i: 0 })).toBeUndefined();
    expect(findChainCovering(entries, { t: 500, i: 0 })).toBeUndefined();
    expect(chainRanges(entries)).toEqual([
      {
        backupId: second.id,
        baseBackupId: first.chain.base,
        from: { t: 1000, i: 1 },
        to: { t: 3000, i: 1 },
      },
    ]);
    // A broken chain covers nothing.
    expect(chainRanges([entry(second), entry(first)])).toEqual([]);
  });
});
