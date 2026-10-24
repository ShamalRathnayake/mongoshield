// `mongoshield rehearse-upgrade` without a server: the analysis-only mode against an
// in-memory backup, and the report printing for outcomes a healthy test server never
// produces (a failed restore, warnings from live checks), with `MongoShield
// .rehearseUpgrade` replaced by a canned report. The real rehearsal runs in
// test/integration/upgrade-rehearsal-cli.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { namedMemoryStore } from "../../../test/helpers/cli-backups.ts";
import type { DrillReport } from "../../engine/drill.ts";
import type { UpgradeRehearsalReport } from "../../engine/upgrade-rehearsal.ts";
import { MongoShield } from "../../shield.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A backup with one geoHaystack index (a problem) and one clean collection. */
async function backupWithProblem() {
  const { url, storage } = await namedMemoryStore();
  const manifest = await writeTestBackup(storage, {
    namespaces: [
      {
        ns: "app.places",
        documents: [{ _id: 1 }],
        indexes: [
          { v: 2, key: { _id: 1 }, name: "_id_" },
          { v: 1, key: { loc: "geoHaystack", type: 1 }, name: "geo", bucketSize: 1 },
        ],
      },
      { ns: "app.users", documents: [{ _id: 1 }] },
    ],
  });
  return { url, id: manifest.id };
}

describe("rehearse-upgrade --analyze-only", () => {
  it("lists findings with their rule and source, and exits 33 on problems", async () => {
    const { url, id } = await backupWithProblem();
    const run = await runTestCli([
      "rehearse-upgrade",
      id,
      "--from",
      url,
      "--target-version",
      "8.0",
      "--analyze-only",
    ]);
    expect(run.code).toBe(33);
    expect(run.stdout).toContain("Compatibility MongoDB 7.0.0 → 8.0, in-place path: 7.0.0 → 8.0");
    expect(run.stdout).toContain('✖ problem  app.places: index "geo" is a geoHaystack index');
    expect(run.stdout).toContain("index-geohaystack, MongoDB 5.0: https://");
    expect(run.stdout).toContain("▲ warning  app.places:");
    expect(run.stdout).toContain("✖ 1 compatibility problem in backup");
  });

  it("narrows the analysis with --include / --exclude", async () => {
    const { url, id } = await backupWithProblem();
    const run = await runTestCli([
      "rehearse-upgrade",
      id,
      "--from",
      url,
      "--target-version",
      "8.0",
      "--analyze-only",
      "--include",
      "app.*",
      "--exclude",
      "app.places",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("nothing in the release notes affects this backup");
    expect(run.stdout).toContain("No compatibility problems");
  });

  it("shows no in-place path for a target that is not newer", async () => {
    const { url, id } = await backupWithProblem();
    const run = await runTestCli([
      "rehearse-upgrade",
      id,
      "--from",
      url,
      "--target-version",
      "6.0",
      "--analyze-only",
    ]);
    expect(run.stdout).toContain("Compatibility MongoDB 7.0.0 → 6.0 (");
    expect(run.stdout).toContain("this would be a downgrade");
  });
});

describe("rehearse-upgrade report printing", () => {
  /** A canned report: restore failed, one live warning, one compatibility warning. */
  function cannedReport(): UpgradeRehearsalReport {
    const drill: DrillReport = {
      backupId: "2026-11-14T03-00-04Z_7f3a9c",
      ok: false,
      startedAt: new Date().toISOString(),
      durationMs: 10,
      restoreDurationMs: 5,
      restored: false,
      documentsRestored: 0,
      databases: [{ source: "app", target: "msdrill_1_app" }],
      kept: false,
      namespaces: [],
      problems: [
        { subject: "restore", problem: "index geo: GeoHaystack indexes cannot be created" },
      ],
      warnings: ["Could not drop the temporary database msdrill_1_app: gone"],
    };
    return {
      backupId: drill.backupId,
      ok: false,
      startedAt: drill.startedAt,
      durationMs: 20,
      sourceVersion: "4.4.29",
      targetVersion: "8.0",
      serverVersion: "8.0.13",
      ephemeral: false,
      compatibility: {
        sourceVersion: "4.4.29",
        targetVersion: "8.0",
        upgradePath: ["5.0", "6.0", "7.0", "8.0"],
        ok: true,
        rulesChecked: 20,
        findings: [
          {
            rule: "upgrade-multiple-steps",
            severity: "warning",
            subject: "upgrade",
            message: "an in-place upgrade from 4.4 must go through every release",
            since: "8.0",
            reference: "https://example.com",
          },
        ],
      },
      drill,
      checks: [
        {
          ns: "app.users",
          check: "validate",
          outcome: "warning",
          message: "validate passed with warnings: w",
        },
      ],
      problems: drill.problems,
      warnings: [],
    };
  }

  it("prints a failed restore, the checks with their outcome, the problems and the drill's warnings", async () => {
    vi.spyOn(MongoShield.prototype, "rehearseUpgrade").mockResolvedValue(cannedReport());
    const { url, id } = await backupWithProblem();
    const run = await runTestCli([
      "rehearse-upgrade",
      id,
      "--from",
      url,
      "--target-version",
      "8.0",
      "--target-uri",
      "mongodb://scratch.example:27017",
    ]);
    expect(run.code).toBe(33);
    expect(run.stderr).toContain("Rehearsing MongoDB 8.0 on mongodb://scratch.example:27017");
    expect(run.stdout).toContain("in-place path: 4.4.29 → 5.0 → 6.0 → 7.0 → 8.0");
    expect(run.stdout).toContain(
      "Restore into MongoDB 8.0.13 (the scratch deployment): 0 documents in 5ms, failed",
    );
    expect(run.stdout).not.toContain("NAMESPACE             TYPE");
    expect(run.stdout).toMatch(
      /app\.users\s+validate\s+warning\s+validate passed with warnings: w/,
    );
    expect(run.stdout).toContain("✖ Rehearsal failed: 1 problem for MongoDB 8.0.13.");
    expect(run.stdout).toContain("• restore: index geo: GeoHaystack indexes cannot be created");
    expect(run.stderr).toContain("Could not drop the temporary database msdrill_1_app");
  });

  it("prints the whole report with --json", async () => {
    vi.spyOn(MongoShield.prototype, "rehearseUpgrade").mockResolvedValue(cannedReport());
    const { url, id } = await backupWithProblem();
    const run = await runTestCli([
      "rehearse-upgrade",
      id,
      "--from",
      url,
      "--target-version",
      "8.0.13",
      "--json",
    ]);
    expect(run.code).toBe(33);
    expect(run.json()).toMatchObject({
      ok: false,
      serverVersion: "8.0.13",
      checks: [{ outcome: "warning" }],
    });
  });
});
