/**
 * Keyboard-only use of the restore wizard: from the backup page to a finished
 * restore without the mouse, step by step (What → Where → Keys → Review → Preview →
 * Confirm) and through the preview down to one document. Every control is reached
 * with Tab, changed with the keyboard, and focus goes somewhere sensible when the
 * wizard changes step or opens a detail (a step that unmounts the focused button must
 * not drop focus on <body>): a step's heading, or the panel of a step without one.
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

  // On to the Where step; it has no heading, so its panel takes focus.
  await tabTo(page, page.getByRole("button", { name: "Next: Where" }));
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("tabpanel", { name: /^Where/ }),
    `focus is on ${await focused(page)}`,
  ).toBeFocused();

  // Choosing the production connection by typing the start of its name.
  const target = page.getByLabel("Target connection", { exact: true });
  await tabTo(page, target);
  await page.keyboard.type("Prod");
  await expect(target.locator("option:checked")).toHaveText(`${NAMES.production} — PRODUCTION`);

  // "Restore as": a copy next to the original, chosen with Space, suffix typed.
  await tabTo(page, page.getByRole("radio", { name: "Original names" }));
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "A copy next to the original" })).toBeChecked();
  await tabTo(page, page.getByLabel("Suffix", { exact: true }));
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("_keyboard");

  // On to Keys (the console holds this backup's key: nothing to type), then the plan.
  await tabTo(page, page.getByRole("button", { name: "Next: Keys" }));
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("tabpanel", { name: /^Keys/ }),
    `focus is on ${await focused(page)}`,
  ).toBeFocused();
  await tabTo(page, page.getByRole("button", { name: "Review plan" }));
  await page.keyboard.press("Enter");

  // The review step replaced the form; focus must land on it, not on <body>.
  const planHeading = page.getByRole("heading", { name: /^Plan: / });
  await expect(planHeading).toBeVisible();
  await expect(planHeading, `focus is on ${await focused(page)}`).toBeFocused();

  // The Preview step opens on what it does, with its heading focused.
  await tabTo(page, page.getByRole("button", { name: "Next: Preview" }));
  await page.keyboard.press("Enter");
  const previewHeading = page.getByRole("heading", { name: /^Preview: / });
  await expect(previewHeading, `focus is on ${await focused(page)}`).toBeFocused();

  // The preview: its heading, then one namespace, then one document, each focused.
  await tabTo(page, page.getByRole("button", { name: "Preview changes" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("table", { name: "Changes per namespace" })).toBeVisible();
  await expect(previewHeading, `focus is on ${await focused(page)}`).toBeFocused();
  const orders = `${SEED.database}.${SEED.orders}`;
  await tabTo(page, page.getByRole("button", { name: `Documents of ${orders}` }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: `Documents of ${orders}` })).toBeFocused();
  // The renamed targets do not exist yet: every document is only in the backup.
  const firstId = page
    .getByRole("list", { name: "Only in the backup: ids" })
    .getByRole("button")
    .first();
  await tabTo(page, firstId);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /^Document _id / })).toBeFocused();
  await tabTo(page, page.getByRole("button", { name: "Next: Confirm" }));
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Confirm restore into production" }),
    `focus is on ${await focused(page)}`,
  ).toBeFocused();

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

test("going back from the review step focuses the step before it and keeps the plan", async ({
  page,
}) => {
  await signIn(page, ADMIN);
  const { storageId, backupId } = await readableBackup(page.request);
  await goTo(page, `/backups/${storageId}/${backupId}/restore`);
  // Where: custom rename rules.
  await page.getByRole("tab", { name: /^Where/ }).click();
  await page.getByRole("radio", { name: "Custom rules (advanced)" }).check();
  await page.getByLabel("Rename rules", { exact: true }).fill(`${SEED.database}.*=shop_back.*`);
  // Keys → the plan.
  await page.getByRole("tab", { name: /^Keys/ }).click();
  await page.getByRole("button", { name: "Review plan" }).click();
  await expect(page.getByRole("heading", { name: /^Plan: / })).toBeVisible();
  const back = page.getByRole("button", { name: "Back" });
  await tabTo(page, back);
  await page.keyboard.press("Enter");
  // Back on Keys, with its panel focused; the plan is kept, so Next goes to it again.
  await expect(
    page.getByRole("tabpanel", { name: /^Keys/ }),
    `focus is on ${await focused(page)}`,
  ).toBeFocused();
  await expect(page.getByRole("button", { name: "Next: Review" })).toBeVisible();
  // And what was typed in Where is still there.
  await page.getByRole("tab", { name: /^Where/ }).click();
  await expect(page.getByLabel("Rename rules", { exact: true })).toHaveValue(
    `${SEED.database}.*=shop_back.*`,
  );
});
