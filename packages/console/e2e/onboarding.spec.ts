/**
 * The quick path, in the real built console against a real mongod: the welcome page
 * (paste a connection string, check it, confirm the defaults), the data browser with
 * the backup actions bar, "Back up now" into the "Local backups" location the console
 * created by itself, the recovery key download, "Check the backup", "Back up every
 * night", and "Restore a backup" into the restore wizard.
 *
 * It also counts the clicks: from the welcome page to a running backup it must take
 * at most two (one more, "Create account and continue", happens on the setup page
 * before it; see the journey), which is the number the docs promise.
 */

import { readFile } from "node:fs/promises";
import type { Locator } from "@playwright/test";
import { accessibilityProblems } from "./a11y.ts";
import { ADMIN, E2E_MONGO_PASSWORD, mongoUri } from "./env.ts";
import { expect, signIn, test } from "./fixtures.ts";

test("paste a connection string, browse it, back it up and restore it in a few clicks", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  let clicks = 0;
  /** A click that counts towards the "clicks to the first backup" budget. */
  const click = async (target: Locator) => {
    clicks += 1;
    await target.click();
  };

  const session: unknown = await (await page.request.get("/api/session")).json();
  const setupDoneHere = Reflect.get(Object(session), "setupComplete") !== true;
  if (Reflect.get(Object(session), "setupComplete") === true) {
    // After the journey: the admin exists and there are connections, so the welcome
    // page is opened directly.
    await signIn(page, ADMIN);
    await page.goto("/#/welcome");
  } else {
    // Run on its own (`--no-deps`): the zero-setup path for real. The console was
    // started moments ago, so its setup window is open and no token is needed.
    await page.goto("/");
    await expect(page.getByText("First come, first served")).toBeVisible();
    await expect(page.getByLabel(/Setup token/)).toHaveCount(0);
    await page.getByLabel("User name").fill(ADMIN.username);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await click(page.getByRole("button", { name: "Create account and continue" }));
  }
  await expect(
    page.getByRole("heading", { name: "Connect your database", level: 1 }),
  ).toBeVisible();
  expect(await accessibilityProblems(page, { shell: true }), "welcome page").toEqual([]);

  await test.step("paste the connection string: it is checked right away", async () => {
    // Exact: the Connect step's panel and the suggestion chips are named with it too.
    const field = page.getByLabel("Connection string", { exact: true });
    await field.focus();
    // A real paste event, as from the clipboard, wrapped in quotes like many copies are.
    await page.evaluate((text) => {
      const target = document.activeElement;
      if (!(target instanceof HTMLTextAreaElement)) throw new Error("No textarea focused");
      const data = new DataTransfer();
      data.setData("text/plain", text);
      // The page handles the paste itself (it cleans the text and masks the password).
      target.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, `"${mongoUri()}"`);
    // The password moved into the masked field: the string shows a placeholder.
    await expect(field).toHaveValue(/:<password>@/);
    await expect(page.getByText(/Connected$/)).toBeVisible();
    // A successful check opens the Details step by itself. A local test database: not
    // production by default, and the reason is shown.
    await expect(page.getByRole("tab", { name: /^Details/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.getByLabel("This is a production database", { exact: true }),
    ).not.toBeChecked();
    await expect(page.getByText(/runs on this computer or in Docker/)).toBeVisible();
    // The password is never shown: only the masked password field holds it.
    expect(await page.locator("body").innerText()).not.toContain(E2E_MONGO_PASSWORD);
    await page.getByLabel("Name", { exact: true }).fill("Quick start");
  });

  await test.step("save and land on the live data with the backup actions", async () => {
    await click(page.getByRole("button", { name: "Save and browse data" }));
    await expect(page.getByRole("heading", { name: "Backups of Quick start" })).toBeVisible();
    await expect(page.getByText(/Nothing is backed up yet/)).toBeVisible();
    // Once saved, the password is nowhere in the page any more.
    expect(await page.content()).not.toContain(E2E_MONGO_PASSWORD);
    expect(await accessibilityProblems(page, { shell: true }), "data page").toEqual([]);
  });

  await test.step("back up now: progress, then the recovery key, once", async () => {
    await click(page.getByRole("button", { name: "Back up now" }));
    // At most three clicks from the setup page to a running backup: create the account,
    // save the connection, back up now (the check runs on paste). Counted from the
    // welcome page when the journey did the setup.
    const fromSetup = setupDoneHere ? clicks : clicks + 1;
    expect(fromSetup).toBeLessThanOrEqual(3);
    test
      .info()
      .annotations.push({ type: "clicks to the first backup", description: String(fromSetup) });
    const dialog = page.getByRole("dialog", { name: "Save your recovery key" });
    await expect(dialog).toBeVisible({ timeout: 120_000 });
    const downloading = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download recovery key" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("mongoshield-recovery-key-Back-up-Quick-start.txt");
    const path = await download.path();
    expect(await readFile(path, "utf8")).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/m);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("Backed up", { exact: true })).toBeVisible();
    await expect(page.getByText("Encrypted", { exact: true })).toBeVisible();
    await expect(page.getByText("Save your recovery key")).toHaveCount(0);
  });

  await test.step("check the backup and make it nightly in one click each", async () => {
    await page.getByRole("button", { name: "Check the backup" }).click();
    await expect(page.getByText("Check: passed")).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Back up every night" }).click();
    await expect(page.getByText(/Backs up automatically \(0 2 \* \* \*/)).toBeVisible();
  });

  await test.step("restore a backup goes straight to the restore wizard", async () => {
    await page.getByRole("link", { name: "Restore a backup" }).click();
    await expect(page.getByRole("heading", { name: /^Restore/, level: 1 })).toBeVisible();
  });
});
