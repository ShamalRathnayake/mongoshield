/**
 * Roles: a viewer and an operator see only what their role allows, and the API
 * refuses the rest even when the request is made by hand. Hiding a control is a
 * convenience; the server check is the security boundary, so every hidden or
 * disabled control below is paired with the request it would have made.
 *
 *   viewer    reads plans, backups, jobs and the audit log; changes nothing, cannot
 *             read documents out of backups
 *   operator  also tests connections, runs plans, verifies, drills, holds, browses
 *             and restores, but not into production, and cannot release holds or
 *             change connections, storage, plans or users
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { baseUrl, NAMES, OPERATOR, VIEWER } from "./env.ts";
import {
  apiSignIn,
  ensureRoleUsers,
  expect,
  goTo,
  idByName,
  readableBackup,
  signIn,
  test,
} from "./fixtures.ts";

/** Ids the checks below need, read with the admin's session. */
interface Ids {
  readonly production: string;
  readonly scratch: string;
  readonly storage: string;
  readonly plan: string;
  readonly backup: string;
}

let ids: Ids;

test.beforeAll(async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: baseUrl() });
  await ensureRoleUsers(admin);
  const { storageId, backupId } = await readableBackup(admin);
  ids = {
    production: await idByName(admin, "/api/connections", NAMES.production),
    scratch: await idByName(admin, "/api/connections", NAMES.scratch),
    storage: storageId,
    plan: await idByName(admin, "/api/plans", NAMES.plan),
    backup: backupId,
  };
  await admin.dispose();
});

/**
 * Status of a state-changing API call made by hand with a signed-in session and
 * its valid CSRF token: only the role can be the reason for a refusal.
 */
async function callAs(
  request: APIRequestContext,
  csrf: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  data: Record<string, unknown> = {},
): Promise<number> {
  const response = await request.fetch(path, {
    method,
    headers: { "x-csrf-token": csrf },
    data,
  });
  return response.status();
}

async function expectNoButton(page: Page, name: string | RegExp): Promise<void> {
  await expect(page.getByRole("button", { name })).toHaveCount(0);
}

