/**
 * The `test` every spec uses, plus helpers the specs share.
 *
 * `test` extends Playwright's with:
 *
 *   baseURL       the console started by global-setup.ts, so `page.goto("/#/plans")` works
 *   pageProblems  (automatic) collects console errors, uncaught page errors and Content
 *                 Security Policy violations for the whole test and fails it if any
 *                 occurred that the test did not expect (`pageProblems.allow(/403/)`)
 *
 * CSP violations are caught twice on purpose: Chromium logs them as console errors,
 * and an init script forwards the DOM's `securitypolicyviolation` event (which also
 * fires for violations that are only reported, never logged).
 *
 * Helpers: signing in through the UI or the API, reading the setup link from the
 * server log, opening a page by its hash route, and a MongoDB client for checking
 * what a restore wrote.
 */

import { readFile } from "node:fs/promises";
import { type APIRequestContext, test as base, expect, type Page } from "@playwright/test";
import { MongoClient } from "mongodb";
import { ADMIN, baseUrl, mongoUri, NAMES, OPERATOR, SEED, serverLog, VIEWER } from "./env.ts";

/** What went wrong in the browser during a test. */
export interface PageProblems {
  /** Lets messages matching `pattern` through (an error the test provokes on purpose). */
  allow(pattern: RegExp): void;
  /** Everything collected so far, allowed or not. */
  readonly all: readonly string[];
}

/** Playwright's `test` with the console's fixtures. */
export const test = base.extend<{ pageProblems: PageProblems }>({
  baseURL: async ({ baseURL: _configured }, use) => {
    await use(baseUrl());
  },
  pageProblems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      const allowed: RegExp[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(`console error: ${message.text()}`);
      });
      page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
      await page.exposeFunction("__e2eReportCspViolation", (description: string) => {
        problems.push(`CSP violation: ${description}`);
      });
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          const report = Reflect.get(window, "__e2eReportCspViolation");
          if (typeof report === "function") {
            report(`${event.violatedDirective} blocked ${event.blockedURI || "inline code"}`);
          }
        });
      });

      await use({
        allow: (pattern) => {
          allowed.push(pattern);
        },
        get all() {
          return problems;
        },
      });

      const unexpected = problems.filter(
        (problem) => !allowed.some((pattern) => pattern.test(problem)),
      );
      expect(unexpected, "console errors or CSP violations on the page").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Opens a hash route, e.g. `goTo(page, "/plans")`, and waits for its heading. */
export async function goTo(page: Page, route: string): Promise<void> {
  await page.goto(`/#${route}`);
  await expect(page.locator("#main h1")).toBeVisible();
}

/** Signs in through the login page. */
export async function signIn(
  page: Page,
  user: { readonly username: string; readonly password: string },
): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

/** Signs out through the top bar and waits for the login page. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
}

/**
 * Signs in through the API (cookie stored in `request`) and returns the CSRF
 * token, for calls the UI would never make: the role tests prove that the API
 * itself refuses what the UI hides.
 */
export async function apiSignIn(
  request: APIRequestContext,
  user: { readonly username: string; readonly password: string },
): Promise<string> {
  const response = await request.post("/api/session", {
    data: { username: user.username, password: user.password },
  });
  expect(response.status(), await response.text()).toBe(200);
  const session: unknown = await response.json();
  const token =
    typeof session === "object" && session !== null ? Reflect.get(session, "csrfToken") : undefined;
  if (typeof token !== "string") throw new Error("The session response has no CSRF token.");
  return token;
}

/** The one-time setup link the console printed on its first start. */
export async function setupLinkFromServerLog(): Promise<string> {
  const log = await readFile(serverLog(), "utf8");
  const link = /https?:\/\/\S+\/setup\?token=[\w-]+/.exec(log)?.[0];
  if (link === undefined) throw new Error(`No setup link in the server log:\n${log}`);
  return link;
}

/** Runs `work` with a client connected to the test mongod (closed afterwards). */
export async function withMongo<Result>(
  work: (client: MongoClient) => Promise<Result>,
): Promise<Result> {
  const client = new MongoClient(mongoUri());
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.close();
  }
}

/**
 * Waits on a job's page until it has finished, and returns its final status
 * label ("Succeeded", "Failed", "Cancelled"). The badge is updated live from the
 * job's event stream, so this also proves the stream works.
 */
export async function waitForJob(page: Page): Promise<string> {
  const header = page.locator(".page-header").first();
  const finished = header.getByText(/^(Succeeded|Failed|Cancelled)$/);
  await expect(finished).toBeVisible({ timeout: 90_000 });
  return (await finished.textContent()) ?? "";
}

/**
 * Creates the operator and viewer test users (see env.ts) unless they exist.
 * Several specs need them and Playwright may run any subset of the specs.
 */
export async function ensureRoleUsers(request: APIRequestContext): Promise<void> {
  const csrf = await apiSignIn(request, ADMIN);
  for (const [user, role] of [
    [OPERATOR, "operator"],
    [VIEWER, "viewer"],
  ] as const) {
    const created = await request.post("/api/users", {
      headers: { "x-csrf-token": csrf },
      data: { username: user.username, password: user.password, role },
    });
    // 409: created by an earlier spec of this run.
    expect([200, 409], await created.text()).toContain(created.status());
  }
}

/** The id of the record named `name` in a list endpoint such as /api/connections. */
export async function idByName(request: APIRequestContext, path: string, name: string) {
  const list: unknown = await (await request.get(path)).json();
  const match = Array.isArray(list)
    ? list.find((item: unknown) => Reflect.get(Object(item), "name") === name)
    : undefined;
  const id = Reflect.get(Object(match), "id");
  if (typeof id !== "string") throw new Error(`${path} has no record named ${name}.`);
  return id;
}

/**
 * The journey's storage location and the backup of its passphrase plan, the one
 * the console can read (it holds the passphrase). That plan backs up shop.orders
 * only, which is how it is told apart from the recipient-encrypted plan's backups.
 */
export async function readableBackup(
  request: APIRequestContext,
): Promise<{ readonly storageId: string; readonly backupId: string }> {
  const storageId = await idByName(request, "/api/storage", NAMES.storage);
  const backups: unknown = await (await request.get(`/api/storage/${storageId}/backups`)).json();
  const match = Array.isArray(backups)
    ? backups.find((item: unknown) => Reflect.get(Object(item), "documents") === SEED.orderCount)
    : undefined;
  const backupId = Reflect.get(Object(match), "id");
  if (typeof backupId !== "string") throw new Error("The passphrase plan's backup is missing.");
  return { storageId, backupId };
}
