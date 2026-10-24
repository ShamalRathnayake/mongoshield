// The one-line run summaries (src/schedule/report.ts) that chat notifications and
// the CLI print, for every run status and the optional parts of a report.

import { describe, expect, it } from "vitest";
import { RUN_REPORT_VERSION, type RunReport, summarizeReport, verifyLabel } from "./report.ts";

const BASE: RunReport = {
  version: RUN_REPORT_VERSION,
  runId: "abc123",
  status: "success",
  startedAt: "2026-10-20T03:00:00.000Z",
  finishedAt: "2026-10-20T03:01:00.000Z",
  durationMs: 60_000,
  host: "runner-1",
  storage: "memory://test/",
  lock: { kind: "storage" },
};

const BACKUP: NonNullable<RunReport["backup"]> = {
  id: "2026-10-20T03-00-00Z_aaaaaa",
  namespaces: 3,
  documents: 12_345,
  bytesRaw: 1000,
  bytesStored: 500,
  durationMs: 1000,
  attempts: 1,
};

describe("summarizeReport", () => {
  it("names the parent and the changes of an incremental backup", () => {
    expect(
      summarizeReport({
        ...BASE,
        backup: {
          ...BACKUP,
          kind: "incremental",
          parent: "2026-10-20T02-00-00Z_bbbbbb",
          changes: 4321,
        },
      }),
    ).toBe(
      "Incremental backup 2026-10-20T03-00-00Z_aaaaaa succeeded: 4,321 changes since 2026-10-20T02-00-00Z_bbbbbb.",
    );
    expect(summarizeReport({ ...BASE, backup: { ...BACKUP, kind: "incremental" } })).toContain(
      "0 changes since its parent",
    );
  });

  it("names the lock holder of a skipped run when it is known", () => {
    expect(
      summarizeReport({
        ...BASE,
        status: "skipped",
        lock: {
          kind: "storage",
          heldBy: { owner: "o", host: "runner-2", expiresAt: BASE.finishedAt },
        },
      }),
    ).toBe("Skipped: the backup lock is held by runner-2.");
    expect(summarizeReport({ ...BASE, status: "skipped" })).toBe(
      "Skipped: the backup lock is held.",
    );
  });

  it("says which step failed and why, or that the error is unknown", () => {
    expect(
      summarizeReport({
        ...BASE,
        status: "failure",
        error: { step: "verify", code: "MS_INTEGRITY_FAILED", message: "bad file" },
      }),
    ).toBe("Backup failed during verify: bad file");
    expect(summarizeReport({ ...BASE, status: "failure" })).toBe(
      "Backup failed during run: unknown error",
    );
  });

  it("shows the parts done of a checkpointed backup, when known", () => {
    expect(
      summarizeReport({
        ...BASE,
        status: "checkpointed",
        backup: { ...BACKUP, status: "checkpointed", parts: { done: 3, total: 10 } },
      }),
    ).toBe(`Backup ${BACKUP.id} checkpointed (3/10 parts done); the next run resumes it.`);
    expect(summarizeReport({ ...BASE, status: "checkpointed" })).toBe(
      "Backup  checkpointed; the next run resumes it.",
    );
  });

  it("summarizes a success with and without verify and prune details", () => {
    expect(summarizeReport(BASE)).toBe("Backup succeeded.");
    expect(summarizeReport({ ...BASE, backup: BACKUP })).toBe(
      `Backup ${BACKUP.id} succeeded: 3 namespaces, 12,345 documents.`,
    );
    const verify = { mode: "fast", ok: true, problems: [], attempts: 1 } as const;
    expect(
      summarizeReport({
        ...BASE,
        backup: BACKUP,
        verify,
        prune: { deletedBackups: 1, deletedBytes: 10, kept: 3 },
      }),
    ).toBe(
      `Backup ${BACKUP.id} succeeded: 3 namespaces, 12,345 documents, verified (fast), pruned 1 old backup.`,
    );
    expect(
      summarizeReport({
        ...BASE,
        backup: BACKUP,
        prune: { deletedBackups: 2, deletedBytes: 10, kept: 3 },
      }),
    ).toContain(", pruned 2 old backups.");
    // Nothing deleted: no prune clause.
    expect(
      summarizeReport({
        ...BASE,
        backup: BACKUP,
        prune: { deletedBackups: 0, deletedBytes: 0, kept: 3 },
      }),
    ).not.toContain("pruned");
  });
});

describe("verifyLabel", () => {
  it("adds the measured RTO for drills, in short units", () => {
    const drill = { mode: "drill", ok: true, problems: [], attempts: 1 } as const;
    expect(verifyLabel({ ...drill, rtoMs: 1234 })).toBe("drill, RTO 1.2 s");
    expect(verifyLabel({ ...drill, rtoMs: 42_400 })).toBe("drill, RTO 42 s");
    expect(verifyLabel({ ...drill, mode: "deep" })).toBe("deep");
  });
});
