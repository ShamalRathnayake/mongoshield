/**
 * Page tests for the jobs list: filtering by kind and status, durations, opening a job,
 * polling while a job is active, and load errors.
 */

import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp, requestsTo } from "../testing.tsx";

afterEach(() => {
  vi.useRealTimers();
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
