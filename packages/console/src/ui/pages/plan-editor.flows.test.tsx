/**
 * More plan editor tests: editing an existing plan (notifications, encryption,
 * schedule), deleting and running it, the not-found and load-error states, the missing
 * prerequisites notice, and the schedule preview for schedules it cannot describe.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp, requestsTo } from "../testing.tsx";
import {
  emptyPlanForm,
  lines,
  planToForm,
  SchedulePreview,
  validatePlanForm,
} from "./plan-editor.tsx";

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

  it("refuses recipients that are neither age keys nor KMS keys", () => {
    const result = validatePlanForm({
      ...validForm(),
      encryptionKind: "recipients",
      recipients: "ssh-rsa AAA",
    });
    expect(result.errors?.recipients).toBe(
      '"ssh-rsa AAA" is not an age recipient (age1…) or a KMS key (kms:…).',
    );
  });

  it("accepts KMS keys as recipients", () => {
    const result = validatePlanForm({
      ...validForm(),
      encryptionKind: "recipients",
      recipients: "kms:aws:alias/backups",
    });
    expect(result.input?.encryption).toEqual({
      kind: "recipients",
      recipients: ["kms:aws:alias/backups"],
    });
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

    await user.selectOptions(screen.getByLabelText("Encryption"), "none");
    expect(
      screen.getByText("Backups will be readable by anyone with access to the storage."),
    ).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Compression"), "gzip");
    await user.selectOptions(screen.getByLabelText("Consistency"), "snapshot");
    await user.selectOptions(screen.getByLabelText("Verify after backup"), "deep");
    await user.selectOptions(screen.getByLabelText("Storage"), "st-r2");
    await user.click(screen.getByLabelText("Run on a schedule"));
    expect(screen.queryByLabelText("Cron expression")).toBeNull();

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
    renderApp({
      signedInAs: "admin",
      hash: "#/plans/new",
      prepare: (mock) => {
        mock.data.connections = [];
      },
    });
    expect(await screen.findByText("Add a connection and storage first")).toBeTruthy();
    expect(screen.getByText("Choose a connection to preview.")).toBeTruthy();
  });

  it("explains when the selection preview cannot list namespaces", async () => {
    renderFailingApp({
      signedInAs: "admin",
      hash: "#/plans/new",
      failures: [{ method: "GET", path: /\/namespaces$/, status: 502, message: "Cannot connect." }],
    });
    expect(await screen.findByText("Could not list namespaces")).toBeTruthy();
  });
});
