/**
 * Authentication, CSRF protection and role checks.
 *
 * Two ways to be signed in:
 *
 * 1. Cookie session (password login or setup). The cookie is `HttpOnly` (no
 *    script can read it), `SameSite=Strict` (never sent on cross-site
 *    requests) and, by default, `Secure` with the `__Host-` prefix (HTTPS only,
 *    no Domain attribute, so a sibling subdomain cannot plant or read it).
 *
 * 2. Trusted reverse proxy (SSO via oauth2-proxy, Authelia, Pomerium, …). Only
 *    when MONGOSHIELD_TRUST_PROXY_SECRET is set, and only for requests whose
 *    `X-MongoShield-Proxy-Secret` header matches it (constant-time). The proxy
 *    must strip both headers from client requests and set them itself.
 *    `X-Forwarded-User` alone is never trusted: anyone can send that header if
 *    the console is reachable without the proxy. Unknown proxy users are
 *    created with the `viewer` role; an admin can promote them.
 *
 * CSRF: every state-changing request from a signed-in principal must carry
 * `x-csrf-token` equal to the token bound to that login (sessions.ts). The
 * token is only available from `GET /api/session` (same-origin JSON), so a
 * cross-site page can neither read nor guess it.
 */

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Role } from "../shared/api.ts";
import { constantTimeEqual, randomId } from "../state/crypto.ts";
import {
  csrfTokenForProxyUser,
  csrfTokenForSession,
  findSession,
  SESSION_MAX_AGE_MS,
} from "../state/sessions.ts";
import type { UserRecord } from "../state/types.ts";
import type { AppEnv, ConsoleServices, Principal } from "./context.ts";
import { ConsoleError, forbidden } from "./errors.ts";
import { isStateChanging } from "./security.ts";

/** Header carrying the proxy's shared secret. */
export const PROXY_SECRET_HEADER = "x-mongoshield-proxy-secret";
/** Header carrying the proxy-authenticated username. */
export const PROXY_USER_HEADER = "x-forwarded-user";
/** Header carrying the CSRF token. */
export const CSRF_HEADER = "x-csrf-token";

/** Usernames: letters, digits and `._@-`, as most identity providers produce. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

/** Rank of each role; each role includes everything below it. */
const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2 };

/** The session cookie's name: `__Host-` prefixed when cookies are Secure. */
export function sessionCookieName(services: ConsoleServices): string {
  return services.settings.cookieSecure ? "__Host-mongoshield_session" : "mongoshield_session";
}

/** Sets the session cookie after login or setup. */
export function setSessionCookie(
  c: Context<AppEnv>,
  services: ConsoleServices,
  token: string,
): void {
  setCookie(c, sessionCookieName(services), token, {
    httpOnly: true,
    secure: services.settings.cookieSecure,
    sameSite: "Strict",
    path: "/",
    // The server enforces the idle timeout; the browser drops the cookie at the absolute limit.
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
}

/** Clears the session cookie (logout). */
export function clearSessionCookie(c: Context<AppEnv>, services: ConsoleServices): void {
  deleteCookie(c, sessionCookieName(services), {
    path: "/",
    secure: services.settings.cookieSecure,
  });
}

/**
 * Finds out who is calling and stores it as `principal` (or `undefined`).
 * Never rejects by itself, except for a wrong proxy secret, which is an attack
 * or a misconfiguration and is refused outright.
 */
export function authenticate(services: ConsoleServices): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set(
      "principal",
      (await proxyPrincipal(c, services)) ?? (await sessionPrincipal(c, services)),
    );
    await next();
  };
}

/** The principal from the cookie session, if valid. */
async function sessionPrincipal(
  c: Context<AppEnv>,
  services: ConsoleServices,
): Promise<Principal | undefined> {
  const token = getCookie(c, sessionCookieName(services));
  // 256-bit base64url ids are 43 characters; refuse anything absurd before hashing.
  if (token === undefined || token.length > 128) return undefined;
  const active = await findSession(services.store, token, services.now());
  if (active === undefined) return undefined;
  return {
    user: active.user,
    via: "session",
    sessionHash: active.session.idHash,
    csrfToken: csrfTokenForSession(services.store.csrfKey, active.session),
  };
}

/** The principal from trusted proxy headers, if proxy mode is on and the secret matches. */
async function proxyPrincipal(
  c: Context<AppEnv>,
  services: ConsoleServices,
): Promise<Principal | undefined> {
  const expected = services.settings.proxySecret;
  const presented = c.req.header(PROXY_SECRET_HEADER);
  if (expected === undefined || presented === undefined) return undefined;
  if (!constantTimeEqual(presented, expected)) {
    throw new ConsoleError(401, "CONSOLE_UNAUTHENTICATED", "The proxy secret is wrong.");
  }
  const username = c.req.header(PROXY_USER_HEADER);
  if (username === undefined || !USERNAME_PATTERN.test(username)) return undefined;
  const user = await proxyUser(services, username);
  return {
    user,
    via: "proxy",
    csrfToken: csrfTokenForProxyUser(services.store.csrfKey, user.username),
  };
}

/** The console user for a proxy-authenticated name, created as a viewer on first sight. */
async function proxyUser(services: ConsoleServices, username: string): Promise<UserRecord> {
  const existing = services.store.current.users.find((user) => user.username === username);
  if (existing !== undefined) return existing;
  const created: UserRecord = {
    id: randomId(),
    username,
    role: "viewer",
    // No password: this user can only sign in through the proxy.
    passwordHash: "",
    createdAt: services.now().toISOString(),
  };
  await services.store.update((state) => {
    state.users = [...state.users, created];
  });
  await services.audit.append({
    at: created.createdAt,
    actor: username,
    action: "user.provision",
    target: username,
    outcome: "success",
    details: { via: "proxy", role: "viewer" },
  });
  return created;
}

/**
 * Requires the CSRF token on state-changing requests of signed-in principals.
 * Unauthenticated requests pass through here and are refused by the route
 * (401), except login and setup, which create the session in the first place.
 */
export function csrfProtection(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (principal !== undefined && isStateChanging(c.req.method)) {
      const presented = c.req.header(CSRF_HEADER);
      if (presented === undefined || !constantTimeEqual(presented, principal.csrfToken)) {
        throw new ConsoleError(
          403,
          "CONSOLE_CSRF",
          "The request is missing a valid CSRF token.",
          "Reload the page and try again.",
        );
      }
    }
    await next();
  };
}

/** The signed-in principal, or `401`. */
export function requireUser(c: Context<AppEnv>): Principal {
  const principal = c.get("principal");
  if (principal === undefined) {
    throw new ConsoleError(401, "CONSOLE_UNAUTHENTICATED", "Sign in first.");
  }
  return principal;
}

/** The signed-in principal if it has at least `role`; else `401` or `403`. */
export function requireRole(c: Context<AppEnv>, role: Role): Principal {
  const principal = requireUser(c);
  if (!hasRole(principal.user.role, role)) throw forbidden();
  return principal;
}

/** True when `actual` includes everything `required` may do. */
export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/**
 * The client's address, for rate limiting and the audit log. The socket
 * address only: `X-Forwarded-For` can be set by anyone and is not trusted.
 */
export function clientAddress(c: Context<AppEnv>): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // In-process requests (tests) have no socket.
    return "unknown";
  }
}
