/**
 * Every page of the console, opened as an admin: each one renders, passes the
 * accessibility smoke check (e2e/a11y.ts) and produces no console errors and no
 * Content Security Policy violations (checked by the `pageProblems` fixture for the
 * whole test, i.e. across every page visited).
 *
 * Runs after the journey, so there are connections, plans, backups and jobs to open.
 */

import type { APIRequestContext } from "@playwright/test";
import { accessibilityProblems } from "./a11y.ts";
import { ADMIN, NAMES } from "./env.ts";
import { expect, idByName, readableBackup, signIn, test } from "./fixtures.ts";

/** Ids of the records the journey created, read through the API. */
async function journeyIds(request: APIRequestContext) {
  const jobs: unknown = await (await request.get("/api/jobs")).json();
  return {
    ...(await readableBackup(request)),
    connectionId: await idByName(request, "/api/connections", NAMES.production),
    planId: await idByName(request, "/api/plans", NAMES.plan),
    jobId: String(Reflect.get(Object(Array.isArray(jobs) ? jobs[0] : undefined), "id")),
  };
}

test("every page is accessible and free of console errors and CSP violations", async ({ page }) => {
  await page.goto("/");
  // The login page: not part of the shell, but it must pass the same checks.
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(await accessibilityProblems(page), "login page").toEqual([]);

  await signIn(page, ADMIN);
  const ids = await journeyIds(page.request);
  for (const [key, value] of Object.entries(ids)) expect(value, key).not.toBe("");
  const backup = `/backups/${ids.storageId}/${ids.backupId}`;

  const routes = [
    "/",
    "/connections",
    `/connections/${ids.connectionId}`,
    "/storage",
    "/plans",
    "/plans/new",
    `/plans/${ids.planId}`,
    "/backups",
    backup,
    `${backup}?tab=namespaces`,
    `${backup}?tab=history`,
    `${backup}?tab=browse`,
    `${backup}/restore`,
    "/jobs",
    `/jobs/${ids.jobId}`,
    "/audit",
    "/users",
    "/settings",
    "/no-such-page",
  ];
  for (const route of routes) {
    await page.goto(`/#${route}`);
    await expect(page.locator("#main h1")).toBeVisible();
    // Let the page's data load, so the check sees the finished page, not a spinner.
    await expect(page.getByRole("status").filter({ hasText: /…$/ })).toHaveCount(0);
    expect(await accessibilityProblems(page, { shell: true }), route).toEqual([]);
  }
});

test("the accessibility check itself finds the problems it looks for", async ({ page }) => {
  await page.setContent(`
    <div>
      <input type="text">
      <button></button>
      <a href="#x"></a>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    </div>`);
  const problems = await accessibilityProblems(page, { shell: true });
  expect(problems).toEqual(
    expect.arrayContaining([
      "no main landmark",
      "no banner landmark",
      "no navigation landmark",
      "no level-1 heading",
      "1 <img> without alt",
      expect.stringMatching(/^unnamed textbox/),
      expect.stringMatching(/^unnamed button/),
      expect.stringMatching(/^control without a label: <input/),
    ]),
  );
});
