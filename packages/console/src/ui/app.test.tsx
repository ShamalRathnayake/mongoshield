/**
 * Tests for the app shell: the session load and its error, an expired session dropping
 * back to the login page, the theme toggle, the skip link, mock mode, page titles and
 * route resolution, plus the setup page's own validation.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./api.ts";
import { App, focusHeadingWhenRendered, resolveRoute } from "./app.tsx";
import { renderFailingApp } from "./failing-backend.testkit.tsx";
import { createMockBackend } from "./mock/backend.ts";
import { renderApp } from "./testing.tsx";

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("resolveRoute", () => {
  it("matches specific patterns before general ones and knows unknown paths", () => {
    expect(resolveRoute("/plans/new")?.route.title).toBe("New plan");
    expect(resolveRoute("/plans/abc")?.params).toEqual({ id: "abc" });
    expect(resolveRoute("/backups/s/b/restore")?.route.role).toBe("operator");
    expect(resolveRoute("/nope")).toBeUndefined();
  });
});

describe("focusHeadingWhenRendered", () => {
  /** A `main` whose heading arrives later, like a page that is still loading. */
  function loadingMain(): HTMLElement {
    const main = document.createElement("main");
    document.body.append(main);
    return main;
  }

  function heading(): HTMLElement {
    const element = document.createElement("h1");
    element.tabIndex = -1;
    element.textContent = "Restore";
    return element;
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("focuses the heading once the page has rendered it", async () => {
    const main = loadingMain();
    const stop = focusHeadingWhenRendered(main);
    const title = heading();
    main.append(title);
    await waitFor(() => expect(document.activeElement).toBe(title));
    stop();
  });

  it("leaves focus alone when the user moved it while the page was loading", async () => {
    const main = loadingMain();
    const field = document.createElement("input");
    document.body.append(field);
    const stop = focusHeadingWhenRendered(main);
    field.focus();
    main.append(heading());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(field);
    stop();
  });
});

describe("app shell", () => {
  it("explains when the server cannot be reached and retries", async () => {
    const { user } = renderFailingApp({
      failures: [{ method: "GET", path: "/api/session", status: "network", times: 1 }],
    });
    expect(await screen.findByText("Cannot reach the console server")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Sign in to MongoShield" })).toBeTruthy();
  });

  it("sends the user back to sign in when the session expires", async () => {
    renderFailingApp({
      signedInAs: "admin",
      hash: "#/plans",
      failures: [
        { method: "GET", path: "/api/plans", status: 401, code: "CONSOLE_UNAUTHENTICATED" },
      ],
    });
    expect(await screen.findByText("Your session has expired. Sign in again.")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Sign in to MongoShield" })).toBeTruthy();
  });

  it("cycles the theme and remembers it", async () => {
    const { user } = renderApp({ signedInAs: "sam" });
    await user.click(await screen.findByRole("button", { name: "Theme: dark. Change theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("mongoshield.theme")).toBe("light");
    await user.click(screen.getByRole("button", { name: "Theme: light. Change theme" }));
    expect(document.documentElement.dataset.theme).toBe("system");
    await user.click(screen.getByRole("button", { name: "Theme: system. Change theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    // Dark is the default, so nothing needs remembering.
    expect(window.localStorage.getItem("mongoshield.theme")).toBeNull();
  });

  it("moves focus to the main area with the skip link and titles the page", async () => {
    const { user } = renderApp({ signedInAs: "sam", hash: "#/jobs" });
    await screen.findByRole("heading", { name: "Jobs", level: 1 });
    await waitFor(() => expect(document.title).toBe("Jobs · MongoShield"));
    await user.click(screen.getByRole("button", { name: "Skip to content" }));
    expect(document.activeElement?.id).toBe("main");
    window.location.hash = "#/missing";
    await waitFor(() => expect(document.title).toBe("Not found · MongoShield"));
  });

  it("marks the current section in the navigation, also for ?storage= links", async () => {
    renderApp({ signedInAs: "sam", hash: "#/backups?storage=st-r2" });
    expect(await screen.findByRole("table", { name: "Backups in R2 offsite" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Backups" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows the mock badge and sign-in hint in mock mode", async () => {
    const backend = createMockBackend({ jobTickMs: 0 });
    const client = new ApiClient({
      fetch: backend.fetch,
      openEventSource: backend.openEventSource,
    });
    window.location.hash = "";
    const user = userEvent.setup();
    render(<App client={client} mock />);
    expect(await screen.findByText("Mock mode")).toBeTruthy();
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "admin");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Mock data")).toBeTruthy();
    backend.dispose();
  });
});

describe("setup page", () => {
  it("explains that the token is needed once the window has closed, and validates every field", async () => {
    const { user, backend } = renderApp({ setupComplete: false, setupWindow: false });
    expect(await screen.findByText("Setup token needed")).toBeTruthy();
    await user.clear(screen.getByLabelText("User name"));
    await user.click(screen.getByRole("button", { name: "Create account and continue" }));
    expect(
      screen.getByText("Paste the token from the setup link in the console's log."),
    ).toBeTruthy();
    expect(screen.getByText("Choose a user name.")).toBeTruthy();
    expect(screen.getByText(/Use at least \d+ characters/)).toBeTruthy();
    // "Show password" reveals what was typed instead of asking for it twice.
    await user.type(screen.getByLabelText("Password"), "a long enough password");
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    await user.click(screen.getByLabelText("Show password"));
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("text");
    expect(backend.requests.some((request) => request.url === "/api/setup")).toBe(false);
  });
});
