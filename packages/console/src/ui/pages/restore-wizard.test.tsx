/**
 * Page tests for the restore wizard: conflict display in the dry-run plan, the typed
 * confirmation for production targets, and starting the job.
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";

/** Opens the wizard for the newest complete backup in the S3 fixture storage. */
async function openWizard(signedInAs: string) {
  const rendered = renderApp({ signedInAs });
  const backup = rendered.backend.data.backups.find(
    (candidate) => candidate.storageId === "st-s3" && candidate.status === "complete",
  );
  window.location.hash = `#/backups/st-s3/${backup?.id ?? ""}/restore`;
  await screen.findByRole("heading", { name: "Restore" });
  return rendered;
}

describe("restore wizard", () => {
  it("highlights conflicts and refuses to start a plan that would fail", async () => {
    const { user } = await openWizard("admin");
    // Defaults: the first non-production target (Staging) and "stop if data exists".
    expect((screen.getByLabelText("Target connection") as HTMLSelectElement).value).toBe(
      "conn-staging",
    );
    await user.click(screen.getByRole("button", { name: "Review plan" }));

    const table = await screen.findByRole("table", { name: "Dry-run plan" });
    const usersRow = within(table)
      .getByText("shop.users", { selector: "td:first-child span" })
      .closest("tr");
    expect(usersRow?.className).toBe("row-blocking");
    expect(within(usersRow as HTMLElement).getByText("Conflict: fail")).toBeTruthy();
    expect(within(usersRow as HTMLElement).getByText("1,200")).toBeTruthy();
    expect(screen.getByText(/conflicts? with existing data/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start restore" })).toHaveProperty("disabled", true);
  });

  it("restores next to the original data with a rename rule", async () => {
    const { user, backend } = await openWizard("maya");
    await user.click(screen.getByLabelText("Rename rules (optional)"));
    await user.paste("shop.*=shop_restored.*");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    const table = await screen.findByRole("table", { name: "Dry-run plan" });
    expect(within(table).getByText("shop_restored.users")).toBeTruthy();
    expect(within(table).queryByText(/Conflict/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Start restore" }));
    expect(await screen.findByRole("heading", { name: "Restore job" })).toBeTruthy();
    const [start] = requestsTo(backend, "POST", "/api/restore");
    expect(start?.url).toBe("/api/restore/plan");
    const restore = requestsTo(backend, "POST", "/api/restore").find(
      (request) => request.url === "/api/restore",
    );
    expect(restore?.body).toMatchObject({
      targetConnectionId: "conn-staging",
      rename: { "shop.*": "shop_restored.*" },
      mode: "fail-if-exists",
    });
  });

  it("requires typing the connection name before restoring into production", async () => {
    const { user, backend } = await openWizard("admin");
    await user.selectOptions(screen.getByLabelText("Target connection"), "conn-prod");
    expect(screen.getByText("This is a production connection")).toBeTruthy();
    await user.selectOptions(
      screen.getByLabelText("If a target collection already has data"),
      "drop",
    );
    await user.click(screen.getByRole("button", { name: "Review plan" }));

    const table = await screen.findByRole("table", { name: "Dry-run plan" });
    // Dropping existing data is highlighted as a conflict but does not block.
    const usersRow = within(table)
      .getByText("shop.users", { selector: "td:first-child span" })
      .closest("tr");
    expect(usersRow?.className).toBe("row-conflict");

    const start = screen.getByRole("button", { name: "Start restore" });
    expect(start).toHaveProperty("disabled", true);
    const confirm = screen.getByLabelText("Type Production cluster to confirm");
    await user.type(confirm, "Production");
    expect(screen.getByText("The name does not match.")).toBeTruthy();
    expect(start).toHaveProperty("disabled", true);
    await user.type(confirm, " cluster");
    expect(start).toHaveProperty("disabled", false);

    await user.click(start);
    expect(await screen.findByRole("heading", { name: "Restore job" })).toBeTruthy();
    const restore = requestsTo(backend, "POST", "/api/restore").find(
      (request) => request.url === "/api/restore",
    );
    expect(restore?.body).toMatchObject({
      targetConnectionId: "conn-prod",
      mode: "drop",
      confirmName: "Production cluster",
    });
  });

  it("tells operators that production restores need an admin", async () => {
    const { user } = await openWizard("maya");
    await user.selectOptions(screen.getByLabelText("Target connection"), "conn-prod");
    await user.selectOptions(
      screen.getByLabelText("If a target collection already has data"),
      "drop",
    );
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    expect(await screen.findByText("Admin role required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start restore" })).toHaveProperty("disabled", true);
  });
});
