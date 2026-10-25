/**
 * Page tests for the jobs list: filtering by kind and status, by plan, storage and who
 * started a job (selects built from the loaded jobs), durations, opening a job, polling
 * while a job is active, and load errors.
 */

import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp, requestsTo } from "../testing.tsx";
import { jobMatches, NO_JOB_FILTERS } from "./jobs.tsx";

afterEach(() => {
  vi.useRealTimers();
});

describe("jobMatches", () => {
  const job = {
    id: "job-1",
    kind: "backup",
    status: "succeeded",
    planId: "plan-a",
    storageId: "st-a",
    startedBy: "schedule",
  } as const;

  it("lets every job through without filters and checks each filter", () => {
    expect(jobMatches(job, NO_JOB_FILTERS)).toBe(true);
    expect(jobMatches(job, { ...NO_JOB_FILTERS, kind: "restore" })).toBe(false);
    expect(jobMatches(job, { ...NO_JOB_FILTERS, status: "failed" })).toBe(false);
    expect(jobMatches(job, { ...NO_JOB_FILTERS, planId: "plan-a", storageId: "st-a" })).toBe(true);
    expect(jobMatches(job, { ...NO_JOB_FILTERS, planId: "plan-b" })).toBe(false);
    expect(jobMatches(job, { ...NO_JOB_FILTERS, storageId: "st-b" })).toBe(false);
    expect(jobMatches(job, { ...NO_JOB_FILTERS, startedBy: "maya" })).toBe(false);
  });
});

describe("jobs page", () => {
  it("filters by kind and status and shows an empty state when nothing matches", async () => {
    const { user } = renderApp({ signedInAs: "sam", hash: "#/jobs" });
    const table = await screen.findByRole("table", { name: "Jobs" });
    await user.selectOptions(screen.getByLabelText("Status"), "failed");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.textContent).toContain("Failed");
    await user.selectOptions(screen.getByLabelText("Kind"), "drill");
    expect(screen.getByText("No jobs match")).toBeTruthy();
  });

  it("filters by plan, storage and who started a job, named from the loaded lists", async () => {
    const { user } = renderApp({ signedInAs: "sam", hash: "#/jobs" });
    const table = await screen.findByRole("table", { name: "Jobs" });
    const plan = screen.getByLabelText("Plan");
    // Plans are named once the plan list arrives; counts are of the loaded jobs.
    await waitFor(() =>
      expect(
        within(plan)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(["Any plan", "Nightly production (2)", "Staging hourly (1)"]),
    );
    await user.selectOptions(plan, "plan-nightly");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("job-1037")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await user.selectOptions(screen.getByLabelText("Storage"), "st-s3");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("job-1042")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    const startedBy = screen.getByLabelText("Started by");
    expect(
      within(startedBy).getByRole("option", { name: "schedule: scheduled runs (4)" }),
    ).toBeTruthy();
    await user.selectOptions(startedBy, "maya");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("job-1039")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeTruthy();
  });

  it("hides a derived filter when no job has such a value, and names unknown ids by id", async () => {
    renderApp({
      signedInAs: "sam",
      hash: "#/jobs",
      prepare: (mock) => {
        // No job writes to a storage location; one names a plan that no longer exists.
        mock.data.jobs = mock.data.jobs.map(({ storageId: _storage, ...job }) =>
          job.id === "job-1041" ? { ...job, planId: "plan-gone" } : job,
        );
      },
    });
    await screen.findByRole("table", { name: "Jobs" });
    expect(screen.queryByLabelText("Storage")).toBeNull();
    const plan = screen.getByLabelText("Plan");
    await waitFor(() =>
      expect(within(plan).getByRole("option", { name: "plan-gone (1)" })).toBeTruthy(),
    );
  });

  it("opens a job from its row", async () => {
    const { user } = renderApp({ signedInAs: "sam", hash: "#/jobs" });
    const table = await screen.findByRole("table", { name: "Jobs" });
    const row = within(table).getByText("job-1042").closest("tr");
    row?.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/jobs/job-1042"));
  });

  it("polls while a job is running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { backend, user } = renderApp({ signedInAs: "maya", hash: "#/plans/plan-local" });
    await user.click(await screen.findByRole("button", { name: "Run now" }));
    window.location.hash = "#/jobs";
    await screen.findByRole("table", { name: "Jobs" });
    const before = requestsTo(backend, "GET", "/api/jobs").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await waitFor(() =>
      expect(requestsTo(backend, "GET", "/api/jobs").length).toBeGreaterThan(before),
    );
  });

  it("retries after a failed load", async () => {
    const { user } = renderFailingApp({
      signedInAs: "sam",
      hash: "#/jobs",
      failures: [{ method: "GET", path: "/api/jobs", status: 500, times: 1 }],
    });
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Jobs" })).toBeTruthy();
  });
});
