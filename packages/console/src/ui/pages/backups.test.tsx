/**
 * Page tests for the backup catalog, the backup detail page and the document browser
 * (paging and filter validation).
 */

import { screen, within } from "@testing-library/react";
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
    await screen.findByRole("list", { name: "Documents on page 1" });
    await screen.findAllByText(/ObjectId\(/);
    return { ...rendered, id };
  }

  it("pages forward and back with the server's cursor", async () => {
    const { user, backend } = await openBrowser();
    const list = screen.getByRole("list", { name: "Documents on page 1" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByRole("button", { name: "Previous page" })).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("list", { name: "Documents on page 2" });
    const pageRequests = requestsTo(backend, "GET", "/api/storage/st-s3/backups/");
    expect(pageRequests.at(-1)?.url).toContain("after=20");
    expect(pageRequests.at(-1)?.url).toContain("ns=shop.users");

    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByRole("list", { name: "Documents on page 1" })).toBeTruthy();
  });

  it("validates the Extended JSON filter before sending it", async () => {
    const { user, backend } = await openBrowser();
    const filter = screen.getByLabelText("Filter (Extended JSON)");
    const before = requestsTo(backend, "GET", "/api/storage/st-s3/backups/").length;

    await user.click(filter);
    await user.paste("{plan: 'pro'}");
    await user.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(screen.getByText(/Not valid Extended JSON/)).toBeTruthy();
    expect(filter.getAttribute("aria-invalid")).toBe("true");

    await user.clear(filter);
    await user.paste('{"plan": {"$equals": "pro"}}');
    await user.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(screen.getByText(/Unknown operator "\$equals"/)).toBeTruthy();
    expect(requestsTo(backend, "GET", "/api/storage/st-s3/backups/")).toHaveLength(before);

    await user.clear(filter);
    await user.paste('{ "plan": "pro" }');
    await user.click(screen.getByRole("button", { name: "Apply filter" }));
    await screen.findByText(/· filtered/);
    const last = requestsTo(backend, "GET", "/api/storage/st-s3/backups/").at(-1);
    expect(decodeURIComponent(last?.url ?? "")).toContain('filter={"plan":"pro"}');
    // Every 5th generated user is on the pro plan.
    const proBadges = await screen.findAllByText('"pro"');
    expect(proBadges.length).toBe(20);
    expect(screen.queryByText('"free"')).toBeNull();
  });

  it("collapses and expands nested values with the keyboard-accessible toggles", async () => {
    const { user } = await openBrowser();
    const [firstCard] = within(
      screen.getByRole("list", { name: "Documents on page 1" }),
    ).getAllByRole("listitem");
    if (firstCard === undefined) throw new Error("no documents");
    const addressToggle = within(firstCard).getByRole("button", { name: /address/ });
    expect(addressToggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(addressToggle);
    expect(addressToggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(firstCard).getByText('"Colombo"')).toBeTruthy();
  });

  it("selects documents and starts a restore limited to them", async () => {
    const { user, id } = await openBrowser();
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0] as HTMLElement);
    await user.click(checkboxes[1] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Restore selected (2)" }));
    expect(await screen.findByText("Restoring 2 selected documents")).toBeTruthy();
    expect(window.location.hash).toContain(`/backups/st-s3/${id}/restore`);
  });
});
