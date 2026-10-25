/**
 * Page tests for signing in, first-run setup and session expiry, against the mock API.
 */

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";

describe("login", () => {
  it("shows the login page when not signed in, rejects a wrong password, then signs in", async () => {
    const { user, backend } = renderApp();
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Wrong username or password.")).toBeTruthy();
    // The password field is cleared after a failure.
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");

    await user.type(screen.getByLabelText("Password"), "admin");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/session")).toHaveLength(2);
  });

  it("asks for both fields before contacting the server", async () => {
    const { user, backend } = renderApp();
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter your username and password.")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/session")).toHaveLength(0);
  });

  it("signs out back to the login page", async () => {
    const { user } = renderApp({ signedInAs: "admin" });
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in to MongoShield" })).toBeTruthy();
  });

  it("hides admin-only navigation from viewers", async () => {
    renderApp({ signedInAs: "sam" });
    await screen.findByRole("heading", { name: "Overview" });
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
    expect(screen.getByRole("link", { name: "Audit log" })).toBeTruthy();
  });
});

describe("setup", () => {
  it("creates the first admin with the token from the setup link and signs in", async () => {
    const { user, backend } = renderApp({
      setupComplete: false,
      setupWindow: false,
      hash: "#/setup?token=mock-setup-token",
    });
    const token = (await screen.findByLabelText("Setup token")) as HTMLInputElement;
    expect(token.value).toBe("mock-setup-token");

    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Create account and continue" }));
    expect(screen.getByText("Use at least 12 characters.")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/setup")).toHaveLength(0);

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "a long passphrase");
    await user.click(screen.getByRole("button", { name: "Create account and continue" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    // The single-use token is removed from the address bar.
    expect(window.location.href).not.toContain("mock-setup-token");
  });

  it("explains a rejected token, even while the setup window is open", async () => {
    const { user } = renderApp({ setupComplete: false, hash: "#/setup?token=stale" });
    expect(await screen.findByLabelText("Setup token (optional)")).toBeTruthy();
    await user.type(screen.getByLabelText("Password"), "a long passphrase");
    await user.click(screen.getByRole("button", { name: "Create account and continue" }));
    expect(await screen.findByText(/invalid or has expired/)).toBeTruthy();
  });

  it("needs no token within the setup window, and says who may set it up", async () => {
    const { user, backend } = renderApp({ setupComplete: false });
    expect(await screen.findByText("First come, first served")).toBeTruthy();
    expect(screen.queryByLabelText(/Setup token/)).toBeNull();
    await user.type(screen.getByLabelText("Password"), "a long passphrase");
    await user.click(screen.getByRole("button", { name: "Create account and continue" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    const [request] = requestsTo(backend, "POST", "/api/setup");
    expect(request?.body).toEqual({ username: "admin", password: "a long passphrase" });
  });

  it("still takes a token during the window when the user has one", async () => {
    const { user, backend } = renderApp({ setupComplete: false });
    await user.click(await screen.findByRole("button", { name: "I have a setup token" }));
    await user.type(screen.getByLabelText("Setup token (optional)"), "mock-setup-token");
    await user.type(screen.getByLabelText("Password"), "a long passphrase");
    await user.click(screen.getByRole("button", { name: "Create account and continue" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/setup")[0]?.body).toMatchObject({
      token: "mock-setup-token",
    });
  });
});
