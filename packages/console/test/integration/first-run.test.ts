/**
 * The first run without any setup: the setup window (first admin without the token for
 * a while after start), the admin from the environment, and the "Local backups"
 * storage location created once on a fresh data directory.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupWindowOpen } from "../../src/server/routes/session.ts";
import { closeConsole, DEFAULT_STORAGE_NAME, openConsole } from "../../src/server/services.ts";
import {
  removeDataDir,
  setupAdmin,
  startConsole,
  TEST_PASSWORD,
  TEST_PASSWORD_COST,
  TEST_SECRET,
  TestClock,
  type TestConsole,
} from "../helpers/console.ts";

const FIFTEEN_MINUTES = 15 * 60_000;

const opened: TestConsole[] = [];
async function open(...args: Parameters<typeof startConsole>): Promise<TestConsole> {
  const testConsole = await startConsole(...args);
  opened.push(testConsole);
  return testConsole;
}

afterEach(async () => {
  vi.useRealTimers();
  const dataDirs = new Set<string>();
  for (const testConsole of opened.splice(0)) {
    await testConsole.close().catch(() => undefined);
    dataDirs.add(testConsole.dataDir);
  }
  for (const dataDir of dataDirs) await removeDataDir(dataDir);
});

/** Reads the audit log through the API with an admin client. */
async function auditActions(testConsole: TestConsole, admin = testConsole.client()) {
  const response = await admin.request("GET", "/api/audit?limit=100");
  return response.body as { action: string; actor: string; details?: Record<string, unknown> }[];
}

