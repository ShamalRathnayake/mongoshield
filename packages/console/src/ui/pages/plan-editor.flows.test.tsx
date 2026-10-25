/**
 * More plan editor tests: editing an existing plan (notifications, encryption,
 * schedule), deleting and running it, the not-found and load-error states, the missing
 * prerequisites notice, and the schedule preview for schedules it cannot describe. Each
 * test opens the step (tab) whose fields it uses.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp, requestsTo } from "../testing.tsx";
import { isClosed, isOpen, openNewPlanStep } from "./plan-editor.testkit.tsx";
import {
  emptyPlanForm,
  lines,
  planToForm,
  SchedulePreview,
  validatePlanForm,
} from "./plan-editor.tsx";

/** Opens a step of the editor by its tab title ("Schedule", "What to back up" …). */
async function openStep(user: ReturnType<typeof renderApp>["user"], title: string) {
  // A tab's name starts with its title, followed by its hint and state.
  await user.click(screen.getByRole("tab", { name: new RegExp(`^${title}`) }));
}

/** A form that passes validation, to vary one field at a time. */
const validForm = () => ({
  ...emptyPlanForm(),
  name: "Plan",
  connectionId: "c",
  storageId: "s",
  encryptionKind: "none" as const,
});

describe("plan form helpers", () => {
  it("splits textareas into trimmed, non-empty lines", () => {
    expect(lines(" a \n\n b\n")).toEqual(["a", "b"]);
  });

  it("refuses recipients that are not age public keys", () => {
    const result = validatePlanForm({
      ...validForm(),
      encryptionKind: "recipients",
      recipients: "ssh-rsa AAA",
    });
    expect(result.errors?.recipients).toBe('"ssh-rsa AAA" is not an age public key (age1…).');
  });

  it("refuses KMS keys, which the console's server does not take", () => {
    const result = validatePlanForm({
      ...validForm(),
      encryptionKind: "recipients",
      recipients: "kms:aws:alias/backups",
    });
    expect(result.errors?.recipients).toBe(
      '"kms:aws:alias/backups" is not an age public key (age1…).',
    );
  });

  it("requires a passphrase for a new passphrase plan, and a long one", () => {
    expect(
      validatePlanForm({ ...validForm(), encryptionKind: "passphrase" }).errors?.passphrase,
    ).toBe("Enter a passphrase.");
    expect(
      validatePlanForm({ ...validForm(), encryptionKind: "passphrase", passphrase: "short" }).errors
        ?.passphrase,
    ).toBe("Use at least 12 characters; a few random words work well.");
    expect(
      validatePlanForm({
        ...validForm(),
        encryptionKind: "passphrase",
        passphrase: "long enough phrase",
      }).input?.encryption,
    ).toEqual({ kind: "passphrase", passphrase: "long enough phrase" });
  });

  it("reports bad exclude patterns and missing notification URLs", () => {
    const result = validatePlanForm({
      ...validForm(),
      selection: "advanced",
      exclude: "nodot",
      notify: [{ type: "webhook", url: "" }],
    });
    expect(result.errors?.exclude).toMatch(/^"nodot": /);
    expect(result.errors?.["notify.0"]).toBe("Enter the webhook URL.");
  });

  it("leaves out retention when every bucket is empty and keeps stored notification URLs", () => {
    const result = validatePlanForm({
      ...validForm(),
      retention: { last: "", daily: "", weekly: "", monthly: "", yearly: "" },
      notify: [{ type: "slack", url: "", storedPreview: "https://hooks.slack.com/***" }],
    });
    expect(result.input?.retention).toBeUndefined();
    expect(result.input?.notify).toEqual([{ type: "slack" }]);
  });

  it("turns a plan without schedule, retention or encryption into a form", () => {
    const form = planToForm({
      id: "p",
      name: "Manual",
      connectionId: "c",
      storageId: "s",
      include: [],
      exclude: [],
      compression: "none",
      encryption: { kind: "none" },
      consistency: "auto",
      verify: "none",
      notify: [{ type: "webhook", url: { configured: true } }],
    });
    expect(form.scheduled).toBe(false);
    expect(form.retention.last).toBe("");
    expect(form.notify[0]?.storedPreview).toBe("configured");
  });
});

describe("schedule preview", () => {
  it("explains schedules it cannot describe in words", () => {
    render(<SchedulePreview cron="0 3 1-7 * *" timezone="UTC" />);
    expect(screen.getByText("Custom schedule")).toBeTruthy();
    expect(screen.getByText(/the server computes when it runs/)).toBeTruthy();
  });

  it("lists no runs for an invalid schedule", () => {
    render(<SchedulePreview cron="not cron" timezone="UTC" />);
    expect(screen.getByText("Invalid schedule")).toBeTruthy();
    expect(screen.queryByText("Next runs:")).toBeNull();
  });
});

