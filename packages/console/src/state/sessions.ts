/**
 * Sessions, CSRF tokens and the one-time setup token.
 *
 * Sessions
 * - The cookie carries a random 256-bit id; console.json stores only its SHA-256,
 *   so reading the state file does not let anyone log in.
 * - Idle timeout: 12 hours without a request ends a session. There is also an
 *   absolute lifetime of 7 days, so a stolen cookie cannot be kept alive forever
 *   by a script that pings the API.
 * - `lastSeenAt` is persisted at most every {@link TOUCH_INTERVAL_MS}, so normal
 *   browsing does not rewrite console.json on every request.
 *
 * CSRF
 * - The token is HMAC(csrf key, "session:" + session id hash) for cookie sessions
 *   and HMAC(csrf key, "proxy:" + username) for reverse-proxy logins. It is bound
 *   to the session (another session's token is useless), needs no storage, and
 *   cannot be computed without MONGOSHIELD_SECRET.
 *
 * Setup token
 * - Single-use, valid 24 hours, stored hashed. A fresh one is issued at every
 *   start until the first admin exists (the old one cannot be printed again,
 *   because only its hash was kept).
 */

import { constantTimeEqual, hashToken, hmac, randomToken } from "./crypto.ts";
import type { StateStore } from "./store.ts";
import type { SessionRecord, UserRecord } from "./types.ts";

/** A session ends after 12 hours without a request. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** And 7 days after login, however active it is. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** `lastSeenAt` is written back at most this often (5 minutes). */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** The setup token is valid for 24 hours. */
export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** A session found for a cookie, with its user. */
export interface ActiveSession {
  readonly session: SessionRecord;
  readonly user: UserRecord;
}

/**
 * Creates a session for `userId`. Returns the cookie value (the only copy of
 * the id) and the stored record. Expired sessions are cleaned up on the way.
 */
export async function createSession(
  store: StateStore,
  userId: string,
  now: Date,
): Promise<{ readonly token: string; readonly session: SessionRecord }> {
  const token = randomToken();
  const at = now.toISOString();
  const session: SessionRecord = {
    idHash: hashToken(token),
    userId,
    createdAt: at,
    lastSeenAt: at,
  };
  await store.update((state) => {
    state.sessions = [...state.sessions.filter((candidate) => isAlive(candidate, now)), session];
  });
  return { token, session };
}

/**
 * Looks up the session for a cookie value. Expired sessions and sessions of
 * deleted users are not returned. Refreshes `lastSeenAt` when it is stale.
 */
export async function findSession(
  store: StateStore,
  token: string,
  now: Date,
): Promise<ActiveSession | undefined> {
  const idHash = hashToken(token);
  const session = store.current.sessions.find((candidate) => candidate.idHash === idHash);
  if (session === undefined || !isAlive(session, now)) return undefined;
  const user = store.current.users.find((candidate) => candidate.id === session.userId);
  if (user === undefined) return undefined;

  if (now.getTime() - Date.parse(session.lastSeenAt) > TOUCH_INTERVAL_MS) {
    const touched: SessionRecord = { ...session, lastSeenAt: now.toISOString() };
    await store.update((state) => {
      state.sessions = state.sessions.map((candidate) =>
        candidate.idHash === idHash ? touched : candidate,
      );
    });
    return { session: touched, user };
  }
  return { session, user };
}

/** Ends one session (logout). */
export async function revokeSession(store: StateStore, idHash: string): Promise<void> {
  await store.update((state) => {
    state.sessions = state.sessions.filter((session) => session.idHash !== idHash);
  });
}

/** Removes every session of a user from a state draft (password change, deletion). */
export function withoutSessionsOf(
  sessions: readonly SessionRecord[],
  userId: string,
): SessionRecord[] {
  return sessions.filter((session) => session.userId !== userId);
}

/** True while a session is within both its idle timeout and its absolute lifetime. */
export function isAlive(session: SessionRecord, now: Date): boolean {
  const idle = now.getTime() - Date.parse(session.lastSeenAt);
  const age = now.getTime() - Date.parse(session.createdAt);
  return idle < SESSION_IDLE_MS && age < SESSION_MAX_AGE_MS;
}

/** The CSRF token bound to a cookie session. */
export function csrfTokenForSession(csrfKey: Buffer, session: SessionRecord): string {
  return hmac(csrfKey, `session:${session.idHash}`);
}

/** The CSRF token bound to a reverse-proxy login. */
export function csrfTokenForProxyUser(csrfKey: Buffer, username: string): string {
  return hmac(csrfKey, `proxy:${username}`);
}

/**
 * Issues a new setup token (replacing any earlier one) and returns it. Only
 * called while no user exists.
 */
export async function issueSetupToken(store: StateStore, now: Date): Promise<string> {
  const token = randomToken();
  await store.update((state) => {
    state.setupToken = {
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + SETUP_TOKEN_TTL_MS).toISOString(),
    };
  });
  return token;
}

/**
 * Checks a setup token without consuming it: it must match the stored hash
 * (compared in constant time) and not be expired. The caller consumes it in the
 * same `update()` that creates the first admin, so it can only ever be used once.
 */
export function isValidSetupToken(store: StateStore, token: string, now: Date): boolean {
  const stored = store.current.setupToken;
  if (stored === undefined) return false;
  if (now.getTime() >= Date.parse(stored.expiresAt)) return false;
  return constantTimeEqual(hashToken(token), stored.tokenHash);
}
