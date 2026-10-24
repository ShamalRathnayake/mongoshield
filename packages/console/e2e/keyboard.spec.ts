/**
 * Keyboard-only use of the restore wizard: from the backup page to a finished
 * restore without the mouse. Every control is reached with Tab, changed with
 * the keyboard, and focus goes somewhere sensible when the wizard changes step
 * (a step that unmounts the focused button must not drop focus on <body>).
 */

import type { Locator, Page } from "@playwright/test";
import { ADMIN, NAMES, SEED } from "./env.ts";
import { expect, goTo, readableBackup, signIn, test, waitForJob, withMongo } from "./fixtures.ts";

/** Most Tab presses any control on the wizard page may need (the shell's links come first). */
const MAX_TABS = 60;

/** Presses Tab until `target` has focus; fails if it is never reached. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < MAX_TABS; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Not reachable with Tab within ${MAX_TABS} presses: ${target}`);
}

/** What has focus, for messages. */
async function focused(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return "body";
    return `${element.tagName.toLowerCase()} ${element.textContent?.trim().slice(0, 40) ?? ""}`;
  });
}

test("the restore wizard works with the keyboard alone", async ({ page }) => {
  await signIn(page, ADMIN);
  // The passphrase plan's backup: the console holds its key, so no key is typed.
  const { storageId, backupId } = await readableBackup(page.request);
  await goTo(page, `/backups/${storageId}/${backupId}`);

  // From the backup page to the wizard: the "Restore…" link, activated with Enter.
  await tabTo(page, page.getByRole("link", { name: "Restore…" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Restore", level: 1 })).toBeVisible();
  // Navigation moved focus to the new page's heading.
  await expect(page.getByRole("heading", { name: "Restore", level: 1 })).toBeFocused();

  // Unchecking and checking the namespace again with Space.
  const namespace = page.getByRole("checkbox", { name: `${SEED.database}.${SEED.orders}` });
  await tabTo(page, namespace);
  await page.keyboard.press("Space");
  await expect(namespace).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(namespace).toBeChecked();

  // Choosing the production connection by typing the start of its name.
  const target = page.getByLabel("Target connection");
  await tabTo(page, target);
  await page.keyboard.type("Prod");
  await expect(target.locator("option:checked")).toHaveText(`${NAMES.production} — PRODUCTION`);

  await tabTo(page, page.getByLabel("Rename rules (optional)"));
  await page.keyboard.type(`${SEED.database}.*=shop_keyboard.*`);
  await tabTo(page, page.getByRole("button", { name: "Review plan" }));
  await page.keyboard.press("Enter");

  // The review step replaced the form; focus must land on it, not on <body>.
  const planHeading = page.getByRole("heading", { name: /^Plan: / });
  await expect(planHeading).toBeVisible();
  await expect(planHeading, `focus is on ${await focused(page)}`).toBeFocused();

  const confirm = page.getByLabel(`Type ${NAMES.production} to confirm`);
  await tabTo(page, confirm);
  await page.keyboard.type(NAMES.production);
  const start = page.getByRole("button", { name: "Start restore" });
  await tabTo(page, start);
  await page.keyboard.press("Enter");

  expect(await waitForJob(page)).toBe("Succeeded");
  const restored = await withMongo((client) =>
    client.db("shop_keyboard").collection(SEED.orders).countDocuments(),
  );
  expect(restored).toBe(SEED.orderCount);
});

test("going back from the review step returns focus to the form", async ({ page }) => {
  await signIn(page, ADMIN);
  const { storageId, backupId } = await readableBackup(page.request);
  await goTo(page, `/backups/${storageId}/${backupId}/restore`);
  await page.getByLabel("Rename rules (optional)").fill(`${SEED.database}.*=shop_back.*`);
  await page.getByRole("button", { name: "Review plan" }).click();
  const back = page.getByRole("button", { name: "Back" });
  await tabTo(page, back);
  await page.keyboard.press("Enter");
  // The form is back, with what was typed, and focus is on its submit button.
  await expect(page.getByLabel("Rename rules (optional)")).toHaveValue(
    `${SEED.database}.*=shop_back.*`,
  );
  await expect(page.getByRole("button", { name: "Review plan" })).toBeFocused();
});
