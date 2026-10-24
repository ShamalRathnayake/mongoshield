/**
 * Page tests for the restore wizard's "Preview changes" step (restore-preview.tsx)
 * against the mock backend: starting the preview from the plan, the summary per
 * namespace with exact and estimated counts, the drill-down to listed `_id`s and to one
 * document's fields side by side, cancelling and leaving a running preview, errors,
 * documents hidden by role, and continuing to the confirmation.
 */

import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PreviewNamespaceView, RestorePreviewView } from "../../shared/api.ts";
import { type FailureRule, renderFailingApp } from "../failing-backend.testkit.tsx";
import { createMockBackend, type MockBackend } from "../mock/backend.ts";
import { renderApp, requestsTo } from "../testing.tsx";
import { describeEffect, describeMetadata, formatValue } from "./restore-preview.tsx";

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

/** Opens the wizard as maya (operator), plans an upsert into Staging, starts the preview. */
async function openPreview(options: { failures?: FailureRule[]; query?: string } = {}) {
  const hash = `#/backups/st-s3/${newestBackupId()}/restore${options.query ?? ""}`;
  const rendered =
    options.failures === undefined
      ? renderApp({ signedInAs: "maya", hash })
      : renderFailingApp({ signedInAs: "maya", hash, failures: options.failures });
  const { user } = rendered;
  await screen.findByRole("heading", { name: "Restore" });
  await user.selectOptions(
    screen.getByLabelText("If a target collection already has data"),
    "upsert",
  );
  await user.click(screen.getByRole("button", { name: "Review plan" }));
  await screen.findByRole("table", { name: "Dry-run plan" });
  return rendered;
}

/** Lets the mock's preview job finish (it takes three ticks). */
function finishJobs(backend: MockBackend) {
  act(() => {
    for (let step = 0; step < 3; step += 1) backend.tickJobs();
  });
}

