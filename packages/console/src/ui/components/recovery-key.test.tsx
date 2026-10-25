/**
 * Tests for finding and downloading a plan's recovery key (recovery-key.tsx): the
 * Settings → Recovery keys list, the button on the plan's Security step, downloading
 * again after it was saved, and viewers who may not download.
 */

import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockManagedKey } from "../mock/onboarding.ts";
import { renderApp, requestsTo } from "../testing.tsx";

beforeEach(() => {
  // jsdom has no Blob URLs and cannot follow a download link; the tests only need the call.
  URL.createObjectURL = vi.fn(() => "blob:recovery-key");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Gives the first fixture plan a console-kept key (saved before or not). */
function withManagedPlan(saved: boolean) {
  return (backend: { data: { plans: { encryption: unknown }[] } }) => {
    const [first] = backend.data.plans;
    if (first !== undefined) first.encryption = { ...mockManagedKey(), recoveryKeySaved: saved };
  };
}

describe("Settings → Recovery keys", () => {
  it("lists plans with a console-kept key and downloads one", async () => {
    const { user, backend } = renderApp({
      signedInAs: "admin",
      hash: "#/settings",
      prepare: withManagedPlan(false),
    });
    const panel = (await screen.findByRole("heading", { name: "Recovery keys" })).closest(
      "section",
    ) as HTMLElement;
    expect(await within(panel).findByText("Not saved yet")).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: /^Save recovery key for / }));
    const dialog = screen.getByRole("dialog", { name: "Save your recovery key" });
    await user.click(within(dialog).getByRole("button", { name: "Download recovery key" }));
    expect(await within(dialog).findByText("Downloaded")).toBeTruthy();
    expect(within(dialog).getByText(/^AGE-SECRET-KEY-1/)).toBeTruthy();
    // The plan reloads as saved, but the open dialog keeps its title.
    expect(screen.getByRole("dialog", { name: "Save your recovery key" })).toBe(dialog);
    expect(requestsTo(backend, "POST", "/api/plans/")).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    // Marked as saved, and it can still be downloaded again.
    expect(await within(panel).findByText("Saved before")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /^Download recovery key for / })).toBeTruthy();
  });

  it("says when no plan has one, and that only admins can download", async () => {
    renderApp({
      signedInAs: "sam",
      hash: "#/settings",
      prepare: withManagedPlan(true),
    });
    const panel = (await screen.findByRole("heading", { name: "Recovery keys" })).closest(
      "section",
    ) as HTMLElement;
    expect(await within(panel).findByText("Saved before")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /recovery key for/ })).toBeNull();
    expect(within(panel).getByText("Only admins can download recovery keys.")).toBeTruthy();
  });

  it("lists nothing without console-kept keys", async () => {
    renderApp({ signedInAs: "admin", hash: "#/settings" });
    expect(await screen.findByText("No plan uses a key kept by the console.")).toBeTruthy();
  });
});

describe("the plan's Security step", () => {
  it("downloads the saved plan's recovery key again", async () => {
    const { user, backend } = renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-nightly?step=security",
      prepare: withManagedPlan(true),
    });
    expect(await screen.findByText("Downloaded before; you can download it again.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Download recovery key for / }));
    const dialog = screen.getByRole("dialog", { name: /^Recovery key of / });
    await user.click(within(dialog).getByRole("button", { name: "Download again" }));
    expect(await within(dialog).findByText("Downloaded")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/plans/")).toHaveLength(1);
  });

  it("explains that a new plan's key comes after saving", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-nightly?step=security" });
    await screen.findByLabelText("Encryption");
    await user.selectOptions(screen.getByLabelText("Encryption"), "managed");
    expect(screen.getByText(/The key is created when the plan is saved/)).toBeTruthy();
  });
});