describe("the setup window", () => {
  it("creates the first admin without the token while it is open, and audits who did it", async () => {
    const clock = new TestClock();
    const testConsole = await open({ clock, firstRun: { setupWindowMs: FIFTEEN_MINUTES } });
    const client = testConsole.client();

    const session = await client.request("GET", "/api/session");
    expect(session.body.setup).toEqual({
      tokenRequired: false,
      windowEndsAt: new Date(clock.now().getTime() + FIFTEEN_MINUTES).toISOString(),
    });

    clock.advance(FIFTEEN_MINUTES - 1);
    const setup = await client.request("POST", "/api/setup", {
      username: "owner",
      password: TEST_PASSWORD,
    });
    expect(setup.status).toBe(200);
    expect(setup.body).toMatchObject({ setupComplete: true, user: { username: "owner" } });
    expect(setup.body.setup).toBeUndefined();

    const entry = (await auditActions(testConsole, client)).find(
      (candidate) => candidate.action === "setup.complete",
    );
    expect(entry).toMatchObject({ actor: "owner", details: { method: "window" } });
    expect(entry?.details?.address).toEqual(expect.any(String));

    // Closed for good once an admin exists, with or without the token.
    const late = await testConsole.client().request("POST", "/api/setup", {
      username: "mallory",
      password: TEST_PASSWORD,
    });
    expect(late.status).toBe(409);
    expect(setupWindowOpen(testConsole.services)).toBe(false);
  });

  it("needs the token once the window has closed, and the token still works", async () => {
    const clock = new TestClock();
    const testConsole = await open({ clock, firstRun: { setupWindowMs: FIFTEEN_MINUTES } });
    clock.advance(FIFTEEN_MINUTES);
    const client = testConsole.client();
    expect((await client.request("GET", "/api/session")).body.setup).toEqual({
      tokenRequired: true,
    });

    const refused = await client.request("POST", "/api/setup", {
      username: "owner",
      password: TEST_PASSWORD,
    });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("CONSOLE_SETUP_TOKEN_REQUIRED");
    expect(refused.body.error.hint).toMatch(/docker logs|restart/);
    expect((await setupAdmin(testConsole)).csrfToken).toEqual(expect.any(String));
  });

  it("accepts the token during the window, but not a wrong one", async () => {
    const testConsole = await open({ firstRun: { setupWindowMs: FIFTEEN_MINUTES } });
    const wrong = await testConsole.client().request("POST", "/api/setup", {
      token: "not-the-token",
      username: "owner",
      password: TEST_PASSWORD,
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("CONSOLE_SETUP_TOKEN_INVALID");
    const admin = await setupAdmin(testConsole);
    const entry = (await auditActions(testConsole, admin)).find(
      (candidate) => candidate.action === "setup.complete",
    );
    expect(entry?.details?.method).toBe("token");
  });

  it("still enforces the password rules and the origin check", async () => {
    const testConsole = await open({ firstRun: { setupWindowMs: FIFTEEN_MINUTES } });
    const weak = await testConsole.client().request("POST", "/api/setup", {
      username: "owner",
      password: "short",
    });
    expect(weak.status).toBe(400);
    const foreign = await testConsole
      .client()
      .request(
        "POST",
        "/api/setup",
        { username: "owner", password: TEST_PASSWORD },
        { headers: { origin: "https://evil.example" } },
      );
    expect(foreign.status).toBe(403);
    expect(testConsole.services.store.current.users).toEqual([]);
  });

  it("has no window when it is turned off (0), or when an admin exists at start", async () => {
    const off = await open({ firstRun: { setupWindowMs: 0 } });
    expect((await off.client().request("GET", "/api/session")).body.setup).toEqual({
      tokenRequired: true,
    });
    await setupAdmin(off);
    await off.close();

    const again = await open({
      dataDir: off.dataDir,
      firstRun: { setupWindowMs: FIFTEEN_MINUTES },
    });
    expect(again.services.setupWindowEndsAt).toBeUndefined();
    expect(again.opened.setupWindowEndsAt).toBeUndefined();
  });

  it("opens again at every start until setup is done (a restart is the way back in)", async () => {
    const clock = new TestClock();
    const first = await open({ clock, firstRun: { setupWindowMs: FIFTEEN_MINUTES } });
    clock.advance(FIFTEEN_MINUTES * 2);
    expect(setupWindowOpen(first.services)).toBe(false);
    await first.close();
    const second = await open({
      dataDir: first.dataDir,
      clock,
      firstRun: { setupWindowMs: FIFTEEN_MINUTES },
    });
    expect(setupWindowOpen(second.services)).toBe(true);
    expect(second.opened.setupWindowEndsAt?.getTime()).toBe(
      clock.now().getTime() + FIFTEEN_MINUTES,
    );
  });

  it("follows the real clock (fake timers): open until the minute is up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T09:00:00Z"));
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dataDir = await mkdtemp(join(tmpdir(), "ms-window-"));
    // No `now` option: the console uses `new Date()`, which the fake timers control.
    const { services, setupWindowEndsAt } = await openConsole({
      dataDir,
      secret: TEST_SECRET,
      passwordCost: TEST_PASSWORD_COST,
      setupWindowMs: 60_000,
    });
    try {
      expect(setupWindowEndsAt?.toISOString()).toBe("2026-10-24T09:01:00.000Z");
      vi.setSystemTime(new Date("2026-10-24T09:00:59.999Z"));
      expect(setupWindowOpen(services)).toBe(true);
      vi.setSystemTime(new Date("2026-10-24T09:01:00.000Z"));
      expect(setupWindowOpen(services)).toBe(false);
    } finally {
      vi.useRealTimers();
      await closeConsole(services, 1_000);
      await removeDataDir(dataDir);
    }
  });
});

