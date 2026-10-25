/**
 * CSRF protection, end to end: the API refuses state-changing requests without
 * the session's CSRF token, with a wrong one, or from a foreign origin, and the UI
 * copes when its token goes stale (signing in again in another tab replaces the
 * session cookie, so the first tab still holds the old session's token).
 */

import { ADMIN, baseUrl, NAMES, OPERATOR } from "./env.ts";
import { apiSignIn, ensureRoleUsers, expect, goTo, signIn, signOut, test } from "./fixtures.ts";

test("the API refuses state changes without a valid CSRF token or from another origin", async ({
  playwright,
}) => {
  const api = await playwright.request.newContext({ baseURL: baseUrl() });
  const csrf = await apiSignIn(api, ADMIN);
  const body = { name: "csrf probe", url: "csrf-probe" };

  const missing = await api.post("/api/storage", { data: body });
  expect(missing.status()).toBe(403);
  expect(await missing.json()).toMatchObject({ error: { code: "CONSOLE_CSRF" } });

  const wrong = await api.post("/api/storage", {
    data: body,
    headers: { "x-csrf-token": `${csrf.slice(0, -2)}xx` },
  });
  expect(wrong.status()).toBe(403);

  const foreign = await api.post("/api/storage", {
    data: body,
    headers: { "x-csrf-token": csrf, origin: "https://evil.example" },
  });
  expect(foreign.status()).toBe(403);

  // Reading needs no token, and nothing above was created.
  const storage = await api.get("/api/storage");
  expect(storage.status()).toBe(200);
  expect(await storage.text()).not.toContain("csrf probe");
  await api.dispose();
});

test("a tab whose CSRF token went stale recovers instead of failing", async ({
  page,
  context,
  pageProblems,
}) => {
  // Chromium logs the first, refused attempt; the client then refreshes its token.
  pageProblems.allow(/status of 403/);
  await signIn(page, ADMIN);
  await goTo(page, "/connections");

  // Signing out and in again in a second tab starts a new session (same cookie
  // jar); the first tab still holds the old session's token.
  const second = await context.newPage();
  await second.goto("/");
  await signOut(second);
  await signIn(second, ADMIN);
  await second.close();

  await page.getByRole("button", { name: `Test ${NAMES.scratch}` }).click();
  const report = page.getByRole("dialog", { name: `Connection test: ${NAMES.scratch}` });
  await expect(report.getByText("Connected")).toBeVisible();
  await report.getByRole("button", { name: "Close", exact: true }).click();
  expect(pageProblems.all.filter((problem) => problem.includes("403"))).toHaveLength(1);
});

test("a tab whose session now belongs to another user goes back to the login page", async ({
  page,
  context,
  pageProblems,
  playwright,
}) => {
  pageProblems.allow(/status of 403/);
  const admin = await playwright.request.newContext({ baseURL: baseUrl() });
  await ensureRoleUsers(admin);
  await admin.dispose();
  await signIn(page, ADMIN);
  await goTo(page, "/connections");

  const second = await context.newPage();
  await second.goto("/");
  await signOut(second);
  await signIn(second, OPERATOR);
  await second.close();

  // Retrying as the operator would act as someone the page does not show.
  await page.getByRole("button", { name: `Test ${NAMES.scratch}` }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Your session has expired. Sign in again.")).toBeVisible();
});
