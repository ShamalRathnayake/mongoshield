/**
 * Restore wizard, the "What" and "Where" steps: the namespace picker grouped by
 * database (tri-state "whole database" checkboxes, search, select all / none, the fixed
 * selection for selected documents) and "Restore as" (original names, a copy, another
 * database of the target, custom rules) with its live preview, its one-click
 * suggestions and the rules it sends.
 *
 * The backup fixture has shop.{users,orders,products,carts} and
 * analytics.{daily_rollups,funnel_view}; the default target, Staging, has the
 * databases shop (users has 1,200 documents) and shop_restored (an empty users).
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp, requestsTo } from "../testing.tsx";
import {
  compactDate,
  customRuleSuggestions,
  databaseNameSuggestions,
  suffixSuggestions,
} from "./restore-as.tsx";
import { currentStep, newestBackupId, openStep, reviewPlan } from "./restore-wizard.testkit.tsx";

/** Opens the wizard as an operator, optionally with a query (selected documents). */
async function openWizard(query = "") {
  const rendered = renderApp({
    signedInAs: "maya",
    hash: `#/backups/st-s3/${newestBackupId()}/restore${query}`,
  });
  await screen.findByRole("heading", { name: "Restore" });
  return rendered;
}

/** Opens the wizard on its Where step (the "Restore as" choice). */
async function openWhere() {
  const rendered = await openWizard();
  await openStep(rendered.user, "Where");
  return rendered;
}

/** The "whole database" checkbox of one database. */
function wholeDatabase(database: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name: `${database} (whole database)` });
}

/** Keeps only the shop database chosen (on the What step), then opens Where again. */
async function chooseOnlyShop(user: ReturnType<typeof renderApp>["user"]) {
  await openStep(user, "What");
  await user.click(screen.getByRole("button", { name: "Select none" }));
  await user.click(wholeDatabase("shop"));
  await openStep(user, "Where");
}

/** The body of the dry-run request the wizard sent last. */
function lastPlanBody(backend: ReturnType<typeof renderApp>["backend"]): unknown {
  return requestsTo(backend, "POST", "/api/restore/plan").at(-1)?.body;
}

