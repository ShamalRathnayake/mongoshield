/**
 * Page tests for one backup: the tabs (summary, namespaces, verification & drills,
 * browse) and their keyboard navigation, the verify / drill / hold / release dialogs
 * with their error paths, incomplete backups and what each role sees.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import type { MockBackend } from "../mock/backend.ts";
import { renderApp, requestsTo } from "../testing.tsx";

/** The id of a fixture backup in `storageId` that passes `predicate`. */
function backupWhere(
  backend: MockBackend,
  storageId: string,
  predicate: (backup: MockBackend["data"]["backups"][number]) => boolean,
): string {
  const backup = backend.data.backups.find(
    (candidate) => candidate.storageId === storageId && predicate(candidate),
  );
  if (backup === undefined) throw new Error("no matching fixture backup");
  return backup.id;
}

/** The newest complete S3 backup: not verified, no hold, no drills. */
const newest = (backend: MockBackend) =>
  backupWhere(backend, "st-s3", (backup) => backup.status === "complete");

/** Opens a backup's page as `signedInAs` and waits for its tabs. */
async function openBackup(
  signedInAs: string,
  pick: (backend: MockBackend) => string,
  tab?: string,
  storageId = "st-s3",
) {
  const rendered = renderApp({ signedInAs });
  const id = pick(rendered.backend);
  window.location.hash = `#/backups/${storageId}/${id}${tab === undefined ? "" : `?tab=${tab}`}`;
  await screen.findByRole("tablist", { name: "Backup details" });
  return { ...rendered, id };
}

