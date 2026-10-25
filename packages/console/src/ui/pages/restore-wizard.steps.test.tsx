/**
 * Restore wizard, the step tabs themselves (components/step-flow.tsx as the wizard
 * uses it): which steps are locked until when, a changed choice throwing the review
 * away (and relocking the later steps while the user stays put), the "done" marks, the
 * navigation row's main button per step, and where focus goes after each step change.
 */

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";
import {
  currentStep,
  isLocked,
  newestBackupId,
  openStep,
  reviewPlan,
  stepTab,
} from "./restore-wizard.testkit.tsx";

/** Opens the wizard as an operator; `unencrypted` turns the fixture backup's encryption off. */
async function openWizard(options: { unencrypted?: boolean } = {}) {
  const id = newestBackupId();
  const rendered = renderApp({
    signedInAs: "maya",
    hash: `#/backups/st-s3/${id}/restore`,
    prepare: (mock) => {
      if (options.unencrypted !== true) return;
      // Backups are read-only records: replace the one restored with an unencrypted copy.
      const index = mock.data.backups.findIndex((candidate) => candidate.id === id);
      const backup = mock.data.backups[index];
      if (backup !== undefined) mock.data.backups[index] = { ...backup, encrypted: false };
    },
  });
  await screen.findByRole("heading", { name: "Restore" });
  return rendered;
}

/** Plans a restore that can run: a copy next to the original (no conflicts). */
async function planACopy(user: ReturnType<typeof renderApp>["user"]) {
  await openStep(user, "Where");
  await user.click(screen.getByRole("radio", { name: /A copy next to the original/ }));
  await reviewPlan(user);
  await screen.findByRole("table", { name: "Dry-run plan" });
}

