import { describe, expect, it, vi } from "vitest";
import {
  idAt,
  makeChainBase,
  makeIncremental,
  makeManifest,
  putCompleteBackup,
} from "../catalog/test-fixtures.ts";
import { isMongoShieldError } from "../errors.ts";
import type { Manifest, NamespaceEntry } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import { memoryStorage } from "../storage/memory.ts";
import {
  backupShapeLabel,
  checkBackupSanity,
  enforceBackupGuard,
  findGuardBaseline,
  GUARD_SHAPE_LABEL,
} from "./backup-guard.ts";

const SHA = "0".repeat(64);

/** A namespace entry with the given document count and raw size. */
function entry(ns: string, documents: number, bytesRaw = documents * 100): NamespaceEntry {
  const [db = "", collection = ""] = ns.split(".");
  return {
    ns,
    db,
    collection,
    type: "collection",
    documents,
    bytesRaw,
    files: [],
    metadata: { key: `${db}/${collection}.metadata.json`, size: 10, sha256: SHA },
  };
}

/** A manifest at `time` holding `entries`, with totals computed. */
function backupAt(
  time: string,
  entries: NamespaceEntry[],
  overrides: Partial<Manifest> = {},
): Manifest {
  return makeManifest(idAt(time), {
    namespaces: entries,
    totals: {
      namespaces: entries.length,
      documents: entries.reduce((sum, item) => sum + item.documents, 0),
      bytesRaw: entries.reduce((sum, item) => sum + item.bytesRaw, 0),
      bytesStored: 0,
    },
    ...overrides,
  });
}

const BEFORE = "2026-10-19T03:00:00Z";
const NOW = "2026-10-20T03:00:00Z";

describe("checkBackupSanity", () => {
  it("passes when there is no previous backup to compare with", () => {
    const current = backupAt(NOW, [entry("app.users", 0)]);
    expect(checkBackupSanity(undefined, current, { maxDocumentDropPercent: 0 })).toEqual({
      ok: true,
      findings: [],
    });
  });

  it("flags a collection that disappeared, by default", () => {
    const previous = backupAt(BEFORE, [entry("app.users", 10), entry("app.orders", 5)]);
    const current = backupAt(NOW, [entry("app.users", 10)]);
    const check = checkBackupSanity(previous, current, {});
    expect(check.ok).toBe(false);
    expect(check.findings).toEqual([
      { ns: "app.orders", message: expect.stringContaining("missing now") },
    ]);
  });

  it("ignores missing collections when failOnMissingCollection is false", () => {
    const previous = backupAt(BEFORE, [entry("app.users", 10), entry("app.orders", 5)]);
    const current = backupAt(NOW, [entry("app.users", 10)]);
    expect(checkBackupSanity(previous, current, { failOnMissingCollection: false }).ok).toBe(true);
  });

  it("flags a document drop above maxDocumentDropPercent and allows one at the limit", () => {
    const previous = backupAt(BEFORE, [entry("app.users", 1000), entry("app.orders", 1000)]);
    const current = backupAt(NOW, [entry("app.users", 500), entry("app.orders", 499)]);
    const check = checkBackupSanity(previous, current, { maxDocumentDropPercent: 50 });
    expect(check.findings).toHaveLength(1);
    expect(check.findings[0]?.ns).toBe("app.orders");
    expect(check.findings[0]?.message).toContain("1,000 to 499 documents (-50.1%)");
  });

  it("never flags growth or collections that were empty before", () => {
    const previous = backupAt(BEFORE, [entry("app.users", 10), entry("app.empty", 0)]);
    const current = backupAt(NOW, [entry("app.users", 50), entry("app.empty", 0)]);
    const policy = { maxDocumentDropPercent: 0, maxSizeDropPercent: 0 };
    expect(checkBackupSanity(previous, current, policy).ok).toBe(true);
  });

  it("flags a total raw size drop above maxSizeDropPercent without a namespace", () => {
    const previous = backupAt(BEFORE, [entry("app.users", 10, 10_000)]);
    const current = backupAt(NOW, [entry("app.users", 10, 2_000)]);
    const check = checkBackupSanity(previous, current, { maxSizeDropPercent: 25 });
    expect(check.findings).toEqual([{ message: expect.stringContaining("-80%") }]);
  });

  it("does not check document or size drops unless a threshold is set", () => {
    const previous = backupAt(BEFORE, [entry("app.users", 1000)]);
    const current = backupAt(NOW, [entry("app.users", 1)]);
    expect(checkBackupSanity(previous, current, {}).ok).toBe(true);
  });
});

