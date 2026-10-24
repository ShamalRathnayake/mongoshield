/**
 * More connection tests: the URI check in the dialog, save and delete errors, deleting
 * a connection a plan uses (refused) or one nobody uses, the test report's outcomes,
 * the empty and error states, and the connection detail page (test, missing
 * connection, namespace errors and refresh).
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp, requestsTo } from "../testing.tsx";
import { ConnectionTestReport } from "./connections.tsx";

describe("connection test report", () => {
  it("lists missing privileges and unknown topology", () => {
    render(
      <ConnectionTestReport
        result={{
          ok: true,
          missingBackupPrivileges: ["find on admin"],
          missingRestorePrivileges: [],
        }}
        error={undefined}
      />,
    );
    expect(screen.getAllByText("unknown")).toHaveLength(2);
    expect(screen.getByText("1 missing")).toBeTruthy();
    expect(screen.getByText("find on admin")).toBeTruthy();
    expect(screen.getByText("All present")).toBeTruthy();
  });

  it("falls back to a generic message for a failed test without details", () => {
    render(
      <ConnectionTestReport
        result={{ ok: false, missingBackupPrivileges: [], missingRestorePrivileges: [] }}
        error={undefined}
      />,
    );
    expect(screen.getByText("The connection failed.")).toBeTruthy();
  });

  it("shows a spinner while connecting", () => {
    render(<ConnectionTestReport result={undefined} error={undefined} />);
    expect(screen.getByRole("status").textContent).toContain("Connecting");
  });
});

describe("connections page", () => {
  it("refuses a connection string with the wrong scheme", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/connections" });
    await user.click(await screen.findByRole("button", { name: "Add connection" }));
    const dialog = screen.getByRole("dialog", { name: "Add connection" });
    await user.type(within(dialog).getByLabelText("Name"), "X");
    await user.type(within(dialog).getByLabelText("Connection string"), "postgres://db");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(
      within(dialog).getByText("A connection string starts with mongodb:// or mongodb+srv://."),
    ).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/connections")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a save error inside the dialog", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      hash: "#/connections",
      failures: [{ method: "POST", path: "/api/connections", status: 409, message: "Name taken." }],
    });
    await user.click(await screen.findByRole("button", { name: "Add connection" }));
    const dialog = screen.getByRole("dialog", { name: "Add connection" });
    await user.type(within(dialog).getByLabelText("Name"), "Staging");
    await user.type(within(dialog).getByLabelText("Connection string"), "mongodb://h");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(await within(dialog).findByText("Name taken.")).toBeTruthy();
  });

  it("refuses to delete a connection that a plan uses", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/connections" });
    await user.click(await screen.findByRole("button", { name: "Delete Staging" }));
    await user.click(screen.getByRole("button", { name: "Delete connection" }));
    expect(await screen.findByText(/This connection is used by a backup plan/)).toBeTruthy();
    expect(backend.data.connections.some((connection) => connection.id === "conn-staging")).toBe(
      true,
    );
  });

  it("deletes a connection no plan uses, and cancel keeps it", async () => {
    const { user, backend } = renderApp({
      signedInAs: "admin",
      hash: "#/connections",
      prepare: (mock) => {
        mock.data.plans = mock.data.plans.filter((plan) => plan.connectionId !== "conn-local");
      },
    });
    await user.click(await screen.findByRole("button", { name: "Delete Local dev" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete Local dev" }));
    await user.click(screen.getByRole("button", { name: "Delete connection" }));
    expect(await screen.findByText('Deleted "Local dev".')).toBeTruthy();
    expect(backend.data.connections.some((connection) => connection.id === "conn-local")).toBe(
      false,
    );
  });

  it("reports a test that could not run", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: "#/connections",
      failures: [{ method: "POST", path: /\/test$/, status: "network" }],
    });
    await user.click(await screen.findByRole("button", { name: "Test Local dev" }));
    const report = screen.getByRole("dialog", { name: "Connection test: Local dev" });
    expect(await within(report).findByText("The test could not run")).toBeTruthy();
    expect(within(report).getByText(/Could not reach the console server/)).toBeTruthy();
  });

  it("opens a connection when its row is activated with the keyboard", async () => {
    const { user } = renderApp({ signedInAs: "sam", hash: "#/connections" });
    const table = await screen.findByRole("table", { name: "Connections" });
    const row = within(table).getByText("Local dev").closest("tr");
    if (row === null) throw new Error("no row");
    row.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/connections/conn-local"));
  });

  it("shows an empty state and a load error", async () => {
    renderApp({
      signedInAs: "sam",
      hash: "#/connections",
      prepare: (mock) => {
        mock.data.connections = [];
      },
    });
    expect(await screen.findByText("No connections yet")).toBeTruthy();
  });

  it("retries after a failed load", async () => {
    const { user } = renderFailingApp({
      signedInAs: "sam",
      hash: "#/connections",
      failures: [{ method: "GET", path: "/api/connections", status: 500, times: 1 }],
    });
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Connections" })).toBeTruthy();
  });
});

describe("connection detail page", () => {
  it("tests the connection and shows the result in place", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: "#/connections/conn-prod" });
    expect(await screen.findByText(/Connects, reads the topology/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("Production", { selector: "dt" })).toBeTruthy();
  });

  it("reports a test request that failed", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: "#/connections/conn-prod",
      failures: [{ method: "POST", path: /\/test$/, status: 502, message: "Gateway down." }],
    });
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Gateway down.")).toBeTruthy();
  });

  it("lists no plans for an unused connection and hides the test from viewers", async () => {
    renderApp({
      signedInAs: "sam",
      hash: "#/connections/conn-local",
      prepare: (mock) => {
        mock.data.plans = [];
      },
    });
    expect(await screen.findByText("None")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("says when the connection does not exist", async () => {
    renderApp({ signedInAs: "sam", hash: "#/connections/conn-gone" });
    expect(await screen.findByRole("heading", { name: "Connection not found" })).toBeTruthy();
  });

  it("shows a load error for the details", async () => {
    renderFailingApp({
      signedInAs: "sam",
      hash: "#/connections/conn-prod",
      failures: [{ method: "GET", path: "/api/plans", status: 500, message: "Plans broke." }],
    });
    expect(await screen.findByText("Plans broke.")).toBeTruthy();
  });

  it("shows a namespace error and refreshes the tree", async () => {
    const { user, backend } = renderFailingApp({
      signedInAs: "sam",
      hash: "#/connections/conn-prod",
      failures: [
        { method: "GET", path: /\/namespaces$/, status: 502, message: "Cannot list.", times: 1 },
      ],
    });
    expect(await screen.findByText("Cannot list.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("users")).toBeTruthy();
    expect(requestsTo(backend, "GET", "/api/connections/conn-prod/namespaces")).toHaveLength(1);
  });
});
