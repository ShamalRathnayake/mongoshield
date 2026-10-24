/**
 * Session routes: who am I (`GET /api/session`), login, logout, and the
 * one-time setup that creates the first admin.
 *
 *   GET    /api/session   anyone   current user, CSRF token, setup state
 *   POST   /api/session   anyone   login (rate limited)
 *   DELETE /api/session   signed in
 *   POST   /api/setup     only while no user exists: with the setup token, or without it
 *                         during the setup window after start (MONGOSHIELD_SETUP_WINDOW_MINUTES)
 *
 * Why a setup window: the first admin used to need the token from the server log, which
 * is one copy-and-paste too many for `docker run` and open the browser. For a limited
 * time after start (15 minutes by default), the setup page may create the first admin
 * without it, as Portainer does. Whoever opens the page first in that window becomes
 * admin, so the window is short, closes for good once an admin exists, is announced on
 * the page and in the log, and every setup is audited with the client address. The
 * token keeps working the whole time (and after the window). docs/console-security.md
 * compares this with the alternatives (token only, loopback only, environment admin).
 */

import type { Context, Hono } from "hono";
import type { SessionInfo } from "../../shared/api.ts";
import { randomId } from "../../state/crypto.ts";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  verifyAgainstDummy,
  verifyPassword,
} from "../../state/passwords.ts";
import {
  createSession,
  csrfTokenForSession,
  isValidSetupToken,
  revokeSession,
} from "../../state/sessions.ts";
import type { UserRecord } from "../../state/types.ts";
import { recordAudit } from "../audit.ts";
import {
  clearSessionCookie,
  clientAddress,
  requireUser,
  setSessionCookie,
  USERNAME_PATTERN,
} from "../auth.ts";
import type { AppEnv, ConsoleServices, Principal } from "../context.ts";
import { ConsoleError, invalid } from "../errors.ts";
import { readJson } from "../security.ts";
import { asObject, optionalString, requiredString } from "../validate.ts";
import { userView } from "../views.ts";

/** Registers the session routes. */
export function sessionRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  app.get("/api/session", (c) => c.json(sessionInfo(services, c.get("principal"))));

  app.post("/api/session", async (c) => {
    const body = asObject(await readJson(c));
    const username = requiredString(body, "username", 64);
    const password = passwordField(body.password, { checkStrength: false });
    const limiterKeys = [`address:${clientAddress(c)}`, `user:${username.toLowerCase()}`];

    const waitMs = services.loginLimiter.retryAfterMs(limiterKeys);
    if (waitMs > 0) {
      c.header("Retry-After", String(Math.ceil(waitMs / 1000)));
      await recordAudit(services, {
        actor: "anonymous",
        action: "session.login_throttled",
        target: username,
        outcome: "failure",
      });
      throw new ConsoleError(
        429,
        "CONSOLE_RATE_LIMITED",
        "Too many failed sign-in attempts.",
        "Wait a few minutes before trying again.",
      );
    }

    const user = services.store.current.users.find((candidate) => candidate.username === username);
    // Unknown users and SSO-only accounts (no password hash) cost one dummy scrypt
    // run, like a real check, so response times do not reveal which accounts exist.
    const ok =
      user === undefined || user.passwordHash === ""
        ? (await verifyAgainstDummy(password, services.passwordCost)) && false
        : await verifyPassword(password, user.passwordHash);
    if (!ok || user === undefined) {
      services.loginLimiter.recordFailure(limiterKeys);
      await recordAudit(services, {
        actor: "anonymous",
        action: "session.login_failed",
        target: username,
        outcome: "failure",
      });
      // The same message for unknown users and wrong passwords: no username enumeration.
      throw new ConsoleError(401, "CONSOLE_LOGIN_FAILED", "Wrong username or password.");
    }

    services.loginLimiter.reset(`user:${username.toLowerCase()}`);
    const principal = await startSession(c, services, user);
    await recordAudit(services, {
      actor: principal,
      action: "session.login",
      outcome: "success",
      details: { method: "password" },
    });
    return c.json(sessionInfo(services, principal));
  });

  app.delete("/api/session", async (c) => {
    const principal = requireUser(c);
    if (principal.sessionHash !== undefined) {
      await revokeSession(services.store, principal.sessionHash);
    }
    clearSessionCookie(c, services);
    await recordAudit(services, { actor: principal, action: "session.logout", outcome: "success" });
    return c.json({ ok: true as const });
  });

  app.post("/api/setup", async (c) => {
    if (services.store.current.users.length > 0) {
      throw new ConsoleError(
        409,
        "CONSOLE_SETUP_DONE",
        "Setup is already complete.",
        "Sign in instead.",
      );
    }
    const body = asObject(await readJson(c));
    // The token is optional only while the setup window is open (see the file header).
    const token = optionalString(body, "token", 128)?.trim() || undefined;
    const limiterKeys = [`address:${clientAddress(c)}`, "setup"];
    if (services.loginLimiter.retryAfterMs(limiterKeys) > 0) {
      throw new ConsoleError(429, "CONSOLE_RATE_LIMITED", "Too many failed setup attempts.");
    }
    if (token === undefined && !setupWindowOpen(services)) {
      await recordAudit(services, {
        actor: "anonymous",
        action: "setup.failed",
        outcome: "failure",
        details: { reason: "window closed" },
      });
      throw new ConsoleError(
        401,
        "CONSOLE_SETUP_TOKEN_REQUIRED",
        "The setup token is required.",
        "Open the setup link printed in the console's log (docker logs <container>), or restart the console to open the setup window again.",
      );
    }
    if (token !== undefined && !isValidSetupToken(services.store, token, services.now())) {
      services.loginLimiter.recordFailure(limiterKeys);
      await recordAudit(services, {
        actor: "anonymous",
        action: "setup.failed",
        outcome: "failure",
      });
      throw new ConsoleError(
        401,
        "CONSOLE_SETUP_TOKEN_INVALID",
        "The setup token is invalid or has expired.",
        "Restart the console to print a new setup link.",
      );
    }
    const username = usernameField(body.username);
    const password = passwordField(body.password, { checkStrength: true });
    const passwordHash = await hashPassword(password, services.passwordCost);

    const admin: UserRecord = {
      id: randomId(),
      username,
      role: "admin",
      passwordHash,
      createdAt: services.now().toISOString(),
    };
    // Check and consume in one update: two concurrent setups cannot both win.
    const created = await services.store.update((state) => {
      if (state.users.length > 0) return false;
      if (token !== undefined && state.setupToken === undefined) return false;
      state.users = [admin];
      delete state.setupToken;
      return true;
    });
    if (!created) {
      throw new ConsoleError(409, "CONSOLE_SETUP_DONE", "Setup is already complete.");
    }
    const principal = await startSession(c, services, admin);
    const method = token === undefined ? "window" : "token";
    await recordAudit(services, {
      actor: principal,
      action: "setup.complete",
      target: username,
      outcome: "success",
      // The address matters most for setups through the window: it is how an operator
      // would tell that someone else claimed the console first.
      details: { method, address: clientAddress(c) },
    });
    services.logger.info("First admin created", { username, method, address: clientAddress(c) });
    return c.json(sessionInfo(services, principal));
  });
}

