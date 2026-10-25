/**
 * Page tests for the document browser beyond paging and filters: changing namespace and
 * page size, clearing a filter, empty results, documents without an `_id` or that are
 * not JSON, read errors (with the hint for encrypted backups), a backup with nothing
 * to browse, and the restore button rules.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api.ts";
import { ToastProvider } from "../components/toast.tsx";
import { ApiProvider, SessionProvider } from "../context.tsx";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { createMockBackend, type MockBackend } from "../mock/backend.ts";
import { renderApp, requestsTo } from "../testing.tsx";
import { DocumentBrowser } from "./document-browser.tsx";

function newestComplete(backend: MockBackend): string {
  const backup = backend.data.backups.find(
    (candidate) => candidate.storageId === "st-s3" && candidate.status === "complete",
  );
  if (backup === undefined) throw new Error("no complete backup");
  return backup.id;
}

async function openBrowser(rendered: ReturnType<typeof renderApp>) {
  window.location.hash = `#/backups/st-s3/${newestComplete(rendered.backend)}?tab=browse`;
  await screen.findByRole("table", { name: "Documents" });
  return rendered;
}

describe("document browser", () => {
  it("restarts from page 1 when the namespace or the page size changes", async () => {
    const { user, backend } = await openBrowser(renderApp({ signedInAs: "maya" }));
    await screen.findAllByRole("button", { name: /^Open document/ });
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText(/^Page 2 of shop.users/);

    const tree = screen.getByRole("tree", { name: "Databases and collections in the backup" });
    await user.click(within(tree).getByRole("treeitem", { name: /^orders/ }));
    expect(await screen.findByText(/^Page 1 of shop.orders/)).toBeTruthy();
    expect(
      within(tree)
        .getByRole("treeitem", { name: /^orders/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    await waitFor(() =>
      expect(requestsTo(backend, "GET", "/api/storage/st-s3/backups/").at(-1)?.url).toContain(
        "ns=shop.orders",
      ),
    );

    await user.selectOptions(screen.getByLabelText("Per page"), "50");
    await waitFor(() =>
      expect(requestsTo(backend, "GET", "/api/storage/st-s3/backups/").at(-1)?.url).toContain(
        "limit=50",
      ),
    );
  });

  it("clears an applied filter, and says when nothing matches it", async () => {
    const { user } = await openBrowser(renderApp({ signedInAs: "maya" }));
    const filter = screen.getByLabelText("Filter (Extended JSON)");
    await user.click(filter);
    await user.paste('{"plan": "no-such-plan"}');
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("No documents match the filter.")).toBeTruthy();

    // Removing the condition's chip clears the filter again.
    await user.click(screen.getByRole("button", { name: "Remove the condition on plan" }));
    expect((filter as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("list", { name: "Applied filter" })).toBeNull();
    expect(
      (await screen.findAllByRole("button", { name: /^Open document/ })).length,
    ).toBeGreaterThan(0);

    // Reset clears whatever is typed, applied or not.
    await user.type(filter, "{{bad");
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect((filter as HTMLInputElement).value).toBe("");
  });

  it("shows odd documents as they are and cannot select one without an _id", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      failures: [
        {
          method: "GET",
          path: /\/documents\?/,
          status: 200,
          body: { documents: ['{"name": "no id"}', "not json at all"] },
        },
      ],
    });
    await openBrowserByHash();
    // The table shows a document that is not JSON as its raw text.
    expect(await screen.findByText("not json at all")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Tree" }));
    expect(await screen.findByText("(no _id)")).toBeTruthy();
    expect(screen.getByText("not json at all")).toBeTruthy();
    const [noId] = screen.getAllByRole("checkbox", { name: /^Select document/ });
    expect(noId).toHaveProperty("disabled", true);
    if (noId !== undefined) await user.click(noId);
    expect(screen.getByRole("button", { name: "Restore selected (0)" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("says when a namespace is empty", async () => {
    renderFailingApp({
      signedInAs: "maya",
      failures: [{ method: "GET", path: /\/documents\?/, status: 200, body: { documents: [] } }],
    });
    await openBrowserByHash();
    expect(await screen.findByText("This namespace is empty.")).toBeTruthy();
  });

  it("explains a read error and that encrypted backups need a stored key", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      failures: [
        {
          method: "GET",
          path: /\/documents\?/,
          status: 422,
          message: "No identity can decrypt this backup.",
          times: 1,
        },
      ],
    });
    await openBrowserByHash();
    expect(await screen.findByText("Could not read documents")).toBeTruthy();
    expect(screen.getByText(/Encrypted backups can only be browsed/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      (await screen.findAllByRole("button", { name: /^Open document/ })).length,
    ).toBeGreaterThan(0);
  });
});

/** Opens the browse tab of the newest S3 backup in an app rendered by renderFailingApp. */
async function openBrowserByHash(): Promise<void> {
  // The fixtures are the same for every backend, so a fresh one tells the backup id.
  const probe = createMockBackend({ jobTickMs: 0 });
  window.location.hash = `#/backups/st-s3/${newestComplete(probe)}?tab=browse`;
  probe.dispose();
  await screen.findByRole("tree", { name: "Databases and collections in the backup" });
}

describe("document browser on its own", () => {
  it("says when a backup has nothing to browse", async () => {
    const backend = createMockBackend({ jobTickMs: 0, signedInAs: "maya" });
    const client = new ApiClient({
      fetch: backend.fetch,
      openEventSource: backend.openEventSource,
    });
    const session = await client.call("GET /api/session");
    render(
      <ToastProvider>
        <ApiProvider client={client}>
          <SessionProvider session={session} onChange={() => undefined}>
            <DocumentBrowser
              storageId="st-s3"
              backupId={newestComplete(backend)}
              encrypted={false}
              namespaces={[{ ns: "a.v", type: "view", documents: 0, bytesRaw: 0, bytesStored: 0 }]}
            />
          </SessionProvider>
        </ApiProvider>
      </ToastProvider>,
    );
    expect(screen.getByText("Nothing to browse")).toBeTruthy();
    expect(within(document.body).queryByRole("list")).toBeNull();
  });
});
