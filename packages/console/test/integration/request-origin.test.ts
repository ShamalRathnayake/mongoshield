/**
 * Where requests come from, and what the console does about it: the Host allow-list
 * against DNS rebinding (the token-less setup window is the prize), trusted reverse
 * proxies (X-Forwarded-For / -Host), login rate limits that hold under parallel
 * guessing and behind a proxy, coalesced audit entries for throttled logins, what
 * viewers see of the audit log, and serving under a sub-path.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MAX_FAILURES } from "../../src/server/rate-limit.ts";
import {
  removeDataDir,
  setupAdmin,
  startConsole,
  TEST_PASSWORD,
  type TestConsole,
  userWithRole,
} from "../helpers/console.ts";

const FIFTEEN_MINUTES = 15 * 60_000;

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

/** A raw request, optionally from a socket peer (what a real server would see). */
async function send(
  testConsole: TestConsole,
  method: string,
  path: string,
  options: {
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
    readonly peer?: string;
  } = {},
): Promise<{
  status: number;
  body: { error?: { code: string; hint?: string } } & Record<string, unknown>;
  headers: Headers;
}> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  // getConnInfo reads the socket from the Node bindings; in-process requests have none.
  const env =
    options.peer === undefined
      ? undefined
      : {
          incoming: {
            socket: { remoteAddress: options.peer, remotePort: 40000, remoteFamily: "IPv4" },
          },
        };
  const response = await testConsole.app.request(
    path,
    {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    env,
  );
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: response.status, body: body as never, headers: response.headers };
}

const admin = { username: "mallory", password: TEST_PASSWORD };

describe("DNS rebinding and the Host allow-list", () => {
  it("refuses a rebinding page that tries to create the first admin during the setup window", async () => {
    const testConsole = await open({ firstRun: { setupWindowMs: FIFTEEN_MINUTES } });
    // attacker.example first resolved to the attacker's server, now to the console:
    // Origin and Host agree, so the same-origin check alone would let this through.
    const rebound = { host: "attacker.example:8080", origin: "http://attacker.example:8080" };
    const probe = await send(testConsole, "GET", "/api/session", { headers: rebound });
    expect(probe.status).toBe(421);
    expect(probe.body.error?.code).toBe("CONSOLE_UNKNOWN_HOST");
    const setup = await send(testConsole, "POST", "/api/setup", { headers: rebound, body: admin });
    expect(setup.status).toBe(421);
    expect(testConsole.services.store.current.users).toHaveLength(0);

    // The console's own addresses still work.
    const local = await send(testConsole, "POST", "/api/setup", {
      headers: { host: "localhost:8080", origin: "http://localhost:8080" },
      body: admin,
    });
    expect(local.status).toBe(200);
  });

  it("answers its LAN IP, the public URL's host and MONGOSHIELD_ALLOWED_HOSTS", async () => {
    const testConsole = await open({
      settings: {
        publicUrl: "https://backups.example.com",
        allowedHosts: ["ops.example.org"],
      },
    });
    for (const host of ["192.168.1.20:8080", "backups.example.com", "ops.example.org:8443"]) {
      expect(
        (await send(testConsole, "GET", "/api/session", { headers: { host } })).status,
        host,
      ).toBe(200);
    }
    const refused = await send(testConsole, "GET", "/api/session", {
      headers: { host: "other.example.org" },
    });
    expect(refused.status).toBe(421);
    expect(refused.body.error?.hint).toMatch(/MONGOSHIELD_PUBLIC_URL/);
  });
});

