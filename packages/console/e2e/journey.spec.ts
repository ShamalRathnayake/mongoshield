/**
 * The main user journey, start to finish, in one browser session against the
 * real console and a real mongod:
 *
 *   first-run setup with the link from the server log → sign out and in → add a
 *   production connection (its secret is never shown again) and a scratch one →
 *   test them → add local storage and test it → create a plan with the namespace
 *   picker, age-recipient encryption and a schedule preview → run it now and watch
 *   the job live → the backup appears, verified → browse documents (filter, paging)
 *   of a passphrase-encrypted backup → restore the selected documents into renamed
 *   collections and check them in MongoDB → restore the whole recipient-encrypted
 *   backup into the production connection (typed name, private key) → drill into
 *   the scratch connection → hold and release → scoped retention → the audit log shows
 *   each action → sign out.
 *
 * Later specs (project "features") rely on what this one creates; see NAMES.
 */

import type { Page } from "@playwright/test";
import { generateIdentity } from "mongoshield";
import { ADMIN, E2E_MONGO_PASSWORD, mongoUri, NAMES, SEED } from "./env.ts";
import {
  expect,
  goTo,
  setupLinkFromServerLog,
  signIn,
  signOut,
  test,
  waitForJob,
  withMongo,
} from "./fixtures.ts";

/** A key pair for the recipient-encrypted plan; the private key is only used to restore. */
const KEY = generateIdentity();
/** The passphrase of the second plan, which the console stores and can therefore read with. */
const PASSPHRASE = "a passphrase the console keeps";
const PASSPHRASE_PLAN = "Shop passphrase";

