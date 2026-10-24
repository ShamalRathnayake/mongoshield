/**
 * Page tests for the audit log: text filters, paging back with "Load older entries",
 * the end of the log, and errors while loading.
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../shared/api.ts";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import type { MockBackend } from "../mock/backend.ts";
import { renderApp, requestsTo } from "../testing.tsx";
import { auditMatches } from "./audit.tsx";

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

  it("matches actor and action or target case-insensitively", () => {
    expect(auditMatches(entry, { actor: "maya", action: "STAGING", outcome: "all" })).toBe(true);
    expect(auditMatches(entry, { actor: "", action: "restore", outcome: "success" })).toBe(true);
    expect(auditMatches(entry, { actor: "sam", action: "", outcome: "all" })).toBe(false);
    expect(auditMatches(entry, { actor: "", action: "", outcome: "failure" })).toBe(false);
  });

  it("treats a missing target as empty", () => {
    const { target: _target, ...withoutTarget } = entry;
    expect(auditMatches(withoutTarget, { actor: "", action: "nope", outcome: "all" })).toBe(false);
  });
});

describe("audit page", () => {
  it("filters by actor and by action, and says when nothing matches", async () => {
    const { user } = renderApp({ signedInAs: "sam", hash: "#/audit" });
    const table = await screen.findByRole("table", { name: "Audit log entries" });
    await user.type(screen.getByLabelText("Actor"), "anonymous");
    for (const row of within(table).getAllByRole("row").slice(1)) {
      expect(row.textContent).toContain("anonymous");
    }
    expect(screen.getByText("username=root ip=203.0.113.7")).toBeTruthy();
    await user.type(screen.getByLabelText("Action or target"), "no-such-action");
    expect(screen.getByText("No entries match the filters")).toBeTruthy();
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