describe("behind a reverse proxy", () => {
  const proxyHeaders = {
    // nginx's default proxy_pass sends the upstream's name as Host.
    host: "mongoshield:8080",
    origin: "https://backups.example.com",
    "x-forwarded-host": "backups.example.com",
    "x-forwarded-for": "198.51.100.7",
  };

  it("uses X-Forwarded-Host for the origin check only from a trusted proxy", async () => {
    // The forwarded name is checked against the allow-list like any Host.
    const trusted = await open({
      settings: { trustedProxies: ["10.0.0.0/8"], allowedHosts: ["backups.example.com"] },
    });
    await setupAdmin(trusted);
    const login = { username: "admin", password: "wrong password!" };
    const viaProxy = await send(trusted, "POST", "/api/session", {
      headers: proxyHeaders,
      body: login,
      peer: "10.0.0.2",
    });
    // Past the origin check: the password is what is wrong.
    expect(viaProxy.status).toBe(401);

    // The same headers from anyone else are not believed.
    const direct = await send(trusted, "POST", "/api/session", {
      headers: proxyHeaders,
      body: login,
      peer: "203.0.113.9",
    });
    expect(direct.status).toBe(403);
    expect(direct.body.error?.code).toBe("CONSOLE_BAD_ORIGIN");
    expect(direct.body.error?.hint).toMatch(/MONGOSHIELD_PUBLIC_URL/);
  });

  it("rate-limits per forwarded client address, so one client cannot lock out everyone", async () => {
    const testConsole = await open({ settings: { trustedProxies: ["10.0.0.2"] } });
    await setupAdmin(testConsole);
    const from = (client: string) => ({
      headers: { "x-forwarded-for": client },
      peer: "10.0.0.2",
    });
    for (let attempt = 0; attempt < MAX_FAILURES; attempt++) {
      const failed = await send(testConsole, "POST", "/api/session", {
        ...from("198.51.100.7"),
        body: { username: `guess-${attempt}`, password: "wrong password!" },
      });
      expect(failed.status).toBe(401);
    }
    const blocked = await send(testConsole, "POST", "/api/session", {
      ...from("198.51.100.7"),
      body: { username: "admin", password: TEST_PASSWORD },
    });
    expect(blocked.status).toBe(429);
    // Another client behind the same proxy signs in.
    const other = await send(testConsole, "POST", "/api/session", {
      ...from("198.51.100.8"),
      body: { username: "admin", password: TEST_PASSWORD },
    });
    expect(other.status).toBe(200);
  });
});

describe("login rate limiting", () => {
  it("limits parallel guesses too: attempts count before the password check", async () => {
    const testConsole = await open();
    await setupAdmin(testConsole);
    const client = testConsole.client();
    const results = await Promise.all(
      Array.from({ length: 40 }, () => client.login("admin", "wrong password!")),
    );
    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(MAX_FAILURES);
    expect(statuses.filter((status) => status === 429)).toHaveLength(40 - MAX_FAILURES);
  });

  it("does not count a successful login as a failure", async () => {
    const testConsole = await open();
    await setupAdmin(testConsole);
    for (let attempt = 0; attempt < MAX_FAILURES + 5; attempt++) {
      expect((await testConsole.client().login("admin")).status).toBe(200);
    }
  });

  it("does not let wrong setup tokens from one address lock everyone out of setup", async () => {
    const testConsole = await open({ settings: { trustedProxies: ["10.0.0.2"] } });
    for (let attempt = 0; attempt < MAX_FAILURES + 2; attempt++) {
      await send(testConsole, "POST", "/api/setup", {
        headers: { "x-forwarded-for": "203.0.113.66" },
        peer: "10.0.0.2",
        body: { ...admin, token: `wrong-${attempt}` },
      });
    }
    const operator = await send(testConsole, "POST", "/api/setup", {
      headers: { "x-forwarded-for": "198.51.100.7" },
      peer: "10.0.0.2",
      body: { username: "admin", password: TEST_PASSWORD, token: testConsole.setupToken },
    });
    expect(operator.status).toBe(200);
  });

  it("writes one audit entry for a flood of throttled logins, not one per request", async () => {
    const testConsole = await open();
    const adminClient = await setupAdmin(testConsole);
    for (let attempt = 0; attempt < MAX_FAILURES + 60; attempt++) {
      await testConsole.client().login("admin", "wrong password!");
    }
    const entries = (await adminClient.request("GET", "/api/audit?limit=500")).body as {
      action: string;
    }[];
    expect(entries.filter((entry) => entry.action === "session.login_failed")).toHaveLength(
      MAX_FAILURES,
    );
    expect(entries.filter((entry) => entry.action === "session.login_throttled")).toHaveLength(1);
  });
});

