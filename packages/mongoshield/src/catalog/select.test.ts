import { describe, expect, it } from "vitest";
import { backupIdToDate } from "../format/layout.ts";
import type { CatalogEntry } from "./catalog.ts";
import { selectBackup } from "./select.ts";
import { idAt, makeManifest } from "./test-fixtures.ts";

/** A complete catalog entry that started at `startIso` and completed at `completedIso`. */
function complete(startIso: string, completedIso?: string, suffix = "000000"): CatalogEntry {
  const id = idAt(startIso, suffix);
  const manifest = makeManifest(
    id,
    completedIso === undefined ? {} : { completedAt: new Date(completedIso).toISOString() },
  );
  return { id, startedAt: backupIdToDate(id), status: "complete", manifest };
}

function incomplete(startIso: string): CatalogEntry {
  const id = idAt(startIso);
  return { id, startedAt: backupIdToDate(id), status: "incomplete" };
}

function invalid(startIso: string): CatalogEntry {
  const id = idAt(startIso);
  return { id, startedAt: backupIdToDate(id), status: "invalid", error: "bad JSON" };
}

/** Runs `select` and returns the thrown error (fails the test if nothing is thrown). */
function errorOf(select: () => unknown): { code: string; message: string; hint?: string } {
  try {
    select();
  } catch (error) {
    return error as { code: string; message: string; hint?: string };
  }
  throw new Error("expected selectBackup to throw");
}

const A = complete("2026-10-18T03:00:00Z");
const B = complete("2026-10-19T03:00:00Z");
const C = complete("2026-10-20T03:00:00Z");

describe("selectBackup: latest", () => {
  it("selects the most recently completed backup, skipping incomplete and invalid ones", () => {
    const entries = [incomplete("2026-10-21T03:00:00Z"), invalid("2026-10-20T09:00:00Z"), C, B, A];
    expect(selectBackup(entries, "latest")).toBe(C);
  });

  it("orders by completion time, not start time", () => {
    const longRunning = complete("2026-10-20T01:00:00Z", "2026-10-20T08:00:00Z");
    const quick = complete("2026-10-20T02:00:00Z", "2026-10-20T02:05:00Z");
    expect(selectBackup([quick, longRunning], "latest")).toBe(longRunning);
  });

  it("fails with a 'no backups yet' hint when nothing is complete", () => {
    const error = errorOf(() => selectBackup([incomplete("2026-10-21T03:00:00Z")], "latest"));
    expect(error.code).toBe("MS_BACKUP_NOT_FOUND");
    expect(error.hint).toMatch(/no complete backups yet/);
  });
});

describe("selectBackup: by id", () => {
  it("selects exactly the backup with that id", () => {
    expect(selectBackup([C, B, A], B.id)).toBe(B);
  });

  it("refuses an incomplete backup", () => {
    const pending = incomplete("2026-10-21T03:00:00Z");
    const error = errorOf(() => selectBackup([pending, C], pending.id));
    expect(error.code).toBe("MS_BACKUP_NOT_FOUND");
    expect(error.message).toMatch(/is incomplete/);
    expect(error.hint).toContain(C.id);
  });

  it("refuses a backup with an invalid manifest", () => {
    const broken = invalid("2026-10-21T03:00:00Z");
    const error = errorOf(() => selectBackup([broken, C], broken.id));
    expect(error.code).toBe("MS_MANIFEST_INVALID");
    expect(error.message).toContain("bad JSON");
  });

  it("suggests the backups that started closest to an unknown id", () => {
    const missing = idAt("2026-10-19T04:00:00Z", "abcdef");
    const far = complete("2026-01-01T00:00:00Z");
    const error = errorOf(() => selectBackup([C, B, A, far], missing));
    expect(error.code).toBe("MS_BACKUP_NOT_FOUND");
    expect(error.hint).toBe(
      `Closest available backups: ${B.id}, ${C.id}, ${A.id}. Run \`mongoshield list\` to see all of them.`,
    );
  });

  it("suggests the newest backups for a malformed id", () => {
    const error = errorOf(() => selectBackup([A, B, C], "yesterday"));
    expect(error.message).toContain('"yesterday"');
    expect(error.hint).toContain(`${C.id}, ${B.id}, ${A.id}`);
  });

  it("says there are no backups yet when the catalog is empty", () => {
    const error = errorOf(() => selectBackup([], idAt("2026-10-19T04:00:00Z")));
    expect(error.hint).toMatch(/no complete backups yet/);
  });
});

describe("selectBackup: before", () => {
  it("selects the newest backup that completed at or before the date", () => {
    // B completes at 03:01 on the 19th (one minute after it starts).
    expect(selectBackup([C, B, A], { before: new Date("2026-10-19T03:01:00Z") })).toBe(B);
    expect(selectBackup([C, B, A], { before: new Date("2026-10-19T03:00:59Z") })).toBe(A);
  });

  it("accepts an ISO string", () => {
    expect(selectBackup([C, B, A], { before: "2026-10-19T12:00:00Z" })).toBe(B);
  });

  it("uses the completion time, not the start time", () => {
    const longRunning = complete("2026-10-19T01:00:00Z", "2026-10-19T09:00:00Z");
    expect(selectBackup([longRunning, A], { before: "2026-10-19T08:00:00Z" })).toBe(A);
  });

  it("suggests the oldest backups when every backup is newer than the date", () => {
    const error = errorOf(() => selectBackup([C, B, A], { before: "2020-01-01T00:00:00Z" }));
    expect(error.code).toBe("MS_BACKUP_NOT_FOUND");
    expect(error.message).toContain("2020-01-01T00:00:00.000Z");
    expect(error.hint).toContain(`${A.id}, ${B.id}, ${C.id}`);
  });

  it("rejects a date that cannot be parsed", () => {
    const error = errorOf(() => selectBackup([C], { before: "last tuesday" }));
    expect(error.code).toBe("MS_CONFIG_INVALID");
  });
});