describe("restore wizard: step tabs", () => {
  it("shows seven steps and replaces the old stepper", async () => {
    await openWizard();
    const tabs = screen.getAllByRole("tab").map((tab) => tab.querySelector(".step-tab-title"));
    expect(tabs.map((title) => title?.textContent)).toEqual([
      "What",
      "Where",
      "Keys",
      "Review",
      "Preview",
      "Confirm",
      "Progress",
    ]);
    expect(screen.getByRole("tablist", { name: "Restore steps" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Restore steps" })).toBeNull();
    expect(screen.getByText("Step 1 of 7")).toBeTruthy();
  });

  it("locks Review, Preview, Confirm and Progress until there is a plan that can run", async () => {
    const { user } = await openWizard();
    for (const title of ["Review", "Preview", "Confirm", "Progress"] as const) {
      expect(isLocked(title)).toBe(true);
    }
    // A locked tab does not open.
    await user.click(stepTab("Review"));
    expect(currentStep()).toBe("What");
    // The arrow keys go round the open steps only: End lands on Keys.
    fireEvent.keyDown(stepTab("What"), { key: "End" });
    expect(currentStep()).toBe("Keys");

    await planACopy(user);
    expect(isLocked("Review")).toBe(false);
    expect(isLocked("Preview")).toBe(false);
    expect(isLocked("Confirm")).toBe(false);
    // Starting leaves for the job page, so Progress is never opened here.
    expect(isLocked("Progress")).toBe(true);
    expect(stepTab("Progress").textContent).toContain("Opens when started");
  });

  it("offers the right main button on each step", async () => {
    const { user } = await openWizard();
    // What and Where: plain Next.
    expect(screen.getByRole("button", { name: /Next: Where/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Next: Where/ }));
    expect(screen.getByRole("button", { name: /Next: Keys/ })).toBeTruthy();
    // Keys, before Review is open: "Review plan".
    await user.click(screen.getByRole("button", { name: /Next: Keys/ }));
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Review plan" })).toBeTruthy();
    // A plan without conflicts, so every later step opens.
    await openStep(user, "Where");
    await user.click(screen.getByRole("radio", { name: /A copy next to the original/ }));
    await openStep(user, "Keys");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await screen.findByRole("table", { name: "Dry-run plan" });
    // Review: Next to the preview, and "Skip preview" next to Back.
    expect(screen.getByRole("button", { name: /Next: Preview/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip preview" })).toBeTruthy();
    // Keys, once the plan exists: Next goes back to it.
    await openStep(user, "Keys");
    expect(screen.getByRole("button", { name: /Next: Review/ })).toBeTruthy();
    // Preview: Next to the confirmation (skipping the preview is allowed).
    await openStep(user, "Preview");
    expect(screen.getByRole("button", { name: /Next: Confirm/ })).toBeTruthy();
    // Confirm: "Start restore" (Progress is locked).
    await openStep(user, "Confirm");
    expect(screen.getByRole("button", { name: "Start restore" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
  });

  it("throws the review away when a choice changes, keeping the user on their step", async () => {
    const { user, backend } = await openWizard();
    await planACopy(user);
    expect(stepTab("Review").textContent).toContain("(done)");
    expect(stepTab("Where").textContent).toContain("(done)");

    // Back on Where, a different suffix: the plan is gone and the later steps lock.
    await openStep(user, "Where");
    await user.type(screen.getByLabelText("Suffix"), "2");
    expect(currentStep()).toBe("Where");
    expect(stepTab("Where").textContent).toContain("copy (_restored2)");
    for (const title of ["Review", "Preview", "Confirm"] as const) {
      expect(isLocked(title)).toBe(true);
    }
    expect(stepTab("Review").textContent).not.toContain("Plan:");
    expect(screen.queryByRole("table", { name: "Dry-run plan" })).toBeNull();

    // The same holds for What and Keys.
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    await openStep(user, "What");
    await user.click(screen.getByRole("checkbox", { name: "shop.users" }));
    expect(currentStep()).toBe("What");
    expect(isLocked("Review")).toBe(true);
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    await openStep(user, "Keys");
    await user.type(screen.getByLabelText("Passphrase (optional)"), "x");
    expect(currentStep()).toBe("Keys");
    expect(isLocked("Review")).toBe(true);
    // The next plan uses the new choices.
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await screen.findByRole("table", { name: "Dry-run plan" });
    expect(requestsTo(backend, "POST", "/api/restore/plan").at(-1)?.body).toMatchObject({
      passphrase: "x",
      rename: { "shop.*": "shop_restored2.*" },
    });
  });

  it("drops a plan that arrives after the choices changed", async () => {
    const { user, backend } = await openWizard();
    await openStep(user, "Keys");
    const planned = screen.getByRole("button", { name: "Review plan" });
    // Typing a key while the plan is on its way makes that plan out of date.
    fireEvent.click(planned);
    fireEvent.change(screen.getByLabelText("Passphrase (optional)"), {
      target: { value: "late" },
    });
    await screen.findByRole("button", { name: "Review plan" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestsTo(backend, "POST", "/api/restore/plan")).toHaveLength(1);
    expect(isLocked("Review")).toBe(true);
    expect(currentStep()).toBe("Keys");
  });

  it("says no key is needed for an unencrypted backup, marked done from the start", async () => {
    const { user } = await openWizard({ unencrypted: true });
    expect(stepTab("Keys").textContent).toContain("Not needed");
    expect(stepTab("Keys").textContent).toContain("(done)");
    await openStep(user, "Keys");
    expect(screen.getByText("No key needed")).toBeTruthy();
    expect(screen.queryByLabelText("Passphrase (optional)")).toBeNull();
  });

  it("marks the choice steps done once the user has been past them", async () => {
    const { user } = await openWizard();
    expect(stepTab("What").textContent).not.toContain("(done)");
    await user.click(screen.getByRole("button", { name: /Next: Where/ }));
    expect(stepTab("What").textContent).toContain("(done)");
    expect(stepTab("Where").textContent).not.toContain("(done)");
  });

  it("moves focus to each step's panel or heading after Back, Next and its own buttons", async () => {
    const { user } = await openWizard();
    // Next: the new step's panel.
    await user.click(screen.getByRole("button", { name: /Next: Where/ }));
    expect(document.activeElement?.getAttribute("role")).toBe("tabpanel");
    expect(document.activeElement?.contains(screen.getByLabelText("Target connection"))).toBe(true);
    // Enter in the Where step's text field goes on to Keys, like Next.
    await user.click(screen.getByRole("radio", { name: /A copy next to the original/ }));
    await user.type(screen.getByLabelText("Suffix"), "{Enter}");
    expect(currentStep()).toBe("Keys");
    // "Review plan": the plan's heading.
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    expect(document.activeElement).toBe(await screen.findByRole("heading", { name: /^Plan: / }));
    // Next: the preview's heading.
    await user.click(screen.getByRole("button", { name: /Next: Preview/ }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: /^Preview: / }));
    // Next: the confirmation's heading.
    await user.click(screen.getByRole("button", { name: /Next: Confirm/ }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Confirm restore" }));
    // Back twice: the preview's heading, then the plan's.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: /^Preview: / }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: /^Plan: / }));
    // Back to Keys: its panel (it has no heading).
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement?.getAttribute("role")).toBe("tabpanel");
    expect(document.activeElement?.contains(screen.getByLabelText("Passphrase (optional)"))).toBe(
      true,
    );
    // A tab click leaves focus on the tab.
    await openStep(user, "Review");
    expect(document.activeElement).toBe(stepTab("Review"));
  });
});
