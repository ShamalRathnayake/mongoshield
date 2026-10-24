/**
 * Page tests for the live data browser against the mock backend: browsing collections,
 * the query form (validation, projection, paging), read-only states, and the write
 * dialogs (edit with review, conflict and reload, insert, duplicate, delete, bulk edits
 * with a typed confirmation).
 *
 * Mock fixtures: "Staging" (conn-staging) allows live edits; maya (operator) holds
 * data:write; admin does not.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";

const STAGING_USERS = "#/connections/conn-staging/data?ns=shop.users";

/** The "run a bulk edit" requests (not the previews, which share the path prefix). */
function bulkRuns(backend: Parameters<typeof requestsTo>[0]) {
  return requestsTo(backend, "POST", "/api/live/conn-staging/bulk").filter(
    (request) => !request.url.includes("/bulk/preview"),
  );
}

/** Waits for the first page of documents and returns the list. */
async function documentList() {
  return screen.findByRole("list", { name: "Documents" }).then(async (list) => {
    await within(list).findAllByRole("listitem");
    return list;
  });
}

describe("live data browser", () => {
  it("lists databases and collections, and asks to choose one", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: "#/connections/conn-staging/data" });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Staging: live data" }),
    ).toBeTruthy();
    const nav = await screen.findByRole("navigation", { name: "Collections" });
    expect(await screen.findByText("Choose a collection")).toBeTruthy();
    await user.click(await within(nav).findByRole("link", { name: "orders" }));
    expect(await screen.findByRole("heading", { name: "shop.orders" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "orders" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("shows documents with a count, and pages through them", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    const list = await documentList();
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByText("Showing 1–20 of about 45 documents")).toBeTruthy();
    const previous = screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 21–40 of about 45 documents")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 41–45 of about 45 documents")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("Showing 21–40 of about 45 documents")).toBeTruthy();
    expect(requestsTo(backend, "GET", "/api/live/conn-staging/documents").at(-1)?.url).toContain(
      "skip=20",
    );
  });

  it("validates the query in the browser before any request", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await documentList();
    const before = requestsTo(backend, "GET", "/api/live/conn-staging/documents").length;
    await user.type(screen.getByLabelText("Filter (Extended JSON)"), "{{status: 1}");
    await user.type(screen.getByLabelText("Sort"), '{{"name": 2}');
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/Not valid Extended JSON/)).toBeTruthy();
    expect(screen.getByText('Sort directions must be 1 or -1 (field "name").')).toBeTruthy();
    expect(requestsTo(backend, "GET", "/api/live/conn-staging/documents")).toHaveLength(before);

    await user.clear(screen.getByLabelText("Filter (Extended JSON)"));
    await user.type(screen.getByLabelText("Filter (Extended JSON)"), '{{"plan": "pro"}');
    await user.clear(screen.getByLabelText("Sort"));
    await user.type(screen.getByLabelText("Sort"), '{{"logins": -1}');
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Showing 1–9 of 9 documents · filtered")).toBeTruthy();
    const url = requestsTo(backend, "GET", "/api/live/conn-staging/documents").at(-1)?.url ?? "";
    expect(decodeURIComponent(url)).toContain('filter={"plan":"pro"}');
    expect(decodeURIComponent(url)).toContain('sort={"logins":-1}');
  });

  it("shows projected documents read-only", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await documentList();
    expect(screen.getAllByRole("button", { name: /^Edit document/ }).length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText("Projection"), '{{"email": 1}');
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/A projection is applied/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: /^Edit document/ })).toHaveLength(0),
    );
  });

  it("says why a collection is read-only for users without data:write", async () => {
    renderApp({ signedInAs: "admin", hash: STAGING_USERS });
    await documentList();
    expect(
      screen.getByText(/Read-only: Changing live data needs the data:write permission/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Insert document" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Edit document/ })).toHaveLength(0);
  });

  it("says why a connection without live edits is read-only", async () => {
    renderApp({ signedInAs: "maya", hash: "#/connections/conn-prod/data?ns=shop.users" });
    await documentList();
    expect(screen.getByText(/Read-only: Live edits are turned off/)).toBeTruthy();
    expect(screen.getByText("These are live production documents.")).toBeTruthy();
  });

  it("shows indexes and statistics", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await documentList();
    await user.click(screen.getByRole("tab", { name: "Indexes" }));
    const table = await screen.findByRole("table", { name: "Indexes of shop.users" });
    expect(within(table).getByText("email_1")).toBeTruthy();
    expect(within(table).getByText("unique")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Stats" }));
    expect(screen.getByText("Allowed for you")).toBeTruthy();
  });

  it("is only for operators", async () => {
    renderApp({ signedInAs: "sam", hash: STAGING_USERS });
    expect(await screen.findByText(/This page needs the operator role/)).toBeTruthy();
  });

  it("tells when the connection does not exist", async () => {
    renderApp({ signedInAs: "maya", hash: "#/connections/nope/data" });
    expect(await screen.findByRole("heading", { name: "Connection not found" })).toBeTruthy();
  });
});

