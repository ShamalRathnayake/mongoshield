/**
 * Tests for the overview: the warnings it derives (failed jobs, unreadable storage,
 * unverified, failed and incomplete backups, plans without a recent backup), running a
 * plan from the table, and the empty, error and all-good states.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BackupSummary, JobSummary, PlanView, StorageView } from "../../shared/api.ts";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp } from "../testing.tsx";
import { backupsPerDay, computeWarnings } from "./overview.tsx";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const HOUR = 3_600_000;

const storage: StorageView = {
  id: "st",
  name: "Bucket",
  url: "s3://b/",
  credentials: { configured: false },
  createdAt: "2026-01-01T00:00:00Z",
};

const plan: PlanView = {
  id: "p",
  name: "Nightly",
  connectionId: "c",
  storageId: "st",
  include: [],
  exclude: [],
  compression: "zstd",
  encryption: { kind: "none" },
  consistency: "auto",
  schedule: { cron: "0 2 * * *", timezone: "UTC" },
  verify: "fast",
  notify: [],
};

function backup(id: string, hoursAgo: number, extra: Partial<BackupSummary> = {}): BackupSummary {
  return {
    id,
    status: "complete",
    startedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    ...extra,
  };
}

type OverviewData = Parameters<typeof computeWarnings>[0];

function data(overrides: Partial<OverviewData>): OverviewData {
  return { plans: [plan], jobs: [], storage: [storage], backups: new Map(), ...overrides };
}

describe("computeWarnings", () => {
  it("is quiet for a recent, verified backup", () => {
    const verified = backup("b1", 2, {
      verification: { mode: "fast", ok: true, verifiedAt: new Date(NOW).toISOString() },
    });
    expect(computeWarnings(data({ backups: new Map([["st", [verified]]]) }), NOW)).toEqual([]);
  });

  it("reports recent failed jobs, with or without a plan, and ignores old ones", () => {
    const failed = (id: string, hoursAgo: number, planId?: string): JobSummary => ({
      id,
      kind: "verify",
      status: "failed",
      startedBy: "admin",
      finishedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
      ...(planId === undefined ? {} : { planId }),
    });
    const warnings = computeWarnings(
      data({ plans: [], jobs: [failed("j1", 1, "p"), failed("j2", 2), failed("j3", 48)] }),
      NOW,
    );
    expect(warnings.map((warning) => warning.text)).toEqual([
      "Verify failed: see the job log",
      "Verify failed: see the job log",
    ]);
  });

  it("names the plan of a failed job and its error", () => {
    const job: JobSummary = {
      id: "j",
      kind: "backup",
      status: "failed",
      startedBy: "schedule",
      planId: "p",
      finishedAt: new Date(NOW).toISOString(),
      error: { code: "MS_X", message: "disk full" },
    };
    const { schedule: _schedule, ...manualPlan } = plan;
    const [warning] = computeWarnings(data({ jobs: [job], plans: [manualPlan] }), NOW);
    expect(warning?.text).toBe('Backup for "Nightly" failed: disk full');
    expect(warning?.href).toBe("#/jobs/j");
  });

  it("reports storage whose catalog could not be read", () => {
    const warnings = computeWarnings(data({ backups: new Map([["st", "Access denied."]]) }), NOW);
    expect(warnings.map((warning) => warning.key)).toEqual(["list-st"]);
  });

  it("reports unverified, failed and incomplete backups and stale plans", () => {
    const backups = [
      backup("new", 30),
      backup("bad", 40, {
        verification: { mode: "fast", ok: false, verifiedAt: "2026-10-20T00:00:00Z" },
      }),
      backup("crash", 50, { status: "incomplete" }),
    ];
    const keys = computeWarnings(data({ backups: new Map([["st", backups]]) }), NOW).map(
      (warning) => warning.key,
    );
    expect(keys).toEqual(["unverified-st", "verify-bad", "incomplete-crash", "stale-p"]);
  });

  it("reports a scheduled plan without any complete backup", () => {
    const keys = computeWarnings(data({ backups: new Map([["st", []]]) }), NOW).map(
      (warning) => warning.key,
    );
    expect(keys).toEqual(["stale-p"]);
  });
});

describe("backupsPerDay", () => {
  it("counts backups per UTC day, oldest first, and ignores ones outside the window", () => {
    const counts = backupsPerDay(
      [
        "2026-10-21T01:00:00Z",
        "2026-10-21T11:00:00Z",
        "2026-10-20T23:59:00Z",
        "2026-10-15T00:00:00Z",
        // Too old for a 7-day window, and one from the future.
        "2026-10-14T23:00:00Z",
        "2026-10-22T01:00:00Z",
      ],
      NOW,
      7,
    );
    expect(counts).toEqual([1, 0, 0, 0, 0, 1, 2]);
  });
});

describe("overview page", () => {
  it("runs a plan from the table and opens its job", async () => {
    const { user } = renderApp({ signedInAs: "maya" });
    await user.click(await screen.findByRole("button", { name: "Run now Local dev snapshot" }));
    expect(await screen.findByText('Started a backup of "Local dev snapshot".')).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/jobs\/job-/));
  });

  it("reports a run that could not start", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      failures: [{ method: "POST", path: /\/run$/, status: 409, message: "Busy." }],
    });
    await user.click(await screen.findByRole("button", { name: "Run now Local dev snapshot" }));
    expect(await screen.findByText("Busy.")).toBeTruthy();
  });

  it("lists upcoming runs and recent jobs, and opens a plan from its row", async () => {
    const { user } = renderApp({
      signedInAs: "admin",
      prepare: (mock) => {
        const first = mock.data.plans[0];
        if (first !== undefined)
          Object.assign(first, { nextRunAt: new Date(Date.now() + HOUR).toISOString() });
      },
    });
    const next = (await screen.findByRole("heading", { name: "Next runs" })).closest("section");
    if (next === null) throw new Error("no next-runs panel");
    expect(within(next).getByText("Nightly production")).toBeTruthy();
    expect(screen.getByRole("link", { name: "New backup plan" })).toBeTruthy();
    const table = screen.getByRole("table", { name: /Backup plans with their last run/ });
    const row = within(table).getByText("Staging hourly").closest("tr");
    row?.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/plans/plan-hourly"));
  });

  it("shows empty panels and the all-good message without data", async () => {
    renderApp({
      signedInAs: "sam",
      prepare: (mock) => {
        mock.data.plans = [];
        mock.data.jobs = [];
        mock.data.storage = [];
      },
    });
    expect(await screen.findByText("No backup plans yet")).toBeTruthy();
    expect(screen.getByText("Nothing scheduled")).toBeTruthy();
    expect(screen.getByText("No jobs yet")).toBeTruthy();
    expect(screen.getByText(/Every plan has a recent, verified backup/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New backup plan" })).toBeNull();
  });

  it("sums up the backups and jobs in four tiles", async () => {
    renderApp({ signedInAs: "sam" });
    const summary = await screen.findByLabelText("Summary");
    for (const label of ["Last backup", "Backups stored", "Verified", "Jobs, last 24 h"]) {
      expect(within(summary).getByText(label)).toBeTruthy();
    }
    // The mock has complete backups in several locations, some of them not verified.
    expect(within(summary).getByText(/across 3 locations/)).toBeTruthy();
    expect(within(summary).getByText(/not verified yet/)).toBeTruthy();
    expect(within(summary).getByText(/%$/)).toBeTruthy();
  });

  it("shows the tiles' empty values without backups or jobs", async () => {
    renderApp({
      signedInAs: "sam",
      prepare: (mock) => {
        mock.data.jobs = [];
        mock.data.storage = [];
      },
    });
    const summary = await screen.findByLabelText("Summary");
    expect(within(summary).getByText("Never")).toBeTruthy();
    expect(within(summary).getByText("No complete backup yet")).toBeTruthy();
    expect(within(summary).getByText("–")).toBeTruthy();
    expect(within(summary).getByText("Every backup checked")).toBeTruthy();
    expect(within(summary).getByText("0 succeeded, none failed")).toBeTruthy();
    expect(within(summary).getByText(/across 0 locations/)).toBeTruthy();
  });

  it("warns about storage it cannot read but shows everything else", async () => {
    renderFailingApp({
      signedInAs: "sam",
      failures: [
        { method: "GET", path: "/api/storage/st-r2/backups", status: 502, message: "R2 is down." },
      ],
    });
    expect(
      await screen.findByText(/Could not list backups in "R2 offsite": R2 is down\./),
    ).toBeTruthy();
    expect(screen.getByRole("table", { name: /Backup plans/ })).toBeTruthy();
  });

  it("shows a load error with retry", async () => {
    const { user } = renderFailingApp({
      signedInAs: "sam",
      failures: [
        { method: "GET", path: "/api/jobs", status: 500, message: "Jobs broke.", times: 1 },
      ],
    });
    expect(await screen.findByText("Jobs broke.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: /Backup plans/ })).toBeTruthy();
  });
});
