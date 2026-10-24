/**
 * More restore wizard tests: rename rule parsing, conflict detection, the form's own
 * validation, request errors at either step, going back, the passphrase field for
 * encrypted backups, restoring selected documents (and refusing a plan that ignored the
 * selection), and the load error.
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type FailureRule, renderFailingApp } from "../failing-backend.testkit.tsx";
import { createMockBackend } from "../mock/backend.ts";
import { renderApp, requestsTo } from "../testing.tsx";
import { isConflict, parseRenameRules } from "./restore-wizard.tsx";

/** The newest complete S3 backup id (the fixtures are the same for every backend). */
function newestBackupId(): string {
  const probe = createMockBackend({ jobTickMs: 0 });
  probe.dispose();
  const backup = probe.data.backups.find(
    (candidate) => candidate.storageId === "st-s3" && candidate.status === "complete",
  );
  if (backup === undefined) throw new Error("no complete backup");
  return backup.id;
}

async function openWizard(
  signedInAs: string,
  options: {
    query?: string;
    failures?: FailureRule[];
    prepare?: Parameters<typeof renderApp>[0];
  } = {},
) {
  const hash = `#/backups/st-s3/${newestBackupId()}/restore${options.query ?? ""}`;
  const rendered =
    options.failures === undefined
      ? renderApp({ signedInAs, hash, ...options.prepare })
      : renderFailingApp({ signedInAs, hash, failures: options.failures, ...options.prepare });
  await screen.findByRole("heading", { name: "Restore" });
  return rendered;
}

describe("parseRenameRules", () => {
  it("reads from=to lines", () => {
    expect(parseRenameRules("shop.*=shop_restored.*\n\nanalytics.x = a2.x")).toEqual({
      "shop.*": "shop_restored.*",
      "analytics.x": "a2.x",
    });
  });

  it("explains lines without = and invalid patterns", () => {
    expect(parseRenameRules("shop.*")).toBe('"shop.*" is not from=to, e.g. shop.*=shop_restored.*');
    expect(parseRenameRules("=x.y")).toMatch(/is not from=to/);
    expect(parseRenameRules("shop=other.x")).toMatch(/^"shop=other.x": /);
  });
});

describe("isConflict", () => {
  it("flags blocking actions and existing data", () => {
    expect(isConflict({ from: "a.b", to: "a.b", documents: 1, action: "fail" })).toBe(true);
    expect(
      isConflict({ from: "a.b", to: "a.b", documents: 1, action: "drop", existingDocuments: 3 }),
    ).toBe(true);
    expect(isConflict({ from: "a.b", to: "a.b", documents: 1, action: "create" })).toBe(false);
  });
});