describe("editing live documents", () => {
  it("edits a document after reviewing the changed fields", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await documentList();
    await user.click(screen.getAllByRole("button", { name: /^Edit document/ })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Edit document" });
    const textarea = within(dialog).getByLabelText(
      "Document (Extended JSON)",
    ) as HTMLTextAreaElement;

    // Nothing changed yet: the review says so.
    await user.click(within(dialog).getByRole("button", { name: "Review changes" }));
    expect(within(dialog).getByText(/Nothing changed yet/)).toBeTruthy();

    const edited = textarea.value.replace('"plan": "pro"', '"plan": "enterprise"');
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste(edited);
    await user.click(within(dialog).getByRole("button", { name: "Review changes" }));
    expect(within(dialog).getByText("1 field will change:")).toBeTruthy();
    const row = within(dialog).getByRole("row", { name: /plan/ });
    expect(within(row).getByText('"pro"')).toBeTruthy();
    expect(within(row).getByText('"enterprise"')).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Saved 1 changed field/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.data && backend.live.documents("conn-staging", "shop.users")[0]?.plan).toBe(
      "enterprise",
    );
    const sent = requestsTo(backend, "PUT", "/api/live/conn-staging/documents")[0]?.body as {
      version: string;
      id: string;
    };
    expect(sent.version).toMatch(/^[0-9a-f]{64}$/);
    expect(backend.live.entries()[0]).toMatchObject({
      op: "update",
      by: "maya",
      status: "applied",
    });
  });

  it("refuses to change _id", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await documentList();
    await user.click(screen.getAllByRole("button", { name: /^Edit document/ })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Edit document" });
    const textarea = within(dialog).getByLabelText(
      "Document (Extended JSON)",
    ) as HTMLTextAreaElement;
    const edited = textarea.value.replace(/"\$oid": "65/, '"$oid": "66');
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste(edited);
    await user.click(within(dialog).getByRole("button", { name: "Review changes" }));
    expect(within(dialog).getByText(/An edit cannot change or remove _id/)).toBeTruthy();
  });

  it("refuses an edit when the document changed meanwhile, and reloads it", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await documentList();
    await user.click(screen.getAllByRole("button", { name: /^Edit document/ })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Edit document" });
    const textarea = within(dialog).getByLabelText(
      "Document (Extended JSON)",
    ) as HTMLTextAreaElement;
    const first = backend.live.documents("conn-staging", "shop.users")[0];
    // Someone else changes the document while the editor is open.
    backend.live.touch("conn-staging", "shop.users", JSON.stringify(first?._id));

    const edited = textarea.value.replace('"plan": "pro"', '"plan": "free"');
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste(edited);
    await user.click(within(dialog).getByRole("button", { name: "Review changes" }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(
      await within(dialog).findByText(/The document changed after you loaded it/),
    ).toBeTruthy();
    expect(backend.live.documents("conn-staging", "shop.users")[0]?.plan).toBe("pro");

    await user.click(within(dialog).getByRole("button", { name: "Reload document" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findAllByText(/"someone else"/)).not.toHaveLength(0);
  });

  it("inserts a document", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await documentList();
    await user.click(screen.getByRole("button", { name: "Insert document" }));
    const dialog = await screen.findByRole("dialog", { name: "Insert document" });
    const textarea = within(dialog).getByLabelText("Document (Extended JSON)");
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste("[1]");
    await user.click(within(dialog).getByRole("button", { name: "Insert document" }));
    expect(within(dialog).getByText("The document must be a JSON object.")).toBeTruthy();
    await user.clear(textarea);
    await user.paste('{"email": "new@example.com"}');
    await user.click(within(dialog).getByRole("button", { name: "Insert document" }));
    expect(await screen.findByText(/Inserted .* Undo it from Edit history/)).toBeTruthy();
    expect(backend.live.documents("conn-staging", "shop.users")).toHaveLength(46);
  });

  it("duplicates a document without its _id", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await documentList();
    await user.click(
      screen.getAllByRole("button", { name: /^Duplicate document/ })[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "Duplicate document" });
    const text = (within(dialog).getByLabelText("Document (Extended JSON)") as HTMLTextAreaElement)
      .value;
    expect(text).not.toContain("_id");
    await user.click(within(dialog).getByRole("button", { name: "Insert document" }));
    expect(await screen.findByText(/Inserted/)).toBeTruthy();
    const body = requestsTo(backend, "POST", "/api/live/conn-staging/documents")[0]?.body as {
      document: string;
    };
    expect(body.document).not.toContain("_id");
  });

  it("deletes a document after confirmation, and reports a conflict", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await documentList();
    const second = backend.live.documents("conn-staging", "shop.users")[1];
    await user.click(screen.getAllByRole("button", { name: /^Delete document/ })[1] as HTMLElement);
    let dialog = await screen.findByRole("dialog", { name: /^Delete document/ });
    backend.live.touch("conn-staging", "shop.users", JSON.stringify(second?._id));
    await user.click(within(dialog).getByRole("button", { name: "Delete document" }));
    expect(await within(dialog).findByText(/changed after you loaded it/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Reload document" }));

    await screen.findByText("Showing 1–20 of about 45 documents");
    await user.click(screen.getAllByRole("button", { name: /^Delete document/ })[0] as HTMLElement);
    dialog = await screen.findByRole("dialog", { name: /^Delete document/ });
    await user.click(within(dialog).getByRole("button", { name: "Delete document" }));
    expect(await screen.findByText(/Deleted .* Undo it from Edit history/)).toBeTruthy();
    expect(backend.live.documents("conn-staging", "shop.users")).toHaveLength(44);
  });

  it("runs delete many after a preview and the exact typed confirmation", async () => {
    const { user, backend } = renderApp({ signedInAs: "maya", hash: STAGING_USERS });
    await documentList();
    await user.click(screen.getByRole("button", { name: "Delete many…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete many documents in shop.users",
    });
    const run = within(dialog).getByRole("button", {
      name: "Delete documents",
    }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText("Filter (Extended JSON)"), '{{"plan": "pro"}');
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = await within(dialog).findByLabelText(
      'Type "delete 9 documents in shop.users" to confirm',
    );
    expect(within(dialog).getByText("9")).toBeTruthy();
    await user.type(confirm, "delete 9 documents");
    expect(run.disabled).toBe(true);
    await user.type(confirm, " in shop.users");
    expect(run.disabled).toBe(false);
    await user.click(run);
    // The edit runs as a job; the browser follows it on the job page.
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/jobs\//));
    for (let step = 0; step < 12; step += 1) backend.tickJobs();
    await waitFor(() =>
      expect(backend.live.documents("conn-staging", "shop.users")).toHaveLength(36),
    );
    expect(bulkRuns(backend)[0]?.body).toMatchObject({
      op: "delete",
      expectedCount: 9,
      confirm: "delete 9 documents in shop.users",
    });
  });

  it("checks update operators, refuses over the cap and resets the preview on change", async () => {
    const { user, backend } = renderApp({
      signedInAs: "maya",
      hash: STAGING_USERS,
      prepare: (mock) => {
        const staging = mock.data.connections.find(
          (connection) => connection.id === "conn-staging",
        );
        if (staging?.liveEdits !== undefined)
          staging.liveEdits = { ...staging.liveEdits, maxBulkDocuments: 5 };
      },
    });
    await documentList();
    await user.click(screen.getByRole("button", { name: "Update many…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Update many documents in shop.users",
    });
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(within(dialog).getByText(/Give at least one update operator/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Update (operators)"), '{{"plan": "x"}');
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(within(dialog).getByText(/"plan" is not an update operator/)).toBeTruthy();
    await user.clear(within(dialog).getByLabelText("Update (operators)"));
    await user.type(
      within(dialog).getByLabelText("Update (operators)"),
      '{{"$set": {{"plan": "x"}}',
    );
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(await within(dialog).findByText("Too many documents")).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Filter (Extended JSON)"), '{{"plan": "pro"}');
    expect(within(dialog).queryByText("Too many documents")).toBeNull();
    expect(bulkRuns(backend)).toHaveLength(0);
  });
});
