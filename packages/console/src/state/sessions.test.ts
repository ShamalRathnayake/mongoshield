import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  csrfTokenForProxyUser,
  csrfTokenForSession,
  findSession,
  issueSetupToken,
  isValidSetupToken,
  revokeSession,
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  SETUP_TOKEN_TTL_MS,
} from "./sessions.ts";
import { StateStore } from "./store.ts";

let dataDir: string;
let store: StateStore;
const start = new Date("2026-10-21T00:00:00Z");
const later = (ms: number): Date => new Date(start.getTime() + ms);

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ms-sessions-"));
  store = await StateStore.open({ dataDir, secret: "sessions-test-secret-0123456789abcdef" });
  await store.update((state) => {
    state.users = [
      {
        id: "u1",
        username: "ada",
        role: "admin",
        passwordHash: "",
        createdAt: start.toISOString(),
      },
    ];
  });
});

afterEach(async () => {
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("sessions", () => {
  it("finds a session by its token and stores only the hash", async () => {
    const { token, session } = await createSession(store, "u1", start);
    expect(session.idHash).not.toBe(token);
    expect(JSON.stringify(store.current)).not.toContain(token);
    expect((await findSession(store, token, start))?.user.username).toBe("ada");
    expect(await findSession(store, "wrong", start)).toBeUndefined();
  });

  it("expires after the idle timeout and after the absolute lifetime", async () => {
    const { token } = await createSession(store, "u1", start);
    expect(await findSession(store, token, later(SESSION_IDLE_MS + 1))).toBeUndefined();

    // Kept alive by activity, but never beyond the absolute limit.
    const { token: busy } = await createSession(store, "u1", start);
    for (let at = 0; at < SESSION_MAX_AGE_MS; at += SESSION_IDLE_MS / 2) {
      expect(await findSession(store, busy, later(at))).toBeDefined();
    }
    expect(await findSession(store, busy, later(SESSION_MAX_AGE_MS + 1))).toBeUndefined();
  });

  it("ends on logout and when the user is deleted", async () => {
    const { token, session } = await createSession(store, "u1", start);
    await revokeSession(store, session.idHash);
    expect(await findSession(store, token, start)).toBeUndefined();

    const { token: second } = await createSession(store, "u1", start);
    await store.update((state) => {
      state.users = [];
    });
    expect(await findSession(store, second, start)).toBeUndefined();
  });

  it("binds CSRF tokens to the session or proxy user", async () => {
    const { session: one } = await createSession(store, "u1", start);
    const { session: two } = await createSession(store, "u1", start);
    expect(csrfTokenForSession(store.csrfKey, one)).not.toBe(
      csrfTokenForSession(store.csrfKey, two),
    );
    expect(csrfTokenForSession(store.csrfKey, one)).toBe(csrfTokenForSession(store.csrfKey, one));
    expect(csrfTokenForProxyUser(store.csrfKey, "ada")).not.toBe(
      csrfTokenForProxyUser(store.csrfKey, "bob"),
    );
  });
});

describe("setup token", () => {
  it("is valid for 24 hours, stored hashed, and replaced by a new one", async () => {
    const token = await issueSetupToken(store, start);
    expect(JSON.stringify(store.current)).not.toContain(token);
    expect(isValidSetupToken(store, token, start)).toBe(true);
    expect(isValidSetupToken(store, "other", start)).toBe(false);
    expect(isValidSetupToken(store, token, later(SETUP_TOKEN_TTL_MS))).toBe(false);
    const next = await issueSetupToken(store, start);
    expect(isValidSetupToken(store, token, start)).toBe(false);
    expect(isValidSetupToken(store, next, start)).toBe(true);
  });
});