describe("the preview step", () => {
  it("previews the plan's request, then shows the changes per namespace", async () => {
    const { user, backend } = await openPreview();
    await user.click(screen.getByRole("button", { name: "Preview changes" }));

    const heading = await screen.findByRole("heading", { name: /^Preview: / });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText("Comparing the backup with the target…")).toBeTruthy();
    const [plan] = requestsTo(backend, "POST", "/api/restore/plan");
    const [preview] = requestsTo(backend, "POST", "/api/restore/preview");
    expect(preview?.body).toEqual(plan?.body);

    finishJobs(backend);
    const table = await screen.findByRole("table", { name: "Changes per namespace" });
    const users = within(table).getByText("shop.users").closest("tr") as HTMLElement;
    expect(within(users).getByText("Exact")).toBeTruthy();
    expect(within(users).getByText(/new, .* replaced, 0 deleted, .* unchanged/)).toBeTruthy();
    expect(within(users).getByText("1 index differs")).toBeTruthy();
    expect(users.className).toBe("row-conflict");

    // shop.orders has 1.2M documents: an estimate, said in words and with ≈.
    const orders = within(table).getByText("shop.orders").closest("tr") as HTMLElement;
    expect(within(orders).getByText("Estimate")).toBeTruthy();
    expect(within(orders).getByText(/sample of 1,000 of 1,204,332/)).toBeTruthy();
    expect(within(orders).getAllByText(/^≈ /).length).toBeGreaterThan(0);
    expect(screen.getByText("Some counts are estimates")).toBeTruthy();
    expect(screen.getByText(/namespaces? would change/)).toBeTruthy();
  });

  it("drills down to the listed ids and one document, side by side", async () => {
    const { user, backend } = await openPreview();
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    finishJobs(backend);
    await user.click(await screen.findByRole("button", { name: "Documents of shop.users" }));

    const details = await screen.findByRole("heading", { name: "Documents of shop.users" });
    expect(document.activeElement).toBe(details);
    expect(screen.getByRole("button", { name: "Documents of shop.users" })).toHaveProperty(
      "ariaPressed",
      "true",
    );
    expect(screen.getByText("email_1")).toBeTruthy();
    const ids = await screen.findByRole("list", { name: "Changed: ids" });
    const buttons = within(ids).getAllByRole("button");
    expect(buttons).toHaveLength(10);

    // Twenty ids are listed: two pages.
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      within(await screen.findByRole("list", { name: "Changed: ids" })).getAllByRole("button"),
    ).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/keeps the first 20 ids/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Previous" }));

    const first = within(await screen.findByRole("list", { name: "Changed: ids" })).getAllByRole(
      "button",
    )[0] as HTMLElement;
    expect(first.textContent).toMatch(/^_id ObjectId\("65/);
    await user.click(first);
    const document_ = await screen.findByRole("heading", { name: /^Document _id ObjectId/ });
    expect(document.activeElement).toBe(document_);
    const fields = screen.getByRole("table", { name: "Fields that differ" });
    const name = within(fields).getByText("name").closest("tr") as HTMLElement;
    expect(within(name).getByText("Changed")).toBeTruthy();
    expect(within(name).getByText(/\(edited\)$/)).toBeTruthy();
    const secret = within(fields).getByText("passwordHash").closest("tr") as HTMLElement;
    expect(within(secret).getAllByText("hidden")).toHaveLength(2);
    expect(screen.getByText(/look like secrets/)).toBeTruthy();
    expect(screen.getByText("In the target now (shop.users)")).toBeTruthy();
    expect(screen.getByText("In the backup (shop.users)")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/restore/preview/")[0]?.body).toMatchObject({
      ns: "shop.users",
    });
  });

  it("shows documents only on one side, and empty categories", async () => {
    const { user, backend } = await openPreview();
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    finishJobs(backend);
    await user.click(await screen.findByRole("button", { name: "Documents of shop.users" }));
    await screen.findByRole("list", { name: "Changed: ids" });
    await user.selectOptions(screen.getByLabelText("Show documents"), "backup-only");
    const ids = await screen.findByRole("list", { name: "Only in the backup: ids" });
    await user.click(within(ids).getAllByRole("button")[0] as HTMLElement);
    await screen.findByRole("heading", { name: /^Document _id/ });
    expect(screen.getByText("No such document.")).toBeTruthy();
    expect(screen.getAllByText("Only in backup").length).toBeGreaterThan(0);

    // Closing the namespace again.
    await user.click(screen.getByRole("button", { name: "Documents of shop.users" }));
    expect(screen.queryByRole("heading", { name: "Documents of shop.users" })).toBeNull();

    // A sampled namespace cannot list documents only in the target.
    await user.click(screen.getByRole("button", { name: "Documents of shop.orders" }));
    await user.selectOptions(await screen.findByLabelText("Show documents"), "live-only");
    expect(await screen.findByText("No documents in this category")).toBeTruthy();
  });

  it("continues to the confirmation and starts the restore", async () => {
    const { user, backend } = await openPreview();
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    finishJobs(backend);
    await screen.findByRole("table", { name: "Changes per namespace" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("heading", { name: "Confirm restore" });
    expect(document.activeElement).toBe(confirm);
    // Back returns to the finished preview without running it again.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("table", { name: "Changes per namespace" })).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/restore/preview")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Start restore" }));
    expect(await screen.findByRole("heading", { name: "Restore job" })).toBeTruthy();
  });

  it("cancels a running preview, and still lets the restore go on", async () => {
    const { user, backend } = await openPreview();
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    await user.click(await screen.findByRole("button", { name: "Cancel preview" }));
    expect(await screen.findByText("Preview cancelled")).toBeTruthy();
    expect(backend.data.jobs[0]).toMatchObject({ kind: "preview", status: "cancelled" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Confirm restore" })).toBeTruthy();
  });

  it("cancels the preview when going back while it runs", async () => {
    const { user, backend } = await openPreview();
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByRole("heading", { name: /^Preview: / });
    expect(screen.getByRole("button", { name: "Skip the rest" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("table", { name: "Dry-run plan" })).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/jobs/")[0]?.url).toMatch(/\/cancel$/);
  });

  it("explains a preview that could not start or failed", async () => {
    const { user } = await openPreview({
      failures: [
        {
          method: "POST",
          path: "/api/restore/preview",
          status: 403,
          message: "Only admins may preview restores into a production connection.",
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(await screen.findByText("Could not start the preview")).toBeTruthy();
  });

  it("says when the preview failed, from its view", async () => {
    const failed: Partial<RestorePreviewView> = {
      status: "failed",
      documentsVisible: true,
      error: { code: "CONSOLE_PREVIEW_TIMEOUT", message: "The preview took too long." },
    };
    const { user, backend } = await openPreview({
      failures: [{ method: "GET", path: /\/api\/restore\/preview\//, status: 200, body: failed }],
    });
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    finishJobs(backend);
    expect(await screen.findByText("The preview failed")).toBeTruthy();
    expect(screen.getByText(/The preview took too long\./)).toBeTruthy();
  });

  it("hides document contents from roles that may not browse documents", async () => {
    const probe = createMockBackend({ jobTickMs: 0 });
    probe.dispose();
    const hidden: RestorePreviewView = {
      jobId: "job-x",
      status: "succeeded",
      storageId: "st-s3",
      backupId: newestBackupId(),
      targetConnectionId: "conn-staging",
      mode: "upsert",
      documentsVisible: false,
      limits: { sampleAbove: 100_000, sampleSize: 1_000, listedPerCategory: 20, timeoutMs: 1 },
      expiresAt: new Date().toISOString(),
      namespaces: [namespace({ from: "shop.users", to: "shop.copy" })],
    };
    const { user, backend } = await openPreview({
      failures: [{ method: "GET", path: /\/api\/restore\/preview\//, status: 200, body: hidden }],
    });
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    finishJobs(backend);
    expect(await screen.findByText("shop.copy")).toBeTruthy();
    expect(screen.getByText("(new)", { exact: false })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Documents of shop.users" }));
    expect(await screen.findByText("Document contents are hidden for your role")).toBeTruthy();
    expect(screen.queryByLabelText("Show documents")).toBeNull();
  });

  it("shows the server's edge cases: no changes, blocked rows, odd documents", async () => {
    // A conflict: the restore would not run for it, so it has no effect.
    const { effect: _effect, ...blockedNamespace } = namespace({
      from: "shop.orders",
      action: "conflict",
      reason: "the target already has documents",
      identical: true,
    });
    const view: RestorePreviewView = {
      jobId: "job-x",
      status: "succeeded",
      storageId: "st-s3",
      backupId: newestBackupId(),
      targetConnectionId: "conn-staging",
      mode: "upsert",
      documentsVisible: true,
      limits: { sampleAbove: 100_000, sampleSize: 1_000, listedPerCategory: 20, timeoutMs: 1 },
      expiresAt: new Date().toISOString(),
      namespaces: [
        namespace({
          from: "shop.users",
          to: "shop.people",
          targetExists: true,
          action: "upsert",
          documents: { backup: 2, live: 2, backupOnly: 0, liveOnly: 0, changed: 0, identical: 2 },
          effect: { inserted: 0, replaced: 0, deleted: 0, kept: 2 },
          listed: { changed: 0, "backup-only": 0, "live-only": 0 },
          identical: true,
        }),
        blockedNamespace,
      ],
    };
    const { user, backend } = await openPreview({
      failures: [
        { method: "GET", path: /\/api\/restore\/preview\/[\w-]+$/, status: 200, body: view },
        {
          method: "POST",
          path: /\/document$/,
          status: 200,
          body: {
            ns: "shop.users",
            to: "shop.people",
            label: "7",
            fields: [],
            truncated: true,
            documentsOmitted: true,
          },
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    finishJobs(backend);
    expect(await screen.findByText(/The target already matches the backup/)).toBeTruthy();
    const row = screen.getByText("shop.users").closest("tr") as HTMLElement;
    expect(row.className).toBe("");
    expect(within(row).queryByText("(new)", { exact: false })).toBeNull();
    const blocked = screen.getByText("shop.orders").closest("tr") as HTMLElement;
    expect(blocked.className).toBe("row-blocking");
    expect(within(blocked).getByText("Blocked (conflict)")).toBeTruthy();
    expect(within(blocked).getByText("the target already has documents")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Documents of shop.users" }));
    // Nothing listed in any category: the changed ones are shown (none).
    expect((await screen.findByLabelText("Show documents")) as HTMLSelectElement).toHaveProperty(
      "value",
      "changed",
    );
  });

  it("explains documents that differ only in field order, and large ones", async () => {
    const { user, backend } = await openPreview({
      failures: [
        {
          method: "POST",
          path: /\/document$/,
          status: 200,
          body: {
            ns: "shop.users",
            to: "shop.users",
            label: "7",
            fields: [],
            truncated: true,
            documentsOmitted: true,
          },
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    finishJobs(backend);
    await user.click(await screen.findByRole("button", { name: "Documents of shop.users" }));
    const ids = await screen.findByRole("list", { name: "Changed: ids" });
    await user.click(within(ids).getAllByRole("button")[0] as HTMLElement);
    expect(await screen.findByText("No field differs now")).toBeTruthy();
    expect(screen.getByText("More fields differ than are listed here.")).toBeTruthy();
    expect(screen.getByText("The documents are too large to show whole.")).toBeTruthy();
  });

  it("shows request errors at each level", async () => {
    const { user, backend } = await openPreview({
      failures: [
        { method: "GET", path: /\/documents\?/, status: 500, message: "List down.", times: 1 },
        { method: "POST", path: /\/document$/, status: 500, message: "Read down." },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    finishJobs(backend);
    await user.click(await screen.findByRole("button", { name: "Documents of shop.users" }));
    expect(await screen.findByText("Could not list the documents")).toBeTruthy();
    // Choosing another category asks again (the failure was once only).
    await user.selectOptions(screen.getByLabelText("Show documents"), "backup-only");
    const ids = await screen.findByRole("list", { name: "Only in the backup: ids" });
    await user.click(within(ids).getAllByRole("button")[0] as HTMLElement);
    expect(await screen.findByText("Could not open the document")).toBeTruthy();
  });

  it("shows when the preview's result cannot be loaded", async () => {
    const { user, backend } = await openPreview({
      failures: [
        { method: "GET", path: /\/api\/restore\/preview\/[\w-]+$/, status: 500, message: "Gone." },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    finishJobs(backend);
    expect(await screen.findByText("Could not load the preview")).toBeTruthy();
  });

  it("sends typed keys again to open a document, and skipping returns to the plan", async () => {
    const hash = `#/backups/st-s3/${newestBackupId()}/restore`;
    const { user, backend } = renderApp({ signedInAs: "maya", hash });
    await screen.findByRole("heading", { name: "Restore" });
    await user.type(screen.getByLabelText("Passphrase (optional)"), "open sesame please");
    await user.type(screen.getByLabelText("Private key (optional)"), "AGE-SECRET-KEY-1ABC");
    await user.selectOptions(
      screen.getByLabelText("If a target collection already has data"),
      "upsert",
    );
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await user.click(await screen.findByRole("button", { name: "Skip preview" }));
    await screen.findByRole("heading", { name: "Confirm restore" });
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("table", { name: "Dry-run plan" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    finishJobs(backend);
    await user.click(await screen.findByRole("button", { name: "Documents of shop.users" }));
    const ids = await screen.findByRole("list", { name: "Changed: ids" });
    await user.click(within(ids).getAllByRole("button")[0] as HTMLElement);
    await screen.findByRole("table", { name: "Fields that differ" });
    const opened = requestsTo(backend, "POST", "/api/restore/preview/").find((request) =>
      request.url.endsWith("/document"),
    );
    expect(opened?.body).toMatchObject({
      passphrase: "open sesame please",
      identities: ["AGE-SECRET-KEY-1ABC"],
    });
  });

  it("is not offered for selected documents", async () => {
    const { user, backend } = renderApp({
      signedInAs: "maya",
      hash: `#/backups/st-s3/${newestBackupId()}/restore?ns=shop.users&ids=[1,2]`,
    });
    await screen.findByRole("heading", { name: "Restore" });
    expect(screen.getByText("3. Preview changes (not for selected documents)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Confirm restore" })).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/restore/preview")).toHaveLength(0);
  });
});

/** A preview namespace with everything at zero unless given. */
function namespace(overrides: Partial<PreviewNamespaceView>): PreviewNamespaceView {
  return {
    from: "app.users",
    to: "app.users",
    targetExists: false,
    action: "create",
    accuracy: "exact",
    documents: { backup: 3, live: 0, backupOnly: 3, liveOnly: 0, changed: 0, identical: 0 },
    effect: { inserted: 3, replaced: 0, deleted: 0, kept: 0 },
    indexes: { backupOnly: [], liveOnly: [], different: [] },
    options: [],
    listed: { changed: 0, "backup-only": 3, "live-only": 0 },
    identical: false,
    ...overrides,
  };
}

describe("preview helpers", () => {
  it("describes what the restore would do, or why it would not", () => {
    expect(describeEffect(namespace({}))).toBe("3 new, 0 replaced, 0 deleted, 0 unchanged");
    const estimated = namespace({
      accuracy: "sampled",
      effect: { inserted: 1_000, replaced: 20, deleted: 0, kept: 5 },
    });
    expect(describeEffect(estimated)).toBe(
      "≈ 1,000 new, ≈ 20 replaced, ≈ 0 deleted, ≈ 5 unchanged",
    );
    const { effect: _effect, ...blocked } = namespace({ action: "conflict" });
    expect(describeEffect(blocked)).toBe("Blocked (conflict)");
    const { effect: _none, ...skipped } = namespace({ action: "skip" });
    expect(describeEffect(skipped)).toBe("Skipped");
  });

  it("summarizes index and option differences", () => {
    expect(describeMetadata(namespace({}))).toBe("Same");
    expect(
      describeMetadata(
        namespace({
          indexes: { backupOnly: ["a_1"], liveOnly: ["b_1"], different: [] },
          options: ["validator"],
        }),
      ),
    ).toBe("2 indexes, 1 option differ");
    expect(describeMetadata(namespace({ options: ["collation"] }))).toBe("1 option differs");
  });

  it("shows Extended JSON values the way MongoDB users know them", () => {
    expect(formatValue('{"$oid":"65f000000000000000000001"}')).toBe(
      'ObjectId("65f000000000000000000001")',
    );
    expect(formatValue('"text"')).toBe("text");
    expect(formatValue("42")).toBe("42");
    expect(formatValue("not json")).toBe("not json");
    expect(formatValue(undefined)).toBe("");
  });
});