describe("editing a plan", () => {
  it("edits notifications and encryption and keeps stored secrets", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-nightly" });
    await screen.findByRole("heading", { name: "Nightly production" });
    await openStep(user, "Retention & alerts");
    expect(screen.getByText("Stored: https://hooks.slack.com/services/T0…/***")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add notification" }));
    const rows = () => document.querySelectorAll(".notify-row");
    expect(rows()).toHaveLength(2);
    const second = rows()[1] as HTMLElement;
    await user.selectOptions(within(second).getByLabelText("Type"), "discord");
    await user.type(within(second).getByLabelText("URL"), "https://discord.example/hook");
    await user.click(screen.getByRole("button", { name: "Add notification" }));
    await user.click(screen.getByRole("button", { name: "Remove notification 3" }));
    expect(rows()).toHaveLength(2);

    await openStep(user, "Security");
    await user.selectOptions(screen.getByLabelText("Encryption"), "none");
    expect(
      screen.getByText("Backups will be readable by anyone with access to the storage."),
    ).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Compression"), "gzip");
    await user.selectOptions(screen.getByLabelText("Consistency"), "snapshot");
    await user.selectOptions(screen.getByLabelText("Verify after backup"), "deep");
    await openStep(user, "Basics");
    await user.selectOptions(screen.getByLabelText("Storage"), "st-r2");
    await openStep(user, "Schedule");
    await user.click(screen.getByLabelText("Run on a schedule"));
    expect(screen.queryByLabelText("Repeat")).toBeNull();

    // An existing plan can be saved from any step, not only from Review.
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("heading", { name: "Backup plans" })).toBeTruthy();
    const [update] = requestsTo(backend, "PUT", "/api/plans/plan-nightly");
    expect(update?.body).toMatchObject({
      compression: "gzip",
      consistency: "snapshot",
      verify: "deep",
      storageId: "st-r2",
      encryption: { kind: "none" },
      notify: [{ type: "slack" }, { type: "discord", url: "https://discord.example/hook" }],
    });
    expect(update?.body).not.toHaveProperty("schedule");
  });

  it("switches to passphrase encryption and requires a passphrase", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-local" });
    await screen.findByRole("heading", { name: "Local dev snapshot" });
    await openStep(user, "Security");
    await user.selectOptions(screen.getByLabelText("Encryption"), "passphrase");
    expect(screen.getByText(/Keep a copy somewhere safe/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Enter a passphrase.")).toBeTruthy();
    expect(
      await screen.findByText("Some fields need attention; see the messages next to them."),
    ).toBeTruthy();
  });

  it("shows why saving failed", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      hash: "#/plans/plan-local",
      failures: [
        {
          method: "PUT",
          path: "/api/plans/",
          status: 409,
          message: "A plan with that name exists.",
        },
      ],
    });
    await screen.findByRole("heading", { name: "Local dev snapshot" });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Could not save the plan")).toBeTruthy();
    expect(screen.getByText("A plan with that name exists.")).toBeTruthy();
  });

  it("deletes a plan after confirmation, and cancelling keeps it", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-local" });
    await screen.findByRole("heading", { name: "Local dev snapshot" });
    await user.click(screen.getByRole("button", { name: "Delete plan" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete plan" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete plan" }),
    );
    expect(
      await screen.findByText('Deleted "Local dev snapshot". Its backups were kept.'),
    ).toBeTruthy();
    expect(backend.data.plans.some((plan) => plan.id === "plan-local")).toBe(false);
  });

  it("reports a failed delete", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      hash: "#/plans/plan-local",
      failures: [{ method: "DELETE", path: "/api/plans/", status: 500, message: "Disk full." }],
    });
    await screen.findByRole("heading", { name: "Local dev snapshot" });
    await user.click(screen.getByRole("button", { name: "Delete plan" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete plan" }),
    );
    expect(await screen.findByText("Disk full.")).toBeTruthy();
  });

  it("runs a plan now and opens its job", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: "#/plans/plan-local" });
    await user.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/jobs\/job-/));
  });

  it("reports a run that could not start", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: "#/plans/plan-local",
      failures: [{ method: "POST", path: /\/run$/, status: 409, message: "Already running." }],
    });
    await user.click(await screen.findByRole("button", { name: "Run now" }));
    expect(await screen.findByText("Already running.")).toBeTruthy();
  });
});

describe("plan editor states", () => {
  it("says when a plan does not exist", async () => {
    renderApp({ signedInAs: "admin", hash: "#/plans/plan-gone" });
    expect(await screen.findByRole("heading", { name: "Plan not found" })).toBeTruthy();
  });

  it("shows a load error and retries", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      hash: "#/plans/new",
      failures: [
        { method: "GET", path: "/api/plans", status: 503, message: "Starting up.", times: 1 },
      ],
    });
    expect(await screen.findByText("Starting up.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "New backup plan" })).toBeTruthy();
  });

  it("asks for a connection and storage before a plan can be made", async () => {
    const { user } = renderApp({
      signedInAs: "admin",
      hash: "#/plans/new",
      prepare: (mock) => {
        mock.data.connections = [];
      },
    });
    expect(await screen.findByText("Add a connection and storage first")).toBeTruthy();
    // Without a connection the plan cannot go further than Basics, which says why.
    expect(isClosed("What to back up")).toBe(true);
    await user.type(screen.getByLabelText("Name"), "No source");
    await openStep(user, "What to back up");
    expect(isOpen("Basics")).toBe(true);
    expect(screen.getByText("Choose the connection to back up.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Connection"));
  });

  it("explains when the selection preview cannot list namespaces", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      hash: "#/plans/new",
      failures: [{ method: "GET", path: /\/namespaces$/, status: 502, message: "Cannot connect." }],
    });
    // The selection preview is the side column of "What to back up".
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "What to back up");
    expect(await screen.findByText("Could not list namespaces")).toBeTruthy();
  });
});
