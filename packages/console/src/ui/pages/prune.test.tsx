/**
 * Page tests for applying a plan's retention from the Backups page: the dry run in the
 * dialog, confirming it as a prune job, and every way the dialog can refuse.
 */

import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";
import { describeRetention } from "./backups.tsx";

/** Opens the retention dialog on a storage location's backups page. */
async function openPruneDialog(rendered: ReturnType<typeof renderApp>) {
  await rendered.user.click(await screen.findByRole("button", { name: "Apply retention…" }));
  return screen.findByRole("dialog", { name: "Apply retention" });
}

describe("apply retention", () => {
  it("shows the dry run, then deletes exactly those backups in a prune job", async () => {
    const rendered = renderApp({ signedInAs: "admin", hash: "#/backups/st-s3" });
    const { user, backend } = rendered;
    const dialog = await openPruneDialog(rendered);
    expect(
      within(dialog).getByRole("option", {
        name: "Nightly production (last 3, daily 7, weekly 4, monthly 12)",
      }),
    ).toBeTruthy();
    const list = await within(dialog).findByRole("list", { name: "Backups to delete" });
    const shown = within(list)
      .getAllByRole("listitem")
      .map((item) => item.querySelector("code")?.textContent);
    expect(shown.length).toBeGreaterThan(0);
    // Held and object-locked backups are never on the list.
    const held = backend.data.backups.find((backup) => backup.hold !== undefined);
    expect(shown).not.toContain(held?.id);

    await user.click(
      within(dialog).getByRole("button", { name: `Delete ${shown.length} backups` }),
    );
    expect(await screen.findByText(/Pruning started/)).toBeTruthy();
    const job = backend.data.jobs[0];
    expect(job?.kind).toBe("prune");
    expect(window.location.hash).toBe(`#/jobs/${job?.id}`);
    expect(requestsTo(backend, "POST", "/api/plans/plan-nightly/prune")[1]?.body).toEqual({
      remove: shown,
    });

    act(() => {
      for (let step = 0; step < 12; step += 1) backend.tickJobs();
    });
    for (const id of shown) {
      expect(backend.data.backups.some((backup) => backup.id === id)).toBe(false);
    }
    expect(backend.data.jobs[0]?.summary).toMatch(/^deleted \d+ backups, kept \d+$/);
  });

  it("applies each plan's retention to its own backups only when plans share a storage", async () => {
    const rendered = renderApp({
      signedInAs: "admin",
      hash: "#/backups/st-s3",
      prepare: (backend) => {
        const [first] = backend.data.plans;
        if (first !== undefined) {
          backend.data.plans.push({ ...first, id: "plan-copy", name: "Second plan" });
        }
      },
    });
    const dialog = await openPruneDialog(rendered);
    expect(await within(dialog).findByRole("list", { name: "Backups to delete" })).toBeTruthy();
    // Both plans can be chosen; switching plans runs a new dry run. The copy wrote no
    // backups yet, so it has nothing to prune and leaves every nightly backup alone.
    await rendered.user.selectOptions(
      within(dialog).getByLabelText("Retention of plan"),
      "plan-copy",
    );
    expect(await within(dialog).findByText(/Nothing to prune/)).toBeTruthy();
    const nightly = rendered.backend.data.backups.filter((backup) => backup.storageId === "st-s3");
    expect(
      within(dialog).getByText(new RegExp(`${nightly.length} other backups in this storage`)),
    ).toBeTruthy();
  });

  it("says when there is nothing to prune and disables the confirmation", async () => {
    const rendered = renderApp({ signedInAs: "admin", hash: "#/backups/st-r2" });
    const dialog = await openPruneDialog(rendered);
    expect(await within(dialog).findByText(/Nothing to prune/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Delete 0 backups" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains when no plan writing here has a retention policy", async () => {
    const rendered = renderApp({ signedInAs: "admin", hash: "#/backups/st-local" });
    const dialog = await openPruneDialog(rendered);
    expect(await within(dialog).findByText("No plan with a retention policy")).toBeTruthy();
    await rendered.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses to confirm when the backups changed since the dry run", async () => {
    const rendered = renderApp({ signedInAs: "admin", hash: "#/backups/st-s3" });
    const { user, backend } = rendered;
    const dialog = await openPruneDialog(rendered);
    await within(dialog).findByRole("list", { name: "Backups to delete" });
    // Another (old, incomplete) backup of the plan appears: the server's plan now removes more.
    backend.data.backups.push({
      id: "2020-01-01T00-00-00Z_abcdef",
      storageId: "st-s3",
      planId: "plan-nightly",
      status: "incomplete",
      startedAt: "2020-01-01T00:00:00.000Z",
      drills: [],
    });
    await user.click(within(dialog).getByRole("button", { name: /^Delete \d+ backups$/ }));
    expect(await within(dialog).findByText("Could not prune")).toBeTruthy();
    expect(within(dialog).getByText(/changed since the dry run/)).toBeTruthy();
    expect(backend.data.jobs.some((job) => job.kind === "prune" && job.status === "running")).toBe(
      false,
    );
  });

  it("shows a failed dry run", async () => {
    const rendered = renderApp({
      signedInAs: "admin",
      hash: "#/backups/st-s3",
      // The plan list says the plan has retention, but the server's copy no longer does.
      prepare: (backend) => {
        const fetch = backend.fetch;
        Object.assign(backend, {
          fetch: (url: string, init: Parameters<typeof fetch>[1]) =>
            url.endsWith("/prune/plan")
              ? Promise.resolve({
                  status: 400,
                  text: async () =>
                    JSON.stringify({
                      error: { code: "CONSOLE_VALIDATION", message: "No policy." },
                    }),
                })
              : fetch(url, init),
        });
      },
    });
    const dialog = await openPruneDialog(rendered);
    expect(await within(dialog).findByText("Could not plan")).toBeTruthy();
  });

  it("is offered to admins only", async () => {
    renderApp({ signedInAs: "maya", hash: "#/backups/st-s3" });
    await screen.findByRole("table", { name: "Backups in S3 primary" });
    expect(screen.queryByRole("button", { name: "Apply retention…" })).toBeNull();
  });

  it("describes a retention policy in words", () => {
    expect(describeRetention({ last: 7, daily: 14 })).toBe("last 7, daily 14");
  });
});
