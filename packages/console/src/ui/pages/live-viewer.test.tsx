/**
 * Page tests for browsing records through the whole app (router, client, mock backend):
 * views remembered per collection, quick filters from a cell, header sorting, filter
 * chips and query history, field suggestions, the schema sample (and its smaller, paced
 * version on Atlas shared tiers, whose refused size statistics show as "—"), canonical
 * JSON, export, cancelling a slow query, the last opened collection, the detail panel's
 * edit action, and the same viewer inside a backup.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";

const STAGING = "#/connections/conn-staging/data";
const STAGING_USERS = `${STAGING}?ns=shop.users`;

/** Waits for the table of documents. */
async function table() {
  const found = await screen.findByRole("table", { name: "Documents" });
  await within(found).findAllByRole("button", { name: /^Open document/ });
  return found;
}

/** The URL of the last request to a path, decoded. */
function lastUrl(backend: Parameters<typeof requestsTo>[0], path: string): string {
  return decodeURIComponent(requestsTo(backend, "GET", path).at(-1)?.url ?? "");
}

describe("browsing records", () => {
  it("remembers the chosen view per collection", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await table();
    await user.click(screen.getByRole("radio", { name: "Cards" }));
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    // Another collection opens with the view used last; then the first one keeps its own.
    window.location.hash = `${STAGING}?ns=shop.orders`;
    expect(await screen.findByRole("heading", { name: "shop.orders" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Cards" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("radio", { name: "Table" }));
    window.location.hash = STAGING_USERS;
    await screen.findByRole("heading", { name: "shop.users" });
    expect(
      ((await screen.findByRole("radio", { name: "Cards" })) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("filters from a clicked cell, shows the condition as a chip and removes it", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    const documents = await table();
    await user.click(within(documents).getAllByText("pro")[0] as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: 'Show documents where plan is "pro"' }));
    expect(await screen.findByText("Showing 1–9 of 9 documents · filtered")).toBeTruthy();
    expect(lastUrl(backend, "/api/live/conn-staging/documents")).toContain('filter={"plan":"pro"}');
    expect((screen.getByLabelText("Filter (Extended JSON)") as HTMLInputElement).value).toBe(
      '{"plan":"pro"}',
    );
    await user.click(screen.getByRole("button", { name: "Remove the condition on plan" }));
    expect(await screen.findByText("Showing 1–20 of about 45 documents")).toBeTruthy();
  });

  it("refuses a quick filter while the filter box holds invalid text", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    const documents = await table();
    await user.type(screen.getByLabelText("Filter (Extended JSON)"), "{{oops");
    await user.click(within(documents).getAllByText("pro")[0] as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: 'Show documents where plan is "pro"' }));
    expect((await screen.findAllByText(/Fix or clear it first/)).length).toBeGreaterThan(0);
  });

  it("sorts on the server from a column header", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await table();
    await user.click(screen.getByRole("button", { name: "Sort by logins" }));
    await waitFor(() =>
      expect(lastUrl(backend, "/api/live/conn-staging/documents")).toContain('sort={"logins":1}'),
    );
    await user.click(screen.getByRole("button", { name: /^Sort by logins, sorted ascending/ }));
    await waitFor(() =>
      expect(lastUrl(backend, "/api/live/conn-staging/documents")).toContain('sort={"logins":-1}'),
    );
    expect((screen.getByLabelText("Sort") as HTMLInputElement).value).toBe('{"logins":-1}');
    const first = screen.getAllByRole("row").find((row) => row.getAttribute("data-index") === "0");
    expect(first?.textContent).toContain("499");
  });

  it("keeps a history of applied queries per collection", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await table();
    const history = screen.getByRole("button", { name: "History" }) as HTMLButtonElement;
    expect(history.disabled).toBe(true);
    await user.type(screen.getByLabelText("Filter (Extended JSON)"), '{{"plan": "free"}');
    await user.keyboard("{Enter}");
    await screen.findByText(/· filtered/);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await screen.findByText("Showing 1–20 of about 45 documents");
    await user.click(history);
    await user.click(screen.getByRole("menuitem", { name: /"plan":"free"/ }));
    expect(await screen.findByText(/· filtered/)).toBeTruthy();
  });

  it("suggests field names from the page and a sample once the filter box has focus", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await table();
    const filter = screen.getByLabelText("Filter (Extended JSON)");
    await user.click(filter);
    await user.type(filter, '{{"addr');
    const list = screen.getByRole("listbox", { name: "Matching field names" });
    expect(within(list).getByRole("option", { name: "address.city" })).toBeTruthy();
    // The sample for suggestions comes after a short pause, once.
    await waitFor(
      () => expect(requestsTo(backend, "GET", "/api/live/conn-staging/sample")).toHaveLength(1),
      {
        timeout: 3000,
      },
    );
    await user.click(screen.getByRole("radio", { name: "Schema" }));
    expect(await screen.findByRole("table", { name: "Fields of the sample" })).toBeTruthy();
    // The schema view reuses that sample: same collection, same filter.
    expect(requestsTo(backend, "GET", "/api/live/conn-staging/sample")).toHaveLength(1);
    expect(lastUrl(backend, "/api/live/conn-staging/sample")).toContain("size=200");
  });

  it("shows the schema of a sample and filters from it", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await table();
    await user.click(screen.getByRole("radio", { name: "Schema" }));
    const fields = await screen.findByRole("table", { name: "Fields of the sample" });
    expect(screen.getByText(/in a random sample of 45 documents/)).toBeTruthy();
    expect(within(fields).getByRole("row", { name: /address\.city/ })).toBeTruthy();
    await user.click(within(fields).getByRole("button", { name: /^Colombo/ }));
    await waitFor(() =>
      expect(lastUrl(backend, "/api/live/conn-staging/documents")).toContain(
        'filter={"address.city":"Colombo"}',
      ),
    );
    // The sample follows the filter.
    await waitFor(() =>
      expect(lastUrl(backend, "/api/live/conn-staging/sample")).toContain("address.city"),
    );
    await user.click(screen.getByRole("radio", { name: "Chart" }));
    expect(await screen.findByRole("heading", { name: /Documents by/ })).toBeTruthy();
  });

  it("samples less, paces background queries and shows refused sizes as — on Atlas shared tiers", async () => {
    const { user, backend } = renderApp({
      signedInAs: "maya",
      hash: STAGING_USERS,
      prepare: (mock) => {
        const staging = mock.data.connections.find(
          (connection) => connection.id === "conn-staging",
        );
        if (staging !== undefined) staging.atlasSharedTier = true;
      },
    });
    await table();
    expect(screen.getByText("Atlas shared tier")).toBeTruthy();
    // No size in the header (the collection is still browsable).
    expect(screen.getByText(/^Collection · about 45 documents · 2 indexes$/)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Schema" }));
    await screen.findByRole("table", { name: "Fields of the sample" });
    expect(lastUrl(backend, "/api/live/conn-staging/sample")).toContain("size=100");
    await user.click(screen.getByRole("tab", { name: "Stats" }));
    expect(
      screen.getByText(
        "Sizes are not available: Atlas Free and Flex clusters do not report collection sizes.",
      ),
    ).toBeTruthy();
    expect(
      screen.getAllByTitle("Atlas Free and Flex clusters do not report collection sizes."),
    ).toHaveLength(4);
    await user.click(screen.getByRole("tab", { name: "Indexes" }));
    expect(screen.getAllByTitle(/do not report collection sizes/).length).toBeGreaterThan(0);
  });

  it("shows canonical Extended JSON from the server in the JSON view", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await table();
    await user.click(screen.getByRole("radio", { name: "JSON" }));
    await user.click(await screen.findByRole("checkbox", { name: "Canonical" }));
    await waitFor(() =>
      expect(lastUrl(backend, "/api/live/conn-staging/documents")).toContain("ejson=canonical"),
    );
    expect((await screen.findAllByText('"$numberInt"')).length).toBeGreaterThan(0);
  });

  it("exports the current result as a file", async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await table();
    await user.type(screen.getByLabelText("Filter (Extended JSON)"), '{{"plan": "pro"}');
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/· filtered/);
    await user.click(screen.getByRole("button", { name: "Export" }));
    const dialog = screen.getByRole("dialog", { name: "Export the result" });
    await user.selectOptions(within(dialog).getByLabelText("Format"), "csv");
    await user.click(within(dialog).getByRole("button", { name: "Download" }));
    expect(await screen.findByText("Downloaded shop.users.csv: 9 documents.")).toBeTruthy();
    const url = lastUrl(backend, "/api/live/conn-staging/export");
    expect(url).toContain("format=csv");
    expect(url).toContain('filter={"plan":"pro"}');
  });

  it("can cancel a slow query", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: STAGING_USERS, latencyMs: 300 });
    // Every request takes a while here, so the first page needs more than the default wait.
    await screen.findByRole("table", { name: "Documents" }, { timeout: 8000 });
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await user.click(await screen.findByRole("button", { name: "Cancel query" }));
    expect(await screen.findByText(/You cancelled the request/)).toBeTruthy();
  });

  it("goes back to the last collection opened in a connection", async () => {
    renderApp({ signedInAs: "maya", hash: `${STAGING}?ns=shop.orders` });
    await screen.findByRole("heading", { name: "shop.orders" });
    window.location.hash = STAGING;
    await waitFor(() => expect(window.location.hash).toBe(`${STAGING}?ns=shop.orders`));
    expect(await screen.findByRole("heading", { name: "shop.orders" })).toBeTruthy();
  });

  it("lists other connections in the tree and loads their databases when opened", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await table();
    const nav = screen.getByRole("navigation", { name: "Collections" });
    expect(requestsTo(backend, "GET", "/api/connections/conn-local/namespaces")).toHaveLength(0);
    await user.click(within(nav).getByRole("treeitem", { name: /^Local dev/ }));
    expect(await within(nav).findByRole("treeitem", { name: /^test/ })).toBeTruthy();
    await user.click(within(nav).getByRole("treeitem", { name: /^test/ }));
    expect(
      within(nav)
        .getByRole("treeitem", { name: /^fixtures/ })
        .getAttribute("href"),
    ).toBe("#/connections/conn-local/data?ns=test.fixtures");
    // The capped collection is marked as such.
    expect(within(nav).getByRole("treeitem", { name: /^audit_log/ }).textContent).toContain(
      "capped",
    );
  });

  it("edits a document from the detail panel", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await table();
    await user.click(screen.getAllByRole("button", { name: /^Open document/ })[0] as HTMLElement);
    const detail = await screen.findByRole("dialog", { name: /^ObjectId/ });
    await user.click(within(detail).getByRole("button", { name: /^Next/ }));
    expect(within(detail).getByText(/\(2 of 20\)/)).toBeTruthy();
    await user.click(within(detail).getByRole("button", { name: /^Edit document/ }));
    expect(await screen.findByRole("dialog", { name: "Edit document" })).toBeTruthy();
  });
});

describe("browsing records in a backup", () => {
  it("offers the same views, a schema of the first documents and an export", async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
    const { user, backend } = renderApp({ signedInAs: "maya" });
    const backup = backend.data.backups.find(
      (candidate) => candidate.storageId === "st-s3" && candidate.status === "complete",
    );
    window.location.hash = `#/backups/st-s3/${backup?.id ?? ""}?tab=browse`;
    await table();
    // Backups are read in storage order: no sort or projection.
    expect(screen.queryByLabelText("Sort")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Sort by/ })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Schema" }));
    expect(
      await screen.findByText(
        /in the first 45 documents in the backup|in the first \d+ documents in the backup/,
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "JSON" }));
    await user.click(screen.getByRole("checkbox", { name: "Canonical" }));
    await waitFor(() =>
      expect(lastUrl(backend, "/api/storage/st-s3/backups/")).toContain("ejson=canonical"),
    );
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByText(/^Downloaded shop\.users\.json: /)).toBeTruthy();
  });
});
