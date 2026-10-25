/**
 * Page tests for the plan editor: validation messages, the live selection and schedule
 * previews, and the request sent on save. The editor is a step flow, so each test opens
 * the step (tab) whose fields it uses, as a person would.
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";
import { isClosed, isOpen, openNewPlanStep, RECIPIENT } from "./plan-editor.testkit.tsx";
import { emptyPlanForm, planToForm, validatePlanForm } from "./plan-editor.tsx";

/** Opens a step of the editor by its tab title ("Schedule", "What to back up" …). */
async function openStep(user: ReturnType<typeof renderApp>["user"], title: string) {
  // A tab's name starts with its title, followed by its hint and state.
  await user.click(screen.getByRole("tab", { name: new RegExp(`^${title}`) }));
}

/** The schedule in words and its next runs (the tab hint and summary repeat the words). */
const schedulePreview = () => document.querySelector(".schedule-preview") as HTMLElement;

describe("validatePlanForm", () => {
  it("reports every problem at once, keyed by field", () => {
    const result = validatePlanForm({
      ...emptyPlanForm(),
      // The pattern boxes are only checked in the "Patterns (advanced)" mode.
      selection: "advanced",
      include: "shop",
      repeat: "custom",
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
    await openNewPlanStep(user, "Schedule");
    expect(screen.queryByLabelText("Full backup")).toBeNull();
    await user.click(screen.getByLabelText("Incremental backups between full ones"));
    // A select of common intervals, weekly by default.
    const interval = screen.getByLabelText("Full backup") as HTMLSelectElement;
    expect(interval.value).toBe("7");
    expect(interval.selectedOptions[0]?.textContent).toBe("Every week (7 days)");
  });
});

describe("plan editor page", () => {
  it("shows validation errors, live previews, and saves a valid plan", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });

    // Nothing is said before anything was tried; Next on an incomplete step stays on it
    // and says what is missing, with focus on the field.
    expect(screen.queryByText("Give the plan a name.")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Next: What to back up/ }));
    expect(screen.getByRole("tab", { name: /^Basics/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Give the plan a name.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Weekly shop");

    // Patterns are the advanced way to choose what to back up.
    await openStep(user, "What to back up");
    await user.click(screen.getByLabelText("Patterns (advanced)"));
    await user.type(screen.getByLabelText("Include"), "shop");
    // The message shows once the step is left with the mistake in it (here: Next).
    expect(screen.queryByText(/add a "\." between database and collection/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Next: Security/ }));
    expect(screen.getByText(/add a "\." between database and collection/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Include"));
    await user.type(screen.getByLabelText("Include"), ".*");
    await user.type(screen.getByLabelText("Exclude"), "*.sessions");

    // With include shop.* and exclude *.sessions: 5 of the 8 collections.
    expect(await screen.findByText(/of 8 collections selected/)).toBeTruthy();
    expect(screen.getByText("5", { selector: "strong" })).toBeTruthy();

    // Security needs a public key before the later steps open.
    await openStep(user, "Security");
    await user.type(screen.getByLabelText("Recipients"), RECIPIENT);

    // A cron expression is the "Custom" repeat choice; it starts from the preset's cron.
    await openStep(user, "Schedule");
    await user.selectOptions(screen.getByLabelText("Repeat"), "custom");
    expect((screen.getByLabelText("Cron expression") as HTMLInputElement).value).toBe("0 2 * * *");
    await user.clear(screen.getByLabelText("Cron expression"));
    await user.type(screen.getByLabelText("Cron expression"), "0 25 * * *");
    // A later tab is closed while the step has a mistake; clicking it says why.
    expect(isClosed("Retention & alerts")).toBe(true);
    await openStep(user, "Retention & alerts");
    expect(isOpen("Schedule")).toBe(true);
    expect(screen.getByText(/The hour field has "25", outside 0–23/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Cron expression"));
    await user.clear(screen.getByLabelText("Cron expression"));
    await user.type(screen.getByLabelText("Cron expression"), "30 3 * * 1");
    await user.selectOptions(screen.getByLabelText("Time zone"), "UTC");
    expect(within(schedulePreview()).getByText("Every Monday at 03:30")).toBeTruthy();
    expect(screen.getByText("Next runs:").nextElementSibling?.children).toHaveLength(5);

    await openStep(user, "Review");
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
      // The recommended retention preset is the default for new plans.
      retention: { daily: 7, weekly: 4, monthly: 12 },
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
    // The step can be linked to directly: `?step=security` opens it.
    renderApp({ signedInAs: "admin", hash: "#/plans/plan-hourly?step=security" });
    expect(await screen.findByText("A passphrase is stored. Leave empty to keep it.")).toBeTruthy();
    expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("tab", { name: /^Security/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});
