/**
 * Browsing records, end to end in the built console against the real mongod: a seeded
 * collection with every common BSON type is opened from the navigation tree and read in
 * every view mode (table, tree, JSON, cards, schema, chart), with quick filters, header
 * sorting, the detail panel, an export (checked as a downloaded file), the keyboard and
 * the accessibility check on each view, in both themes.
 *
 * The data lives in its own database (`browsee2e`), so the other specs are not affected.
 */

import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { Binary, Decimal128, Long, ObjectId, Timestamp } from "mongodb";
import { accessibilityProblems } from "./a11y.ts";
import { ADMIN, NAMES } from "./env.ts";
import { expect, goTo, idByName, signIn, test, withMongo } from "./fixtures.ts";

const DATABASE = "browsee2e";
const COLLECTION = "products";
/** How many products are seeded. */
const COUNT = 30;

let scratchId = "";

test.beforeAll(async () => {
  await withMongo(async (client) => {
    const db = client.db(DATABASE);
    await db.dropDatabase();
    await db.collection(COLLECTION).insertMany(
      Array.from({ length: COUNT }, (_unused, index) => ({
        _id: new ObjectId(),
        name: `Product ${String(index + 1).padStart(2, "0")}`,
        status: index % 3 === 0 ? "draft" : "live",
        price: Decimal128.fromString(`${index + 9}.99`),
        stock: (index * 7) % 50,
        views: Long.fromString("9007199254740993"),
        active: index % 4 !== 0,
        retiredAt: null,
        createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
        tags: index % 2 === 0 ? ["sale", "new"] : [],
        dimensions: { width: 10 + index, unit: "cm" },
        externalId: new Binary(Buffer.alloc(16, index), Binary.SUBTYPE_UUID),
        lastSync: new Timestamp({ t: 1_700_000_000 + index, i: 1 }),
      })),
    );
    // A capped collection, to show its own icon and label in the tree.
    await db.createCollection("events", { capped: true, size: 64 * 1024 });
  });
});

/** Opens the data browser of the scratch connection on the seeded collection. */
async function openProducts(page: Page): Promise<void> {
  if (scratchId === "") scratchId = await idByName(page.request, "/api/connections", NAMES.scratch);
  await goTo(page, `/connections/${scratchId}/data`);
  // Through the tree, as a person would: find the collection by name, open it.
  await page.getByLabel("Find a collection").fill(COLLECTION);
  await page.getByRole("treeitem", { name: new RegExp(`^${COLLECTION}`) }).click();
  await expect(page.getByRole("heading", { name: `${DATABASE}.${COLLECTION}` })).toBeVisible();
}

/** Chooses a view in the "View as" switch. */
async function view(page: Page, name: string): Promise<void> {
  await page.locator(".view-option", { hasText: name }).click();
  await expect(page.getByRole("radio", { name })).toBeChecked();
}

/** The accessibility smoke check of the current state, as part of the test's assertions. */
async function accessible(page: Page, what: string): Promise<void> {
  expect(await accessibilityProblems(page, { shell: true }), what).toEqual([]);
}

