/**
 * Shared helpers for the restore wizard's page tests (restore-wizard*.test.tsx and
 * restore-preview.test.tsx): the fixture backup to restore, and moving through the
 * wizard's step tabs (What, Where, Keys, Review, Preview, Confirm, Progress) the way a
 * user does, by clicking a tab or the navigation row's buttons.
 */

import { screen } from "@testing-library/react";
import { createMockBackend } from "../mock/backend.ts";
import type { renderApp } from "../testing.tsx";

/** The `user` of a rendered app (user-event, set up by `renderApp`). */
type User = ReturnType<typeof renderApp>["user"];

/** The wizard's step titles, as their tabs show them. */
export type RestoreStepTitle =
  | "What"
  | "Where"
  | "Keys"
  | "Review"
  | "Preview"
  | "Confirm"
  | "Progress";

/** The newest complete S3 backup id (the fixtures are the same for every backend). */
export function newestBackupId(): string {
  const probe = createMockBackend({ jobTickMs: 0 });
  probe.dispose();
  const backup = probe.data.backups.find(
    (candidate) => candidate.storageId === "st-s3" && candidate.status === "complete",
  );
  if (backup === undefined) throw new Error("no complete backup");
  return backup.id;
}

/**
 * The tab of one step. Its accessible name starts with the title, followed by the hint
 * and, for done or failed steps, "(done)" / "(needs attention)".
 */
export function stepTab(title: RestoreStepTitle): HTMLElement {
  return screen.getByRole("tab", { name: new RegExp(`^${title}`) });
}

/** Opens a step by clicking its tab (which must not be locked). */
export async function openStep(user: User, title: RestoreStepTitle): Promise<void> {
  await user.click(stepTab(title));
}

/** True when a step's tab is locked (shown dimmed, cannot be opened yet). */
export function isLocked(title: RestoreStepTitle): boolean {
  return stepTab(title).getAttribute("aria-disabled") === "true";
}

/** The title of the step that is shown now. */
export function currentStep(): string {
  const selected = screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true");
  return selected?.querySelector(".step-tab-title")?.textContent ?? "";
}

/**
 * Asks for the plan as a user does: on the Keys step (the last choice), the navigation
 * row's "Review plan" button. Does not wait for the answer.
 */
export async function reviewPlan(user: User): Promise<void> {
  await openStep(user, "Keys");
  await user.click(screen.getByRole("button", { name: "Review plan" }));
}
