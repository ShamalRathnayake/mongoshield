/**
 * Authentication and HTTP security of the console API: setup token lifecycle,
 * login/logout, sessions, CSRF, the origin check, rate limiting, proxy auth,
 * security headers and body handling.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  removeDataDir,
  setupAdmin,
  startConsole,
  TEST_PASSWORD,
  TestClock,
  type TestConsole,
  userWithRole,
} from "../helpers/console.ts";

const opened: TestConsole[] = [];
async function open(...args: Parameters<typeof startConsole>): Promise<TestConsole> {
  const testConsole = await startConsole(...args);
  opened.push(testConsole);
  return testConsole;
}

afterEach(async () => {
  for (const testConsole of opened.splice(0)) {
    await testConsole.close().catch(() => undefined);
    await removeDataDir(testConsole.dataDir);
  }
});

describe("setup token", () => {
  it("reports that setup is pending and accepts the token exactly once", async () => {
    const testConsole = await open();
    expect(testConsole.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const client = testConsole.client();

    const before = await client.request("GET", "/api/session");
    expect(before.body).toEqual({
      setupComplete: false,
      authMethods: ["password"],
      // Tests open consoles without a setup window: the token is required.
      setup: { tokenRequired: true },
    });

    const setup = await client.request("POST", "/api/setup", {
      token: testConsole.setupToken,
      username: "admin",
      password: TEST_PASSWORD,
    });
    expect(setup.status).toBe(200);
    expect(setup.body.setupComplete).toBe(true);
    expect(setup.body.user).toMatchObject({ username: "admin", role: "admin" });
    expect(setup.body.csrfToken).toEqual(expect.any(String));

    const again = await testConsole.client().request("POST", "/api/setup", {
      token: testConsole.setupToken,
      username: "mallory",
      password: TEST_PASSWORD,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONSOLE_SETUP_DONE");
  });

  it("rejects a wrong token", async () => {
    const testConsole = await open();
    const response = await testConsole.client().request("POST", "/api/setup", {
      token: "not-the-token",
      username: "admin",
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("CONSOLE_SETUP_TOKEN_INVALID");
  });

  it("expires the token after 24 hours", async () => {
    const clock = new TestClock();
    const testConsole = await open({ clock });
    clock.advance(24 * 60 * 60 * 1000 + 1);
    const response = await testConsole.client().request("POST", "/api/setup", {
      token: testConsole.setupToken,
      username: "admin",
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(401);
  });

  it("issues a new token at each start until setup is done, invalidating the old one", async () => {
    const first = await open();
    const oldToken = first.setupToken;
    await first.close();
    const second = await open({ dataDir: first.dataDir });
    expect(second.setupToken).toBeDefined();
    expect(second.setupToken).not.toBe(oldToken);
    const stale = await second.client().request("POST", "/api/setup", {
      token: oldToken,
      username: "admin",
      password: TEST_PASSWORD,
    });
    expect(stale.status).toBe(401);
  });

  it("requires a strong enough password for the first admin", async () => {
    const testConsole = await open();
    const response = await testConsole.client().request("POST", "/api/setup", {
      token: testConsole.setupToken,
      username: "admin",
      password: "short",
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("CONSOLE_VALIDATION");
  });
});

describe("login and sessions", () => {
  it("logs in, sets a hardened cookie, and logs out", async () => {
    const testConsole = await open({ settings: { cookieSecure: true } });
    await setupAdmin(testConsole);
    const client = testConsole.client();

    const login = await client.login("admin");
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-mongoshield_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);

    const session = await client.session();
    expect(session.user?.username).toBe("admin");
    expect(session.user?.lastLoginAt).toBeDefined();

    const logout = await client.request("DELETE", "/api/session");
    expect(logout.status).toBe(200);
    expect((await client.session()).user).toBeUndefined();
  });

  it("gives the same answer for unknown users and wrong passwords", async () => {
    const testConsole = await open();
    await setupAdmin(testConsole);
    const wrongPassword = await testConsole.client().login("admin", "wrong password!!");
    const unknownUser = await testConsole.client().login("nobody", "wrong password!!");
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownUser.body);
  });

  it("rate-limits failed logins per username", async () => {
    const testConsole = await open();
    await setupAdmin(testConsole);
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await testConsole.client().login("admin", "wrong password!!")).status).toBe(401);
    }
    const blocked = await testConsole.client().login("admin");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("CONSOLE_RATE_LIMITED");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("ends a session after 12 idle hours", async () => {
    const clock = new TestClock();
    const testConsole = await open({ clock });
    const admin = await setupAdmin(testConsole);
    clock.advance(11 * 60 * 60 * 1000);
    expect((await admin.session()).user).toBeDefined();
    // Activity refreshed the idle timer: 11 more hours are still fine.
    clock.advance(11 * 60 * 60 * 1000);
    expect((await admin.session()).user).toBeDefined();
    clock.advance(12 * 60 * 60 * 1000 + 1);
    expect((await admin.session()).user).toBeUndefined();
  });

  it("stores only hashes of session ids", async () => {
    const testConsole = await open();
    await setupAdmin(testConsole);
    const client = testConsole.client();
    const login = await client.login("admin");
    const token = (login.headers.get("set-cookie") ?? "").split(";")[0]?.split("=")[1] ?? "";
    expect(token.length).toBeGreaterThan(40);
    const state = JSON.stringify(testConsole.services.store.current);
    expect(state).not.toContain(token);
  });

  it("signs a user out everywhere when an admin changes their password", async () => {
    const testConsole = await open();
    const admin = await setupAdmin(testConsole);
    const viewer = await userWithRole(testConsole, admin, "viewer", "vera");
    const id = (await viewer.session()).user?.id;
    const update = await admin.request("PUT", `/api/users/${id}`, {
      username: "vera",
      role: "viewer",
      password: "a brand new password",
    });
    expect(update.status).toBe(200);
    expect((await viewer.session()).user).toBeUndefined();
    expect((await testConsole.client().login("vera", "a brand new password")).status).toBe(200);
  });
});

describe("CSRF and origin checks", () => {
  it("refuses state-changing requests without the CSRF token", async () => {
    const testConsole = await open();
    const admin = await setupAdmin(testConsole);
    const body = { username: "x-user", role: "viewer", password: TEST_PASSWORD };
    const missing = await admin.request("POST", "/api/users", body, { csrf: false });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe("CONSOLE_CSRF");
    const wrong = await admin.request("POST", "/api/users", body, { csrf: "forged" });
    expect(wrong.status).toBe(403);
    expect((await admin.request("POST", "/api/users", body)).status).toBe(200);
  });

  it("does not accept another session's CSRF token", async () => {
    const testConsole = await open();
    const admin = await setupAdmin(testConsole);
    const other = testConsole.client();
    await other.login("admin");
    expect(other.csrfToken).not.toBe(admin.csrfToken);
    const response = await admin.request(
      "POST",
      "/api/users",
      { username: "y-user", role: "viewer", password: TEST_PASSWORD },
      { csrf: other.csrfToken ?? "" },
    );
    expect(response.status).toBe(403);
  });

  it("refuses cross-site requests by their Origin header, even for login", async () => {
    const testConsole = await open();
    await setupAdmin(testConsole);
    const response = await testConsole
      .client()
      .request(
        "POST",
        "/api/session",
        { username: "admin", password: TEST_PASSWORD },
        { headers: { origin: "https://evil.example", host: "console.local" } },
      );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("CONSOLE_BAD_ORIGIN");
    const sameSite = await testConsole
      .client()
      .request(
        "POST",
        "/api/session",
        { username: "admin", password: TEST_PASSWORD },
        { headers: { origin: "http://console.local", host: "console.local" } },
      );
    expect(sameSite.status).toBe(200);
  });

  it("only accepts JSON bodies", async () => {
    const testConsole = await open();
    await setupAdmin(testConsole);
    const response = await testConsole.app.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=admin&password=x",
    });
    expect(response.status).toBe(415);
  });

  it("limits request bodies to 64 KiB", async () => {
    const testConsole = await open();
    const admin = await setupAdmin(testConsole);
    const response = await admin.request("POST", "/api/connections", {
      name: "big",
      uri: `mongodb://localhost/${"x".repeat(70 * 1024)}`,
      production: false,
    });
    expect(response.status).toBe(413);
  });
});

describe("security headers and errors", () => {
  it("sets a strict CSP and the other security headers", async () => {
    const testConsole = await open();
    const response = await testConsole.client().request("GET", "/api/session");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("sends HSTS when served over TLS", async () => {
    const testConsole = await open({ settings: { https: true } });
    const response = await testConsole.client().request("GET", "/healthz");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("answers unknown API paths with a JSON 404", async () => {
    const testConsole = await open();
    const response = await testConsole.client().request("GET", "/api/nope");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("CONSOLE_NOT_FOUND");
  });

  it("serves /healthz without authentication", async () => {
    const testConsole = await open();
    const response = await testConsole.client().request("GET", "/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});

describe("trusted reverse proxy", () => {
  const proxySecret = "proxy-secret-0123456789abcdef0123456789";

  it("signs in proxy users only with the shared secret, as viewers first", async () => {
    const testConsole = await open({ settings: { proxySecret } });
    await setupAdmin(testConsole);
    const client = testConsole.client();

    const headerOnly = await client.request("GET", "/api/session", undefined, {
      headers: { "x-forwarded-user": "admin" },
    });
    expect(headerOnly.body.user).toBeUndefined();

    const wrongSecret = await client.request("GET", "/api/session", undefined, {
      headers: { "x-forwarded-user": "admin", "x-mongoshield-proxy-secret": "wrong" },
    });
    expect(wrongSecret.status).toBe(401);

    const proxied = { "x-forwarded-user": "pat", "x-mongoshield-proxy-secret": proxySecret };
    const session = await client.request("GET", "/api/session", undefined, { headers: proxied });
    expect(session.body.user).toMatchObject({ username: "pat", role: "viewer" });
    expect(session.body.authMethods).toContain("proxy");

    // Proxy logins need the CSRF token too.
    const noCsrf = await client.request("DELETE", "/api/session", undefined, {
      headers: proxied,
      csrf: false,
    });
    expect(noCsrf.status).toBe(403);
    // A viewer may not create users.
    const create = await client.request(
      "POST",
      "/api/users",
      { username: "x", role: "admin", password: TEST_PASSWORD },
      { headers: proxied },
    );
    expect(create.status).toBe(403);
  });
});

describe("metrics", () => {
  const metricsToken = "metrics-token-0123456789abcdef01234567";

  it("is disabled without a token", async () => {
    const testConsole = await open();
    expect((await testConsole.client().request("GET", "/metrics")).status).toBe(404);
  });

  it("requires the bearer token and serves Prometheus text", async () => {
    const testConsole = await open({ settings: { metricsToken } });
    const client = testConsole.client();
    expect((await client.request("GET", "/metrics")).status).toBe(401);
    const response = await client.request("GET", "/metrics", undefined, {
      headers: { authorization: `Bearer ${metricsToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.text).toContain("mongoshield_console_jobs_running 0");
  });
});