describe("the admin from the environment", () => {
  it("creates the admin at the first start, without a setup token or window", async () => {
    const testConsole = await open({
      firstRun: {
        initialAdmin: { username: "ops@example.com", password: TEST_PASSWORD },
        setupWindowMs: FIFTEEN_MINUTES,
      },
    });
    expect(testConsole.opened.provisionedAdmin).toBe("ops@example.com");
    expect(testConsole.setupToken).toBeUndefined();
    expect(testConsole.services.store.current.setupToken).toBeUndefined();
    const client = testConsole.client();
    expect((await client.request("GET", "/api/session")).body).toMatchObject({
      setupComplete: true,
    });
    expect((await client.login("ops@example.com")).status).toBe(200);
    const entry = (await auditActions(testConsole, client)).find(
      (candidate) => candidate.action === "setup.complete",
    );
    expect(entry).toMatchObject({ actor: "environment", details: { method: "environment" } });
    // The password is stored as a scrypt hash only.
    expect(testConsole.services.store.current.users[0]?.passwordHash).toMatch(/^scrypt\$/);
  });

  it("never changes existing accounts on later starts", async () => {
    const first = await open({
      firstRun: { initialAdmin: { username: "ops", password: TEST_PASSWORD } },
    });
    await first.close();
    const second = await open({
      dataDir: first.dataDir,
      firstRun: { initialAdmin: { username: "ops", password: "a different password!" } },
    });
    expect(second.opened.provisionedAdminIgnored).toBe(true);
    expect(second.services.store.current.users).toHaveLength(1);
    // The original password still works; the new one does not.
    expect((await second.client().login("ops")).status).toBe(200);
    const wrong = await second
      .client()
      .request("POST", "/api/session", { username: "ops", password: "a different password!" });
    expect(wrong.status).toBe(401);
  });

  it("is ignored when an admin was created through setup first", async () => {
    const first = await open();
    await setupAdmin(first, "owner");
    await first.close();
    const second = await open({
      dataDir: first.dataDir,
      firstRun: { initialAdmin: { username: "ops", password: TEST_PASSWORD } },
    });
    expect(second.opened.provisionedAdminIgnored).toBe(true);
    expect(second.services.store.current.users.map((user) => user.username)).toEqual(["owner"]);
  });
});

describe("the default storage location", () => {
  it("creates Local backups once, in <data>/backups, and audits it", async () => {
    const testConsole = await open({ firstRun: { defaultStorage: true } });
    expect(testConsole.opened.createdStorage).toEqual({
      name: DEFAULT_STORAGE_NAME,
      path: join(testConsole.dataDir, "backups"),
    });
    const storage = testConsole.services.store.current.storage;
    expect(storage).toHaveLength(1);
    expect(storage[0]).toMatchObject({ name: "Local backups", url: "backups" });
    expect((await stat(join(testConsole.dataDir, "backups"))).isDirectory()).toBe(true);
    expect(testConsole.services.store.current.defaults?.storageId).toBe(storage[0]?.id);

    const admin = await setupAdmin(testConsole);
    const entry = (await auditActions(testConsole, admin)).find(
      (candidate) => candidate.action === "storage.create",
    );
    expect(entry).toMatchObject({ actor: "system", details: { reason: "first-run default" } });
    // The location works: its storage test writes, reads and deletes a probe.
    const id = storage[0]?.id ?? "";
    expect((await admin.request("POST", `/api/storage/${id}/test`)).body.ok).toBe(true);
  });

  it("is idempotent across restarts, and a deleted default stays deleted", async () => {
    const first = await open({ firstRun: { defaultStorage: true } });
    const admin = await setupAdmin(first);
    await first.close();

    const second = await open({ dataDir: first.dataDir, firstRun: { defaultStorage: true } });
    expect(second.opened.createdStorage).toBeUndefined();
    expect(second.services.store.current.storage).toHaveLength(1);
    const client = second.client();
    await client.login("admin");
    const id = second.services.store.current.storage[0]?.id ?? "";
    expect((await client.request("DELETE", `/api/storage/${id}`)).status).toBe(200);
    await second.close();

    const third = await open({ dataDir: first.dataDir, firstRun: { defaultStorage: true } });
    expect(third.services.store.current.storage).toEqual([]);
    expect(admin).toBeDefined();
  });

  it("leaves existing consoles alone, and is off unless asked for", async () => {
    const plain = await open();
    expect(plain.services.store.current.storage).toEqual([]);
    expect(plain.services.store.current.defaults).toBeUndefined();
    const admin = await setupAdmin(plain);
    await admin.request("POST", "/api/connections", {
      name: "app",
      uri: "mongodb://localhost:27017",
      production: false,
    });
    await plain.close();

    // An existing deployment (it has a user and a connection) starts exactly as before.
    const upgraded = await open({ dataDir: plain.dataDir, firstRun: { defaultStorage: true } });
    expect(upgraded.services.store.current.storage).toEqual([]);
    expect(upgraded.services.store.current.defaults).toBeUndefined();
  });
});
