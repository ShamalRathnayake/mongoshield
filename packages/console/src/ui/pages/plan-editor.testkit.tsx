/**
 * Shared helpers for the plan editor's page tests (plan-editor*.test.tsx): opening a
 * step by its tab, and filling in a new plan's required values so the steps after them
 * open. The editor keeps people from moving past an incomplete step (StepFlow's
 * `isComplete`): a new plan starts without a name and without a public key, so "What to
 * back up" opens only once it is named, and Schedule, Retention and Review only once
 * Security is complete too.
 */

import { screen } from "@testing-library/react";
import type { renderApp } from "../testing.tsx";

/** The `user` of a rendered app (user-event, set up by `renderApp`). */
type User = ReturnType<typeof renderApp>["user"];

/** A valid age public key, for the "Recipients" field. */
export const RECIPIENT = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

/** The editor's step titles, as their tabs show them. */
export type PlanStepTitle =
  | "Basics"
  | "What to back up"
  | "Security"
  | "Schedule"
  | "Retention & alerts"
  | "Review";

/** The titles in step order. */
const ORDER: readonly PlanStepTitle[] = [
  "Basics",
  "What to back up",
  "Security",
  "Schedule",
  "Retention & alerts",
  "Review",
];

/**
 * The tab of one step. Its accessible name starts with the title, followed by the hint
 * and, for done or failed steps, "(done)" / "(needs attention)".
 */
export function stepTab(title: PlanStepTitle): HTMLElement {
  return screen.getByRole("tab", { name: new RegExp(`^${title}`) });
}

/** Opens a step by clicking its tab. */
export async function openStep(user: User, title: PlanStepTitle): Promise<void> {
  await user.click(stepTab(title));
}

/** True when the step's tab is the open one. */
export function isOpen(title: PlanStepTitle): boolean {
  return stepTab(title).getAttribute("aria-selected") === "true";
}

/** True when the step's tab is closed (behind an incomplete step). */
export function isClosed(title: PlanStepTitle): boolean {
  return stepTab(title).getAttribute("aria-disabled") === "true";
}

/**
 * On a new plan, fills in what the steps before `title` require, as a user would (a name
 * on Basics; a public key on Security when `title` comes after it), then opens `title`.
 * Every other default is left as it is.
 */
export async function openNewPlanStep(
  user: User,
  title: PlanStepTitle,
  name = "Test plan",
): Promise<void> {
  const at = ORDER.indexOf(title);
  // Only what is still missing is filled in, so this can be called again later.
  const nameField = screen.getByLabelText("Name") as HTMLInputElement;
  if (at > ORDER.indexOf("Basics") && nameField.value.trim() === "") {
    await openStep(user, "Basics");
    await user.type(nameField, name);
  }
  const encryption = screen.getByLabelText("Encryption") as HTMLSelectElement;
  const recipients = screen.queryByLabelText("Recipients") as HTMLTextAreaElement | null;
  if (
    at > ORDER.indexOf("Security") &&
    encryption.value === "recipients" &&
    recipients?.value.trim() === ""
  ) {
    await openStep(user, "Security");
    await user.type(recipients, RECIPIENT);
  }
  await openStep(user, title);
}
