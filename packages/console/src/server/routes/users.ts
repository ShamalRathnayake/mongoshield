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
 *
 * Permissions (`permissions`, e.g. `data:write`) are granted per user on top of the
 * role. Only operators and admins can hold them; making a user a viewer removes them.
 */

import type { Hono } from "hono";
import { PERMISSIONS, type Permission, ROLES, type Role } from "../../shared/api.ts";
import { randomId } from "../../state/crypto.ts";
import { hashPassword } from "../../state/passwords.ts";
import { withoutSessionsOf } from "../../state/sessions.ts";
import type { UserRecord } from "../../state/types.ts";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { ConsoleError, invalid, notFound } from "../errors.ts";
import { readJson } from "../security.ts";
import { asObject, type Fields, oneOf } from "../validate.ts";
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
    const permissions = permissionsField(body, role) ?? [];
    const passwordHash = await initialPasswordHash(services, body.password);
    const user: UserRecord = {
      id: randomId(),
      username,
      role,
      passwordHash,
      createdAt: services.now().toISOString(),
      ...(permissions.length === 0 ? {} : { permissions }),
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
      details: {
        role,
        signIn: passwordHash === "" ? "sso" : "password",
        permissions: permissions.join(","),
      },
    });
    return c.json(userView(user));
  });

  app.put("/api/users/:id", async (c) => {
    const principal = requireRole(c, "admin");
    const id = c.req.param("id");
    const body = asObject(await readJson(c));
    const username = usernameField(body.username);
    const role: Role = oneOf(body, "role", ROLES);
    const requestedPermissions = permissionsField(body, role);
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
      // Omitted permissions are kept, except that viewers can hold none.
      const permissions =
        requestedPermissions ?? (role === "viewer" ? [] : (existing.permissions ?? []));
      const { permissions: _previous, ...withoutPermissions } = existing;
      const next: UserRecord = {
        ...withoutPermissions,
        username,
        role,
        ...(newHash === undefined ? {} : { passwordHash: newHash }),
        ...(permissions.length === 0 ? {} : { permissions }),
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
      details: {
        role,
        passwordChanged: newHash !== undefined,
        permissions: (updated.permissions ?? []).join(","),
      },
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

/**
 * The optional `permissions` field: known permissions only, no duplicates, and none for
 * viewers (`data:write` needs at least the operator role). `undefined` when absent.
 */
function permissionsField(body: Fields, role: Role): Permission[] | undefined {
  const raw = body.permissions;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw))
    throw invalid(`"permissions" must be a list of ${PERMISSIONS.join(", ")}.`);
  const permissions: Permission[] = [];
  for (const item of raw) {
    const permission = PERMISSIONS.find((candidate) => candidate === item);
    if (permission === undefined) {
      throw invalid(`"permissions" may only contain ${PERMISSIONS.join(", ")}.`);
    }
    if (!permissions.includes(permission)) permissions.push(permission);
  }
  if (role === "viewer" && permissions.length > 0) {
    throw invalid("Viewers cannot hold extra permissions.", "Make the user an operator first.");
  }
  return permissions;
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
