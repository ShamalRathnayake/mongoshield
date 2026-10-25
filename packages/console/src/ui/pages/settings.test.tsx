/**
 * Page tests for the settings page: theme, account, config export, and the config
 * import flow (input checks, the plan name suggestions or the detected plan list, dry
 * run, apply, server errors, non-admins).
 */

import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";
import { importShape, parseImportInput } from "./settings.tsx";

/** jsdom has no Blob URLs and cannot follow `<a download>` clicks, so both are faked. */
beforeEach(() => {
  Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Pastes text into a field (typing would treat `{` and `[` as key descriptors). */
async function paste(user: UserEvent, label: string, text: string): Promise<void> {
  await user.click(await screen.findByLabelText(label));
  await user.paste(text);
}

const NEW_CONFIG = JSON.stringify({
  source: { uri: "mongodb://reports.internal:27017" },
  storage: "s3://reports-backups/",
  retention: { last: 5 },
  heartbeat: "https://hc-ping.com/abc",
});

describe("settings", () => {
  it("shows the account and changes the theme", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: "#/settings" });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    // The account panel (the sidebar shows the role too).
    expect(within(screen.getByRole("main")).getByText("operator")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Theme"), "dark");
    expect((screen.getByLabelText("Theme") as HTMLSelectElement).value).toBe("dark");
    await user.selectOptions(screen.getByLabelText("Theme"), "system");
  });

  it("exports the configuration for admins", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/settings" });
    await user.click(await screen.findByRole("button", { name: "Download mongoshield.config.ts" }));
    expect(await screen.findByText("Downloaded mongoshield.config.ts.")).toBeTruthy();
    expect(screen.getAllByText(/defineConfig/).length).toBeGreaterThan(0);
  });

  it("tells viewers that export and import are for admins", async () => {
    renderApp({ signedInAs: "sam", hash: "#/settings" });
    expect(await screen.findByText("Only admins can export the configuration.")).toBeTruthy();
    expect(screen.getByText("Only admins can import a configuration.")).toBeTruthy();
    expect(screen.queryByLabelText("Configuration (JSON)")).toBeNull();
  });
});