describe("restore wizard: what to restore", () => {
  it("groups namespaces by database with a tri-state whole-database checkbox", async () => {
    const { user } = await openWizard();
    const shop = screen.getByRole("group", { name: "shop" });
    expect(within(shop).getAllByRole("checkbox")).toHaveLength(5);
    expect(within(shop).getByText("4 of 4 collections selected")).toBeTruthy();
    expect(screen.getByText("6 of 6 collections selected")).toBeTruthy();
    // Document counts and types are shown with each collection.
    expect(within(shop).getByText("48,210 documents")).toBeTruthy();
    expect(screen.getByText("View")).toBeTruthy();
    expect(wholeDatabase("shop").checked).toBe(true);

    // Part of a database: the whole-database box becomes mixed.
    await user.click(screen.getByRole("checkbox", { name: "shop.users" }));
    expect(wholeDatabase("shop").checked).toBe(false);
    expect(wholeDatabase("shop").indeterminate).toBe(true);
    expect(wholeDatabase("shop").getAttribute("aria-checked")).toBe("mixed");
    expect(within(shop).getByText("3 of 4 collections selected")).toBeTruthy();

    // Mixed → all; all → none.
    await user.click(wholeDatabase("shop"));
    expect(wholeDatabase("shop").checked).toBe(true);
    expect(wholeDatabase("shop").indeterminate).toBe(false);
    expect(screen.getByRole("checkbox", { name: "shop.users" })).toHaveProperty("checked", true);
    await user.click(wholeDatabase("shop"));
    expect(screen.getByRole("checkbox", { name: "shop.orders" })).toHaveProperty("checked", false);
    expect(screen.getByText("2 of 6 collections selected")).toBeTruthy();

    // Keyboard: Space toggles the focused whole-database checkbox.
    wholeDatabase("analytics").focus();
    await user.keyboard(" ");
    expect(screen.getByText("0 of 6 collections selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("6 of 6 collections selected")).toBeTruthy();
  });

  it("searches databases and collections, and selects what is shown", async () => {
    const { user, backend } = await openWizard();
    const search = screen.getByLabelText("Find a database or collection");
    await user.type(search, "DAILY");
    expect(screen.queryByRole("group", { name: "shop" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "analytics.daily_rollups" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "analytics.funnel_view" })).toBeNull();

    // The buttons act on the search results only.
    await user.click(screen.getByRole("button", { name: "Select none (1 shown)" }));
    expect(screen.getByText("5 of 6 collections selected")).toBeTruthy();
    // The whole-database box still counts the hidden collection.
    expect(wholeDatabase("analytics").indeterminate).toBe(true);

    // A database name shows all its collections.
    await user.clear(search);
    await user.type(search, "shop");
    expect(screen.getAllByRole("checkbox", { name: /^shop\./ })).toHaveLength(4);
    await user.clear(search);
    await user.type(search, "nothing");
    expect(screen.getByText("No database or collection matches “nothing”.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select all (0 shown)" })).toHaveProperty(
      "disabled",
      true,
    );

    await user.clear(search);
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    expect(lastPlanBody(backend)).toMatchObject({
      include: [
        "shop.users",
        "shop.orders",
        "shop.products",
        "shop.carts",
        "analytics.funnel_view",
      ],
    });
  });

  it("shows the fixed namespace of selected documents with every control disabled", async () => {
    await openWizard("?ns=shop.users&ids=[1]");
    expect(screen.getByRole("checkbox", { name: "shop.users" })).toHaveProperty("checked", true);
    expect(screen.getByRole("checkbox", { name: "shop.users" })).toHaveProperty("disabled", true);
    expect(wholeDatabase("shop").indeterminate).toBe(true);
    expect(wholeDatabase("shop").disabled).toBe(true);
    expect(screen.getByLabelText("Find a database or collection")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Select all" })).toHaveProperty("disabled", true);
  });
});

describe("restore wizard: restore as", () => {
  it("previews original names and notes collections that already exist", async () => {
    await openWhere();
    expect(screen.getByRole("radio", { name: /Original names/ })).toHaveProperty("checked", true);
    const preview = screen.getByRole("list", { name: "Result in Staging" });
    // The note appears once the target's databases have loaded.
    await within(preview).findByText(/already exists \(1,200 documents\)/);
    const users = within(preview).getByText("shop.users", { selector: "span:first-child" });
    expect(users.closest("li")?.textContent).toBe(
      "shop.users →  restored as shop.users · already exists (1,200 documents)",
    );
    // One line per chosen collection (up to eight, then "…and N more").
    expect(within(preview).getAllByRole("listitem")).toHaveLength(6);
  });

  it("previews the first eight collections, then says how many more", async () => {
    const { user } = renderApp({
      signedInAs: "maya",
      hash: `#/backups/st-s3/${newestBackupId()}/restore`,
      prepare: (mock) => {
        const backup = mock.data.backups.find((candidate) => candidate.id === newestBackupId());
        const manifest = backup?.manifest as { namespaces: { ns: string }[] } | undefined;
        for (const name of ["leads", "deals", "notes", "tasks"]) {
          manifest?.namespaces.push({ ns: `crm.${name}` });
        }
      },
    });
    await screen.findByRole("heading", { name: "Restore" });
    await openStep(user, "Where");
    const preview = screen.getByRole("list", { name: "Result in Staging" });
    expect(within(preview).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByText("…and 2 more collections.")).toBeTruthy();
    expect(screen.getByText("10 of 10 collections selected")).toBeTruthy();
  });

  it("restores a copy with an editable suffix and previews the new names", async () => {
    const { user, backend } = await openWhere();
    await user.click(screen.getByRole("radio", { name: /A copy next to the original/ }));
    const preview = screen.getByRole("list", { name: "Result in Staging" });
    await within(preview).findByText(/already exists \(empty\)/);
    expect(preview.textContent).toContain("shop_restored.users · already exists (empty)");
    expect(preview.textContent).toContain("analytics_restored.daily_rollups");

    const suffix = screen.getByLabelText("Suffix");
    await user.clear(suffix);
    // The later steps stay closed: trying to go on shows the problem, focus on the field.
    await openStep(user, "Keys");
    expect(currentStep()).toBe("Where");
    expect(screen.getByText("Enter a suffix, e.g. _restored.")).toBeTruthy();
    expect(document.activeElement).toBe(suffix);
    // No preview while the rules are invalid.
    expect(screen.queryByRole("list", { name: "Result in Staging" })).toBeNull();

    await user.type(suffix, "_2026");
    expect(screen.getByRole("list", { name: "Result in Staging" }).textContent).toContain(
      "shop_2026.users",
    );
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    expect(lastPlanBody(backend)).toMatchObject({
      rename: { "shop.*": "shop_2026.*", "analytics.*": "analytics_2026.*" },
    });
    expect(lastPlanBody(backend)).not.toHaveProperty("include");
  });

  it("offers another database only for collections from one database", async () => {
    const { user } = await openWhere();
    const another = screen.getByRole("radio", { name: /Into another database/ });
    expect(another).toHaveProperty("disabled", true);
    expect(
      screen.getByText("Needs collections from one database; these come from 2."),
    ).toBeTruthy();

    await chooseOnlyShop(user);
    expect(another).toHaveProperty("disabled", false);
    await user.click(another);
    expect(screen.getByRole("combobox", { name: "Database in Staging" })).toBeTruthy();

    // Choosing more databases afterwards explains what to change.
    await openStep(user, "What");
    await user.click(wholeDatabase("analytics"));
    await openStep(user, "Where");
    expect(screen.getByText("Choose collections from one database")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Database in Staging" })).toBeNull();
  });

  it("restores into an existing database of the target", async () => {
    const { user, backend } = await openWhere();
    await chooseOnlyShop(user);
    await user.click(screen.getByRole("radio", { name: /Into another database/ }));
    const select = await screen.findByRole("combobox", { name: "Database in Staging" });
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    // The source database itself is not offered (that would be "Original names").
    expect(options).toEqual([
      "Choose a database…",
      "shop_restored (1 collection)",
      "New database…",
    ]);

    await user.click(screen.getByRole("button", { name: /Next: Keys/ }));
    expect(currentStep()).toBe("Where");
    expect(screen.getByText("Choose the database to restore into.")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/restore/plan")).toHaveLength(0);

    await user.selectOptions(select, "shop_restored");
    expect(screen.getByRole("list", { name: "Result in Staging" }).textContent).toContain(
      "shop_restored.orders",
    );
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    expect(lastPlanBody(backend)).toMatchObject({
      include: ["shop.users", "shop.orders", "shop.products", "shop.carts"],
      rename: { "shop.*": "shop_restored.*" },
    });
  });

  it("restores into a new database with a checked name", async () => {
    const { user, backend } = await openWhere();
    await chooseOnlyShop(user);
    await user.click(screen.getByRole("radio", { name: /Into another database/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Database in Staging" }),
      "New database…",
    );
    const name = screen.getByLabelText("New database name");
    await user.type(name, "shop recovered");
    // Enter in the field goes on like Next: here it stays and says why.
    await user.keyboard("{Enter}");
    expect(currentStep()).toBe("Where");
    expect(screen.getByText(/Database names cannot contain spaces/)).toBeTruthy();

    await user.clear(name);
    await user.type(name, "shop_recovered");
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    expect(lastPlanBody(backend)).toMatchObject({ rename: { "shop.*": "shop_recovered.*" } });
  });

  it("lists the databases of the connection chosen as target", async () => {
    const { user } = await openWhere();
    await chooseOnlyShop(user);
    await user.click(screen.getByRole("radio", { name: /Into another database/ }));
    await user.selectOptions(screen.getByLabelText("Target connection"), "conn-local");
    const select = await screen.findByRole("combobox", { name: "Database in Local dev" });
    expect(await within(select).findByRole("option", { name: "test (1 collection)" })).toBeTruthy();
    expect(within(select).queryByRole("option", { name: /shop_restored/ })).toBeNull();
  });

  it("still offers a new database when the target's databases cannot be listed", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: `#/backups/st-s3/${newestBackupId()}/restore`,
      failures: [
        { method: "GET", path: /\/namespaces$/, status: 502, message: "Staging is down." },
      ],
    });
    await screen.findByRole("heading", { name: "Restore" });
    await chooseOnlyShop(user);
    await user.click(screen.getByRole("radio", { name: /Into another database/ }));
    expect(
      await screen.findByText(/Could not list the databases of Staging: Staging is down\./),
    ).toBeTruthy();
    const select = screen.getByRole("combobox", { name: "Database in Staging" });
    expect(within(select).getAllByRole("option")).toHaveLength(2);
  });

  it("starts custom rules from the previous choice", async () => {
    const { user, backend } = await openWhere();
    await user.click(screen.getByRole("radio", { name: /A copy next to the original/ }));
    await user.click(screen.getByRole("radio", { name: /Custom rules/ }));
    const rules = screen.getByLabelText("Rename rules");
    expect((rules as HTMLTextAreaElement).value).toBe(
      "shop.*=shop_restored.*\nanalytics.*=analytics_restored.*",
    );
    await user.clear(rules);
    await user.type(rules, "shop.users=shop.users_old");
    expect(screen.getByRole("list", { name: "Result in Staging" }).textContent).toContain(
      "shop.users_old",
    );
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    expect(lastPlanBody(backend)).toMatchObject({ rename: { "shop.users": "shop.users_old" } });

    // Going back keeps the typed rules (switching choices loses nothing).
    await openStep(user, "Where");
    await user.click(screen.getByRole("radio", { name: /Original names/ }));
    await user.click(screen.getByRole("radio", { name: /Custom rules/ }));
    expect((screen.getByLabelText("Rename rules") as HTMLTextAreaElement).value).toBe(
      "shop.users=shop.users_old",
    );
  });
});

describe("restore wizard: fill suggestions", () => {
  it("derive names from the source database and the backup's date", () => {
    expect(compactDate("2026-10-24T23:30:00.000Z")).toBe("20261024");
    expect(compactDate("not a date")).toBeUndefined();
    expect(compactDate(undefined)).toBeUndefined();
    expect(suffixSuggestions("2026-10-24T02:00:00Z")).toEqual([
      "_restored",
      "_copy",
      "_20261024",
      "_before_fix",
    ]);
    expect(suffixSuggestions(undefined)).toContain(undefined);
    expect(databaseNameSuggestions("shop", "2026-10-24T02:00:00Z")).toEqual([
      "shop_restored",
      "shop_20261024",
      "shop_copy",
    ]);
    expect(databaseNameSuggestions(undefined, undefined)).toEqual([]);
    expect(customRuleSuggestions(["shop", "crm"], "shop.*=shop_restored.*\n")).toEqual([
      "crm.*=crm_restored.*",
    ]);
  });

  it("fill the suffix with one click, the backup's date included", async () => {
    const { user, backend } = await openWhere();
    await user.click(screen.getByRole("radio", { name: /A copy next to the original/ }));
    const chips = screen.getByRole("group", { name: "Suggestions for Suffix" });
    // The default suffix is the chosen chip.
    expect(
      within(chips).getByRole("button", { name: "_restored" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const startedAt = backend.data.backups.find(
      (backup) => backup.id === newestBackupId(),
    )?.startedAt;
    const day = compactDate(startedAt) ?? "";
    await user.click(within(chips).getByRole("button", { name: `_${day}` }));
    expect((screen.getByLabelText("Suffix") as HTMLInputElement).value).toBe(`_${day}`);
    expect(screen.getByRole("list", { name: "Result in Staging" }).textContent).toContain(
      `shop_${day}.users`,
    );
    await user.click(within(chips).getByRole("button", { name: "_before_fix" }));
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    expect(lastPlanBody(backend)).toMatchObject({
      rename: { "shop.*": "shop_before_fix.*", "analytics.*": "analytics_before_fix.*" },
    });
  });

  it("fill a new database's name from the source database", async () => {
    const { user, backend } = await openWhere();
    await chooseOnlyShop(user);
    await user.click(screen.getByRole("radio", { name: /Into another database/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Database in Staging" }),
      "New database…",
    );
    const chips = screen.getByRole("group", { name: "Suggestions for New database name" });
    await user.click(within(chips).getByRole("button", { name: "shop_copy" }));
    expect((screen.getByLabelText("New database name") as HTMLInputElement).value).toBe(
      "shop_copy",
    );
    expect(
      within(chips).getByRole("button", { name: "shop_copy" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    expect(lastPlanBody(backend)).toMatchObject({ rename: { "shop.*": "shop_copy.*" } });
  });

  it("add a rule line per chosen database to the custom rules", async () => {
    const { user } = await openWhere();
    await user.click(screen.getByRole("radio", { name: /Custom rules/ }));
    const rules = screen.getByLabelText("Rename rules") as HTMLTextAreaElement;
    await user.type(rules, "shop.users=shop.users_old");
    const chips = screen.getByRole("group", { name: "Suggestions for Rename rules" });
    await user.click(
      within(chips).getByRole("button", { name: "analytics.*=analytics_restored.*" }),
    );
    // Added on its own line, after what was typed; the chip goes once its line is there.
    expect(rules.value).toBe("shop.users=shop.users_old\nanalytics.*=analytics_restored.*");
    expect(within(chips).queryByRole("button", { name: /^analytics/ })).toBeNull();
    await user.clear(rules);
    await user.click(
      within(screen.getByRole("group", { name: "Suggestions for Rename rules" })).getByRole(
        "button",
        { name: "shop.*=shop_restored.*" },
      ),
    );
    expect(rules.value).toBe("shop.*=shop_restored.*");
  });

  it("are not offered for the typed production confirmation", async () => {
    const rendered = renderApp({
      signedInAs: "admin",
      hash: `#/backups/st-s3/${newestBackupId()}/restore`,
    });
    const { user } = rendered;
    await screen.findByRole("heading", { name: "Restore" });
    await openStep(user, "Where");
    await user.selectOptions(screen.getByLabelText("Target connection"), "conn-prod");
    await user.click(screen.getByRole("radio", { name: /A copy next to the original/ }));
    await reviewPlan(user);
    await user.click(await screen.findByRole("button", { name: "Skip preview" }));
    expect(screen.getByLabelText("Type Production cluster to confirm")).toBeTruthy();
    // The only suggestion row on the page is the (hidden) Suffix one of the Where step.
    expect(screen.queryAllByRole("group", { name: /^Suggestions for Type/ })).toHaveLength(0);
    expect(
      screen
        .queryAllByRole("group", { name: /^Suggestions for/, hidden: true })
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Suggestions for Suffix"]);
  });
});