describe("backupShapeLabel", () => {
  it("does not depend on pattern order or query values", () => {
    const one = backupShapeLabel({ include: ["a.*", "b.*"], query: { "a.x": { n: 1 } } });
    const two = backupShapeLabel({ include: ["b.*", "a.*"], query: { "a.x": { n: 2 } } });
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs when the selection differs", () => {
    expect(backupShapeLabel({ include: ["a.*"] })).not.toBe(backupShapeLabel({ exclude: ["a.*"] }));
  });
});

describe("findGuardBaseline", () => {
  const shapeA = { [GUARD_SHAPE_LABEL]: backupShapeLabel({ include: ["app.*"] }) };
  const shapeB = { [GUARD_SHAPE_LABEL]: backupShapeLabel({ include: ["other.*"] }) };

  it("picks the newest earlier backup with the same shape and deployment", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, idAt("2026-10-17T03:00:00Z"), { labels: shapeA });
    await putCompleteBackup(storage, idAt("2026-10-18T03:00:00Z"), { labels: shapeA });
    // Newer but a different shape, a different cluster, or no label: all skipped.
    await putCompleteBackup(storage, idAt("2026-10-19T01:00:00Z"), { labels: shapeB });
    await putCompleteBackup(storage, idAt("2026-10-19T02:00:00Z"), {
      labels: shapeA,
      source: { topology: "replicaSet", serverVersion: "7.0.0", clusterId: "other" },
    });
    await putCompleteBackup(storage, idAt("2026-10-19T02:30:00Z"));

    const candidate = backupAt(NOW, [], {
      labels: shapeA,
      source: { topology: "replicaSet", serverVersion: "7.0.0", clusterId: "mine" },
    });
    const baseline = await findGuardBaseline(storage, candidate);
    expect(baseline?.id).toBe(idAt("2026-10-18T03:00:00Z"));
  });

  it("never compares a backup with itself or with a later one", async () => {
    const storage = memoryStorage();
    const candidate = backupAt(NOW, []);
    await putCompleteBackup(storage, candidate.id);
    await putCompleteBackup(storage, idAt("2026-10-21T03:00:00Z"));
    expect(await findGuardBaseline(storage, candidate)).toBeUndefined();
  });
});

describe("the guard and incremental backups", () => {
  it("never uses an incremental as the baseline, and does not check one", async () => {
    const storage = memoryStorage();
    const full = backupAt(BEFORE, [entry("app.users", 100)]);
    await putCompleteBackup(storage, full.id, full);
    // An incremental lists no collections: as a baseline, everything would look missing.
    const incremental = makeIncremental(
      idAt("2026-10-19T04:00:00Z"),
      makeChainBase(full.id, 10),
      20,
    );
    await putCompleteBackup(storage, incremental.id, incremental);

    const candidate = backupAt(NOW, [entry("app.users", 100)]);
    expect((await findGuardBaseline(storage, candidate))?.id).toBe(full.id);

    const later = makeIncremental(idAt("2026-10-20T04:00:00Z"), incremental, 30);
    const result = await enforceBackupGuard({
      storage,
      candidate: later,
      policy: { maxDocumentDropPercent: 10 },
    });
    expect(result).toMatchObject({ ok: true, findings: [], baselineId: undefined });
  });
});

describe("enforceBackupGuard", () => {
  /** Storage with one earlier backup of `app.users` holding 100 documents. */
  async function storageWithBaseline() {
    const storage = memoryStorage();
    const previous = backupAt(BEFORE, [entry("app.users", 100)]);
    await putCompleteBackup(storage, previous.id, previous);
    return { storage, previous };
  }

  it("throws MS_GUARD_FAILED with the findings when the action is fail", async () => {
    const { storage, previous } = await storageWithBaseline();
    const candidate = backupAt(NOW, [entry("app.users", 1)]);
    const error = await enforceBackupGuard({
      storage,
      candidate,
      policy: { maxDocumentDropPercent: 10 },
    }).catch((caught: unknown) => caught);

    expect(isMongoShieldError(error, "MS_GUARD_FAILED")).toBe(true);
    if (!isMongoShieldError(error)) return;
    expect(error.message).toContain("guard refused");
    expect(error.details).toMatchObject({ baselineId: previous.id, guard: [{ ns: "app.users" }] });
  });

  it("only logs the findings when the action is warn", async () => {
    const { storage, previous } = await storageWithBaseline();
    const warn = vi.fn<Logger["warn"]>();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const result = await enforceBackupGuard({
      storage,
      candidate: backupAt(NOW, []),
      policy: { action: "warn" },
      logger,
    });
    expect(result).toMatchObject({ ok: false, action: "warn", baselineId: previous.id });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("app.users"), expect.anything());
  });

  it("passes the very first backup", async () => {
    const result = await enforceBackupGuard({
      storage: memoryStorage(),
      candidate: backupAt(NOW, []),
      policy: { maxDocumentDropPercent: 0 },
    });
    expect(result).toEqual({ ok: true, findings: [], baselineId: undefined, action: "fail" });
  });
});
