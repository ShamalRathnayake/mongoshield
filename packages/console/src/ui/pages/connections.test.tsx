/**
 * Page tests for connections: creating one, the write-only connection string, the
 * connection test report and the namespace tree.
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";

describe("connections", () => {
  it("creates a connection, then tests it and shows topology and missing privileges", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/connections" });
    await user.click(await screen.findByRole("button", { name: "Add connection" }));
    const dialog = screen.getByRole("dialog", { name: "Add connection" });

    // Both fields are required.
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(within(dialog).getByText("Paste the connection string.")).toBeTruthy();

    await user.type(within(dialog).getByLabelText("Name"), "Analytics replica");
    await user.type(
      within(dialog).getByLabelText("Connection string"),
      "mongodb://reader:t0p-secret@analytics:27017",
    );
    await user.click(within(dialog).getByLabelText("This is a production deployment"));
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));

    const report = await screen.findByRole("dialog", {
      name: "Connection test: Analytics replica",
    });
    expect(await within(report).findByText("Connected")).toBeTruthy();
    expect(within(report).getByText("replicaSet")).toBeTruthy();

    const [create] = requestsTo(backend, "POST", "/api/connections");
    expect(create?.body).toEqual({
      name: "Analytics replica",
      production: true,
      uri: "mongodb://reader:t0p-secret@analytics:27017",
    });
    await user.click(within(report).getByRole("button", { name: "Close" }));

    // The list shows the redacted preview, never the password.
    const row = (await screen.findByText("Analytics replica")).closest("tr");
    expect(row?.textContent).toContain("mongodb://reader:***@analytics:27017");
    expect(document.body.innerHTML).not.toContain("t0p-secret");
  });

  it("never re-displays the stored connection string and keeps it when left empty", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/connections" });
    await user.click(await screen.findByRole("button", { name: "Edit Production cluster" }));
    const dialog = screen.getByRole("dialog", { name: 'Edit "Production cluster"' });
    // A normal, visible text box (only a password goes into a masked field), empty: the
    // stored string is never sent back to the browser.
    const uriField = within(dialog).getByLabelText("Connection string") as HTMLTextAreaElement;
    expect(uriField.value).toBe("");
    expect(uriField.tagName).toBe("TEXTAREA");
    expect(
      within(dialog).getByText("mongodb+srv://backup:***@prod-cluster.a1b2c.mongodb.net/"),
    ).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("s3cr3t");

    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Prod");
    await user.click(within(dialog).getByRole("button", { name: "Save and test" }));
    await screen.findByRole("dialog", { name: "Connection test: Prod" });

    const [update] = requestsTo(backend, "PUT", "/api/connections/conn-prod");
    expect(update?.body).toEqual({ name: "Prod", production: true });
    expect(
      backend.data.connections.find((connection) => connection.id === "conn-prod")?.uri,
    ).toContain("s3cr3t");
  });

  it("shows a failed test with the server's hint", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: "#/connections" });
    await user.click(await screen.findByRole("button", { name: "Test Staging" }));
    const report = await screen.findByRole("dialog", { name: "Connection test: Staging" });
    expect(await within(report).findByText("Could not connect")).toBeTruthy();
    expect(within(report).getByText(/Check the host name/)).toBeTruthy();
    // Operators may test but not edit.
    expect(screen.queryByRole("button", { name: "Add connection" })).toBeNull();
  });

  it("lists databases and collections with the plans that back them up", async () => {
    renderApp({ signedInAs: "sam", hash: "#/connections/conn-prod" });
    const usersRow = (await screen.findByText("users")).closest("tr");
    expect(usersRow?.textContent).toContain("48,210");
    expect(usersRow?.textContent).toContain("Nightly production");
    const sessionsRow = screen.getByText("sessions").closest("tr");
    expect(sessionsRow?.textContent).toContain("No plan");
  });
});
