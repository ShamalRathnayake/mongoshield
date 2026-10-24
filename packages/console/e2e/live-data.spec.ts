/**
 * Live data, end to end in the built console against the real mongod:
 *
 *   an admin turns on "Allow live edits" for the scratch connection (and is stopped
 *   from doing the same for production without the typed name and a reason) → an
 *   editor with the data:write permission browses databases → collections → documents
 *   → edits a document, reviews the field diff and saves it (checked in MongoDB) →
 *   edits another one that someone changes meanwhile and gets the conflict, nothing
 *   written → undoes the first edit from the Edit history (checked in MongoDB).
 *
 * The data lives in its own database (`livee2e`), so the other specs are not affected.
 */

import type { Page } from "@playwright/test";
import { accessibilityProblems } from "./a11y.ts";
import { ADMIN, baseUrl, NAMES } from "./env.ts";
import { apiSignIn, expect, goTo, idByName, signIn, signOut, test, withMongo } from "./fixtures.ts";

/** The user who edits (an operator with data:write). */
const EDITOR = { username: "edith", password: "editor password for e2e" } as const;
const DATABASE = "livee2e";
const COLLECTION = "people";

/** The seeded documents. */
const PEOPLE = [
  { _id: 1, name: "Ada", email: "ada@example.com" },
  { _id: 2, name: "Grace", email: "grace@example.com" },
  { _id: 3, name: "Edsger", email: "edsger@example.com" },
];

let scratchId = "";
let productionId = "";

test.beforeAll(async ({ playwright }) => {
  await withMongo(async (client) => {
    const people = client.db(DATABASE).collection<{ _id: number; name?: string }>(COLLECTION);
    await people.deleteMany({});
    await people.insertMany(PEOPLE);
  });
  // The editor account, created through the API (the Users page has its own tests).
  const admin = await playwright.request.newContext({ baseURL: baseUrl() });
  const csrf = await apiSignIn(admin, ADMIN);
  const created = await admin.post("/api/users", {
    headers: { "x-csrf-token": csrf },
    data: { ...EDITOR, role: "operator", permissions: ["data:write"] },
  });
  expect([200, 409], await created.text()).toContain(created.status());
  scratchId = await idByName(admin, "/api/connections", NAMES.scratch);
  productionId = await idByName(admin, "/api/connections", NAMES.production);
  await admin.dispose();
});

/** The name stored in MongoDB for one seeded person. */
async function storedName(id: number): Promise<unknown> {
  return withMongo(async (client) => {
    const person = await client
      .db(DATABASE)
      .collection<{ _id: number; name?: string }>(COLLECTION)
      .findOne({ _id: id });
    return person?.name;
  });
}

/** Opens the editor of one document and replaces its text with `edit(current)`. */
async function openEditor(
  page: Page,
  id: number,
  edit: (current: Record<string, unknown>) => Record<string, unknown>,
) {
  await page.getByRole("button", { name: `Edit document ${id}` }).click();
  const dialog = page.getByRole("dialog", { name: "Edit document" });
  const editor = dialog.getByLabel("Document (Extended JSON)");
  const current = JSON.parse(await editor.inputValue());
  await editor.fill(JSON.stringify(edit(current), null, 2));
  return dialog;
}

test("an admin turns on live edits; production needs the typed name and a reason", async ({
  page,
}) => {
  await signIn(page, ADMIN);
  await goTo(page, `/connections/${productionId}`);
  await page.getByLabel("Allow live edits").check();
  await page.getByRole("button", { name: "Save live edit settings" }).click();
  // Refused: neither the name nor a reason was given (the UI or the server says so).
  await expect(page.getByText(/type (its|the connection's) name|reason/i).first()).toBeVisible();

  // …and nothing was saved.
  const production: unknown = await (await page.request.get("/api/connections")).json();
  const saved = Array.isArray(production)
    ? production.find((item: unknown) => Reflect.get(Object(item), "id") === productionId)
    : undefined;
  expect(Reflect.get(Object(saved), "liveEdits")).toMatchObject({ enabled: false });

  await goTo(page, `/connections/${scratchId}`);
  await page.getByLabel("Allow live edits").check();
  await page.getByLabel("Reason").fill("e2e: fixing test data");
  await page.getByRole("button", { name: "Save live edit settings" }).click();
  await expect(page.getByText(/live edits are (on|allowed|enabled)/i).first()).toBeVisible();
  await signOut(page);
});

test("browse → edit with a diff review → conflict → undo from the edit history", async ({
  page,
  pageProblems,
}) => {
  // The conflict is a 409 on purpose; the browser logs failed requests as console errors.
  pageProblems.allow(/409/);
  await signIn(page, EDITOR);

  await test.step("browse databases, collections and documents", async () => {
    await goTo(page, `/connections/${scratchId}`);
    await page.getByRole("link", { name: "Browse live data" }).click();
    await expect(page.locator("#main h1")).toContainText(/live data/i);
    // Find the collection in the navigation tree by name, then open it.
    await page.getByLabel("Find a collection").fill(COLLECTION);
    await page.getByRole("treeitem", { name: new RegExp(`^${COLLECTION}`) }).click();
    await expect(page.getByText("ada@example.com")).toBeVisible();
    expect(await accessibilityProblems(page, { shell: true }), "live data page").toEqual([]);
    // Each document's edit buttons are in the tree view.
    await page.locator(".view-option", { hasText: "Tree" }).click();
    await expect(page.getByRole("button", { name: "Edit document 1" })).toBeVisible();
  });

  await test.step("edit a document: review the diff, save, and find it in MongoDB", async () => {
    const dialog = await openEditor(page, 1, (current) => ({ ...current, name: "Ada Lovelace" }));
    await dialog.getByRole("button", { name: "Review changes" }).click();
    await expect(dialog.getByText("name").first()).toBeVisible();
    await expect(dialog.getByText("Ada Lovelace").first()).toBeVisible();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => storedName(1)).toBe("Ada Lovelace");
  });

  await test.step("a document changed by someone else is not overwritten", async () => {
    const dialog = await openEditor(page, 2, (current) => ({ ...current, name: "Grace Hopper" }));
    // Meanwhile, another client changes the same document.
    await withMongo((client) =>
      client
        .db(DATABASE)
        .collection<{ _id: number; name?: string }>(COLLECTION)
        .updateOne({ _id: 2 }, { $set: { name: "Rear Admiral" } }),
    );
    await dialog.getByRole("button", { name: "Review changes" }).click();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/changed after you loaded it/).first()).toBeVisible();
    expect(await storedName(2)).toBe("Rear Admiral");
    await page.getByRole("button", { name: "Reload document" }).click();
    await expect(page.getByText("Rear Admiral").first()).toBeVisible();
  });

  await test.step("undo the first edit from the edit history", async () => {
    await page.getByRole("link", { name: "Edit history", exact: true }).click();
    await expect(page.locator("#main h1")).toContainText(/edit history/i);
    expect(await accessibilityProblems(page, { shell: true }), "edit history page").toEqual([]);
    await page.getByRole("button", { name: `Undo edit of 1 in ${DATABASE}.${COLLECTION}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Undo edit" }).click();
    await expect.poll(() => storedName(1)).toBe("Ada");
    // The undo is an entry of its own, so it could be undone (redone) as well.
    await expect(page.getByRole("cell", { name: /undo/i }).first()).toBeVisible();
  });
});
