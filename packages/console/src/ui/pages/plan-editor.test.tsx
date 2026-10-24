/**
 * Page tests for the plan editor: validation messages, the live selection and schedule
 * previews, and the request sent on save.
 */

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";
import { emptyPlanForm, planToForm, validatePlanForm } from "./plan-editor.tsx";

const RECIPIENT = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

describe("validatePlanForm", () => {
  it("reports every problem at once, keyed by field", () => {
    const result = validatePlanForm({
      ...emptyPlanForm(),
      include: "shop",
      cron: "0 25 * * *",
      timezone: "Nowhere/Land",
      retention: { last: "-1", daily: "7", weekly: "", monthly: "x", yearly: "" },
      notify: [{ type: "slack", url: "http://insecure" }],
    });
    expect(result.input).toBeUndefined();
    expect(Object.keys(result.errors ?? {}).sort()).toEqual(
      [
        "connectionId",
        "cron",
        "include",
        "name",
        "notify.0",
        "recipients",
        "retention.last",
        "retention.monthly",
        "storageId",
        "timezone",
      ].sort(),
    );
  });

  it("omits an empty passphrase on edit so the stored one is kept", () => {
    const result = validatePlanForm({
      ...emptyPlanForm(),
      name: "x",
      connectionId: "c",
      storageId: "s",
      encryptionKind: "passphrase",
      passphraseStored: true,
      scheduled: false,
    });
    expect(result.input?.encryption).toEqual({ kind: "passphrase" });
    expect(result.input?.schedule).toBeUndefined();
  });
});

describe("incremental backups in the plan form", () => {
  const valid = {
    ...emptyPlanForm(),
    name: "x",
    connectionId: "c",
    storageId: "s",
    encryptionKind: "none" as const,
  };

  it("sends incremental: { fullEveryDays } only when the box is ticked", () => {
    expect(validatePlanForm(valid).input?.incremental).toBeUndefined();
    const ticked = validatePlanForm({ ...valid, incremental: true, fullEveryDays: "0.5" });
    expect(ticked.input?.incremental).toEqual({ fullEveryDays: 0.5 });
  });

  it.each(["", "0", "-1", "400", "weekly"])("refuses a full-backup interval of %j", (days) => {
    const result = validatePlanForm({ ...valid, incremental: true, fullEveryDays: days });
    expect(result.errors?.fullEveryDays).toMatch(/number of days/);
  });

  it("round-trips an incremental plan through the form", () => {
    const form = planToForm({
      id: "p",
      name: "x",
      connectionId: "c",
      storageId: "s",
      include: [],
      exclude: [],
      compression: "zstd",
      encryption: { kind: "none" },
      consistency: "auto",
      verify: "fast",
      notify: [],
      incremental: { fullEveryDays: 7 },
    });
    expect(form).toMatchObject({ incremental: true, fullEveryDays: "7" });
  });

  it("shows the interval field once the box is ticked", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    expect(screen.queryByLabelText("Full backup every (days)")).toBeNull();
    await user.click(screen.getByLabelText("Incremental backups between full ones"));
    expect((screen.getByLabelText("Full backup every (days)") as HTMLInputElement).value).toBe("7");
  });
});

describe("plan editor page", () => {
  it("shows validation errors, live previews, and saves a valid plan", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });

    await user.click(screen.getByRole("button", { name: "Create plan" }));
    expect(screen.getByText("Give the plan a name.")).toBeTruthy();
    expect(screen.getByText("Add at least one age recipient (age1…).")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/plans")).toHaveLength(0);

    await user.type(screen.getByLabelText("Include"), "shop");
    expect(screen.getByText(/add a "\." between database and collection/)).toBeTruthy();
    await user.type(screen.getByLabelText("Include"), ".*");

    // With include shop.* and the default exclude *.sessions: 5 of the 8 collections.
    expect(await screen.findByText(/of 8 collections selected/)).toBeTruthy();
    expect(screen.getByText("5", { selector: "strong" })).toBeTruthy();

    await user.clear(screen.getByLabelText("Cron expression"));
    await user.type(screen.getByLabelText("Cron expression"), "0 25 * * *");
    expect(screen.getByText(/The hour field has "25", outside 0–23/)).toBeTruthy();
    await user.clear(screen.getByLabelText("Cron expression"));
    await user.type(screen.getByLabelText("Cron expression"), "30 3 * * 1");
    await user.clear(screen.getByLabelText("Time zone"));
    await user.type(screen.getByLabelText("Time zone"), "UTC");
    expect(screen.getByText("Every Monday at 03:30")).toBeTruthy();
    expect(screen.getByText("Next runs:").nextElementSibling?.children).toHaveLength(5);

    await user.type(screen.getByLabelText("Name"), "Weekly shop");
    await user.type(screen.getByLabelText("Recipients"), RECIPIENT);
    await user.click(screen.getByRole("button", { name: "Create plan" }));

    expect(await screen.findByRole("heading", { name: "Backup plans" })).toBeTruthy();
    const [create] = requestsTo(backend, "POST", "/api/plans");
    expect(create?.body).toMatchObject({
      name: "Weekly shop",
      connectionId: "conn-prod",
      storageId: "st-s3",
      include: ["shop.*"],
      exclude: ["*.sessions"],
      encryption: { kind: "recipients", recipients: [RECIPIENT] },
      schedule: { cron: "30 3 * * 1", timezone: "UTC" },
      retention: { last: 3, daily: 7, weekly: 4, monthly: 12 },
    });
  });

  it("is read-only for operators", async () => {
    renderApp({ signedInAs: "maya", hash: "#/plans/plan-nightly" });
    expect(await screen.findByText("Only admins can change backup plans.")).toBeTruthy();
    // The whole form sits in a disabled <fieldset>.
    expect(screen.getByLabelText("Name").matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
  });

  it("shows that a stored passphrase is kept when left empty", async () => {
    renderApp({ signedInAs: "admin", hash: "#/plans/plan-hourly" });
    expect(await screen.findByText("A passphrase is stored. Leave empty to keep it.")).toBeTruthy();
    expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("");
  });
});
