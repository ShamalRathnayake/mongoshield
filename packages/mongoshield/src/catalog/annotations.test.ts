import { describe, expect, it } from "vitest";
import type { DrillReport } from "../engine/drill.ts";
import { recordDrill } from "../engine/drill-record.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { VerifyReport } from "../types.ts";
import {
  deleteAnnotations,
  placeHold,
  readAnnotations,
  readDrills,
  recordVerification,
  releaseHold,
} from "./annotations.ts";
import { listBackups } from "./catalog.ts";
import { pruneBackups } from "./prune.ts";
import { idAt, putCompleteBackup } from "./test-fixtures.ts";

/** A verify report with sensible defaults for tests. */
function report(backupId: string, overrides: Partial<VerifyReport> = {}): VerifyReport {
  return {
    backupId,
    mode: "fast",
    ok: true,
    filesChecked: 3,
    bytesChecked: 100,
    documentsChecked: 0,
    problems: [],
    durationMs: 5,
    ...overrides,
  };
}

describe("verification records", () => {
  it("are read back oldest first, with the newest as lastVerification", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-11-01T03:00:00Z");
    await recordVerification(storage, report(id, { ok: false }), new Date("2026-11-02T00:00:00Z"));
    await recordVerification(
      storage,
      report(id, { mode: "deep" }),
      new Date("2026-11-03T00:00:00Z"),
    );

    const annotations = await readAnnotations(storage, id);

    expect(annotations.verifications.map((record) => record.ok)).toEqual([false, true]);
    expect(annotations.lastVerification?.mode).toBe("deep");
  });

  it("skip unreadable records instead of failing", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-11-01T03:00:00Z");
    await storage.put(`annotations/${id}/verifications/garbage.json`, Buffer.from("{not json"));
    expect((await readAnnotations(storage, id)).verifications).toEqual([]);
  });
});

/** A drill report with sensible defaults for tests. */
function drillReport(backupId: string, overrides: Partial<DrillReport> = {}): DrillReport {
  return {
    backupId,
    ok: true,
    startedAt: "2026-11-02T00:00:00.000Z",
    durationMs: 50_000,
    restoreDurationMs: 42_000,
    restored: true,
    documentsRestored: 1000,
    databases: [],
    kept: false,
    namespaces: [],
    problems: [],
    warnings: [],
    ...overrides,
  };
}

describe("drill records", () => {
  it("are read back newest first, with the newest as lastDrill", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-11-01T03:00:00Z");
    await recordDrill(storage, drillReport(id, { ok: false }), new Date("2026-11-02T00:00:00Z"));
    await recordDrill(
      storage,
      drillReport(id, { restoreDurationMs: 7_000 }),
      new Date("2026-11-03T00:00:00Z"),
    );

    const annotations = await readAnnotations(storage, id);

    expect(annotations.drills.map((record) => record.ok)).toEqual([true, false]);
    expect(annotations.lastDrill).toMatchObject({ ok: true, restoreDurationMs: 7_000 });
    // readDrills keeps its documented oldest-first order.
    expect((await readDrills(storage, id)).map((record) => record.ok)).toEqual([false, true]);
  });

  it("skip unreadable records, and do not count as verifications", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-11-01T03:00:00Z");
    await storage.put(`annotations/${id}/drills/garbage.json`, Buffer.from("{not json"));
    await recordDrill(storage, drillReport(id));
    const annotations = await readAnnotations(storage, id);
    expect(annotations.drills).toHaveLength(1);
    expect(annotations.verifications).toEqual([]);
  });

  it("appear on catalog entries as lastDrill", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-11-01T03:00:00Z");
    await putCompleteBackup(storage, id);
    await recordDrill(storage, drillReport(id));
    const [entry] = await listBackups(storage);
    expect(entry?.lastDrill).toMatchObject({ backupId: id, ok: true, restoreDurationMs: 42_000 });
    expect(entry?.verification).toBeUndefined();
  });
});

