/**
 * Page tests for user management: the sign-in method column, creating password and
 * SSO-only accounts, editing, deleting, and validation.
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";

describe("users", () => {
  it("lists users with their role and sign-in method", async () => {
    renderApp({ signedInAs: "admin", hash: "#/users" });
    const table = await screen.findByRole("table", { name: "Users" });
    expect(within(table).getAllByText("Password")).toHaveLength(3);
    expect(within(table).getByText("(you)")).toBeTruthy();
    // You cannot delete yourself.
    expect(
      (within(table).getByRole("button", { name: "Delete admin" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("requires a strong initial password when single sign-on is off", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/users" });
    await user.click(await screen.findByRole("button", { name: "Add user" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText("Enter a username.")).toBeTruthy();
    expect(within(dialog).getByText("Set an initial password.")).toBeTruthy();

    await user.type(within(dialog).getByLabelText("Username"), "riley");
    await user.type(within(dialog).getByLabelText("Initial password"), "short");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText("Use at least 12 characters.")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/users")).toHaveLength(0);

    await user.clear(within(dialog).getByLabelText("Initial password"));
    await user.type(within(dialog).getByLabelText("Initial password"), "a long passphrase");
    await user.selectOptions(within(dialog).getByLabelText("Role"), "operator");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved riley.")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/users")[0]?.body).toEqual({
      username: "riley",
      role: "operator",
      password: "a long passphrase",
    });
  });

  it("creates an SSO-only account without a password when single sign-on is on", async () => {
    const { user, backend } = renderApp({
      signedInAs: "admin",
      hash: "#/users",
      authMethods: ["password", "oidc"],
    });
    await user.click(await screen.findByRole("button", { name: "Add user" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/leave empty for an account that signs in only/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Username"), "jo@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved jo@example.com.")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/users")[0]?.body).toEqual({
      username: "jo@example.com",
      role: "viewer",
    });
    const table = screen.getByRole("table", { name: "Users" });
    expect(within(table).getByText("Single sign-on")).toBeTruthy();
  });

  it("edits a user and keeps the password when the field is empty", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/users" });
    await user.click(await screen.findByRole("button", { name: "Edit sam" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Leave empty to keep the current password.")).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText("Role"), "operator");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved sam.")).toBeTruthy();
    expect(requestsTo(backend, "PUT", "/api/users/user-sam")[0]?.body).toEqual({
      username: "sam",
      role: "operator",
    });
  });

  it("shows a server error inside the dialog", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/users" });
    await user.click(await screen.findByRole("button", { name: "Add user" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Username"), "maya");
    await user.type(within(dialog).getByLabelText("Initial password"), "a long passphrase");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Could not save")).toBeTruthy();
    expect(within(dialog).getByText(/already exists/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("deletes a user after confirmation", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/users" });
    await user.click(await screen.findByRole("button", { name: "Delete sam" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete sam?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete user" }));
    expect(await screen.findByText("Deleted sam.")).toBeTruthy();
    expect(backend.data.users.some((candidate) => candidate.username === "sam")).toBe(false);
  });

  it("cancels a deletion", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/users" });
    await user.click(await screen.findByRole("button", { name: "Delete maya" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete maya?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(requestsTo(backend, "DELETE", "/api/users")).toHaveLength(0);
  });
});
