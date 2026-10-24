/**
 * Page tests for storage locations: adding one (validation, credentials parsing, the
 * automatic test), editing with write-only credentials, removing, the test report in
 * all its outcomes, error paths and what each role may do.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp, requestsTo } from "../testing.tsx";
import { parseCredentials, StorageTestReport } from "./storage.tsx";

describe("parseCredentials", () => {
  it("reads KEY=value lines and skips blank lines and comments", () => {
    expect(
      parseCredentials("# a comment\n\nAWS_ACCESS_KEY_ID = abc \nAWS_SECRET_ACCESS_KEY=x=y"),
    ).toEqual({
      AWS_ACCESS_KEY_ID: "abc",
      AWS_SECRET_ACCESS_KEY: "x=y",
    });
  });

  it("names the first line that is not KEY=value", () => {
    expect(parseCredentials("A=1\nnot a pair")).toBe("Line 2 is not KEY=value.");
    expect(parseCredentials("=value")).toBe("Line 1 is not KEY=value.");
  });
});

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

    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(within(dialog).getByText("Give the storage a name, e.g. “S3 primary”.")).toBeTruthy();
    expect(within(dialog).getByText(/Enter a URL such as/)).toBeTruthy();

    await user.type(within(dialog).getByLabelText("Name"), "Archive");
    await user.type(within(dialog).getByLabelText("Location"), "s3://archive/prod/");
    await user.type(within(dialog).getByLabelText("Credentials"), "oops");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(within(dialog).getByText("Line 1 is not KEY=value.")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/storage")).toHaveLength(0);

    await user.clear(within(dialog).getByLabelText("Credentials"));
    await user.type(within(dialog).getByLabelText("Credentials"), "AWS_ACCESS_KEY_ID=AKIA1");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));

    const report = await screen.findByRole("dialog", { name: "Storage test: Archive" });
    expect(await within(report).findByText("Write, read and delete work")).toBeTruthy();
    const [create] = requestsTo(backend, "POST", "/api/storage");
    expect(create?.body).toEqual({
      name: "Archive",
      url: "s3://archive/prod/",
      credentials: { AWS_ACCESS_KEY_ID: "AKIA1" },
    });
    await user.click(within(report).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByRole("link", { name: "Archive" })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("AKIA1");
  });

  it("keeps stored credentials when the credentials box is left empty on edit", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/storage" });
    await user.click(await screen.findByRole("button", { name: "Edit S3 primary" }));
    const dialog = screen.getByRole("dialog", { name: 'Edit "S3 primary"' });
    expect(within(dialog).getByText(/Leave empty to keep them/)).toBeTruthy();
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "S3 main");
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
    await user.type(within(dialog).getByLabelText("Location"), "ftp://x");
    await user.click(within(dialog).getByRole("button", { name: "Add and test" }));
    expect(await within(dialog).findByText("Could not save")).toBeTruthy();
    expect(within(dialog).getByText("Unsupported storage URL scheme.")).toBeTruthy();
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
