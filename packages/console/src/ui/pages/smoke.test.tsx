/**
 * Smoke tests: every page renders its heading with the mock data, for the role that may
 * see it, and the overview reports the fixture warnings.
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../testing.tsx";

describe("every page renders", () => {
  it.each([
    ["#/", "Overview"],
    ["#/connections", "Connections"],
    ["#/storage", "Storage"],
    ["#/plans", "Backup plans"],
    ["#/plans/plan-nightly", "Nightly production"],
    ["#/backups", "Backups"],
    ["#/jobs", "Jobs"],
    ["#/jobs/job-1042", "Backup job"],
    ["#/audit", "Audit log"],
    ["#/users", "Users"],
    ["#/settings", "Settings"],
  ])("%s shows %s", async (hash, heading) => {
    renderApp({ signedInAs: "admin", hash });
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });

  it("shows a not-found notice for unknown routes and a role notice for admin pages", async () => {
    renderApp({ signedInAs: "sam", hash: "#/users" });
    expect(await screen.findByText("Not allowed")).toBeTruthy();
    window.location.hash = "#/nope";
    expect(await screen.findByText("Page not found")).toBeTruthy();
  });
});

describe("overview", () => {
  it("lists warnings for failed runs, failed verification and incomplete backups", async () => {
    renderApp({ signedInAs: "sam" });
    const panel = (await screen.findByRole("heading", { name: /Needs attention/ })).closest(
      "section",
    );
    if (panel === null) throw new Error("no warnings panel");
    expect(within(panel).getByText(/Backup for "Staging hourly" failed/)).toBeTruthy();
    expect(within(panel).getByText(/failed verification/)).toBeTruthy();
    expect(within(panel).getByText(/is incomplete/)).toBeTruthy();
  });
});

describe("audit log", () => {
  it("filters loaded entries by outcome", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/audit" });
    const table = await screen.findByRole("table", { name: "Audit log entries" });
    await user.selectOptions(screen.getByLabelText("Outcome"), "failure");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.textContent).toContain("Failure");
  });
});
