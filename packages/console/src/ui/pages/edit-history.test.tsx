/**
 * Page tests for the Edit history (undo of live edits) and the connection page's Live
 * data panel (the "Allow live edits" settings with the production confirmation).
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MockBackend } from "../mock/backend.ts";
import { renderApp, requestsTo } from "../testing.tsx";

/** Makes one live edit through the mock's API, as the browser would, signed in as maya. */
async function editFirstUser(backend: MockBackend, plan: string): Promise<void> {
  const page = await backend.fetch("/api/live/conn-staging/documents?ns=shop.users&limit=1", {
    method: "GET",
    headers: {},
    credentials: "same-origin",
  });
  const [document] = (
    JSON.parse(await page.text()) as { documents: { json: string; id: string; version: string }[] }
  ).documents;
  if (document === undefined) throw new Error("no document");
  const session = JSON.parse(
    await (
      await backend.fetch("/api/session", {
        method: "GET",
        headers: {},
        credentials: "same-origin",
      })
    ).text(),
  ) as {
    csrfToken: string;
  };
  const edited = { ...(JSON.parse(document.json) as Record<string, unknown>), plan };
  const response = await backend.fetch("/api/live/conn-staging/documents", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
    credentials: "same-origin",
    body: JSON.stringify({
      ns: "shop.users",
      id: document.id,
      version: document.version,
      document: JSON.stringify(edited),
    }),
  });
  if (response.status !== 200) throw new Error(await response.text());
}