test("an admin sets up the console, backs up, browses, restores and audits", async ({
  page,
  pageProblems,
}) => {
  test.setTimeout(10 * 60_000);
  let recipientBackupId = "";
  let passphraseBackupId = "";

  await test.step("first-run setup with the link from the server log", async () => {
    const link = await setupLinkFromServerLog();
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Set up MongoShield" })).toBeVisible();
    // The token comes from the link; the operator only chooses a password.
    await expect(page.getByLabel("Setup token")).not.toHaveValue("");
    await page.getByLabel("Admin username").fill(ADMIN.username);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByLabel("Repeat password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Create admin and sign in" }).click();
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    // The single-use token is removed from the address bar and history.
    expect(page.url()).not.toContain("token=");
  });

  await test.step("sign out and sign in again", async () => {
    await signOut(page);
    await signIn(page, ADMIN);
    await expect(page.getByText(`${ADMIN.username} (admin)`)).toBeVisible();
  });

  await test.step("add the production connection; its secret is never shown again", async () => {
    await goTo(page, "/connections");
    await addConnection(page, NAMES.production, true);
    const row = page.getByRole("row", { name: new RegExp(NAMES.production) });
    await expect(row.getByText("Production", { exact: true })).toBeVisible();
    await expect(row.getByText(/\*\*\*/)).toBeVisible();

    // Not in the page, not in the edit dialog, not in any API response.
    expect(await page.content()).not.toContain(E2E_MONGO_PASSWORD);
    await page.getByRole("button", { name: `Edit ${NAMES.production}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Connection string")).toHaveValue("");
    await expect(dialog.getByText(/Stored: .*\*\*\*/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    const listed = await page.request.get("/api/connections");
    expect(await listed.text()).not.toContain(E2E_MONGO_PASSWORD);
  });

  await test.step("add a scratch connection and test it from the list", async () => {
    await addConnection(page, NAMES.scratch, false);
    await page.getByRole("button", { name: `Test ${NAMES.scratch}` }).click();
    const report = page.getByRole("dialog", { name: `Connection test: ${NAMES.scratch}` });
    await expect(report.getByText("Connected")).toBeVisible();
    await report.getByRole("button", { name: "Close", exact: true }).click();
  });

  await test.step("add local storage and test it", async () => {
    await goTo(page, "/storage");
    await page.getByRole("button", { name: "Add storage" }).click();
    const dialog = page.getByRole("dialog", { name: "Add storage" });
    await dialog.getByLabel("Name").fill(NAMES.storage);
    await dialog.getByLabel("Location").fill(NAMES.storagePath);
    await dialog.getByRole("button", { name: /Add/ }).last().click();
    const report = page.getByRole("dialog", { name: `Storage test: ${NAMES.storage}` });
    await expect(report.getByText("Write, read and delete work")).toBeVisible();
    await report.getByRole("button", { name: "Close", exact: true }).click();
    // Testing again from the list works the same way.
    await page.getByRole("button", { name: `Test ${NAMES.storage}` }).click();
    await expect(report.getByText("Write, read and delete work")).toBeVisible();
    await report.getByRole("button", { name: "Close", exact: true }).click();
  });

  await test.step("create a plan: namespace picker, recipient encryption, schedule preview", async () => {
    await goTo(page, "/plans");
    await page.getByRole("link", { name: "New plan" }).click();
    const form = page.getByRole("form", { name: "Backup plan" });
    await form.getByLabel("Name").fill(NAMES.plan);
    await form.getByLabel("Connection").selectOption({ label: `${NAMES.production} (production)` });
    await form.getByLabel("Storage").selectOption({ label: NAMES.storage });

    // The picker previews what the patterns select in the live database.
    await form.getByLabel("Include").fill(`${SEED.database}.*`);
    await form.getByLabel("Exclude").fill("");
    const preview = page.getByRole("complementary", { name: "Selection preview" });
    const ordersRow = preview.getByRole("row", { name: new RegExp(SEED.orders) });
    await expect(ordersRow.getByText("Included")).toBeVisible();
    const contactsRow = preview.getByRole("row", { name: /contacts/ });
    await expect(contactsRow.getByText("Excluded")).toBeVisible();

    await form
      .getByLabel("Encryption")
      .selectOption({ label: "Public keys (age recipients) — recommended" });
    await form.getByLabel("Recipients").fill(KEY.recipient);

    await form.getByLabel("Cron expression").fill("30 1 * * *");
    await form.getByLabel("Time zone").fill("UTC");
    await expect(form.getByText("Every day at 01:30")).toBeVisible();
    await expect(
      form.getByRole("list").filter({ hasText: "01:30" }).getByRole("listitem"),
    ).toHaveCount(5);

    // Keep one backup so the prune dry run later has something to show.
    await form.getByLabel("Last N").fill("1");
    for (const bucket of ["Daily", "Weekly", "Monthly"]) await form.getByLabel(bucket).fill("");

    await form.getByRole("button", { name: "Create plan" }).click();
    await expect(page.getByRole("heading", { name: "Backup plans", level: 1 })).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(NAMES.plan) })).toBeVisible();
  });

  await test.step("run the plan now and watch the job live", async () => {
    await page.getByRole("button", { name: `Run now ${NAMES.plan}` }).click();
    await expect(page.getByRole("heading", { name: "Backup job", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Progress" })).toBeVisible();
    expect(await waitForJob(page)).toBe("Succeeded");
    // Progress arrived over the live event stream and shows the finished totals.
    const progress = page.getByRole("progressbar", { name: "Documents" });
    await expect(progress).toHaveAttribute("value", String(SEED.orderCount + SEED.customerCount));
    await expect(page.getByText(/128 of ~128/)).toBeVisible();
    await expect(page.getByText(/verified \(fast\)/)).toBeVisible();
    // Each namespace with its own final count (a small collection used to be lost
    // between two throttled progress events, and its documents counted to another).
    const namespaces = page.locator(".panel", { hasText: "Namespaces" }).getByRole("listitem");
    await expect(namespaces).toHaveCount(2);
    await expect(namespaces.filter({ hasText: `${SEED.database}.${SEED.orders}` })).toContainText(
      `Done${SEED.database}.${SEED.orders}${SEED.orderCount} documents`,
    );
    await expect(
      namespaces.filter({ hasText: `${SEED.database}.${SEED.customers}` }),
    ).toContainText(`${SEED.customerCount} documents`);
    recipientBackupId = await backupIdOnJobPage(page);
  });

  await test.step("the backup appears in the catalog, verified", async () => {
    await page.getByRole("link", { name: "Backups", exact: true }).click();
    const row = page.getByRole("row", { name: new RegExp(recipientBackupId) });
    await expect(row.getByText("Verified (fast)")).toBeVisible();
    await row.getByRole("link", { name: recipientBackupId }).click();
    await expect(page.getByRole("heading", { name: recipientBackupId, level: 1 })).toBeVisible();
    await page.getByRole("tab", { name: "Verification & drills" }).click();
    const verification = page.locator(".panel", { hasText: "Latest verification" });
    await expect(verification.getByText("Verified", { exact: true })).toBeVisible();
    await expect(verification.getByText("fast", { exact: true })).toBeVisible();
  });

  await test.step("a backup encrypted to a public key cannot be browsed without its key", async () => {
    // The console only holds the public key, so reading documents fails, and says why.
    pageProblems.allow(/Failed to load resource: the server responded with a status of 4\d\d/);
    await page.getByRole("tab", { name: "Browse documents" }).click();
    await expect(page.getByText("Could not read documents")).toBeVisible();
    await expect(page.getByText(/Encrypted backups can only be browsed/)).toBeVisible();
  });

  await test.step("a second plan with passphrase encryption backs up shop.orders", async () => {
    await goTo(page, "/plans/new");
    const form = page.getByRole("form", { name: "Backup plan" });
    await form.getByLabel("Name").fill(PASSPHRASE_PLAN);
    await form.getByLabel("Include").fill(`${SEED.database}.${SEED.orders}`);
    await form.getByLabel("Exclude").fill("");
    await form.getByLabel("Encryption").selectOption({ label: "Passphrase" });
    await form.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
    await form.getByLabel("Run on a schedule").uncheck();
    await form.getByRole("button", { name: "Create plan" }).click();
    await page.getByRole("button", { name: `Run now ${PASSPHRASE_PLAN}` }).click();
    expect(await waitForJob(page)).toBe("Succeeded");
    passphraseBackupId = await backupIdOnJobPage(page);
    // The passphrase never reaches the browser again.
    expect(await (await page.request.get("/api/plans")).text()).not.toContain(PASSPHRASE);
  });

  await test.step("browse its documents with a filter and paging", async () => {
    await openBackup(page, passphraseBackupId, "Browse documents");
    await page
      .getByLabel("Namespace")
      .selectOption({ label: `${SEED.database}.${SEED.orders} (${SEED.orderCount})` });
    const firstPage = page.getByRole("list", { name: "Documents on page 1" });
    await expect(firstPage.getByRole("listitem")).toHaveCount(20);
    await page.getByRole("button", { name: "Next page" }).click();
    const secondPage = page.getByRole("list", { name: "Documents on page 2" });
    await expect(secondPage.getByRole("listitem")).toHaveCount(20);
    await page.getByRole("button", { name: "Previous page" }).click();
    await expect(firstPage.getByRole("listitem")).toHaveCount(20);

    // One in three orders is open: 40 documents, two pages of 20.
    await page.getByLabel("Filter (Extended JSON)").fill('{"status": "open"}');
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(page.getByText(/· filtered/)).toBeVisible();
    await expect(firstPage.getByRole("listitem")).toHaveCount(20);
    await expect(firstPage.getByRole("listitem").first()).toContainText("open");
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(secondPage.getByRole("listitem")).toHaveCount(20);
    await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
    await page.getByRole("button", { name: "Previous page" }).click();
  });

  await test.step("restore two selected documents into renamed collections", async () => {
    const firstPage = page.getByRole("list", { name: "Documents on page 1" });
    const selectedIds: number[] = [];
    for (const index of [0, 1]) {
      const choice = firstPage.getByRole("listitem").nth(index).locator(".document-select");
      selectedIds.push(Number(await choice.textContent()));
      await choice.getByRole("checkbox").check();
    }
    await page.getByRole("button", { name: "Restore selected (2)" }).click();

    await expect(page.getByRole("heading", { name: "Restore", level: 1 })).toBeVisible();
    await expect(page.getByText("Restoring 2 selected documents")).toBeVisible();
    // A non-production connection is preselected.
    await expect(page.getByLabel("Target connection")).toHaveValue(
      await connectionId(page, NAMES.scratch),
    );
    await page.getByLabel("Rename rules (optional)").fill(`${SEED.database}.*=shop_selected.*`);
    await page.getByRole("button", { name: "Review plan" }).click();
    await expect(
      page.getByText(`Plan: 1 namespace, 2 documents into ${NAMES.scratch}`),
    ).toBeVisible();
    await page.getByRole("button", { name: "Start restore" }).click();
    expect(await waitForJob(page)).toBe("Succeeded");

    const restored = await withMongo((client) =>
      client.db("shop_selected").collection(SEED.orders).find().sort({ _id: 1 }).toArray(),
    );
    // Exactly the selected documents, with their backed-up contents.
    expect(restored.map((document) => document._id)).toEqual(selectedIds.sort((a, b) => a - b));
    for (const document of restored) {
      expect(document).toMatchObject({
        sku: `SKU-${String(document._id).padStart(4, "0")}`,
        status: "open",
      });
    }
  });

  await test.step("restore the whole recipient-encrypted backup into production", async () => {
    await openBackup(page, recipientBackupId);
    await page.getByRole("link", { name: "Restore…" }).click();
    await page
      .getByLabel("Target connection")
      .selectOption({ label: `${NAMES.production} — PRODUCTION` });
    await expect(page.getByText("This is a production connection")).toBeVisible();
    await page.getByLabel("Rename rules (optional)").fill(`${SEED.database}.*=shop_full.*`);
    await page.getByLabel("Private key (optional)").fill(KEY.identity);
    await page.getByRole("button", { name: "Review plan" }).click();
    await expect(
      page.getByText(
        `Plan: 2 namespaces, ${SEED.orderCount + SEED.customerCount} documents into ${NAMES.production}`,
      ),
    ).toBeVisible();

    // Production needs its name typed exactly.
    const start = page.getByRole("button", { name: "Start restore" });
    await expect(start).toBeDisabled();
    const confirm = page.getByLabel(`Type ${NAMES.production} to confirm`);
    await confirm.fill("production shop");
    await expect(page.getByText("The name does not match.")).toBeVisible();
    await expect(start).toBeDisabled();
    await confirm.fill(NAMES.production);
    await expect(start).toBeEnabled();
    await start.click();
    expect(await waitForJob(page)).toBe("Succeeded");
    expect(await page.content()).not.toContain(KEY.identity);

    const counts = await withMongo(async (client) => ({
      orders: await client.db("shop_full").collection(SEED.orders).countDocuments(),
      customers: await client.db("shop_full").collection(SEED.customers).countDocuments(),
    }));
    expect(counts).toEqual({ orders: SEED.orderCount, customers: SEED.customerCount });
  });

  await test.step("drill the passphrase backup into the non-production connection", async () => {
    await openBackup(page, passphraseBackupId);
    await page.getByRole("button", { name: "Drill…" }).click();
    const dialog = page.getByRole("dialog", { name: "Restore drill" });
    // Production connections are never offered as drill targets.
    const options = dialog.getByLabel("Target connection").getByRole("option");
    await expect(options).toHaveText([NAMES.scratch]);
    await dialog.getByRole("button", { name: "Start drill" }).click();
    expect(await waitForJob(page)).toBe("Succeeded");

    await openBackup(page, passphraseBackupId, "Verification & drills");
    const drills = page.getByRole("table", { name: "Restore drills of this backup" });
    await expect(drills.getByText("Succeeded")).toBeVisible();
  });

  await test.step("put the backup on hold and release it", async () => {
    await page.getByRole("button", { name: "Hold…" }).click();
    const hold = page.getByRole("dialog", { name: "Put backup on hold" });
    await hold.getByLabel("Reason").fill("Legal hold: ticket SEC-1234");
    await hold.getByRole("button", { name: "Hold backup" }).click();
    await expect(page.getByText(/Legal hold: ticket SEC-1234 — held since/)).toBeVisible();

    await page.getByRole("button", { name: "Release hold…" }).click();
    const release = page.getByRole("dialog", { name: "Release hold" });
    await release.getByRole("button", { name: "Release hold" }).click();
    await expect(page.getByText(/held since/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Hold…" })).toBeVisible();
  });

  await test.step("retention after a run: prunes only the plan's own backups", async () => {
    // A second run of the plan that keeps only the newest backup. Another plan
    // writes to the same storage; the run's automatic prune must delete this plan's
    // older backup and never the other plan's (before scoped retention it deleted both).
    await goTo(page, "/plans");
    await page.getByRole("button", { name: `Run now ${NAMES.plan}` }).click();
    expect(await waitForJob(page)).toBe("Succeeded");
    await goTo(page, "/backups");
    await expect(page.getByRole("row", { name: new RegExp(passphraseBackupId) })).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(recipientBackupId) })).toHaveCount(0);

    // The dry run covers the plan's own backups only and says what it leaves alone.
    await page.getByRole("button", { name: "Apply retention…" }).click();
    const dialog = page.getByRole("dialog", { name: "Apply retention" });
    await dialog.getByLabel("Retention of plan").selectOption({ label: `${NAMES.plan} (last 1)` });
    await expect(dialog.getByText(/Nothing to prune/)).toBeVisible();
    await expect(dialog.getByText(/1 other backup in this storage/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("row", { name: new RegExp(passphraseBackupId) })).toBeVisible();
  });

  await test.step("the audit log shows each action", async () => {
    await goTo(page, "/audit");
    const log = page.getByRole("table", { name: "Audit log entries" });
    for (const action of [
      "setup.complete",
      "session.logout",
      "session.login",
      "connection.create",
      "connection.test",
      "storage.create",
      "storage.test",
      "plan.create",
      "plan.run",
      "backup.browse",
      "restore.start",
      "backup.drill",
      "backup.hold",
      "backup.release",
    ]) {
      await expect(log.getByText(action, { exact: true }).first(), action).toBeVisible();
    }
    // Filtering narrows the table to one kind of action.
    await page.getByLabel("Action or target").fill("restore.start");
    await expect(log.getByRole("row")).toHaveCount(3);
  });

  await test.step("sign out", async () => {
    await signOut(page);
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect((await page.request.get("/api/connections")).status()).toBe(401);
  });
});

/** The id of the backup a finished backup job wrote (the link in its details). */
async function backupIdOnJobPage(page: Page): Promise<string> {
  const link = page.getByRole("link", { name: /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_/ });
  const id = await link.textContent();
  if (id === null || id === "") throw new Error("The job page links no backup.");
  return id;
}

/** Opens a backup of the journey's storage location, optionally on one tab. */
async function openBackup(page: Page, backupId: string, tab?: string): Promise<void> {
  await goTo(page, "/backups");
  await page.getByRole("link", { name: backupId }).click();
  await expect(page.getByRole("heading", { name: backupId, level: 1 })).toBeVisible();
  if (tab !== undefined) await page.getByRole("tab", { name: tab }).click();
}

/** A connection's id, read from the API with the page's session. */
async function connectionId(page: Page, name: string): Promise<string> {
  const connections: unknown = await (await page.request.get("/api/connections")).json();
  if (!Array.isArray(connections)) throw new Error("GET /api/connections did not return a list.");
  for (const connection of connections) {
    if (Reflect.get(connection, "name") === name) return String(Reflect.get(connection, "id"));
  }
  throw new Error(`No connection named ${name}.`);
}

/** Adds a connection to the test mongod through the dialog and closes the automatic test. */
async function addConnection(page: Page, name: string, production: boolean): Promise<void> {
  await page.getByRole("button", { name: "Add connection" }).click();
  const dialog = page.getByRole("dialog", { name: "Add connection" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Connection string").fill(mongoUri());
  if (production) await dialog.getByLabel("This is a production deployment").check();
  await dialog.getByRole("button", { name: "Add and test" }).click();
  // Saving runs a connection test right away.
  const report = page.getByRole("dialog", { name: `Connection test: ${name}` });
  await expect(report.getByText("Connected")).toBeVisible();
  await report.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();
}
