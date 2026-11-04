/**
 * Page tests for single sign-on on the login page: the OIDC link, the explanation of
 * every `sso_error` code the server can send back, and SSO-only / proxy-only consoles.
 */

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OIDC_ERROR_CODES, OIDC_LOGIN_PATH } from "../../shared/api.ts";
import { renderApp } from "../testing.tsx";
import { cookieLostOverHttp, ssoErrorMessage } from "./login.tsx";

describe("single sign-on on the login page", () => {
  it("offers a plain link to the OIDC login endpoint next to the password form", async () => {
    renderApp({ authMethods: ["password", "oidc"] });
    const link = await screen.findByRole("link", { name: "Sign in with single sign-on" });
    // A real navigation: the server redirects to the identity provider.
    expect(link.getAttribute("href")).toBe(`.${OIDC_LOGIN_PATH}`);
    expect(link.className).toContain("button-secondary");
    expect(screen.getByLabelText("Username")).toBeTruthy();
  });

  it("shows only the SSO link when passwords are not accepted", async () => {
    renderApp({ authMethods: ["oidc"] });
    const link = await screen.findByRole("link", { name: "Sign in with single sign-on" });
    expect(link.className).toContain("button-primary");
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("explains a proxy-only console without offering any form", async () => {
    renderApp({ authMethods: ["proxy"] });
    expect(await screen.findByText("Signed in by your proxy")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in with single sign-on" })).toBeNull();
  });

  it("offers no SSO link on a password-only console", async () => {
    renderApp();
    await screen.findByLabelText("Username");
    expect(screen.queryByRole("link", { name: "Sign in with single sign-on" })).toBeNull();
  });

  it("explains a failed sign-in sent back by the server", async () => {
    renderApp({
      authMethods: ["password", "oidc"],
      hash: "#/?sso_error=CONSOLE_OIDC_NOT_PROVISIONED",
    });
    expect(await screen.findByText("Single sign-on failed")).toBeTruthy();
    expect(screen.getByText(/There is no console account for you yet/)).toBeTruthy();
  });

  it("has a distinct explanation for every error code", () => {
    const messages = OIDC_ERROR_CODES.map((code) => ssoErrorMessage(`#/?sso_error=${code}`));
    expect(new Set(messages).size).toBe(OIDC_ERROR_CODES.length);
    for (const message of messages) expect(message).toEqual(expect.any(String));
  });

  it("uses a generic message for unknown codes and nothing without a code", () => {
    expect(ssoErrorMessage("#/?sso_error=<script>")).toMatch(/did not complete/);
    expect(ssoErrorMessage("#/")).toBeUndefined();
    expect(ssoErrorMessage("")).toBeUndefined();
  });
});

describe("plain HTTP on the login page", () => {
  const lan = { protocol: "http:", hostname: "192.168.1.20" };

  it("warns when the Secure session cookie would be dropped over plain HTTP", () => {
    expect(cookieLostOverHttp({ cookieSecure: true }, lan)).toBe(true);
    // Older servers do not say; Secure is their default too.
    expect(cookieLostOverHttp({}, lan)).toBe(true);
  });

  it("does not warn on localhost, over HTTPS, or when cookies are not Secure", () => {
    expect(
      cookieLostOverHttp({ cookieSecure: true }, { protocol: "http:", hostname: "localhost" }),
    ).toBe(false);
    expect(
      cookieLostOverHttp(
        { cookieSecure: true },
        { protocol: "https:", hostname: "backups.example.com" },
      ),
    ).toBe(false);
    expect(cookieLostOverHttp({ cookieSecure: false }, lan)).toBe(false);
  });
});