describe("edit history", () => {
  it("is empty at first and is in the navigation for operators", async () => {
    renderApp({ signedInAs: "maya", hash: "#/edit-history" });
    expect(await screen.findByText("No live edits yet")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(nav).getByRole("link", { name: "Edit history" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("is not in the navigation for viewers", async () => {
    renderApp({ signedInAs: "sam", hash: "#/" });
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: "Edit history" })).toBeNull();
  });

  it("undoes an edit, and the undo can itself be undone", async () => {
    const { user, backend } = renderApp({
      signedInAs: "maya",
      hash: "#/edit-history",
    });
    await editFirstUser(backend, "enterprise");
    // Reload the page's data: switch the connection filter back and forth.
    await user.selectOptions(await screen.findByLabelText("Connection"), "conn-staging");
    const table = await screen.findByRole("table", { name: "Live edits" });
    expect(await within(table).findByText("Edit")).toBeTruthy();
    expect(within(table).getByText("Applied")).toBeTruthy();

    await user.click(within(table).getByRole("button", { name: /^Undo edit of/ }));
    const dialog = await screen.findByRole("dialog", { name: "Undo this edit?" });
    await user.click(within(dialog).getByRole("button", { name: "Undo edit" }));
    expect(await screen.findByText(/Undone\. The document is back/)).toBeTruthy();
    expect(backend.live.documents("conn-staging", "shop.users")[0]?.plan).toBe("pro");
    expect(await within(table).findByText("(undone)")).toBeTruthy();

    // The undo entry is undoable too (that redoes the edit).
    await user.click(within(table).getByRole("button", { name: /^Undo undo of/ }));
    const redo = await screen.findByRole("dialog", { name: "Undo this edit?" });
    await user.click(within(redo).getByRole("button", { name: "Undo edit" }));
    await waitFor(() =>
      expect(backend.live.documents("conn-staging", "shop.users")[0]?.plan).toBe("enterprise"),
    );
  });

  it("refuses an undo when the document changed since the edit", async () => {
    const { user, backend } = renderApp({
      signedInAs: "maya",
      hash: "#/edit-history?connection=conn-staging",
    });
    await editFirstUser(backend, "enterprise");
    const first = backend.live.documents("conn-staging", "shop.users")[0];
    backend.live.touch("conn-staging", "shop.users", JSON.stringify(first?._id));
    await user.selectOptions(await screen.findByLabelText("Connection"), "");
    const table = await screen.findByRole("table", { name: "Live edits" });
    await user.click(await within(table).findByRole("button", { name: /^Undo edit of/ }));
    const dialog = await screen.findByRole("dialog", { name: "Undo this edit?" });
    await user.click(within(dialog).getByRole("button", { name: "Undo edit" }));
    expect(
      await within(dialog).findByText(/undoing it would overwrite newer changes/),
    ).toBeTruthy();
    expect(backend.live.documents("conn-staging", "shop.users")[0]?.touchedBy).toBe("someone else");
  });

  it("hides undo from users without data:write, but shows the details", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/edit-history" });
    // Edit as maya through the API, then look as the admin (who lacks data:write).
    const maya = backend.data.users.find((candidate) => candidate.username === "maya");
    const admin = backend.data.users.find((candidate) => candidate.username === "admin");
    if (maya === undefined || admin === undefined) throw new Error("fixtures changed");
    admin.permissions = ["data:write"];
    await editFirstUser(backend, "enterprise");
    admin.permissions = [];
    await user.selectOptions(await screen.findByLabelText("Connection"), "conn-staging");
    const table = await screen.findByRole("table", { name: "Live edits" });
    await within(table).findByText("Edit");
    expect(within(table).queryByRole("button", { name: /^Undo/ })).toBeNull();

    await user.click(within(table).getByRole("button", { name: /^Details of edit/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit in shop.users" });
    expect(await within(dialog).findByRole("heading", { name: "Before" })).toBeTruthy();
    expect(within(dialog).getAllByText('"pro"').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('"enterprise"').length).toBeGreaterThan(0);
  });

  it("starts a job to undo a bulk edit", async () => {
    const { user, backend } = renderApp({
      signedInAs: "maya",
      hash: "#/connections/conn-staging/data?ns=shop.users",
    });
    await user.click(await screen.findByRole("button", { name: "Delete many…" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Filter (Extended JSON)"), '{{"plan": "pro"}');
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    await user.type(
      await within(dialog).findByLabelText('Type "delete 9 documents in shop.users" to confirm'),
      "delete 9 documents in shop.users",
    );
    await user.click(within(dialog).getByRole("button", { name: "Delete documents" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/jobs\//));
    for (let step = 0; step < 12; step += 1) backend.tickJobs();
    await waitFor(() => expect(backend.live.entries()).toHaveLength(1));

    window.location.hash = "#/edit-history";
    const table = await screen.findByRole("table", { name: "Live edits" });
    expect(within(table).getByText("9 documents")).toBeTruthy();
    await user.click(
      within(table).getByRole("button", { name: /^Undo delete many of 9 documents/ }),
    );
    const confirm = await screen.findByRole("dialog", { name: "Undo this edit?" });
    await user.click(within(confirm).getByRole("button", { name: "Undo edit" }));
    expect(await screen.findByRole("link", { name: "Follow the undo job" })).toBeTruthy();
    for (let step = 0; step < 12; step += 1) backend.tickJobs();
    await waitFor(() =>
      expect(backend.live.documents("conn-staging", "shop.users")).toHaveLength(45),
    );
    expect(requestsTo(backend, "POST", "/api/live-edits/")).toHaveLength(1);
  });
});

describe("live data settings on the connection page", () => {
  it("shows the settings to everyone and the form to admins only", async () => {
    renderApp({ signedInAs: "maya", hash: "#/connections/conn-staging" });
    expect(await screen.findByRole("heading", { name: "Live data" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse live data" }).getAttribute("href")).toBe(
      "#/connections/conn-staging/data",
    );
    expect(screen.getByText("Allowed")).toBeTruthy();
    expect(screen.getByText("Fixing test data before the release")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Allow live edits" })).toBeNull();
  });

  it("hides the browse link from viewers", async () => {
    renderApp({ signedInAs: "sam", hash: "#/connections/conn-staging" });
    expect(await screen.findByRole("heading", { name: "Live data" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Browse live data" })).toBeNull();
  });

  it("turns live edits on for a non-production connection", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/connections/conn-local" });
    expect(await screen.findByText("Off (read-only)")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Allow live edits" }));
    await user.selectOptions(screen.getByLabelText("Edit journal"), "st-s3");
    await user.clear(screen.getByLabelText("Most documents per bulk edit"));
    await user.type(screen.getByLabelText("Most documents per bulk edit"), "0");
    await user.click(screen.getByRole("button", { name: "Save live edit settings" }));
    expect(screen.getByText(/Enter a whole number from 1 to/)).toBeTruthy();
    await user.clear(screen.getByLabelText("Most documents per bulk edit"));
    await user.type(screen.getByLabelText("Most documents per bulk edit"), "250");
    await user.click(screen.getByRole("button", { name: "Save live edit settings" }));
    expect(await screen.findByText("Live edits are allowed.")).toBeTruthy();
    expect(requestsTo(backend, "PUT", "/api/connections/conn-local/live-edits")[0]?.body).toEqual({
      enabled: true,
      maxBulkDocuments: 250,
      journalStorageId: "st-s3",
    });
    expect(await screen.findByText("Allowed")).toBeTruthy();
  });

  it("needs the typed name and a reason for a production connection", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/connections/conn-prod" });
    await user.click(await screen.findByRole("checkbox", { name: "Allow live edits" }));
    expect(screen.getByText("This is a production connection")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save live edit settings" }));
    expect(screen.getByText(/Give a reason/)).toBeTruthy();
    expect(screen.getByText('Type "Production cluster" exactly.')).toBeTruthy();
    expect(requestsTo(backend, "PUT", "/api/connections/conn-prod/live-edits")).toHaveLength(0);

    await user.type(screen.getByLabelText("Reason"), "Incident 4711: fix corrupted carts");
    await user.type(
      screen.getByLabelText("Type the connection's name to confirm"),
      "Production cluster",
    );
    await user.click(screen.getByRole("button", { name: "Save live edit settings" }));
    expect(await screen.findByText("Allowed (confirmed for production)")).toBeTruthy();
    expect(
      backend.data.connections.find((connection) => connection.id === "conn-prod")?.liveEdits,
    ).toMatchObject({
      enabled: true,
      productionConfirmed: true,
      reason: "Incident 4711: fix corrupted carts",
    });
  });

  it("shows a refusal from the server", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/connections/conn-local" });
    await user.click(await screen.findByRole("checkbox", { name: "Allow live edits" }));
    await user.selectOptions(screen.getByLabelText("Edit journal"), "st-s3");
    // The storage location disappears after the page loaded its list (deterministic,
    // unlike a timer, which can fire before the list is shown on a busy machine).
    backend.data.storage = backend.data.storage.filter((location) => location.id !== "st-s3");
    await user.click(screen.getByRole("button", { name: "Save live edit settings" }));
    expect(await screen.findByText("Could not save")).toBeTruthy();
  });
});