describe("restore wizard", () => {
  it("requires a namespace and valid rename rules before planning", async () => {
    const { user, backend } = await openWizard("maya");
    const group = screen.getByRole("group", { name: "What to restore" });
    for (const checkbox of within(group).getAllByRole("checkbox")) await user.click(checkbox);
    await user.type(screen.getByLabelText("Rename rules (optional)"), "nonsense");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    expect(screen.getByText("Choose at least one namespace.")).toBeTruthy();
    expect(screen.getByText(/is not from=to/)).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/restore")).toHaveLength(0);
  });

  it("restores only the chosen namespaces, with the passphrase, and can go back", async () => {
    const { user, backend } = await openWizard("maya");
    const group = screen.getByRole("group", { name: "What to restore" });
    const [first] = within(group).getAllByRole("checkbox");
    if (first !== undefined) await user.click(first);
    await user.type(screen.getByLabelText("Passphrase (optional)"), "open sesame please");
    await user.selectOptions(
      screen.getByLabelText("If a target collection already has data"),
      "upsert",
    );
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await screen.findByRole("table", { name: "Dry-run plan" });
    const [plan] = requestsTo(backend, "POST", "/api/restore/plan");
    expect(plan?.body).toMatchObject({ passphrase: "open sesame please", mode: "upsert" });
    expect(plan?.body).toHaveProperty("include");

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Review plan" })).toBeTruthy();
  });

  it("sends typed age private keys with the plan and refuses anything else", async () => {
    const { user, backend } = await openWizard("maya");
    const keyField = screen.getByLabelText("Private key (optional)");
    await user.type(keyField, "not-a-key");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    expect(screen.getByText(/not an age private key/)).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/restore/plan")).toHaveLength(0);

    await user.clear(keyField);
    await user.type(keyField, "AGE-SECRET-KEY-1ABC AGE-SECRET-KEY-1DEF");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await screen.findByRole("table", { name: "Dry-run plan" });
    const [plan] = requestsTo(backend, "POST", "/api/restore/plan");
    expect(plan?.body).toMatchObject({
      identities: ["AGE-SECRET-KEY-1ABC", "AGE-SECRET-KEY-1DEF"],
    });
  });

  it("moves focus to the plan when reviewing and back to the form when going back", async () => {
    const { user } = await openWizard("maya");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    const planHeading = await screen.findByRole("heading", { name: /^Plan: / });
    expect(document.activeElement).toBe(planHeading);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review plan" }));
  });

  it("shows a planning error", async () => {
    const { user } = await openWizard("maya", {
      failures: [{ method: "POST", path: "/api/restore/plan", status: 422, message: "Bad key." }],
    });
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    expect(await screen.findByText("Could not plan the restore")).toBeTruthy();
    expect(screen.getByText("Bad key.")).toBeTruthy();
  });

  it("shows an error when the restore cannot start", async () => {
    const { user } = await openWizard("maya", {
      failures: [{ method: "POST", path: /\/api\/restore$/, status: 409, message: "Target busy." }],
    });
    await user.type(screen.getByLabelText("Rename rules (optional)"), "shop.*=shop_copy.*");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await user.click(await screen.findByRole("button", { name: "Start restore" }));
    expect(await screen.findByText("Could not start the restore")).toBeTruthy();
    expect(screen.getByText("Target busy.")).toBeTruthy();
  });

  it("asks for a target when there are no connections", async () => {
    const { user } = await openWizard("admin", {
      prepare: {
        prepare: (mock) => {
          mock.data.connections = [];
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    expect(screen.getByText("Choose a target connection.")).toBeTruthy();
  });

  it("restores selected documents with an $in filter", async () => {
    const { user, backend } = await openWizard("maya", { query: "?ns=shop.users&ids=[1,2]" });
    expect(screen.getByText("Restoring 2 selected documents")).toBeTruthy();
    expect(
      (screen.getByLabelText("If a target collection already has data") as HTMLSelectElement).value,
    ).toBe("upsert");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await screen.findByRole("table", { name: "Dry-run plan" });
    const [plan] = requestsTo(backend, "POST", "/api/restore/plan");
    expect(plan?.body).toMatchObject({ filter: '{"_id":{"$in":[1,2]}}', include: ["shop.users"] });
  });

  it("refuses to start when the server ignored the selection", async () => {
    const { user } = await openWizard("maya", {
      query: "?ns=shop.users&ids=[1]",
      failures: [
        {
          method: "POST",
          path: "/api/restore/plan",
          status: 200,
          body: {
            backupId: newestBackupId(),
            mode: "upsert",
            entries: [{ from: "shop.users", to: "shop.users", documents: 500, action: "upsert" }],
          },
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    expect(
      await screen.findByText("The server did not limit the restore to the selected documents"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start restore" })).toHaveProperty("disabled", true);
  });

  it("ignores a selection that is not a JSON array", async () => {
    await openWizard("maya", { query: "?ns=shop.users&ids=nope" });
    expect(screen.queryByText(/selected document/)).toBeNull();
  });

  it("shows a load error and retries", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: `#/backups/st-s3/${newestBackupId()}/restore`,
      failures: [
        { method: "GET", path: "/api/connections", status: 500, message: "Down.", times: 1 },
      ],
    });
    expect(await screen.findByText("Down.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Restore" })).toBeTruthy();
  });
});
