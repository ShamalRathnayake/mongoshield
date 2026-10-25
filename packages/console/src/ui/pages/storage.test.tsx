/**
 * Page tests for storage locations: adding one (validation, credentials, the automatic
 * test), editing with write-only credentials, removing, the test report in all its
 * outcomes, error paths and what each role may do. The dialog's per-type fields have
 * their own tests (storage-form.test.tsx).
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp, requestsTo } from "../testing.tsx";
import { StorageTestReport } from "./storage.tsx";

describe("storage test report", () => {
  it("shows a spinner while the probe runs", () => {
    render(<StorageTestReport result={undefined} error={undefined} />);
    expect(screen.getByRole("status").textContent).toContain("probe object");
  });

  it("explains a failed test with the server's message and hint", () => {
    render(
      <StorageTestReport
        result={{
          ok: false,
          error: {
            code: "MS_STORAGE_FORBIDDEN",
            message: "Access denied.",
            hint: "Check the IAM policy.",
          },
        }}
        error={undefined}
      />,
    );
    expect(screen.getByText("The storage test failed")).toBeTruthy();
    expect(screen.getByText("Access denied.")).toBeTruthy();
    expect(screen.getByText("Check the IAM policy.")).toBeTruthy();
  });

  it("falls back to a generic message when a failed test carries no error", () => {
    render(<StorageTestReport result={{ ok: false }} error={undefined} />);
    expect(screen.getByText("The probe object could not be written.")).toBeTruthy();
  });

  it("lists supported and unsupported capabilities", () => {
    render(
      <StorageTestReport
        result={{
          ok: true,
          capabilities: { conditionalWrites: true, rangeReads: false, objectLock: true },
        }}
        error={undefined}
      />,
    );
    expect(screen.getByText("Write, read and delete work")).toBeTruthy();
    expect(screen.getByText("Supported")).toBeTruthy();
    expect(screen.getByText("Not supported")).toBeTruthy();
    expect(screen.getByText("Enabled")).toBeTruthy();
  });
});

describe("storage page", () => {
  it("validates the form, then adds a location with credentials and tests it", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/storage" });
    await user.click(await screen.findByRole("button", { name: "Add storage" }));
    const dialog = screen.getByRole("dialog", { name: "Add storage" });

    // Amazon S3 with access keys is preselected; the dialog starts on its first step.
    expect((within(dialog).getByLabelText("Type") as HTMLSelectElement).value).toBe("s3");
    const tab = (name: RegExp) => within(dialog).getByRole("tab", { name });
    expect(tab(/^Location/).getAttribute("aria-selected")).toBe("true");
    // Nothing is flagged before the user tries to move on; Sign in is closed until then.
    expect(within(dialog).queryByText("Enter the bucket name.")).toBeNull();
    expect(tab(/^Sign in/).getAttribute("aria-disabled")).toBe("true");
    expect(tab(/^Sign in/).getAttribute("title")).toBe("Complete “Location” first");
    // Next on the empty location stays there and says what is missing, focus on the name.
    await user.click(within(dialog).getByRole("button", { name: "Next: Sign in" }));
    expect(within(dialog).getByText("Give the storage a name, e.g. “S3 primary”.")).toBeTruthy();
    expect(within(dialog).getByText("Enter the bucket name.")).toBeTruthy();
    expect(tab(/^Location.*\(needs attention\)/).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Name"));
    // The sign-in fields are not flagged: that step was not tried yet.
    expect(within(dialog).queryByText("Enter the access key ID.")).toBeNull();

    await user.type(within(dialog).getByLabelText("Name"), "Archive");
    await user.type(within(dialog).getByLabelText("Bucket"), "archive");
    await user.type(within(dialog).getByLabelText("Folder in the bucket (optional)"), "prod/");
    expect(within(dialog).getByLabelText("Resulting URL").textContent).toBe("s3://archive/prod/");
    await user.click(within(dialog).getByRole("button", { name: "Next: Sign in" }));
    // The location is complete now: its tab has a check mark.
    expect(tab(/^Location.*\(done\)/)).toBeTruthy();
    // Saving without keys flags the sign-in step.
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(within(dialog).getByText("Enter the access key ID.")).toBeTruthy();
    expect(tab(/^Sign in.*\(needs attention\)/).getAttribute("aria-selected")).toBe("true");
    // KEY=value lines are still possible, and still checked.
    await user.click(within(dialog).getByRole("radio", { name: /KEY=value lines/ }));
    await user.type(within(dialog).getByLabelText("Credentials"), "oops");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(within(dialog).getByText("Line 1 is not KEY=value.")).toBeTruthy();
    // Only the sign-in step has a problem now: the flow stays there.
    expect(tab(/^Sign in/).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Credentials"));
    expect(requestsTo(backend, "POST", "/api/storage")).toHaveLength(0);

    await user.click(within(dialog).getByRole("radio", { name: /Access keys/ }));
    await user.type(within(dialog).getByLabelText("Access key ID"), "AKIA1");
    await user.type(within(dialog).getByLabelText("Secret access key"), "s3cret-value");
    expect(within(dialog).getByLabelText("Secret access key")).toHaveProperty("type", "password");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));

    const report = await screen.findByRole("dialog", { name: "Storage test: Archive" });
    expect(await within(report).findByText("Write, read and delete work")).toBeTruthy();
    const [create] = requestsTo(backend, "POST", "/api/storage");
    expect(create?.body).toEqual({
      name: "Archive",
      url: "s3://archive/prod/",
      credentials: { AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "s3cret-value" },
    });
    await user.click(within(report).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByRole("link", { name: "Archive" })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("AKIA1");
    expect(document.body.innerHTML).not.toContain("s3cret-value");
  });

  it("keeps stored credentials on edit unless they are replaced", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/storage" });
    await user.click(await screen.findByRole("button", { name: "Edit S3 primary" }));
    const dialog = screen.getByRole("dialog", { name: 'Edit "S3 primary"' });
    // A saved location opens with both steps complete.
    expect(within(dialog).getByRole("tab", { name: /^Location.*\(done\)/ })).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: /^Sign in.*\(done\)/ })).toBeTruthy();
    await user.click(within(dialog).getByRole("tab", { name: /^Sign in/ }));
    const keep = within(dialog).getByRole("radio", { name: /Keep the stored credentials/ });
    expect(keep).toHaveProperty("checked", true);
    expect(
      within(dialog).getByText(/Stored: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY/),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: /Back/ }));
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "S3 main");
    // Saving is on the last step.
    await user.click(within(dialog).getByRole("button", { name: "Next: Sign in" }));
    await user.click(within(dialog).getByRole("button", { name: "Save and test" }));

    expect(await screen.findByRole("dialog", { name: "Storage test: S3 main" })).toBeTruthy();
    const [update] = requestsTo(backend, "PUT", "/api/storage/st-s3");
    expect(update?.body).toEqual({ name: "S3 main", url: "s3://acme-backups/prod/" });
  });

  it("shows the save error inside the dialog", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      hash: "#/storage",
      failures: [
        {
          method: "POST",
          path: "/api/storage",
          status: 400,
          message: "Unsupported storage URL scheme.",
        },
      ],
    });
    await user.click(await screen.findByRole("button", { name: "Add storage" }));
    const dialog = screen.getByRole("dialog", { name: "Add storage" });
    await user.type(within(dialog).getByLabelText("Name"), "Weird");
    await user.click(within(dialog).getByLabelText("Edit as URL (advanced)"));
    await user.clear(within(dialog).getByLabelText("Location URL"));
    // A scheme the console cannot write to is refused right here.
    await user.type(within(dialog).getByLabelText("Location URL"), "ftp://x");
    await user.click(within(dialog).getByRole("button", { name: "Next: Sign in" }));
    expect(
      within(dialog).getByText(
        "Use s3://, gs://, az://, sftp:// or a folder in the console's data volume.",
      ),
    ).toBeTruthy();
    // One the browser cannot tell is wrong goes to the server, which refuses it here.
    await user.clear(within(dialog).getByLabelText("Location URL"));
    await user.type(within(dialog).getByLabelText("Location URL"), "s3://x/?odd=1");
    await user.click(within(dialog).getByRole("button", { name: "Next: Sign in" }));
    await user.click(within(dialog).getByRole("radio", { name: /The console's environment/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    // Shown on the step the save was made from, above its button.
    const failure = await within(dialog).findByText("Could not save");
    expect(within(dialog).getByText("Unsupported storage URL scheme.")).toBeTruthy();
    expect(failure.closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(false);
  });

  it("saves a local folder from the first step, shows a failure there, and cancels", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      hash: "#/storage",
      failures: [{ method: "POST", path: "/api/storage", status: 400, message: "Disk full." }],
    });
    await user.click(await screen.findByRole("button", { name: "Add storage" }));
    const dialog = screen.getByRole("dialog", { name: "Add storage" });
    await user.type(within(dialog).getByLabelText("Name"), "Here");
    await user.selectOptions(within(dialog).getByLabelText("Type"), "local");
    await user.type(within(dialog).getByLabelText("Folder"), "backups");
    // No credentials to ask for: "Sign in" is locked and saving happens on "Location".
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    const failure = await within(dialog).findByText("Disk full.");
    expect(failure.closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(false);
    // The flow's Cancel closes the dialog without saving.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses to remove a location a plan still writes to", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/storage" });
    await user.click(await screen.findByRole("button", { name: "Remove S3 primary" }));
    const dialog = screen.getByRole("dialog", { name: 'Remove "S3 primary"?' });
    await user.click(within(dialog).getByRole("button", { name: "Remove storage" }));
    expect(await screen.findByText(/This storage location is used by a backup plan/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.data.storage.some((storage) => storage.id === "st-s3")).toBe(true);
  });

  it("closes the remove dialog on cancel without removing anything", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/storage" });
    await user.click(await screen.findByRole("button", { name: "Remove R2 offsite" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requestsTo(backend, "DELETE", "/api/storage")).toHaveLength(0);
  });

  it("removes a location that no plan uses", async () => {
    const { user, backend } = renderApp({
      signedInAs: "admin",
      hash: "#/storage",
      prepare: (mock) => {
        mock.data.storage.push({
          id: "st-spare",
          name: "Spare",
          url: "/data/spare",
          credentials: {},
          createdAt: new Date().toISOString(),
          objectLock: false,
        });
      },
    });
    await user.click(await screen.findByRole("button", { name: "Remove Spare" }));
    const dialog = screen.getByRole("dialog", { name: 'Remove "Spare"?' });
    await user.click(within(dialog).getByRole("button", { name: "Remove storage" }));
    expect(await screen.findByText('Removed "Spare". Its backups were not deleted.')).toBeTruthy();
    expect(backend.data.storage.some((storage) => storage.id === "st-spare")).toBe(false);
  });

  it("reports a test that could not run at all", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: "#/storage",
      failures: [{ method: "POST", path: /\/test$/, status: 502, message: "Storage unreachable." }],
    });
    await user.click(await screen.findByRole("button", { name: "Test S3 primary" }));
    const report = screen.getByRole("dialog", { name: "Storage test: S3 primary" });
    expect(await within(report).findByText("The test could not run")).toBeTruthy();
    expect(within(report).getByText("Storage unreachable.")).toBeTruthy();
  });

  it("lets operators test but not edit, and viewers do neither", async () => {
    renderApp({ signedInAs: "maya", hash: "#/storage" });
    expect(await screen.findByRole("button", { name: "Test S3 primary" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit S3 primary" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add storage" })).toBeNull();
  });

  it("shows viewers the list without actions", async () => {
    renderApp({ signedInAs: "sam", hash: "#/storage" });
    expect(await screen.findByRole("table", { name: "Storage locations" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Test S3 primary" })).toBeNull();
  });

  it("shows an empty state without locations", async () => {
    renderApp({
      signedInAs: "admin",
      hash: "#/storage",
      prepare: (mock) => {
        mock.data.storage = [];
      },
    });
    expect(await screen.findByText("No storage yet")).toBeTruthy();
  });

  it("shows a load error with a retry that recovers", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      hash: "#/storage",
      failures: [{ method: "GET", path: "/api/storage", status: 500, times: 1, message: "Boom." }],
    });
    expect(await screen.findByText("Boom.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Storage locations" })).toBeTruthy();
  });
});
