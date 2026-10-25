/**
 * Page tests for the audit log: the filters (actor and action selects built from the
 * loaded entries, the target search with suggestions, clearing them), paging back with
 * "Load older entries", the end of the log, and errors while loading.
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../shared/api.ts";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import type { MockBackend } from "../mock/backend.ts";
import { renderApp, requestsTo } from "../testing.tsx";
import {
  actionFamily,
  actionMatches,
  auditMatches,
  groupActions,
  NO_AUDIT_FILTERS,
} from "./audit.tsx";

/** Replaces the fixture log with `count` entries, one minute apart, newest first. */
function fillLog(backend: MockBackend, count: number): void {
  const now = Date.now();
  backend.data.audit = Array.from(
    { length: count },
    (_, index): AuditEntry => ({
      at: new Date(now - index * 60_000).toISOString(),
      actor: index % 2 === 0 ? "admin" : "schedule",
      action: "backup.finish",
      target: `entry-${index}`,
      outcome: "success",
    }),
  );
}

describe("auditMatches", () => {
  const entry: AuditEntry = {
    at: "2026-10-21T10:00:00Z",
    actor: "Maya",
    action: "restore.start",
    target: "Staging",
    outcome: "success",
  };

  it("matches the exact actor and action, part of the target, and the outcome", () => {
    const match = (filters: Partial<typeof NO_AUDIT_FILTERS>) =>
      auditMatches(entry, { ...NO_AUDIT_FILTERS, ...filters });
    expect(match({})).toBe(true);
    expect(match({ actor: "Maya", action: "restore.start", outcome: "success" })).toBe(true);
    expect(match({ actor: "maya" })).toBe(false);
    expect(match({ action: "restore.*" })).toBe(true);
    expect(match({ action: "session.*" })).toBe(false);
    expect(match({ target: "  stag " })).toBe(true);
    expect(match({ target: "prod" })).toBe(false);
    expect(match({ outcome: "failure" })).toBe(false);
  });

  it("treats a missing target as empty", () => {
    const { target: _target, ...withoutTarget } = entry;
    expect(auditMatches(withoutTarget, { ...NO_AUDIT_FILTERS, target: "nope" })).toBe(false);
    expect(auditMatches(withoutTarget, NO_AUDIT_FILTERS)).toBe(true);
  });
});

describe("action families", () => {
  it("takes the part before the first dot as the family", () => {
    expect(actionFamily("session.login_failed")).toBe("session");
    expect(actionFamily("restore.preview.document")).toBe("restore");
    expect(actionFamily("setup")).toBe("setup");
  });

  it("matches any action, an exact one, or a whole family", () => {
    expect(actionMatches("", "backup.hold")).toBe(true);
    expect(actionMatches("backup.hold", "backup.hold")).toBe(true);
    expect(actionMatches("backup.hold", "backup.release")).toBe(false);
    expect(actionMatches("backup.*", "backup.release")).toBe(true);
    // "backup.*" is the family, not every action starting with "backup".
    expect(actionMatches("backup.*", "backups.list")).toBe(false);
  });

  it("groups and counts the actions, families and actions A to Z", () => {
    expect(
      groupActions(["session.login", "backup.hold", "session.login", "session.logout"]),
    ).toEqual([
      { family: "backup", total: 1, actions: [{ value: "backup.hold", count: 1 }] },
      {
        family: "session",
        total: 3,
        actions: [
          { value: "session.login", count: 2 },
          { value: "session.logout", count: 1 },
        ],
      },
    ]);
  });
});