/** What `GET /api/session` returns for a principal (or nobody). */
function sessionInfo(services: ConsoleServices, principal: Principal | undefined): SessionInfo {
  const authMethods: SessionInfo["authMethods"] = [
    "password",
    ...(services.oidc === undefined ? [] : (["oidc"] as const)),
    ...(services.settings.proxySecret === undefined ? [] : (["proxy"] as const)),
  ];
  const setupComplete = services.store.current.users.length > 0;
  const windowOpen = setupWindowOpen(services);
  return {
    setupComplete,
    authMethods,
    ...(setupComplete
      ? {}
      : {
          setup: {
            tokenRequired: !windowOpen,
            ...(windowOpen && services.setupWindowEndsAt !== undefined
              ? { windowEndsAt: services.setupWindowEndsAt.toISOString() }
              : {}),
          },
        }),
    ...(principal === undefined
      ? {}
      : { user: userView(principal.user), csrfToken: principal.csrfToken }),
  };
}

/** True while the first admin may be created without the setup token. */
export function setupWindowOpen(services: ConsoleServices): boolean {
  const endsAt = services.setupWindowEndsAt;
  if (endsAt === undefined) return false;
  return services.store.current.users.length === 0 && services.now().getTime() < endsAt.getTime();
}

/**
 * Creates a fresh session (a new id on every login: an id planted before login
 * is never promoted, which prevents session fixation) and sets the cookie.
 * Used by password login, setup and OIDC sign-in.
 */
export async function startSession(
  c: Context<AppEnv>,
  services: ConsoleServices,
  user: UserRecord,
): Promise<Principal> {
  const now = services.now();
  const { token, session } = await createSession(services.store, user.id, now);
  const refreshed: UserRecord = { ...user, lastLoginAt: now.toISOString() };
  await services.store.update((state) => {
    state.users = state.users.map((candidate) =>
      candidate.id === user.id ? refreshed : candidate,
    );
  });
  setSessionCookie(c, services, token);
  return {
    user: refreshed,
    via: "session",
    sessionHash: session.idHash,
    csrfToken: csrfTokenForSession(services.store.csrfKey, session),
  };
}

/** A username from a request body. */
export function usernameField(value: unknown): string {
  if (typeof value !== "string" || !USERNAME_PATTERN.test(value)) {
    throw invalid(
      "The username must be 1-64 characters: letters, digits, dots, dashes, underscores or @.",
    );
  }
  return value;
}

/**
 * A password from a request body. New passwords must be at least 12 characters
 * (length is what makes passwords strong; no composition rules, per NIST 800-63B).
 * Login only checks the type and the upper bound.
 */
export function passwordField(
  value: unknown,
  options: { readonly checkStrength: boolean },
): string {
  if (typeof value !== "string" || value.length > MAX_PASSWORD_LENGTH) {
    throw invalid(`The password must be a string of at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (options.checkStrength && value.length < MIN_PASSWORD_LENGTH) {
    throw invalid(`The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  return value;
}
