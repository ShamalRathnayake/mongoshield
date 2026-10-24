/**
 * User management (admin only).
 *
 *   GET    /api/users
 *   POST   /api/users        create (password required, unless SSO is on: then omitting
 *                             it creates an SSO-only account)
 *   PUT    /api/users/:id    rename, change role, or set a new password
 *   DELETE /api/users/:id
 *
 * Safety rules: the last admin can be neither demoted nor deleted (the console
 * would become unmanageable), you cannot delete yourself, and changing a
 * password signs that user out everywhere.
 */

import type { Hono } from "hono";
import { ROLES, type Role } from "../../shared/api.ts";
import { randomId } from "../../state/crypto.ts";
import { hashPassword } from "../../state/passwords.ts";
import { withoutSessionsOf } from "../../state/sessions.ts";
import type { UserRecord } from "../../state/types.ts";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { ConsoleError, invalid, notFound } from "../errors.ts";
import { readJson } from "../security.ts";
import { asObject, oneOf } from "../validate.ts";
import { userView } from "../views.ts";
import { passwordField, usernameField } from "./session.ts";

/** Registers the user routes. */
export function userRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  const { store } = services;

  app.get("/api/users", (c) => {
    requireRole(c, "admin");
    return c.json(store.current.users.map(userView));
  });

  app.post("/api/users", async (c) => {
    const principal = requireRole(c, "admin");
    const body = asObject(await readJson(c));
    const username = usernameField(body.username);
    const role: Role = oneOf(body, "role", ROLES);
    const passwordHash = await initialPasswordHash(services, body.password);
    const user: UserRecord = {
      id: randomId(),
      username,
      role,
      passwordHash,
      createdAt: services.now().toISOString(),
    };
    await store.update((state) => {
      assertUsernameFree(state.users, username, undefined);
      state.users = [...state.users, user];
    });
    await recordAudit(services, {
      actor: principal,
      action: "user.create",
      target: username,
      outcome: "success",
      details: { role, signIn: passwordHash === "" ? "sso" : "password" },
    });
    return c.json(userView(user));
  });

  app.put("/api/users/:id", async (c) => {
    const principal = requireRole(c, "admin");
    const id = c.req.param("id");
    const body = asObject(await readJson(c));
    const username = usernameField(body.username);
    const role: Role = oneOf(body, "role", ROLES);
    const newHash =
      body.password === undefined || body.password === null
        ? undefined
        : await hashPassword(
            passwordField(body.password, { checkStrength: true }),
            services.passwordCost,
          );

    const updated = await store.update((state) => {
      const existing = state.users.find((user) => user.id === id);
      if (existing === undefined) throw notFound("The user");
      assertUsernameFree(state.users, username, id);
      if (existing.role === "admin" && role !== "admin") assertNotLastAdmin(state.users, id);
      const next: UserRecord = {
        ...existing,
        username,
        role,
        ...(newHash === undefined ? {} : { passwordHash: newHash }),
      };
      state.users = state.users.map((user) => (user.id === id ? next : user));
      // A new password ends every session of that user (a reset after a suspected compromise).
      if (newHash !== undefined) state.sessions = withoutSessionsOf(state.sessions, id);
      return next;
    });
    await recordAudit(services, {
      actor: principal,
      action: "user.update",
      target: updated.username,
      outcome: "success",
      details: { role, passwordChanged: newHash !== undefined },
    });
    return c.json(userView(updated));
  });

  app.delete("/api/users/:id", async (c) => {
    const principal = requireRole(c, "admin");
    const id = c.req.param("id");
    if (id === principal.user.id) {
      throw invalid("You cannot delete your own account.", "Ask another admin to do it.");
    }
    const removed = await store.update((state) => {
      const existing = state.users.find((user) => user.id === id);
      if (existing === undefined) throw notFound("The user");
      if (existing.role === "admin") assertNotLastAdmin(state.users, id);
      state.users = state.users.filter((user) => user.id !== id);
      state.sessions = withoutSessionsOf(state.sessions, id);
      return existing;
    });
    await recordAudit(services, {
      actor: principal,
      action: "user.delete",
      target: removed.username,
      outcome: "success",
    });
    return c.json({ ok: true as const });
  });
}

/**
 * The password hash of a new account. Without a password the account can only
 * sign in through SSO, which only makes sense (and is only allowed) when OIDC or
 * the trusted proxy is configured: admins pre-create such accounts when OIDC
 * auto-provisioning is off.
 */
async function initialPasswordHash(services: ConsoleServices, password: unknown): Promise<string> {
  if (password !== undefined && password !== null) {
    return hashPassword(passwordField(password, { checkStrength: true }), services.passwordCost);
  }
  const ssoEnabled = services.oidc !== undefined || services.settings.proxySecret !== undefined;
  if (!ssoEnabled) {
    throw invalid(
      "A password is required for a new user.",
      "Accounts without a password are only possible when single sign-on is configured.",
    );
  }
  return "";
}

function assertUsernameFree(
  users: readonly UserRecord[],
  username: string,
  exceptId: string | undefined,
): void {
  if (users.some((user) => user.username === username && user.id !== exceptId)) {
    throw new ConsoleError(409, "CONSOLE_CONFLICT", `The username "${username}" is taken.`);
  }
}

function assertNotLastAdmin(users: readonly UserRecord[], id: string): void {
  if (!users.some((user) => user.role === "admin" && user.id !== id)) {
    throw new ConsoleError(
      409,
      "CONSOLE_LAST_ADMIN",
      "This is the last admin.",
      "Make another user an admin first.",
    );
  }
}