describe("audit page", () => {
  it("filters by actor from a select, always offering schedule and anonymous", async () => {
    const { user } = renderApp({ signedInAs: "sam", hash: "#/audit" });
    const table = await screen.findByRole("table", { name: "Audit log entries" });
    const actor = screen.getByLabelText("Actor");
    // Built from the loaded entries, with counts; the special actors are explained.
    const labels = within(actor)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual([
      "Anyone",
      "admin (5)",
      "anonymous: failed sign-ins (1)",
      "maya (1)",
      "schedule: scheduled runs (0)",
    ]);
    await user.selectOptions(actor, "anonymous");
    for (const row of within(table).getAllByRole("row").slice(1)) {
      expect(row.textContent).toContain("anonymous");
    }
    expect(screen.getByText("username=root ip=203.0.113.7")).toBeTruthy();
    expect(screen.getByText("Showing 1 of 7 loaded entries.")).toBeTruthy();
    // Nobody ran a schedule in the fixtures: the filter says so instead of guessing.
    await user.selectOptions(actor, "schedule");
    expect(screen.getByText("No entries match the filters")).toBeTruthy();
  });

  it("filters by an action or a whole family of actions", async () => {
    const { user } = renderApp({
      signedInAs: "sam",
      hash: "#/audit",
      prepare: (mock) => {
        mock.data.audit = [
          ...mock.data.audit,
          {
            at: "2020-01-01T00:00:00Z",
            actor: "admin",
            action: "session.logout",
            // A second entry about Staging, so its suggestion counts two.
            target: "Staging",
            outcome: "success",
          },
        ];
      },
    });
    await screen.findByRole("table", { name: "Audit log entries" });
    const action = screen.getByLabelText("Action");
    // Families are option groups; "All … actions" only where a family has several.
    expect(within(action).getByRole("group", { name: "Session" })).toBeTruthy();
    expect(within(action).queryByRole("option", { name: /^All backup actions/ })).toBeNull();
    await user.selectOptions(action, "session.*");
    expect(screen.getByText("Showing 3 of 8 loaded entries.")).toBeTruthy();
    await user.selectOptions(action, "restore.start");
    expect(screen.getByText("Showing 1 of 8 loaded entries.")).toBeTruthy();
    // The target suggestions count the loaded entries naming each target.
    await user.type(screen.getByRole("combobox", { name: "Target" }), "Stag");
    expect(screen.getByRole("option", { name: /^Staging/ }).textContent).toBe("Staging2 entries");
  });

  it("searches the target with suggestions, and clears every filter at once", async () => {
    const { user } = renderApp({ signedInAs: "sam", hash: "#/audit" });
    await screen.findByRole("table", { name: "Audit log entries" });
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    const target = screen.getByRole("combobox", { name: "Target" });
    await user.type(target, "stag");
    expect(screen.getByText("Showing 1 of 7 loaded entries.")).toBeTruthy();
    // The known targets containing the text are suggested; picking one fills the box.
    const suggestions = screen.getByRole("listbox", { name: "Known targets" });
    expect(
      within(suggestions)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Staging1 entry"]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(target).toHaveProperty("value", "Staging");
    await user.clear(target);
    await user.type(target, "no-such-target");
    expect(screen.getByText("No entries match the filters")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(target).toHaveProperty("value", "");
    expect(screen.getByText("Showing 7 of 7 loaded entries.")).toBeTruthy();
  });

  it("says there is nothing older when the first page is short", async () => {
    renderApp({ signedInAs: "sam", hash: "#/audit" });
    const button = await screen.findByRole("button", { name: "No older entries" });
    expect(button).toHaveProperty("disabled", true);
  });

  it("loads older entries until the log is exhausted", async () => {
    const { user, backend } = renderApp({
      signedInAs: "sam",
      hash: "#/audit",
      prepare: (mock) => fillLog(mock, 150),
    });
    await user.click(await screen.findByRole("button", { name: "Load older entries" }));
    expect(await screen.findByText("Showing 150 of 150 loaded entries.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "No older entries" })).toHaveProperty(
      "disabled",
      true,
    );
    const [, older] = requestsTo(backend, "GET", "/api/audit");
    expect(older?.url).toContain("before=");
  });

  it("shows why older entries could not be loaded", async () => {
    const { user } = renderFailingApp({
      signedInAs: "sam",
      hash: "#/audit",
      prepare: (mock) => fillLog(mock, 120),
      failures: [{ method: "GET", path: /before=/, status: 500, message: "Log unreadable." }],
    });
    await user.click(await screen.findByRole("button", { name: "Load older entries" }));
    expect(await screen.findByText("Log unreadable.")).toBeTruthy();
  });

  it("retries after the first page failed", async () => {
    const { user } = renderFailingApp({
      signedInAs: "sam",
      hash: "#/audit",
      failures: [{ method: "GET", path: "/api/audit", status: 500, times: 1 }],
    });
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Audit log entries" })).toBeTruthy();
  });
});
