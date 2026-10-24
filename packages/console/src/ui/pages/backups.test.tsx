/**
 * Page tests for the backup catalog, the backup detail page and the document browser
 * (paging and filter validation).
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";

/** The newest complete backup in the S3 fixture storage. */
function newestCompleteId(backend: ReturnType<typeof renderApp>["backend"]): string {
  const backup = backend.data.backups.find(
    (candidate) => candidate.storageId === "st-s3" && candidate.status === "complete",
  );
  if (backup === undefined) throw new Error("fixtures have no complete backup");
  return backup.id;
}

describe("backups", () => {
  it("lists backups with status, verification and protection, and opens the detail page", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/backups/st-s3" });
    const table = await screen.findByRole("table", { name: "Backups in S3 primary" });
    expect(within(table).getAllByText("Incomplete").length).toBeGreaterThan(0);
    expect(within(table).getByText("Verify failed")).toBeTruthy();
    expect(within(table).getByText("On hold")).toBeTruthy();

    const id = newestCompleteId(backend);
    await user.click(within(table).getByRole("link", { name: id }));
    expect(await screen.findByRole("heading", { name: id })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Summary", selected: true })).toBeTruthy();
    expect(screen.getByText("Replica set, MongoDB 8.0.4")).toBeTruthy();
  });

  it("marks incremental backups instead of showing a document count", async () => {
    renderApp({
      signedInAs: "admin",
      hash: "#/backups/st-s3",
      prepare: (backend) => {
        const newest = backend.data.backups.find((backup) => backup.storageId === "st-s3");
        if (newest === undefined) throw new Error("fixtures have no backup");
        backend.data.backups.unshift({
          ...newest,
          id: newest.id.replace(/_[0-9a-f]{6}$/, "_1a2b3c"),
          kind: "incremental",
          chainLength: 3,
        });
      },
    });
    const table = await screen.findByRole("table", { name: "Backups in S3 primary" });
    expect(within(table).getByText("Incremental #3")).toBeTruthy();
  });

  it("filters the catalog", async () => {
    const { user } = renderApp({ signedInAs: "sam", hash: "#/backups/st-s3" });
    const table = await screen.findByRole("table", { name: "Backups in S3 primary" });
    await user.selectOptions(screen.getByLabelText("Show"), "protected");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  it("hides the document browser and hold release from viewers", async () => {
    const { backend } = renderApp({ signedInAs: "sam" });
    const id = newestCompleteId(backend);
    window.location.hash = `#/backups/st-s3/${id}`;
    await screen.findByRole("tab", { name: "Summary" });
    expect(screen.queryByRole("tab", { name: "Browse documents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hold…" })).toBeNull();
  });
});

describe("document browser", () => {
  async function openBrowser() {
    const rendered = renderApp({ signedInAs: "maya" });
    const id = newestCompleteId(rendered.backend);
    window.location.hash = `#/backups/st-s3/${id}?tab=browse`;
    const table = await screen.findByRole("table", { name: "Documents" });
    await within(table).findAllByRole("button", { name: /^Open document/ });
    return { ...rendered, id, table };
  }

  /** The document rows of the table view (not its header). */
  function documentRows(table: HTMLElement): HTMLElement[] {
    return within(table)
      .getAllByRole("row")
      .filter((row) => row.hasAttribute("data-index"));
  }

  it("pages forward and back with the server's cursor", async () => {
    const { user, backend, table } = await openBrowser();
    expect(documentRows(table)).toHaveLength(20);
    expect(screen.getByText(/^Page 1 of shop.users/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous page" })).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText(/^Page 2 of shop.users/)).toBeTruthy();
    const pageRequests = requestsTo(backend, "GET", "/api/storage/st-s3/backups/");
    expect(pageRequests.at(-1)?.url).toContain("after=20");
    expect(pageRequests.at(-1)?.url).toContain("ns=shop.users");

    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText(/^Page 1 of shop.users/)).toBeTruthy();
  });

  it("validates the Extended JSON filter before sending it", async () => {
    const { user, backend } = await openBrowser();
    const filter = screen.getByLabelText("Filter (Extended JSON)");
    const before = requestsTo(backend, "GET", "/api/storage/st-s3/backups/").length;

    await user.click(filter);
    await user.paste("{plan: 'pro'}");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText(/Not valid Extended JSON/)).toBeTruthy();
    expect(filter.getAttribute("aria-invalid")).toBe("true");

    await user.clear(filter);
    await user.paste('{"plan": {"$equals": "pro"}}');
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText(/Unknown operator "\$equals"/)).toBeTruthy();
    expect(requestsTo(backend, "GET", "/api/storage/st-s3/backups/")).toHaveLength(before);

    await user.clear(filter);
    await user.paste('{ "plan": "pro" }');
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/· filtered/);
    const last = requestsTo(backend, "GET", "/api/storage/st-s3/backups/").at(-1);
    expect(decodeURIComponent(last?.url ?? "")).toContain('filter={"plan":"pro"}');
    // Every 5th generated user is on the pro plan; the table shows each plan once per row.
    const table = screen.getByRole("table", { name: "Documents" });
    await waitFor(() => expect(within(table).getAllByText("pro")).toHaveLength(20));
    expect(within(table).queryByText("free")).toBeNull();
    // The applied filter shows as a removable chip.
    expect(screen.getByText('plan is "pro"')).toBeTruthy();
  });

  it("collapses and expands nested values with the keyboard-accessible tree", async () => {
    const { user } = await openBrowser();
    await user.click(screen.getByRole("radio", { name: "Tree" }));
    const [firstTree] = await screen.findAllByRole("tree", { name: /^Document / });
    if (firstTree === undefined) throw new Error("no documents");
    const address = within(firstTree).getByRole("treeitem", { name: /^address/ });
    expect(address.getAttribute("aria-expanded")).toBe("false");
    await user.click(address);
    expect(address.getAttribute("aria-expanded")).toBe("true");
    expect(within(firstTree).getByText('"Colombo"')).toBeTruthy();
    // ← closes it again from the keyboard.
    address.focus();
    await user.keyboard("{ArrowLeft}");
    expect(address.getAttribute("aria-expanded")).toBe("false");
  });

  it("selects documents and starts a restore limited to them", async () => {
    const { user, id } = await openBrowser();
    const checkboxes = screen.getAllByRole("checkbox", { name: /^Select document/ });
    await user.click(checkboxes[0] as HTMLElement);
    await user.click(checkboxes[1] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Restore selected (2)" }));
    expect(await screen.findByText("Restoring 2 selected documents")).toBeTruthy();
    expect(window.location.hash).toContain(`/backups/st-s3/${id}/restore`);
  });
});
