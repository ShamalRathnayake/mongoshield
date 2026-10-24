/**
 * More page tests for the live data browser and Edit history: the less common states
 * (views, time series, empty results, refused writes that are not conflicts, multi-field
 * reviews, bulk previews with no match, failed loads) that keep the pages honest.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp } from "../testing.tsx";

const STAGING_USERS = "#/connections/conn-staging/data?ns=shop.users";

describe("live data browser, other states", () => {
  it("describes a view and a time series collection", async () => {
    renderApp({
      signedInAs: "maya",
      hash: "#/connections/conn-prod/data?ns=analytics.funnel_view",
    });
    expect(await screen.findByText(/^View · about 0 documents/)).toBeTruthy();
    expect(await screen.findByText("Read-only: Views are read-only.")).toBeTruthy();
    expect(await screen.findByText("This collection is empty.")).toBeTruthy();
  });

  it("describes a time series collection", async () => {
    const { user } = renderApp({
      signedInAs: "maya",
      hash: "#/connections/conn-prod/data?ns=shop.events.2026",
    });
    expect(await screen.findByText(/^Time series · about/)).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Stats" }));
    expect(
      screen.getByText("Time series collections are read-only in the data browser."),
    ).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("reports a collection that does not exist", async () => {
    renderApp({ signedInAs: "maya", hash: "#/connections/conn-staging/data?ns=shop.nope" });
    expect(await screen.findByText("Could not read the collection")).toBeTruthy();
  });

  it("shows when no document matches, and changes the page size", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await screen.findByText("Showing 1–20 of about 45 documents");
    await user.selectOptions(screen.getByLabelText("Per page"), "50");
    expect(await screen.findByText("Showing 1–45 of about 45 documents")).toBeTruthy();
    await user.type(screen.getByLabelText("Filter (Extended JSON)"), '{{"plan": "none"}');
    await user.type(screen.getByLabelText("Projection"), "[[1]");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/Must be an object/)).toBeTruthy();
    await user.clear(screen.getByLabelText("Projection"));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("No documents match the filter.")).toBeTruthy();
  });

  it("shows a refused write that is not a conflict as an error", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await screen.findByText("Showing 1–20 of about 45 documents");
    await user.click(screen.getAllByRole("button", { name: /^Edit document/ })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Edit document" });
    const textarea = within(dialog).getByLabelText(
      "Document (Extended JSON)",
    ) as HTMLTextAreaElement;
    const edited = textarea.value
      .replace('"plan": "pro"', '"plan": "enterprise"')
      .replace('"city": "Colombo"', '"city": "Kandy"');
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste(edited);
    await user.click(within(dialog).getByRole("button", { name: "Review changes" }));
    expect(within(dialog).getByText("2 fields will change:")).toBeTruthy();
    // Back to editing keeps the text; then the permission is revoked meanwhile.
    await user.click(within(dialog).getByRole("button", { name: "Back to editing" }));
    expect(
      (within(dialog).getByLabelText("Document (Extended JSON)") as HTMLTextAreaElement).value,
    ).toContain("Kandy");
    const maya = backend.data.users.find((candidate) => candidate.username === "maya");
    if (maya !== undefined) maya.permissions = [];
    await user.click(within(dialog).getByRole("button", { name: "Review changes" }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText("Not saved")).toBeTruthy();
    expect(within(dialog).getByText(/needs the data:write permission/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Reload document" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reports an insert over an existing _id as a conflict", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await screen.findByText("Showing 1–20 of about 45 documents");
    const first = backend.live.documents("conn-staging", "shop.users")[0];
    await user.click(screen.getByRole("button", { name: "Insert document" }));
    const dialog = await screen.findByRole("dialog", { name: "Insert document" });
    const textarea = within(dialog).getByLabelText("Document (Extended JSON)");
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste(JSON.stringify({ _id: first?._id }));
    await user.click(within(dialog).getByRole("button", { name: "Insert document" }));
    expect(await within(dialog).findByText(/already exists/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Reload document" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("previews a bulk edit that matches nothing, and reports refusals", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await screen.findByText("Showing 1–20 of about 45 documents");
    await user.type(screen.getByLabelText("Filter (Extended JSON)"), '{{"plan": "none"}');
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("No documents match the filter.");
    await user.click(screen.getByRole("button", { name: "Delete many…" }));
    const dialog = await screen.findByRole("dialog");
    // The browser's filter is the starting point.
    expect(
      (within(dialog).getByLabelText("Filter (Extended JSON)") as HTMLTextAreaElement).value,
    ).toBe('{"plan":"none"}');
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(await within(dialog).findByText(/nothing to delete/)).toBeTruthy();

    await user.clear(within(dialog).getByLabelText("Filter (Extended JSON)"));
    await user.type(within(dialog).getByLabelText("Filter (Extended JSON)"), "{{bad");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(within(dialog).getByText(/Not valid Extended JSON/)).toBeTruthy();

    const maya = backend.data.users.find((candidate) => candidate.username === "maya");
    if (maya !== undefined) maya.permissions = [];
    await user.clear(within(dialog).getByLabelText("Filter (Extended JSON)"));
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(await within(dialog).findByText("Could not delete")).toBeTruthy();
  });

  it("shows when the connection list cannot be loaded", async () => {
    renderFailingApp({
      signedInAs: "maya",
      hash: STAGING_USERS,
      failures: [{ method: "GET", path: /\/api\/connections$/, status: 500 }],
    });
    expect(await screen.findByText("The mock was told to fail.")).toBeTruthy();
  });

  it("shows failed loads of the tree and the documents with a retry", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: STAGING_USERS,
      failures: [
        { method: "GET", path: "/api/connections/conn-staging/namespaces", status: 502, times: 1 },
        { method: "GET", path: "/api/live/conn-staging/documents", status: 502, times: 1 },
      ],
    });
    expect(await screen.findByText("Could not read documents")).toBeTruthy();
    const retries = await screen.findAllByRole("button", { name: "Try again" });
    for (const retry of retries) await user.click(retry);
    expect(await screen.findByText("Showing 1–20 of about 45 documents")).toBeTruthy();
    expect(await screen.findAllByRole("link", { name: "users" })).not.toHaveLength(0);
  });
});

describe("edit history, other states", () => {
  it("shows bulk entries, details of deletes and a deleted connection", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await screen.findByText("Showing 1–20 of about 45 documents");
    await user.click(screen.getAllByRole("button", { name: /^Delete document/ })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: /^Delete document/ });
    await user.click(within(dialog).getByRole("button", { name: "Delete document" }));
    await screen.findByText(/Deleted/);

    // The connection is deleted afterwards: the history keeps the entry.
    backend.data.connections = backend.data.connections.filter(
      (connection) => connection.id !== "conn-local",
    );
    window.location.hash = "#/edit-history";
    const table = await screen.findByRole("table", { name: "Live edits" });
    expect(within(table).getByText("Delete")).toBeTruthy();
    await user.click(within(table).getByRole("button", { name: /^Details of delete/ }));
    const details = await screen.findByRole("dialog", { name: "Delete in shop.users" });
    expect(await within(details).findByText("Deleted.")).toBeTruthy();
    expect(within(details).getByText(/^before /)).toBeTruthy();
    await user.click(within(details).getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("filters by connection from the browser's link", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await user.click(await screen.findByRole("link", { name: "Edit history of this connection" }));
    expect(await screen.findByText("No live edits yet")).toBeTruthy();
    expect((screen.getByLabelText("Connection") as HTMLSelectElement).value).toBe("conn-staging");
  });

  it("shows failed loads of the history and of an entry's details", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: STAGING_USERS,
      failures: [
        { method: "GET", path: /\/api\/live-edits(\?|$)/, status: 500, times: 1 },
        { method: "GET", path: /\/api\/live-edits\/[^/?]+$/, status: 502 },
      ],
    });
    await screen.findByText("Showing 1–20 of about 45 documents");
    await user.click(screen.getAllByRole("button", { name: /^Delete document/ })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: /^Delete document/ });
    await user.click(within(dialog).getByRole("button", { name: "Delete document" }));
    await screen.findByText(/Deleted/);
    window.location.hash = "#/edit-history";
    expect(await screen.findByText("The mock was told to fail.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    const table = await screen.findByRole("table", { name: "Live edits" });
    await user.click(within(table).getByRole("button", { name: /^Details of delete/ }));
    const details = await screen.findByRole("dialog", { name: "Delete in shop.users" });
    expect(await within(details).findByText("The mock was told to fail.")).toBeTruthy();
  });
});