describe("config import", () => {
  it("checks the JSON before sending anything", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/settings" });
    await user.click(await screen.findByRole("button", { name: "Preview changes" }));
    expect(screen.getByText("Paste the configuration as JSON.")).toBeTruthy();

    await paste(user, "Configuration (JSON)", "{ not json");
    await paste(user, "Secrets (JSON, optional)", "[1]");
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(screen.getByText(/This is not valid JSON/)).toBeTruthy();
    expect(screen.getByText(/Use an object of plan names/)).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/config/import")).toHaveLength(0);
  });

  it("previews the changes, then applies exactly that request", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/settings" });
    await paste(user, "Configuration (JSON)", NEW_CONFIG);
    await user.type(screen.getByLabelText("Plan name"), "Reports");
    await paste(user, "Secrets (JSON, optional)", '{"Reports": {"passphrase": "unused here"}}');
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    const table = await screen.findByRole("table", { name: "Changes the import would make" });
    expect(within(table).getByText("s3://reports-backups/")).toBeTruthy();
    expect(within(table).getByText("reports.internal:27017")).toBeTruthy();
    expect(within(table).getByText("Reports")).toBeTruthy();
    expect(screen.getByText(/heartbeat is not managed by the console/)).toBeTruthy();
    // Nothing was created by the dry run.
    expect(backend.data.plans.some((plan) => plan.name === "Reports")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Apply import" }));
    expect(await screen.findByText("Imported the configuration: 3 change(s).")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Changes the import made" })).toBeTruthy();
    expect(backend.data.plans.some((plan) => plan.name === "Reports")).toBe(true);

    const [dryRun, apply] = requestsTo(backend, "POST", "/api/config/import");
    expect(dryRun?.body).toMatchObject({ dryRun: true, planName: "Reports" });
    expect(apply?.body).toEqual({ ...(dryRun?.body as object), dryRun: false });
  });

  it("shows field changes of an existing plan and discards the preview on edit", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/settings" });
    const document = {
      "Staging hourly": {
        source: {},
        storage: "s3://acme-offsite/weekly/",
        compression: "none",
        backup: { include: ["shop.orders"] },
        retention: { last: 48 },
        schedule: { cron: "15 * * * *" },
      },
    };
    await paste(user, "Configuration (JSON)", JSON.stringify(document));
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    const table = await screen.findByRole("table", { name: "Changes the import would make" });
    expect(within(table).getByText("update")).toBeTruthy();
    expect(within(table).getByText(/"gzip" → "none"/)).toBeTruthy();
    expect(within(table).getByText(/\{"last":24\} → \{"last":48\}/)).toBeTruthy();

    // Several plans keyed by name: no plan name is asked; the plans found are listed.
    expect(screen.queryByLabelText("Plan name")).toBeNull();
    const plans = screen.getByRole("list", { name: "Plans in the configuration" });
    expect(plans.textContent).toBe("Staging hourly (updates the existing plan)");
    await paste(user, "Secrets (JSON, optional)", "{}");
    expect(screen.queryByRole("table", { name: "Changes the import would make" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();
  });

  it("suggests the existing plans as the plan name and says what the import will do", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/settings" });
    await paste(user, "Configuration (JSON)", NEW_CONFIG);
    const name = screen.getByRole("combobox", { name: "Plan name" });
    expect(screen.getByText(/Pick an existing plan to update it, or type a new name/)).toBeTruthy();
    // Down opens the list of every existing plan; Enter picks the highlighted (first) one.
    await user.click(name);
    await user.keyboard("{ArrowDown}");
    const list = await screen.findByRole("listbox", { name: "Existing plans" });
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    await user.keyboard("{Enter}");
    expect(name).toHaveProperty("value", "Nightly production");
    expect(screen.getByText('Updates the existing plan "Nightly production".')).toBeTruthy();
    await user.clear(name);
    await user.type(name, "Reports");
    expect(screen.getByText('Creates a new plan "Reports".')).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByRole("table", { name: "Changes the import would make" });
    expect(requestsTo(backend, "POST", "/api/config/import")[0]?.body).toMatchObject({
      planName: "Reports",
    });
  });

  it("does not send a plan name for a configuration of several plans", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/settings" });
    await user.type(await screen.findByRole("combobox", { name: "Plan name" }), "Ignored");
    const document = { Reports: JSON.parse(NEW_CONFIG) as object, Archive: { storage: "/b" } };
    await paste(user, "Configuration (JSON)", JSON.stringify(document));
    expect(screen.getByRole("list", { name: "Plans in the configuration" }).textContent).toBe(
      "Reports (new plan)Archive (new plan)",
    );
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByText("Could not import");
    expect(requestsTo(backend, "POST", "/api/config/import")[0]?.body).not.toHaveProperty(
      "planName",
    );
  });

  it("explains a refused document", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/settings" });
    await paste(
      user,
      "Configuration (JSON)",
      JSON.stringify({ source: { uri: "mongodb://app:hunter2@db:27017" }, storage: "/data/b" }),
    );
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(await screen.findByText("Could not import")).toBeTruthy();
    expect(screen.getByText(/source.uri contains a password/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();
  });
});

describe("importShape", () => {
  it("tells one config from several keyed by plan name", () => {
    expect(importShape('{"storage": "/b"}')).toEqual({ kind: "single" });
    expect(importShape('{" Nightly ": {"storage": "/a"}, "Hourly": {}}')).toEqual({
      kind: "several",
      planNames: ["Nightly", "Hourly"],
    });
  });

  it("is unknown for empty text, invalid JSON and other shapes", () => {
    for (const text of ["", "  ", "{ not json", "[1]", "{}", '{"a": 1}', "null"]) {
      expect(importShape(text), text).toEqual({ kind: "unknown" });
    }
  });
});

describe("parseImportInput", () => {
  it("accepts a document without secrets", () => {
    expect(parseImportInput('{"storage": "/b"}', "  ")).toEqual({
      ok: true,
      document: { storage: "/b" },
      secrets: undefined,
    });
  });

  it("reports only the field that is wrong", () => {
    expect(parseImportInput('{"storage": "/b"}', "null")).toEqual({
      ok: false,
      secretsError: expect.stringMatching(/object of plan names/),
    });
    expect(parseImportInput("", '{"a": {}}')).toEqual({
      ok: false,
      documentError: "Paste the configuration as JSON.",
    });
  });
});