test("a viewer can look but not touch, and the API refuses every change", async ({
  page,
  playwright,
}) => {
  await signIn(page, VIEWER);
  await expect(page.getByText(`${VIEWER.username} (viewer)`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);

  await goTo(page, "/connections");
  await expect(page.getByRole("row", { name: new RegExp(NAMES.production) })).toBeVisible();
  await expectNoButton(page, "Add connection");
  await expectNoButton(page, /^(Test|Edit|Delete) /);

  await goTo(page, "/storage");
  await expectNoButton(page, "Add storage");
  await expectNoButton(page, /^(Test|Edit|Remove) /);

  await goTo(page, "/plans");
  await expect(page.getByRole("link", { name: "New plan" })).toHaveCount(0);
  await expectNoButton(page, /^Run now/);
  await goTo(page, `/plans/${ids.plan}`);
  await expect(page.getByText("Only admins can change backup plans.")).toBeVisible();
  await expect(page.getByLabel("Name")).toBeDisabled();
  await expectNoButton(page, "Run now");

  await goTo(page, `/backups/${ids.storage}/${ids.backup}`);
  for (const action of ["Verify…", "Drill…", "Hold…"]) await expectNoButton(page, action);
  await expect(page.getByRole("link", { name: "Restore…" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Browse documents" })).toHaveCount(0);
  await goTo(page, `/backups/${ids.storage}/${ids.backup}/restore`);
  await expect(page.getByRole("heading", { name: "Not allowed", level: 1 })).toBeVisible();
  await expect(
    page.getByText("This page needs the operator role.", { exact: false }),
  ).toBeVisible();
  await goTo(page, "/users");
  await expect(page.getByText("This page needs the admin role.")).toBeVisible();

  // The same actions, asked of the API directly.
  const api = await playwright.request.newContext({ baseURL: baseUrl() });
  const csrf = await apiSignIn(api, VIEWER);
  const backupPath = `/api/storage/${ids.storage}/backups/${ids.backup}`;
  const refused: [method: "POST" | "PUT" | "DELETE", path: string, body?: object][] = [
    ["POST", "/api/connections", { name: "x", uri: "mongodb://h/", production: false }],
    ["POST", `/api/connections/${ids.scratch}/test`],
    ["POST", `/api/plans/${ids.plan}/run`],
    ["POST", `${backupPath}/verify`, { mode: "fast" }],
    ["POST", `${backupPath}/hold`, { reason: "no" }],
    ["POST", `${backupPath}/drill`, { targetConnectionId: ids.scratch }],
    ["POST", "/api/restore/plan", restoreBody(ids.scratch)],
    ["POST", "/api/restore/preview", restoreBody(ids.scratch)],
    ["POST", "/api/users", { username: "eve", password: "long enough password", role: "admin" }],
  ];
  for (const [method, path, body] of refused) {
    expect(await callAs(api, csrf, method, path, { ...body }), `${method} ${path}`).toBe(403);
  }
  const browse = await api.get(`${backupPath}/documents?ns=shop.orders`);
  expect(browse.status(), "reading documents").toBe(403);
  await api.dispose();
});

test("an operator runs and restores, but not into production, and cannot administer", async ({
  page,
  playwright,
}) => {
  await signIn(page, OPERATOR);
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);

  await goTo(page, "/connections");
  await expect(page.getByRole("button", { name: `Test ${NAMES.scratch}` })).toBeVisible();
  await expectNoButton(page, "Add connection");
  await expectNoButton(page, /^(Edit|Delete) /);

  await goTo(page, "/plans");
  await expect(page.getByRole("button", { name: `Run now ${NAMES.plan}` })).toBeVisible();
  await expect(page.getByRole("link", { name: "New plan" })).toHaveCount(0);

  await goTo(page, `/backups/${ids.storage}/${ids.backup}`);
  for (const action of ["Verify…", "Drill…", "Hold…"]) {
    await expect(page.getByRole("button", { name: action })).toBeVisible();
  }
  await expect(page.getByRole("tab", { name: "Browse documents" })).toBeVisible();

  // The wizard lets an operator plan a restore into production but never start it.
  await page.getByRole("link", { name: "Restore…" }).click();
  await page
    .getByLabel("Target connection")
    .selectOption({ label: `${NAMES.production} — PRODUCTION` });
  await expect(page.getByText(/only admins can restore into production/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review plan" })).toBeDisabled();
  // Into a non-production connection, the operator may go ahead.
  await page.getByLabel("Target connection").selectOption({ label: NAMES.scratch });
  await expect(page.getByRole("button", { name: "Review plan" })).toBeEnabled();

  const api = await playwright.request.newContext({ baseURL: baseUrl() });
  const csrf = await apiSignIn(api, OPERATOR);
  const backupPath = `/api/storage/${ids.storage}/backups/${ids.backup}`;
  const refused: [method: "POST" | "PUT" | "DELETE", path: string, body?: object][] = [
    ["POST", "/api/restore/plan", restoreBody(ids.production)],
    ["POST", "/api/restore/preview", restoreBody(ids.production)],
    ["POST", "/api/restore", { ...restoreBody(ids.production), confirmName: NAMES.production }],
    ["POST", "/api/connections", { name: "x", uri: "mongodb://h/", production: false }],
    ["DELETE", `/api/connections/${ids.scratch}`],
    ["POST", "/api/storage", { name: "x", url: "elsewhere" }],
    ["DELETE", `/api/plans/${ids.plan}`],
    ["POST", `/api/plans/${ids.plan}/prune/plan`],
    ["DELETE", `${backupPath}/hold`],
    ["POST", "/api/users", { username: "eve", password: "long enough password", role: "admin" }],
    ["POST", "/api/config/import", { document: {}, dryRun: true }],
  ];
  for (const [method, path, body] of refused) {
    expect(await callAs(api, csrf, method, path, { ...body }), `${method} ${path}`).toBe(403);
  }
  // What the operator may do, the API allows.
  expect(await callAs(api, csrf, "POST", `/api/connections/${ids.scratch}/test`)).toBe(200);
  await api.dispose();
});

/** A restore request for the journey's newest backup into `target`. */
function restoreBody(target: string): Record<string, unknown> {
  return {
    storageId: ids.storage,
    backupId: ids.backup,
    targetConnectionId: target,
    mode: "fail-if-exists",
    rename: { "shop.*": "shop_refused.*" },
  };
}