describe("backup detail tabs", () => {
  it("shows the summary with the source, encryption, labels and the raw manifest", async () => {
    await openBackup("sam", newest);
    expect(screen.getByText("Replica set, MongoDB 8.0.4")).toBeTruthy();
    expect(screen.getByText("age-v1, 1 recipient(s)")).toBeTruthy();
    expect(screen.getByText("trigger=schedule, plan=Nightly production")).toBeTruthy();
    expect(screen.getByText("Raw manifest")).toBeTruthy();
    expect(screen.getByText("mongoshield@2.0.0")).toBeTruthy();
  });

  it("says when a backup is not encrypted", async () => {
    await openBackup(
      "sam",
      (backend) => backupWhere(backend, "st-r2", () => true),
      undefined,
      "st-r2",
    );
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("lists namespaces with browse links for operators and sorts them", async () => {
    const { user } = await openBackup("maya", newest, "namespaces");
    const table = screen.getByRole("table", { name: "Namespaces in this backup" });
    expect(within(table).getAllByRole("link", { name: "Browse" }).length).toBeGreaterThan(0);
    await user.click(within(table).getByRole("button", { name: /Documents/ }));
    const firstCell = () => within(table).getAllByRole("row")[1]?.textContent ?? "";
    const ascending = firstCell();
    await user.click(within(table).getByRole("button", { name: /Documents/ }));
    expect(firstCell()).not.toBe(ascending);
  });

  it("hides browse links from viewers", async () => {
    await openBackup("sam", newest, "namespaces");
    const table = screen.getByRole("table", { name: "Namespaces in this backup" });
    expect(within(table).queryByRole("link", { name: "Browse" })).toBeNull();
  });

  it("shows an unverified backup without drills", async () => {
    await openBackup("sam", newest, "history");
    expect(screen.getByText("Not verified yet")).toBeTruthy();
    expect(screen.getByText("No drills yet")).toBeTruthy();
  });

  it("shows the latest verification and past drills", async () => {
    await openBackup(
      "sam",
      (backend) => backupWhere(backend, "st-s3", (backup) => backup.drills.length > 0),
      "history",
    );
    const drills = screen.getByRole("table", { name: "Restore drills of this backup" });
    expect(within(drills).getByText("14 min 12 s")).toBeTruthy();
    expect(screen.getByText("deep")).toBeTruthy();
  });

  it("moves between tabs with the arrow, Home and End keys", async () => {
    const { user } = await openBackup("maya", newest);
    screen.getByRole("tab", { name: "Summary" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("tab", { name: "Namespaces", selected: true })).toBeTruthy();
    await user.keyboard("{End}");
    expect(
      await screen.findByRole("tab", { name: "Browse documents", selected: true }),
    ).toBeTruthy();
    await user.keyboard("{Home}");
    expect(await screen.findByRole("tab", { name: "Summary", selected: true })).toBeTruthy();
    await user.keyboard("{ArrowLeft}");
    expect(
      await screen.findByRole("tab", { name: "Browse documents", selected: true }),
    ).toBeTruthy();
    await user.keyboard("x");
    expect(screen.getByRole("tab", { name: "Browse documents", selected: true })).toBeTruthy();
  });

  it("falls back to the summary for an unknown tab", async () => {
    await openBackup("maya", newest, "nonsense");
    expect(screen.getByRole("tab", { name: "Summary", selected: true })).toBeTruthy();
  });
});

describe("incomplete backups", () => {
  it("warns, offers no verify or restore, and cannot be browsed", async () => {
    await openBackup(
      "admin",
      (backend) => backupWhere(backend, "st-s3", (backup) => backup.status === "incomplete"),
      "browse",
    );
    expect(screen.getByText("This backup is not complete")).toBeTruthy();
    expect(screen.getByText("Incomplete backups cannot be browsed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verify…" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Restore…" })).toBeNull();
  });
});

describe("backup actions", () => {
  it("starts a deep verify and opens its job", async () => {
    const { user, backend, id } = await openBackup("maya", newest);
    await user.click(screen.getByRole("button", { name: "Verify…" }));
    const dialog = screen.getByRole("dialog", { name: "Verify backup" });
    await user.selectOptions(within(dialog).getByLabelText("Mode"), "deep");
    await user.click(within(dialog).getByRole("button", { name: "Start verify" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/jobs\/job-/));
    const [request] = requestsTo(backend, "POST", `/api/storage/st-s3/backups/${id}/verify`);
    expect(request?.body).toEqual({ mode: "deep" });
  });

  it("reports a verify that could not start", async () => {
    const { user, backend } = renderFailingApp({
      signedInAs: "maya",
      failures: [
        { method: "POST", path: /\/verify$/, status: 409, message: "A verify is already running." },
      ],
    });
    window.location.hash = `#/backups/st-s3/${newest(backend)}`;
    await user.click(await screen.findByRole("button", { name: "Verify…" }));
    await user.click(screen.getByRole("button", { name: "Start verify" }));
    expect(await screen.findByText("A verify is already running.")).toBeTruthy();
  });

  it("offers only non-production connections for a drill and starts it", async () => {
    const { user, backend } = await openBackup("maya", newest);
    await user.click(screen.getByRole("button", { name: "Drill…" }));
    const dialog = screen.getByRole("dialog", { name: "Restore drill" });
    const select = (await within(dialog).findByLabelText("Target connection")) as HTMLSelectElement;
    const options = [...select.options].map((option) => option.textContent);
    expect(options).not.toContain("Production cluster");
    await user.selectOptions(select, "conn-local");
    await user.click(within(dialog).getByRole("button", { name: "Start drill" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/jobs\/job-/));
    const [request] = requestsTo(backend, "POST", "/api/storage/st-s3/backups/");
    expect(request?.body).toEqual({ targetConnectionId: "conn-local" });
  });

  it("explains that drills need a non-production connection", async () => {
    const { user, backend } = renderApp({
      signedInAs: "admin",
      prepare: (mock) => {
        for (const connection of mock.data.connections) connection.production = true;
      },
    });
    window.location.hash = `#/backups/st-s3/${newest(backend)}`;
    await user.click(await screen.findByRole("button", { name: "Drill…" }));
    expect(await screen.findByText("No non-production connection")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start drill" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reports a drill that could not start", async () => {
    const { user, backend } = renderFailingApp({
      signedInAs: "maya",
      failures: [{ method: "POST", path: /\/drill$/, status: 403, message: "Not for you." }],
    });
    window.location.hash = `#/backups/st-s3/${newest(backend)}`;
    await user.click(await screen.findByRole("button", { name: "Drill…" }));
    await screen.findByLabelText("Target connection");
    await user.click(screen.getByRole("button", { name: "Start drill" }));
    expect(await screen.findByText("Not for you.")).toBeTruthy();
  });

  it("requires a reason for a hold, then holds the backup", async () => {
    const { user, backend } = await openBackup("maya", newest);
    await user.click(screen.getByRole("button", { name: "Hold…" }));
    const dialog = screen.getByRole("dialog", { name: "Put backup on hold" });
    await user.click(within(dialog).getByRole("button", { name: "Hold backup" }));
    expect(
      within(dialog).getByText("Say why the backup is held, e.g. a ticket number."),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Reason"), "  Ticket SEC-9  ");
    await user.click(within(dialog).getByRole("button", { name: "Hold backup" }));
    expect(await screen.findByText("Backup is on hold.")).toBeTruthy();
    expect(await screen.findByText("On hold", { selector: ".notice-title" })).toBeTruthy();
    const [request] = requestsTo(backend, "POST", "/api/storage/st-s3/backups/");
    expect(request?.body).toEqual({ reason: "Ticket SEC-9" });
    // Operators may not release it again.
    expect(screen.queryByRole("button", { name: "Release hold…" })).toBeNull();
  });

  it("lets admins release a hold", async () => {
    const { user, backend } = await openBackup("admin", (mock) =>
      backupWhere(mock, "st-s3", (backup) => backup.hold !== undefined),
    );
    await user.click(screen.getByRole("button", { name: "Release hold…" }));
    const dialog = screen.getByRole("dialog", { name: "Release hold" });
    expect(within(dialog).getByText("Release the hold on this backup?")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Release hold" }));
    expect(await screen.findByText("Hold released.")).toBeTruthy();
    expect(requestsTo(backend, "DELETE", "/api/storage/st-s3/backups/")).toHaveLength(1);
  });

  it("shows why releasing a hold failed inside the dialog", async () => {
    const { user, backend } = renderFailingApp({
      signedInAs: "admin",
      failures: [
        { method: "DELETE", path: /\/hold$/, status: 403, message: "Only admins may release." },
      ],
    });
    const held = backupWhere(backend, "st-s3", (backup) => backup.hold !== undefined);
    window.location.hash = `#/backups/st-s3/${held}`;
    await user.click(await screen.findByRole("button", { name: "Release hold…" }));
    const dialog = screen.getByRole("dialog", { name: "Release hold" });
    await user.click(within(dialog).getByRole("button", { name: "Release hold" }));
    expect(await within(dialog).findByText("Only admins may release.")).toBeTruthy();
  });
});

describe("backup detail errors", () => {
  it("shows a read error with the breadcrumbs and retries", async () => {
    const { user, backend } = renderFailingApp({
      signedInAs: "sam",
      failures: [
        {
          method: "GET",
          path: /\/backups\/[^/]+$/,
          status: 404,
          message: "No such backup.",
          times: 1,
        },
      ],
    });
    window.location.hash = `#/backups/st-s3/${newest(backend)}`;
    expect(await screen.findByText("Could not read the backup")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("tablist", { name: "Backup details" })).toBeTruthy();
  });
});