test("a seeded collection in every view: table, tree, JSON, cards, schema and chart", async ({
  page,
}) => {
  await signIn(page, ADMIN);
  await openProducts(page);

  await test.step("table: flattened columns, typed cells, server-side sorting", async () => {
    const table = page.getByRole("table", { name: "Documents" });
    await expect(table.locator("tbody tr[data-index]")).toHaveCount(20);
    await expect(table.getByRole("columnheader", { name: "dimensions.width" })).toBeVisible();
    await expect(table.getByText("9.99 D").first()).toBeVisible();
    await expect(table.getByText("9007199254740993 L").first()).toBeVisible();
    // ObjectIds carry their creation time as a tooltip.
    await expect(table.locator(".bson-id").first()).toHaveAttribute(
      "title",
      /^ObjectId · created /,
    );
    await page.getByRole("button", { name: "Sort by stock" }).click();
    await page.getByRole("button", { name: /^Sort by stock, sorted ascending/ }).click();
    await expect(page.getByLabel("Sort", { exact: true })).toHaveValue('{"stock":-1}');
    await expect(table.locator("tbody tr[data-index]").first()).toContainText("49");
    await accessible(page, "table view");
  });

  await test.step("a quick filter from a cell, shown as a chip and removed again", async () => {
    await page.getByRole("table", { name: "Documents" }).getByText("draft").first().click();
    await page.getByRole("menuitem", { name: 'Show documents where status is "draft"' }).click();
    await expect(page.getByText("Showing 1–10 of 10 documents · filtered")).toBeVisible();
    await page.getByRole("button", { name: "Remove the condition on status" }).click();
    await expect(page.getByText(/^Showing 1–20 of about 30 documents$/)).toBeVisible();
  });

  await test.step("the detail panel steps through the page", async () => {
    await page
      .getByRole("button", { name: /^Open document/ })
      .first()
      .click();
    const detail = page.getByRole("dialog");
    await expect(detail.getByText(/\(1 of 20\)/)).toBeVisible();
    await detail.getByRole("button", { name: /^Next/ }).click();
    await expect(detail.getByText(/\(2 of 20\)/)).toBeVisible();
    await expect(detail.getByText("UUID").first()).toBeVisible();
    await accessible(page, "detail panel");
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
  });

  await test.step("tree: types, expand all, keyboard", async () => {
    await view(page, "Tree");
    const first = page.getByRole("tree", { name: /^Document / }).first();
    await expect(first.getByText("Decimal128", { exact: true })).toBeVisible();
    // The type badge (the value itself also reads "Timestamp(…)").
    await expect(first.getByText("Timestamp", { exact: true })).toBeVisible();
    const dimensions = first.getByRole("treeitem", { name: /^dimensions/ });
    await dimensions.focus();
    await page.keyboard.press("ArrowRight");
    await expect(dimensions).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(dimensions).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Expand all" }).first().click();
    await expect(first.getByText("unit")).toBeVisible();
    await accessible(page, "tree view");
  });

  await test.step("JSON: relaxed, then canonical from the server", async () => {
    await view(page, "JSON");
    await expect(page.getByText('"$numberDecimal"').first()).toBeVisible();
    await page.getByLabel("Canonical", { exact: true }).check();
    await expect(page.getByText('"$numberInt"').first()).toBeVisible();
    await accessible(page, "JSON view");
  });

  await test.step("cards with a readable title", async () => {
    await view(page, "Cards");
    await expect(page.getByRole("listitem").filter({ hasText: "Product" }).first()).toBeVisible();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("name");
    await accessible(page, "cards view");
  });

  await test.step("schema of a random sample, and a filter from a value", async () => {
    await view(page, "Schema");
    const fields = page.getByRole("table", { name: "Fields of the sample" });
    await expect(page.getByText(/in a random sample of 30 documents/)).toBeVisible();
    await expect(fields.getByRole("row", { name: /^price/ })).toContainText("Decimal128 100%");
    await expect(fields.getByRole("row", { name: /^createdAt/ })).toContainText("Date 100%");
    await accessible(page, "schema view");
    await fields.getByRole("button", { name: /^live/ }).click();
    await expect(page.getByText(/· filtered/)).toBeVisible();
    await page.getByRole("button", { name: "Reset" }).click();
  });

  await test.step("chart of a field, filtering from a bar", async () => {
    await view(page, "Chart");
    await page.getByLabel("Field", { exact: true }).selectOption("status");
    await expect(page.getByRole("heading", { name: /Documents by status/ })).toBeVisible();
    await accessible(page, "chart view");
    await page.getByRole("button", { name: /^status draft: 10/ }).click();
    await expect(page.getByText(/· filtered/)).toBeVisible();
  });

  await test.step("the capped collection is marked in the tree", async () => {
    await page.getByLabel("Find a collection").fill("events");
    await expect(page.getByRole("treeitem", { name: /^events/ })).toContainText("capped");
  });
});

test("the chosen view is remembered, and the result exports as a file", async ({ page }) => {
  await signIn(page, ADMIN);
  await openProducts(page);
  await view(page, "Cards");
  await page.reload();
  await expect(page.getByRole("radio", { name: "Cards" })).toBeChecked();

  await page.getByLabel("Filter (Extended JSON)").fill('{"status": "draft"}');
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText(/· filtered/)).toBeVisible();
  await page.getByRole("button", { name: "Export" }).click();
  const dialog = page.getByRole("dialog", { name: "Export the result" });
  await dialog.getByLabel("Format").selectOption("jsonl");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${DATABASE}.${COLLECTION}.jsonl`);
  const lines = (await readFile(await file.path(), "utf8")).trim().split("\n");
  expect(lines).toHaveLength(10);
  expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ status: "draft" });
  await expect(
    page.getByText(`Downloaded ${DATABASE}.${COLLECTION}.jsonl: 10 documents.`),
  ).toBeVisible();
});

test("the browser reads well in the dark theme too", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page, ADMIN);
  await openProducts(page);
  for (const name of ["Table", "Tree", "JSON", "Cards", "Schema", "Chart"]) {
    await view(page, name);
    await accessible(page, `${name} view, dark`);
  }
});

test("view switch, rows and the detail panel work with the keyboard alone", async ({ page }) => {
  await signIn(page, ADMIN);
  await openProducts(page);
  // The view switch is a radio group: arrow keys move between the views.
  await page.getByRole("radio", { name: "Table" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Tree" })).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("radio", { name: "Table" })).toBeChecked();
  // Rows: one Tab stop, arrows move, Enter opens the document, Escape returns.
  const rows = page.getByRole("table", { name: "Documents" }).locator("tbody tr[data-index]");
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog").getByText(/\(2 of 20\)/)).toBeVisible();
  await page.keyboard.press("]");
  await expect(page.getByRole("dialog").getByText(/\(3 of 20\)/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rows.nth(1)).toBeFocused();
});