describe("the audit log for non-admins", () => {
  it("hides client addresses and the usernames typed at failed sign-ins", async () => {
    const testConsole = await open();
    const adminClient = await setupAdmin(testConsole);
    // People type their password into the username field.
    await testConsole.client().login("hunter2-my-password", "x");
    const viewer = await userWithRole(testConsole, adminClient, "viewer");

    type Entry = { action: string; target?: string; details?: Record<string, unknown> };
    const seenByViewer = (await viewer.request("GET", "/api/audit")).body as Entry[];
    const failed = seenByViewer.find((entry) => entry.action === "session.login_failed");
    expect(failed).toBeDefined();
    expect(failed?.target).toBeUndefined();
    expect(JSON.stringify(seenByViewer)).not.toContain("hunter2-my-password");
    expect(seenByViewer.some((entry) => entry.details?.address !== undefined)).toBe(false);

    const seenByAdmin = (await adminClient.request("GET", "/api/audit")).body as Entry[];
    expect(seenByAdmin.find((entry) => entry.action === "session.login_failed")?.target).toBe(
      "hunter2-my-password",
    );
    expect(
      seenByAdmin.find((entry) => entry.action === "setup.complete")?.details?.address,
    ).toBeDefined();
  });

  it("keeps the config export for admins", async () => {
    const testConsole = await open();
    const adminClient = await setupAdmin(testConsole);
    const viewer = await userWithRole(testConsole, adminClient, "viewer");
    const operator = await userWithRole(testConsole, adminClient, "operator");
    expect((await viewer.request("GET", "/api/config/export")).status).toBe(403);
    expect((await operator.request("GET", "/api/config/export")).status).toBe(403);
    expect((await adminClient.request("GET", "/api/config/export")).status).toBe(200);
  });
});

describe("signing a user out everywhere", () => {
  it("ends every session of the user, but not the admin's own", async () => {
    const testConsole = await open();
    const adminClient = await setupAdmin(testConsole);
    const laptop = await userWithRole(testConsole, adminClient, "operator", "ada");
    const phone = testConsole.client();
    expect((await phone.login("ada")).status).toBe(200);
    const users = (await adminClient.request("GET", "/api/users")).body as {
      id: string;
      username: string;
    }[];
    const ada = users.find((user) => user.username === "ada");
    const self = users.find((user) => user.username === "admin");

    const response = await adminClient.request("POST", `/api/users/${ada?.id}/sign-out`);
    expect(response.body).toEqual({ revoked: 2 });
    expect((await laptop.session()).user).toBeUndefined();
    expect((await phone.session()).user).toBeUndefined();

    // An admin's own sign-out keeps the session they are using.
    const otherAdminSession = testConsole.client();
    await otherAdminSession.login("admin");
    expect((await adminClient.request("POST", `/api/users/${self?.id}/sign-out`)).body).toEqual({
      revoked: 1,
    });
    expect((await adminClient.session()).user?.username).toBe("admin");
    expect((await otherAdminSession.session()).user).toBeUndefined();
  });
});

describe("serving under a sub-path", () => {
  it("routes /<path>/api like /api, redirects the bare path, and tells the UI about Secure cookies", async () => {
    const testConsole = await open({ settings: { publicUrl: "https://example.com/mongoshield" } });
    const headers = { host: "example.com" };
    const prefixed = await send(testConsole, "GET", "/mongoshield/api/session", { headers });
    expect(prefixed.status).toBe(200);
    expect(prefixed.body.setupComplete).toBe(false);
    // Test consoles turn Secure cookies off; GET /api/session says so for the login page.
    expect(prefixed.body.cookieSecure).toBe(false);
    // A proxy that strips the prefix still works.
    expect((await send(testConsole, "GET", "/api/session", { headers })).status).toBe(200);
    const bare = await send(testConsole, "GET", "/mongoshield?x=1", { headers });
    expect(bare.status).toBe(308);
    expect(bare.headers.get("location")).toBe("/mongoshield/?x=1");
    // Unknown API paths under the prefix are still JSON 404s with no-store.
    const unknown = await send(testConsole, "GET", "/mongoshield/api/nope", { headers });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
  });
});
