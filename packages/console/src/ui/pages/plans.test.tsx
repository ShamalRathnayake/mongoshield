/**
 * Page tests for the plan list: schedules in words, sources and targets, running a plan
 * (and a refused run), opening a plan, the empty state per role, and load errors.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp } from "../testing.tsx";

describe("plans page", () => {
  it("lists plans with their schedule, source and target", async () => {
    renderApp({ signedInAs: "sam", hash: "#/plans" });
    const table = await screen.findByRole("table", { name: "Backup plans" });
    const nightly = within(table).getByText("Nightly production").closest("tr");
    expect(nightly?.textContent).toContain("Every day at 02:00");
    expect(nightly?.textContent).toContain("Production cluster");
    expect(nightly?.textContent).toContain("S3 primary");
    const local = within(table).getByText("Local dev snapshot").closest("tr");
    expect(local?.textContent).toContain("Never");
    expect(screen.queryByRole("button", { name: /Run now/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "New plan" })).toBeNull();
  });

  it("falls back to ids for unknown connections and storage", async () => {
    renderApp({
      signedInAs: "sam",
      hash: "#/plans",
      prepare: (mock) => {
        mock.data.connections = [];
        mock.data.storage = [];
      },
    });
    const table = await screen.findByRole("table", { name: "Backup plans" });
    expect(within(table).getByText(/conn-prod/)).toBeTruthy();
  });

  it("runs a plan and opens its job", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: "#/plans" });
    await user.click(await screen.findByRole("button", { name: "Run now Local dev snapshot" }));
    expect(await screen.findByText('Started a backup of "Local dev snapshot".')).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/jobs\/job-/));
  });

  it("reports a run that could not start", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: "#/plans",
      failures: [{ method: "POST", path: /\/run$/, status: 409, message: "Locked." }],
    });
    await user.click(await screen.findByRole("button", { name: "Run now Staging hourly" }));
    expect(await screen.findByText("Locked.")).toBeTruthy();
  });

  it("opens a plan from its row", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans" });
    const table = await screen.findByRole("table", { name: "Backup plans" });
    within(table).getByText("Staging hourly").closest("tr")?.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/plans/plan-hourly"));
  });

  it("offers admins a first plan when there is none", async () => {
    renderApp({
      signedInAs: "admin",
      hash: "#/plans",
      prepare: (mock) => {
        mock.data.plans = [];
      },
    });
    expect(await screen.findByText("No backup plans yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a plan" })).toBeTruthy();
  });

  it("shows the empty state without the create link to viewers", async () => {
    renderApp({
      signedInAs: "sam",
      hash: "#/plans",
      prepare: (mock) => {
        mock.data.plans = [];
      },
    });
    expect(await screen.findByText("No backup plans yet")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create a plan" })).toBeNull();
  });

  it("retries after a failed load", async () => {
    const { user } = renderFailingApp({
      signedInAs: "sam",
      hash: "#/plans",
      failures: [{ method: "GET", path: "/api/plans", status: 500, times: 1 }],
    });
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Backup plans" })).toBeTruthy();
  });
});