describe("holds", () => {
  it("can be placed and released", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-11-01T03:00:00Z");
    await placeHold(storage, id, { reason: "legal hold", by: "ops" });
    expect((await readAnnotations(storage, id)).hold?.reason).toBe("legal hold");

    await releaseHold(storage, id);
    expect((await readAnnotations(storage, id)).hold).toBeUndefined();
  });

  it("require a reason", async () => {
    await expect(placeHold(memoryStorage(), "x", { reason: "  " })).rejects.toMatchObject({
      code: "MS_CONFIG_INVALID",
    });
  });

  it("still protect the backup when the hold file is unreadable", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-11-01T03:00:00Z");
    await storage.put(`annotations/${id}/hold.json`, Buffer.from("corrupt"));
    expect((await readAnnotations(storage, id)).hold).toBeDefined();
  });
});

describe("annotations in the catalog and in pruning", () => {
  it("show up on catalog entries", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-11-01T03:00:00Z");
    await putCompleteBackup(storage, id);
    await recordVerification(storage, report(id));
    await placeHold(storage, id, { reason: "audit" });

    const [entry] = await listBackups(storage);

    expect(entry?.verification?.ok).toBe(true);
    expect(entry?.hold?.reason).toBe("audit");
  });

  it("keep held backups and delete the annotations of pruned ones", async () => {
    const storage = memoryStorage();
    const old = idAt("2026-10-01T03:00:00Z");
    const held = idAt("2026-10-02T03:00:00Z");
    const newest = idAt("2026-11-01T03:00:00Z");
    for (const id of [old, held, newest]) await putCompleteBackup(storage, id);
    await placeHold(storage, held, { reason: "keep me" });
    await recordVerification(storage, report(old));

    const result = await pruneBackups(
      storage,
      { last: 1 },
      { now: new Date("2026-11-02T00:00:00Z") },
    );

    expect(result.plan.remove.map((removed) => removed.id)).toEqual([old]);
    expect(storage.keys().some((key) => key.includes(old))).toBe(false);
    expect((await readAnnotations(storage, held)).hold).toBeDefined();
  });

  it("count verified backups towards minVerified", async () => {
    const storage = memoryStorage();
    const verifiedOld = idAt("2026-10-01T03:00:00Z");
    const newest = idAt("2026-11-01T03:00:00Z");
    await putCompleteBackup(storage, verifiedOld);
    await putCompleteBackup(storage, newest);
    await recordVerification(storage, report(verifiedOld));

    const result = await pruneBackups(
      storage,
      { last: 1, minVerified: 1 },
      { now: new Date("2026-11-02T00:00:00Z"), dryRun: true },
    );

    expect(result.plan.remove).toEqual([]);
  });

  it("count a passed restore drill as verified for minVerified", async () => {
    const storage = memoryStorage();
    const drilledOld = idAt("2026-10-01T03:00:00Z");
    const newest = idAt("2026-11-01T03:00:00Z");
    await putCompleteBackup(storage, drilledOld);
    await putCompleteBackup(storage, newest);
    // A drill record exactly as `recordDrill` writes it.
    const drill = {
      backupId: drilledOld,
      drilledAt: "2026-10-02T00:00:00.000Z",
      ok: true,
      restored: true,
      restoreDurationMs: 42_000,
      durationMs: 50_000,
      namespaces: 3,
      documentsRestored: 1000,
      problemCount: 0,
      tool: "mongoshield@test",
    };
    await storage.put(
      `annotations/${drilledOld}/drills/2026-10-02T00-00-00-000Z.json`,
      Buffer.from(JSON.stringify(drill)),
    );

    const result = await pruneBackups(
      storage,
      { last: 1, minVerified: 1 },
      { now: new Date("2026-11-02T00:00:00Z"), dryRun: true },
    );

    expect(result.plan.remove).toEqual([]);
  });

  it("deleteAnnotations removes everything for one backup only", async () => {
    const storage = memoryStorage();
    await placeHold(storage, "a", { reason: "x" });
    await placeHold(storage, "b", { reason: "y" });
    await deleteAnnotations(storage, "a");
    expect(storage.keys()).toEqual(["annotations/b/hold.json"]);
  });
});
