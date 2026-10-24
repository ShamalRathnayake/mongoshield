// The backup descriptions shared by `list` and `inspect`: which check of a backup
// (verification or restore drill) the VERIFIED column shows, and how an RTO reads.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { DrillRecord, VerificationRecord } from "../catalog/annotations.ts";
import type { CatalogEntry } from "../catalog/catalog.ts";
import { idAt } from "../catalog/test-fixtures.ts";
import { formatRto, verificationSummary } from "./describe.ts";
import { Output } from "./io.ts";

const out = new Output(
  { stdout: new PassThrough(), stderr: new PassThrough(), env: {}, cwd: "/", isTTY: false },
  { json: false, quiet: false, verbose: false, color: false },
);
const NOW = new Date("2026-11-05T00:00:00Z");
const ID = idAt("2026-11-01T03:00:00Z");

function verification(verifiedAt: string, ok = true): VerificationRecord {
  return {
    backupId: ID,
    verifiedAt,
    mode: "deep",
    ok,
    filesChecked: 3,
    documentsChecked: 10,
    problemCount: ok ? 0 : 1,
    tool: "mongoshield@test",
  };
}

function drill(drilledAt: string, ok = true): DrillRecord {
  return {
    backupId: ID,
    drilledAt,
    ok,
    restored: true,
    restoreDurationMs: 42_400,
    durationMs: 50_000,
    namespaces: 2,
    documentsRestored: 10,
    problemCount: ok ? 0 : 1,
    tool: "mongoshield@test",
  };
}

function entry(extra: Pick<CatalogEntry, "verification" | "lastDrill">): CatalogEntry {
  return { id: ID, startedAt: new Date("2026-11-01T03:00:00Z"), status: "complete", ...extra };
}

describe("verificationSummary", () => {
  it("shows a drill with its RTO when the drill is the latest check", () => {
    const summary = verificationSummary(
      entry({
        verification: verification("2026-11-02T00:00:00Z"),
        lastDrill: drill("2026-11-03T00:00:00Z"),
      }),
      out,
      NOW,
    );
    expect(summary).toMatch(/^drill ✓ \(RTO 42s\) /);
  });

  it("shows the verification when it ran after the last drill", () => {
    const summary = verificationSummary(
      entry({
        verification: verification("2026-11-04T00:00:00Z"),
        lastDrill: drill("2026-11-03T00:00:00Z"),
      }),
      out,
      NOW,
    );
    expect(summary).toMatch(/^✓ deep /);
  });

  it("shows a failed drill as failed", () => {
    const summary = verificationSummary(
      entry({ lastDrill: drill("2026-11-03T00:00:00Z", false) }),
      out,
      NOW,
    );
    expect(summary).toMatch(/^drill ✗ failed /);
  });
});

describe("formatRto", () => {
  it("uses whole seconds under a minute and the usual durations otherwise", () => {
    expect(formatRto(42_400)).toBe("42s");
    expect(formatRto(350)).toBe("350ms");
    expect(formatRto(185_000)).toBe("3m 05s");
  });
});
